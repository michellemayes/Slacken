import { spawn } from 'node:child_process';
import { SYSTEM_PROMPT, RESPONSE_SCHEMA, TONE_VALUES, buildBatchPayload } from './prompt.js';
import { Cache } from './cache.js';

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
 * A persistent --input-format stream-json session was measured too and is
 * deliberately not used: turns were no faster, and because the conversation
 * accumulates, the sixth turn cost 4.7x the first.
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

    this.stats = {
      calls: 0, batched: 0, cacheHits: 0,
      softened: 0, condensed: 0, errors: 0,
      costUsd: 0, day: today(),
    };
  }

  get paused() {
    return Boolean(this.state?.paused);
  }

  async moderate({ text, sender, channel }) {
    // Checked before the cache as well as before the model: while paused,
    // Slacken hands back a verdict that changes nothing, so the words on
    // screen are the ones that were actually written.
    if (this.paused) return clean({ reason: 'paused' });

    const trimmed = (text || '').trim();
    if (!trimmed) return clean({ reason: 'empty' });
    if (trimmed.length > this.config.maxChars) return clean({ reason: 'too-long' });

    const key = Cache.key(this.config.model, trimmed);
    const cached = this.cache.get(key);
    if (cached) {
      this.stats.cacheHits += 1;
      return { ...cached, cached: true };
    }

    if (this.overBudget()) return clean({ reason: 'budget', error: 'daily budget reached' });

    const verdict = await this.enqueue({ text: trimmed, sender, channel });
    this.cache.set(key, verdict);
    if (verdict.hostile) this.stats.softened += 1;
    if (verdict.verbose) this.stats.condensed += 1;
    return verdict;
  }

  overBudget() {
    const limit = this.config.dailyBudgetUsd;
    if (!limit || limit <= 0) return false;
    if (this.stats.day !== today()) {
      this.stats.day = today();
      this.stats.costUsd = 0;
    }
    return this.stats.costUsd >= limit;
  }

  // Hold each request for a short window so messages that render together —
  // catching up on a channel, or a burst from one person — travel as one call.
  enqueue(item) {
    return new Promise((resolve) => {
      this.queue.push({ ...item, id: `m${this.seq++}`, resolve });
      if (this.queue.length >= this.config.batchSize) this.flush();
      // Deliberately not unref'd: the batch window is the only thing holding
      // a queued message, so it has to keep the process alive on its own.
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.config.batchWindowMs);
    });
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.queue.length) return;
    if (this.inFlight >= this.config.maxConcurrency) {
      // All workers busy. Try again once one frees up.
      this.timer = setTimeout(() => this.flush(), 50);
      return;
    }

    const batch = this.queue.splice(0, this.config.batchSize);
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
    this.stats.calls += 1;
    this.stats.batched += batch.length;

    const stdout = await runClaude({
      bin: this.config.claudeBin,
      args: this.claudeArgs(),
      input: buildBatchPayload(batch),
      timeoutMs: this.config.requestTimeoutMs,
    });

    const { verdicts, costUsd } = parseResponse(stdout);
    if (costUsd) {
      if (this.stats.day !== today()) {
        this.stats.day = today();
        this.stats.costUsd = 0;
      }
      this.stats.costUsd += costUsd;
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
        ? normalize(raw, this.config, item.text)
        : clean({ error: 'no verdict returned' }));
    }
  }

  claudeArgs() {
    return [
      '-p',
      '--output-format', 'json',
      '--model', this.config.model,
      '--system-prompt', SYSTEM_PROMPT,
      ...(this.config.useJsonSchema ? ['--json-schema', JSON.stringify(RESPONSE_SCHEMA)] : []),
      // Everything below is startup and turn weight we do not need. Without
      // them a verdict costs ~800 thinking tokens and 8-11 seconds.
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

function runClaude({ bin, args, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // The single biggest lever there is: it takes a verdict from ~800
        // output tokens and ~10s down to ~50 tokens and ~2.4s.
        env: { ...process.env, MAX_THINKING_TOKENS: '0' },
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

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
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
  } = config;

  const severity = clampInt(raw.severity, 0, 3);
  const rewrite = typeof raw.rewrite === 'string' && raw.rewrite.trim() ? raw.rewrite.trim() : null;
  const tone = Array.isArray(raw.tone) ? raw.tone.filter((t) => TONE_VALUES.includes(t)) : [];

  // Each transformation earns the swap on its own terms. Softening has to
  // clear the severity floor. Condensing has to start from something actually
  // long, and has to come back meaningfully shorter — otherwise we would be
  // swapping a person's own words for a paraphrase of the same length, which
  // is all cost and no benefit.
  const originalWords = wordCount(originalText);
  const hostile = Boolean(raw.hostile) && severity >= minSeverity;
  const verbose = Boolean(raw.verbose)
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
  };
}

function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
