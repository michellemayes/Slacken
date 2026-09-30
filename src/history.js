import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.js';
import { writeFileAtomic } from './fsutil.js';

export const HISTORY_PATH = path.join(HOME_DIR, 'history.jsonl');

// Long enough to recognise a message, short enough that a pasted stack trace
// does not turn the record into a copy of your Slack.
const MAX_TEXT = 2000;
const TRIM_EVERY = 200;

/*
 * Every rewrite that reached the screen, with both texts, and every time an
 * original was asked for back — so "what did it decide I did not need to
 * read" can be answered after the message has scrolled away. One JSON object
 * per line: cheap to append and readable with `tail`.
 */
export class History {
  // Holds the live config rather than a copy, so turning the record off from
  // the menu bar takes effect on the next line.
  constructor({
    file = HISTORY_PATH,
    config = null,
    enabled = true,
    maxEntries = 2000,
  } = {}) {
    this.file = file;
    this.config = config;
    this.fallbackEnabled = enabled;
    this.fallbackMaxEntries = maxEntries;
    // Trimming reads the whole file, so it runs on the first append (catching
    // growth across restarts) and then every TRIM_EVERY appends.
    this.appends = 0;
  }

  get enabled() {
    return this.config ? this.config.historyEnabled !== false : this.fallbackEnabled;
  }

  get maxEntries() {
    return Math.max(10, Number(this.config?.historyMaxEntries ?? this.fallbackMaxEntries) || 2000);
  }

  record(entry) {
    if (!this.enabled) return null;
    const row = { at: new Date().toISOString(), ...entry };
    for (const key of ['original', 'rewrite']) {
      if (typeof row[key] === 'string' && row[key].length > MAX_TEXT) {
        row[key] = `${row[key].slice(0, MAX_TEXT)}…`;
      }
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
      if (this.appends % TRIM_EVERY === 0) this.trim();
      this.appends += 1;
    } catch (err) {
      console.warn(`[slacken] could not write ${this.file}: ${err.message}`);
    }
    return row;
  }

  // Only verdicts that changed something are recorded.
  recordVerdict({ sender, channel, text, verdict }) {
    if (!verdict?.flagged || !verdict.rewrite) return null;
    return this.record({
      kind: verdict.hostile && verdict.verbose ? 'softened+condensed'
        : verdict.verbose ? 'condensed' : 'softened',
      sender: sender || null,
      channel: channel || null,
      severity: verdict.severity ?? null,
      tone: verdict.tone || [],
      note: verdict.note || null,
      original: text || '',
      rewrite: verdict.rewrite,
    });
  }

  // The badge was clicked: the clearest sign a rewrite was not wanted.
  recordReveal({ sender, channel, note, kind }) {
    return this.record({
      kind: 'revealed',
      of: kind || null,
      sender: sender || null,
      channel: channel || null,
      note: note || null,
    });
  }

  // Newest last, the way the file reads.
  read({ limit = 50 } = {}) {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // A half-written line from a daemon killed mid-append.
      }
    }
    return out;
  }

  trim() {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= this.maxEntries) return false;
      writeFileAtomic(this.file, lines.slice(-this.maxEntries).join('\n') + '\n');
      return true;
    } catch {
      return false;
    }
  }
}

// One entry, formatted for `slacken history`.
export function formatEntry(entry) {
  const when = String(entry.at || '').replace('T', ' ').slice(0, 19);
  const who = `${entry.sender || 'someone'}${entry.channel ? ` in ${entry.channel}` : ''}`;
  if (entry.kind === 'revealed') {
    return `${when}  original asked for  ${who}${entry.of ? ` (${entry.of})` : ''}`;
  }
  const head = `${when}  ${String(entry.kind || '?').padEnd(18)} ${who}`;
  const detail = [
    entry.note ? `note: ${entry.note}` : null,
    entry.original ? `was:  ${oneLine(entry.original)}` : null,
    entry.rewrite ? `now:  ${oneLine(entry.rewrite)}` : null,
  ].filter(Boolean).map((line) => `    ${line}`);
  return [head, ...detail].join('\n');
}

function oneLine(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}
