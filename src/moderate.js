import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { SYSTEM_PROMPT, RESPONSE_SCHEMA, TONE_VALUES, buildBatchPayload } from './prompt.js';
import { resolveClaudeBin, notFoundMessage, spawnPath } from './claude-bin.js';
import { Cache } from './cache.js';
import { HOME_DIR } from './config.js';
import { forChannel, gateSignature } from './settings.js';

export const CLEAN = {
  flagged: false, hostile: false, verbose: false,
  tone: [], severity: 0, rewrite: null, note: null,
};

const clean = (extra) => ({ ...CLEAN, ...extra });

/*
 * Batches messages into a single `claude -p` call.
 *
 * Measured on claude-haiku-4-5, thinking disabled:
 *   1 message  per call ~2.4s   ~$0.0031/msg
 *   8 messages per call ~5.2s   ~$0.00068/msg   (~650ms and 4.5x cheaper per message)
 *
 * A persistent --input-format stream-json session was measured and not used:
 * turns were no faster, and the growing conversation made the sixth turn cost
 * 4.7x the first.
 *
 * A held message stays behind "checking…" for as long as a call takes, so
 * anything that is not the model answering is worth cutting.
 */
export class Moderator {
  constructor(config, state = null) {
    this.config = config;
    // Optional: when present and paused, no message reaches the model.
    this.state = state;
    this.cache = new Cache({
      ttlHours: config.cacheTtlHours,
      maxEntries: config.cacheMaxEntries,
    });

    this.queue = [];
    this.timer = null;
    this.inFlight = 0;
    this.seq = 0;
    // Cache key -> the verdict promise for a message already on its way to the
    // model, so two windows showing the same message cost one call.
    this.waiting = new Map();

    this.stats = {
      calls: 0, batched: 0, cacheHits: 0,
      softened: 0, condensed: 0, errors: 0,
      retries: 0, schemaRetries: 0, reveals: 0, notifications: 0, drafts: 0,
      // What today has cost, which is not what this process has cost: the
      // budget is a property of the day and outlives any one daemon.
      costUsd: state?.spentToday ?? 0,
      sessionCostUsd: 0,
      day: today(),
    };
    // The last failure worth telling someone about, and what kind it was.
    // Cleared by the next call that works, so the menu never goes on
    // reporting a problem that has stopped happening.
    this.lastError = null;
  }

  get paused() {
    return Boolean(this.state?.paused);
  }

  async moderate({ text, sender, channel }) {
    // Checked before the cache too: while paused nothing is changed at all.
    if (this.paused) return clean({ reason: 'paused' });

    const trimmed = (text || '').trim();
    if (!trimmed) return clean({ reason: 'empty' });
    if (trimmed.length > this.config.maxChars) return clean({ reason: 'too-long' });

    // Keyed by the settings in force as well as the text: a verdict is stored
    // already judged against them.
    const key = Cache.key(this.config.model, trimmed, gateSignature(this.config, channel));
    const cached = this.cache.get(key);
    if (cached) {
      this.stats.cacheHits += 1;
      return { ...cached, cached: true };
    }

    const joined = this.waiting.get(key);
    if (joined) return joined;

    if (this.overBudget()) return clean({ reason: 'budget', error: 'daily budget reached' });

    const pending = this.enqueue({ text: trimmed, sender, channel }).then((verdict) => {
      // A failure is not a verdict: caching one would keep this message
      // unjudged for the whole TTL, long after the cause was fixed.
      if (!verdict.error) this.cache.set(key, verdict);
      if (verdict.hostile) this.stats.softened += 1;
      if (verdict.verbose) this.stats.condensed += 1;
      return verdict;
    }).finally(() => {
      this.waiting.delete(key);
    });
    this.waiting.set(key, pending);
    return pending;
  }

  // Read through State when there is one, so a restarted daemon knows what
  // the previous one spent today.
  spentToday() {
    if (this.state) {
      this.stats.day = today();
      this.stats.costUsd = this.state.spentToday;
      return this.stats.costUsd;
    }
    if (this.stats.day !== today()) {
      this.stats.day = today();
      this.stats.costUsd = 0;
    }
    return this.stats.costUsd;
  }

  overBudget() {
    const limit = this.config.dailyBudgetUsd;
    if (!limit || limit <= 0) return false;
    return this.spentToday() >= limit;
  }

