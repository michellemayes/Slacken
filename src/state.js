import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.js';

export const STATE_PATH = path.join(HOME_DIR, 'state.json');

/*
 * The one piece of daemon state that is not configuration: whether Slacken is
 * currently allowed to change anything you read.
 *
 * It is written to disk because the login agent restarts the daemon whenever
 * it exits, and a pause that silently un-paused itself after a crash would be
 * the worst kind of surprise — you would go on reading a rewritten feed
 * believing you had turned it off. The menu bar item makes the persisted state
 * visible, so a pause can never be forgotten either.
 */
export class State {
  constructor({ file = STATE_PATH, persist = true } = {}) {
    this.file = file;
    this.persist = persist;
    this.startedAt = Date.now();
    this.paused = false;
    this.pausedAt = null;
    this.listeners = new Set();
    if (persist) this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.paused = Boolean(raw.paused);
      this.pausedAt = this.paused && Number.isFinite(raw.pausedAt) ? raw.pausedAt : null;
    } catch {
      // No state yet, or it is corrupt. Not paused is the right default.
    }
  }

  save() {
    if (!this.persist) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ paused: this.paused, pausedAt: this.pausedAt }) + '\n');
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

  get uptimeMs() {
    return Date.now() - this.startedAt;
  }
}
