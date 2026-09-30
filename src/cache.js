import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME_DIR } from './config.js';
import { writeFileAtomic } from './fsutil.js';

const CACHE_PATH = path.join(HOME_DIR, 'cache.json');

export class Cache {
  constructor({ ttlHours, maxEntries }) {
    this.ttlMs = ttlHours * 3600 * 1000;
    this.maxEntries = maxEntries;
    // A zero TTL or size disables the cache outright, including on disk, so a
    // disabled cache never overwrites a populated file with an empty one.
    this.enabled = this.ttlMs > 0 && maxEntries > 0;
    this.map = new Map();
    this.flushTimer = null;
    if (this.enabled) this.load();
  }

  // `gate` is the settings the verdict was judged against: the same text
  // under different thresholds is a different answer.
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
      // Missing or corrupt: start empty.
    }
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at >= this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    // Move to the back so eviction drops the least recently used entry.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (!this.enabled) return;
    this.map.delete(key);
    this.map.set(key, { at: Date.now(), value });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
    this.scheduleFlush();
  }

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
      writeFileAtomic(CACHE_PATH, JSON.stringify(Object.fromEntries(this.map)));
    } catch (err) {
      console.warn(`[slacken] could not write cache: ${err.message}`);
    }
  }
}