  recordCost(costUsd) {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    this.stats.sessionCostUsd += costUsd;
    if (this.state) {
      this.state.addCost(costUsd);
      this.stats.day = today();
      this.stats.costUsd = this.state.spentToday;
      return;
    }
    this.spentToday();
    this.stats.costUsd += costUsd;
  }

  /*
   * Hold each request briefly so messages that render together travel as one
   * call. With a call already out the full window costs nothing, since new
   * messages would queue behind it anyway. With nothing in flight the shorter
   * idle window applies: a burst rendered in one frame arrives within a
   * millisecond or two, and a lone message should not wait for company.
   */
  enqueue(item) {
    return new Promise((resolve) => {
      this.queue.push({ ...item, id: `m${this.seq++}`, resolve });
      if (this.queue.length >= this.batchSize()) this.flush();
      // Not unref'd: a queued message needs the process kept alive.
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.batchWindow());
    });
  }

  // Guarded so a batchSize of 0 in a hand-edited config cannot stall the queue.
  batchSize() {
    return Math.max(1, Math.floor(Number(this.config.batchSize)) || 1);
  }

  batchWindow() {
    const full = this.config.batchWindowMs;
    if (this.inFlight > 0) return full;
    const idle = Number(this.config.batchWindowIdleMs);
    return Number.isFinite(idle) && idle >= 0 ? Math.min(idle, full) : full;
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.queue.length) return;
    // All workers busy: the next one to finish flushes again.
    if (this.inFlight >= Math.max(1, Number(this.config.maxConcurrency) || 1)) return;

    const batch = this.queue.splice(0, this.batchSize());
    this.inFlight += 1;
    this.runBatch(batch)
      .catch((err) => {
        this.stats.errors += 1;
        for (const item of batch) item.resolve(clean({ error: err.message }));
      })
      .finally(() => {
        this.inFlight -= 1;
        if (this.queue.length) this.flush();
      });
  }

  async runBatch(batch) {
    this.stats.batched += batch.length;
    const payload = buildBatchPayload(batch);

    const stdout = await this.callWithRetry(payload);

    let { verdicts, costUsd } = parseResponse(stdout);
    this.recordCost(costUsd);

    // `--json-schema` costs a second model turn (~730 input tokens, ~1.2s)
    // on every call to prevent a rare failure, so the fast call goes first
    // and only output that does not parse is asked again with the schema.
    if (!verdicts && !this.config.useJsonSchema) {
      this.stats.schemaRetries += 1;
      if (this.config.verbose) console.warn('[slacken] output did not parse, asking again with the schema');
      const strict = await this.callWithRetry(payload, { schema: true });
      const second = parseResponse(strict);
      this.recordCost(second.costUsd);
      verdicts = second.verdicts;
    }

    if (!verdicts) {
      this.stats.errors += 1;
      if (this.config.verbose) console.warn(`[slacken] unparseable output: ${stdout.slice(0, 300)}`);
      for (const item of batch) item.resolve(clean({ error: 'unparseable model output' }));
      return;
    }

    const byId = new Map(verdicts.filter((v) => v && typeof v.id === 'string').map((v) => [v.id, v]));
    for (const item of batch) {
      const raw = byId.get(item.id);
      item.resolve(raw
        ? normalize(raw, forChannel(this.config, item.channel), item.text)
        : clean({ error: 'no verdict returned' }));
    }
  }

  /*
   * One call, retried only when the failure is transient (a timeout, a rate
   * limit). Being signed out is not retried. The kind of the last failure is
   * kept so the menu can name it rather than count it.
   */
  async callWithRetry(input, { schema = this.config.useJsonSchema } = {}) {
    const attempts = Math.max(0, Number(this.config.retries) || 0) + 1;
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      this.stats.calls += 1;
      try {
        const stdout = await runClaude({
          bin: await this.binPath(),
          args: this.claudeArgs({ schema }),
          input,
          cwd: this.workDir(),
          timeoutMs: this.config.requestTimeoutMs,
        });
        this.lastError = null;
        return stdout;
      } catch (err) {
        lastErr = err;
        const kind = classifyError(err.message);
        this.lastError = { kind, message: err.message, at: Date.now() };
        if (attempt >= attempts || !RETRIABLE.has(kind)) break;
        this.stats.retries += 1;
        if (this.config.verbose) console.warn(`[slacken] ${kind}, trying once more: ${err.message}`);
        await sleep(600 * attempt);
      }
    }
    throw lastErr;
  }

  // The full path, since a daemon started at login has almost no PATH.
  async binPath() {
    const { path: file, searched } = await resolveClaudeBin(this.config.claudeBin);
    if (!file) throw new Error(notFoundMessage(this.config.claudeBin, searched));
    return file;
  }

  // The daemon's own answer, which can differ from a terminal's.
  async whereIsClaude() {
    const { path: file, source, searched } = await resolveClaudeBin(this.config.claudeBin);
    return { bin: this.config.claudeBin, path: file, source, searched };
  }

  // Calls run from ~/.slacken rather than wherever the daemon was started,
  // so a project's CLAUDE.md never reaches the prompt and startup stays fast.
  workDir() {
    if (this.cwd !== undefined) return this.cwd;
    try {
      fs.mkdirSync(HOME_DIR, { recursive: true });
      this.cwd = HOME_DIR;
    } catch {
      // Unwritable home; run from wherever we are.
      this.cwd = null;
    }
    return this.cwd;
  }

  claudeArgs({ schema = this.config.useJsonSchema } = {}) {
    return [
      '-p',
      '--output-format', 'json',
      '--model', this.config.model,
      '--system-prompt', SYSTEM_PROMPT,
      ...(schema ? ['--json-schema', JSON.stringify(RESPONSE_SCHEMA)] : []),
      // Startup and turn weight a verdict does not need.
      '--tools', '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--setting-sources', '',
      ...this.config.claudeArgs,
    ];
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Separates the failures you have to act on (sign in, install claude) from the
// ones that fix themselves (a rate limit, a timeout).
export const RETRIABLE = new Set(['timeout', 'rate-limit', 'overloaded', 'unknown']);

export function classifyError(message) {
  const text = String(message || '').toLowerCase();
  if (/not (logged|signed) in|unauthor|authentication|invalid api key|please run .?claude login|credit balance/.test(text)) {
    return 'auth';
  }
  if (/rate limit|429|too many requests|usage limit/.test(text)) return 'rate-limit';
  if (/overloaded|529|503|502|temporarily unavailable/.test(text)) return 'overloaded';
  if (/timed out|timeout|etimedout/.test(text)) return 'timeout';
  if (/could not spawn|could not run|enoent|not found/.test(text)) return 'missing';
  return 'unknown';
}

// One line for the menu, in the imperative where there is something to do.
export function errorHint(kind, message) {
  switch (kind) {
    case 'auth': return 'Not signed in to Claude — run: claude login';
    case 'missing': return "Can't find claude — run: slacken doctor";
    case 'rate-limit': return 'Rate limited by the API — rewriting will catch up';
    case 'overloaded': return 'The API is overloaded — rewriting will catch up';
    case 'timeout': return 'Model calls are timing out';
    default: return String(message || 'model call failed').slice(0, 80);
  }
}

// Background work `claude` would otherwise do around a call someone is
// waiting on. None of it changes the answer.
const QUIET_ENV = {
  // ~800 output tokens and ~10s down to ~50 tokens and ~2.4s.
  MAX_THINKING_TOKENS: '0',
  // ~500ms a call spent flushing after the result was already printed.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
  // Only for the copies Slacken spawns; your own claude still updates.
  DISABLE_AUTOUPDATER: '1',
};

// How long a child that has already answered gets to exit on its own.
const REAP_GRACE_MS = 2000;
const MAX_STDERR = 16_384;

function runClaude({ bin, args, input, cwd = null, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(cwd ? { cwd } : {}),
        env: {
          ...process.env,
          ...QUIET_ENV,
          // An npm-installed claude needs node on the PATH to run.
          PATH: spawnPath(bin),
        },
      });
    } catch (err) {
      reject(new Error(`could not spawn ${bin}: ${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Resolve as soon as the envelope parses rather than on exit: the process
    // can take another half second to shut down after printing it.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
      if (settled || !isComplete(stdout)) return;
      settled = true;
      clearTimeout(timer);
      const grace = setTimeout(() => child.kill('SIGKILL'), REAP_GRACE_MS);
      grace.unref?.();
      child.on('close', () => clearTimeout(grace));
      resolve(stdout);
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_STDERR) stderr += d;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`could not run ${bin}: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.trim().slice(0, 200) || 'no stderr'}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Only a successful result envelope counts as complete. A failure envelope is
// left to the exit code and stderr, which carry the message worth showing.
export function isComplete(stdout) {
  if (!stdout.trimEnd().endsWith('}')) return false;
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return false;
  }
  if (!envelope || typeof envelope !== 'object' || envelope.is_error === true) return false;
  return typeof envelope.result === 'string' || Array.isArray(envelope.verdicts);
}

// `claude -p --output-format json` wraps the answer in a result envelope that
// also carries what the call cost.
export function parseResponse(stdout) {
  let body = stdout;
  let costUsd = 0;
  try {
    const envelope = JSON.parse(stdout);
    if (envelope && typeof envelope === 'object') {
      if (typeof envelope.total_cost_usd === 'number') costUsd = envelope.total_cost_usd;
      if (typeof envelope.result === 'string') body = envelope.result;
      else if (Array.isArray(envelope.verdicts)) return { verdicts: envelope.verdicts, costUsd };
    }
  } catch {
    // Not an envelope. Treat stdout as the answer.
  }
  const parsed = extractJsonObject(body);
  return { verdicts: Array.isArray(parsed?.verdicts) ? parsed.verdicts : null, costUsd };
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  // Scan for the matching brace so fences or trailing prose cannot break us.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function normalize(raw, config = {}, originalText = '') {
  const {
    minSeverity = 2,
    condenseMinWords = 45,
    condenseMaxRatio = 0.7,
    condenseEnabled = true,
  } = config;

  const severity = clampInt(raw.severity, 0, 3);
  const rewrite = typeof raw.rewrite === 'string' && raw.rewrite.trim() ? raw.rewrite.trim() : null;
  const tone = Array.isArray(raw.tone) ? raw.tone.filter((t) => TONE_VALUES.includes(t)) : [];

  // Softening has to clear the severity floor. Condensing has to be switched
  // on, start from something long, and come back meaningfully shorter — a
  // paraphrase of the same length is all cost and no benefit.
  const originalWords = wordCount(originalText);
  const hostile = Boolean(raw.hostile) && severity >= minSeverity;
  const verbose = Boolean(raw.verbose)
    && condenseEnabled !== false
    && rewrite !== null
    && originalWords >= condenseMinWords
    && wordCount(rewrite) <= originalWords * condenseMaxRatio;

  const flagged = (hostile || verbose) && rewrite !== null;
  return {
    flagged,
    hostile: flagged && hostile,
    verbose: flagged && verbose,
    tone,
    severity,
    rewrite: flagged ? rewrite : null,
    note: flagged && typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : null,
    why: flagged ? null : whyNot({
      raw,
      rewrite,
      severity,
      originalWords,
      minSeverity,
      condenseMinWords,
      condenseMaxRatio,
      condenseEnabled,
    }),
  };
}

/*
 * Why a message was left alone: the model saw nothing wrong, or a threshold
 * refused its rewrite. The two have different fixes, so the log names which,
 * and the setting to move.
 */
function whyNot({
  raw, rewrite, severity, originalWords, minSeverity, condenseMinWords, condenseMaxRatio, condenseEnabled,
}) {
  const calledHostile = Boolean(raw.hostile);
  const calledVerbose = Boolean(raw.verbose);

  if (!calledHostile && !calledVerbose) return 'nothing to change';
  if (rewrite === null) return 'flagged it, but sent back no rewrite';

  if (calledVerbose && condenseEnabled !== false) {
    if (originalWords < condenseMinWords) {
      return `${originalWords} words, condensing starts at condenseMinWords ${condenseMinWords}`;
    }
    const rewriteWords = wordCount(rewrite);
    if (rewriteWords > originalWords * condenseMaxRatio) {
      const pct = Math.round((rewriteWords / originalWords) * 100);
      return `the rewrite was ${pct}% of the length, condenseMaxRatio allows ${Math.round(condenseMaxRatio * 100)}%`;
    }
  }
  if (calledHostile && severity < minSeverity) {
    return `severity ${severity}, below minSeverity ${minSeverity}`;
  }
  if (calledVerbose && condenseEnabled === false) return 'condensing is off (condenseEnabled)';
  return 'nothing to change';
}

function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
