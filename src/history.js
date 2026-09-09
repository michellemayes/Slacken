import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.js';

export const HISTORY_PATH = path.join(HOME_DIR, 'history.jsonl');

// Long enough that a message is recognisable, short enough that a pasted
// stack trace does not turn the record into a copy of your Slack.
const MAX_TEXT = 2000;

/*
 * What Slacken changed, in the order it changed it.
 *
 * The counts in the menu bar answer "is it doing anything". They do not answer
 * the question the tool actually raises, which is "what did it decide I did
 * not need to read" — and that question has to be answerable after the fact,
 * because the moment you think to ask it the message has usually scrolled
 * away. So every rewrite is appended here with both texts, along with every
 * time you asked for an original back.
 *
 * It is one JSON object per line: appendable without reading the file, and
 * readable with `tail` if Slacken is not running to read it for you. Verdicts
 * already sit in plain text in cache.json, so this stores no category of
 * information that was not already on disk — but it is the file most worth
 * knowing about, so `historyEnabled` turns it off and `slacken history` is the
 * only thing that reads it.
 */
export class History {
  // Handed the live config object rather than a copy of two fields off it, so
  // turning the record off from the menu bar stops the next line being
  // written rather than the next daemon.
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
    // Counted rather than measured: trimming means reading the whole file, and
    // doing that on every rewrite would be the most expensive thing Slacken
    // does. The count starts unknown and is learned from the first trim.
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
      this.appends += 1;
      // Checked periodically rather than per append: the file is a log, and a
      // few hundred lines over the cap for a while costs nothing.
      if (this.appends % 200 === 0) this.trim();
    } catch (err) {
      console.warn(`[slacken] could not write ${this.file}: ${err.message}`);
    }
    return row;
  }

  // A rewrite that reached the screen. Verdicts that changed nothing are not
  // recorded: this is a record of what was done to what you read, and most
  // messages have nothing done to them.
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

  // Someone clicked the badge. The strongest signal there is that a rewrite
  // was not wanted, and it is worth being able to count them by sender.
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
        // A half-written line from a daemon killed mid-append. Skip it rather
        // than refusing to show the rest.
      }
    }
    return out;
  }

  trim() {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= this.maxEntries) return false;
      // Written beside the real file and moved into place, so a daemon that
      // dies mid-trim leaves the old history rather than half of one.
      const temp = `${this.file}.trimming`;
      fs.writeFileSync(temp, lines.slice(-this.maxEntries).join('\n') + '\n');
      fs.renameSync(temp, this.file);
      return true;
    } catch {
      return false;
    }
  }
}

// One line per entry, for `slacken history` and nothing else.
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
