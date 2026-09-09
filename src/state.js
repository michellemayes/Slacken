import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.js';

export const STATE_PATH = path.join(HOME_DIR, 'state.json');

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/*
 * The daemon state that is not configuration: whether Slacken is currently
 * allowed to change anything you read, and what today has cost so far.
 *
 * Both are written to disk because the login agent restarts the daemon
 * whenever it exits, and both mean something different if they are forgotten:
 *
 *   A pause that silently un-paused itself after a crash would be the worst
 *   kind of surprise — you would go on reading a rewritten feed believing you
 *   had turned it off. The menu bar item makes the persisted state visible, so
 *   a pause can never be forgotten either.
 *
 *   A daily budget that started again from zero at every restart would not be
 *   a daily budget. The agent restarts on a crash and at every login, so a
 *   $0.25 cap held only in memory is a $0.25 cap per restart — which is to say
 *   no cap at all on the day a Slack update makes the daemon fall over twice.
 *   The spend is written the moment a call reports what it cost, not on a
 *   timer, because the crash is exactly the case it exists for.
 */
export class State {
  constructor({ file = STATE_PATH, persist = true } = {}) {
    this.file = file;
    this.persist = persist;
    this.startedAt = Date.now();
    this.paused = false;
    this.pausedAt = null;
    this.day = today();
    this.costUsd = 0;
    this.listeners = new Set();
    if (persist) this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.paused = Boolean(raw.paused);
      this.pausedAt = this.paused && Number.isFinite(raw.pausedAt) ? raw.pausedAt : null;
      // A spend from a previous day is not this day's spend. Reading it as
      // zero rather than dropping the field keeps yesterday's number out of
      // today's budget without a separate rollover pass at startup.
      if (typeof raw.day === 'string' && raw.day === today() && Number.isFinite(raw.costUsd)) {
        this.day = raw.day;
        this.costUsd = Math.max(0, raw.costUsd);
      }
    } catch {
      // No state yet, or it is corrupt. Not paused, nothing spent, is the
      // right default.
    }
  }

  save() {
    if (!this.persist) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({
        paused: this.paused,
        pausedAt: this.pausedAt,
        day: this.day,
        costUsd: Number(this.costUsd.toFixed(6)),
      }) + '\n');
    } catch (err) {
      console.warn(`[slacken] could not write ${this.file}: ${err.message}`);
    }
  }

  // Returns true if this actually changed anything, so callers can skip the
  // work of telling every Slack window about a no-op.
  setPaused(paused) {
    const next = Boolean(paused);
    if (next === this.paused) return false;
    this.paused = next;
    this.pausedAt = next ? Date.now() : null;
    this.save();
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // A listener that throws must not stop the others being told.
      }
    }
    return true;
  }

  toggle() {
    this.setPaused(!this.paused);
    return this.paused;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* ------------------------------------------------------------- spending */

  // Rolls the day over on read as well as on write, so a daemon left running
  // past midnight is not still measuring yesterday.
  get spentToday() {
    this.rollDay();
    return this.costUsd;
  }

  rollDay() {
    const now = today();
    if (this.day === now) return false;
    this.day = now;
    this.costUsd = 0;
    return true;
  }

  addCost(usd) {
    if (!Number.isFinite(usd) || usd <= 0) return this.spentToday;
    this.rollDay();
    this.costUsd += usd;
    this.save();
    return this.costUsd;
  }

  get uptimeMs() {
    return Date.now() - this.startedAt;
  }
}
