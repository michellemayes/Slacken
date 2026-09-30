import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.js';
import { writeFileAtomic } from './fsutil.js';

export const STATE_PATH = path.join(HOME_DIR, 'state.json');

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/*
 * Daemon state that is not configuration: whether Slacken is paused, and what
 * today has cost. Both persist because the login agent restarts the daemon on
 * every crash and login — a pause that silently lifted, or a daily budget that
 * reset on each restart, would both be broken promises. Spend is written as
 * soon as a call reports it, not on a timer, since a crash is the case it is
 * for.
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
      // Spend from an earlier day does not count against today.
      if (typeof raw.day === 'string' && raw.day === today() && Number.isFinite(raw.costUsd)) {
        this.day = raw.day;
        this.costUsd = Math.max(0, raw.costUsd);
      }
    } catch {
      // Missing or corrupt: not paused, nothing spent.
    }
  }

  save() {
    if (!this.persist) return;
    try {
      writeFileAtomic(this.file, JSON.stringify({
        paused: this.paused,
        pausedAt: this.pausedAt,
        day: this.day,
        costUsd: Number(this.costUsd.toFixed(6)),
      }) + '\n');
    } catch (err) {
      console.warn(`[slacken] could not write ${this.file}: ${err.message}`);
    }
  }

  // Returns whether anything changed, so callers can skip no-op broadcasts.
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
        // One bad listener must not stop the others hearing about it.
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

  // Rolls over on read too, so a daemon running past midnight starts afresh.
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
