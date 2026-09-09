import { spawn } from 'node:child_process';
import { buildPrompt, TONE_VALUES } from './prompt.js';
import { Cache } from './cache.js';

const CLEAN = { flagged: false, tone: [], severity: 0, rewrite: null, note: null };

export class Moderator {
  constructor(config) {
    this.config = config;
    this.cache = new Cache({
      ttlHours: config.cacheTtlHours,
      maxEntries: config.cacheMaxEntries,
    });
    this.inFlight = 0;
    this.queue = [];
    this.stats = { calls: 0, cacheHits: 0, flagged: 0, errors: 0 };
  }

  async moderate({ text, sender, channel }) {
    const trimmed = (text || '').trim();
    if (!trimmed) return { ...CLEAN, reason: 'empty' };
    if (trimmed.length > this.config.maxChars) return { ...CLEAN, reason: 'too-long' };

    const key = Cache.key(this.config.model, trimmed);
    const cached = this.cache.get(key);
    if (cached) {
      this.stats.cacheHits += 1;
      return { ...cached, cached: true };
    }

    const verdict = await this.withSlot(() => this.askClaude({ text: trimmed, sender, channel }));
    this.cache.set(key, verdict);
    if (verdict.flagged) this.stats.flagged += 1;
    return verdict;
  }

  // Cap how many `claude -p` processes run at once. A busy channel can deliver
  // a dozen messages in one render pass.
  withSlot(fn) {
    if (this.inFlight < this.config.maxConcurrency) {
      this.inFlight += 1;
      return fn().finally(() => {
        this.inFlight -= 1;
        const next = this.queue.shift();
        if (next) next();
      });
    }
    return new Promise((resolve, reject) => {
      this.queue.push(() => {
        this.inFlight += 1;
        fn().then(resolve, reject).finally(() => {
          this.inFlight -= 1;
          const next = this.queue.shift();
          if (next) next();
        });
      });
    });
  }

  async askClaude({ text, sender, channel }) {
    this.stats.calls += 1;
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', this.config.model,
      ...this.config.claudeArgs,
    ];

    let raw;
    try {
      raw = await runClaude(this.config.claudeBin, args, buildPrompt({ text, sender, channel }), this.config.requestTimeoutMs);
    } catch (err) {
      this.stats.errors += 1;
      return { ...CLEAN, error: err.message };
    }

    const verdict = parseVerdict(raw);
    if (!verdict) {
      this.stats.errors += 1;
      if (this.config.verbose) console.warn(`[slackcensor] unparseable model output: ${raw.slice(0, 300)}`);
      return { ...CLEAN, error: 'unparseable model output' };
    }
    return normalize(verdict, this.config.minSeverity);
  }
}

function runClaude(bin, args, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
    child.stdin.end(prompt);
  });
}

// `claude -p --output-format json` wraps the answer in a result envelope, but
// fall back to treating stdout as the answer itself if that ever changes.
export function parseVerdict(stdout) {
  let body = stdout;
  try {
    const envelope = JSON.parse(stdout);
    if (envelope && typeof envelope.result === 'string') body = envelope.result;
    else if (envelope && typeof envelope.flagged === 'boolean') return envelope;
  } catch {
    // Not an envelope. Keep the raw text.
  }
  return extractJsonObject(body);
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  // Scan for the matching brace so trailing prose or fences do not break us.
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

export function normalize(verdict, minSeverity) {
  const severity = clampInt(verdict.severity, 0, 3);
  const rewrite = typeof verdict.rewrite === 'string' && verdict.rewrite.trim()
    ? verdict.rewrite.trim()
    : null;
  const tone = Array.isArray(verdict.tone)
    ? verdict.tone.filter((t) => TONE_VALUES.includes(t))
    : [];
  // A "flagged" verdict with no rewrite, or one below the severity floor, is
  // not actionable: leave the message exactly as it was written.
  const flagged = Boolean(verdict.flagged) && rewrite !== null && severity >= minSeverity;
  return {
    flagged,
    tone,
    severity,
    rewrite: flagged ? rewrite : null,
    note: flagged && typeof verdict.note === 'string' && verdict.note.trim()
      ? verdict.note.trim()
      : null,
  };
}

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
