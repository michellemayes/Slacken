import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME_DIR } from './config.js';

const CACHE_PATH = path.join(HOME_DIR, 'cache.json');

export class Cache {
  constructor({ ttlHours, maxEntries }) {
    this.ttlMs = ttlHours * 3600 * 1000;
    this.maxEntries = maxEntries;
    // A zero TTL means "do not cache", not "expire everything the moment it
    // lands". Read the second way it would keep every entry it was given until
    // the next flush wrote an empty file over a week of real answers, so a
    // disabled cache touches neither memory nor disk.
    this.enabled = this.ttlMs > 0 && maxEntries > 0;
    this.map = new Map();
    this.flushTimer = null;
    if (this.enabled) this.load();
  }

  // The gate is the settings the verdict was judged against. Two verdicts for
  // the same text under different thresholds are different answers, and a
  // cache that could not tell them apart would hand one channel the other's.
  static key(model, text, gate = '') {
    return crypto.createHash('sha256').update(`${model} ${gate} ${text}`).digest('hex').slice(0, 32);
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      const now = Date.now();
      for (const [k, entry] of Object.entries(raw)) {
        if (entry && now - entry.at < this.ttlMs) this.map.set(k, entry);
      }
    } catch {
      // No cache yet, or it is corrupt. Either way we start empty.
    }
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at >= this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value) {
    if (!this.enabled) return;
    this.map.set(key, { at: Date.now(), value });
    // Map preserves insertion order, so the first keys are the oldest.
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
    this.scheduleFlush();
  }

  // Every entry was judged against thresholds that have just moved, so none of
  // them answers the question being asked now.
  clear() {
    this.map.clear();
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 5000);
    this.flushTimer.unref?.();
  }

  flush() {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(HOME_DIR, { recursive: true });
      fs.writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(this.map)));
    } catch (err) {
      console.warn(`[slacken] could not write cache: ${err.message}`);
    }
  }
}
