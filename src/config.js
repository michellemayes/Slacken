import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SETTINGS, coerce, coerceAll, coerceChannelPatch, inList, withEntry, channelKey, forChannel,
} from './settings.js';
import { writeFileAtomic } from './fsutil.js';

export const HOME_DIR = path.join(os.homedir(), '.slacken');
export const CONFIG_PATH = path.join(HOME_DIR, 'config.json');

/*
 * Bumped when a default moves. The config file is written out in full on
 * first run, which pins every key — so a moved default would otherwise only
 * reach new installs.
 */
export const CONFIG_VERSION = 2;

// Defaults that have moved, and the value they used to hold. Only a key still
// holding exactly the old default is brought forward; a value you chose stays.
const SUPERSEDED_DEFAULTS = {
  useJsonSchema: true,
};

export const DEFAULTS = {
  // Chrome DevTools Protocol port that Slack.app is launched with.
  cdpPort: 9222,
  // Which DevTools page targets to inject into. Widen this if your workspace
  // lives on a custom domain.
  targetUrlPattern: '^https://([a-z0-9-]+\\.)*slack\\.com/',
  // Local HTTP API, used by `slacken test`, `slacken status`, health checks
  // and the menu bar item. Loopback only.
  httpPort: 8787,
  // Show a menu bar item while the daemon runs: what it has done, and a
  // pause/resume toggle. Needs `swiftc` (Xcode Command Line Tools); without it
  // the daemon says so once and carries on.
  menuBar: true,

  // Which model does the rewriting. Haiku keeps it cheap and fast; messages
  // arrive faster than you read them.
  model: 'claude-haiku-4-5-20251001',
  claudeBin: 'claude',
  claudeArgs: [],
  requestTimeoutMs: 25000,
  // How many times a failed call is tried again. Only failures that could
  // plausibly go differently are retried; being signed out never is.
  retries: 1,

  // Messages that render together travel as one `claude -p` call. Measured on
  // haiku with thinking off: 1/call is ~2.4s and $0.0031 a message, 8/call is
  // ~650ms and $0.00068 a message.
  batchSize: 8,
  batchWindowMs: 120,
  // The window with no call already out: long enough to collect a burst that
  // rendered in one frame, short enough that a lone message is not kept waiting.
  batchWindowIdleMs: 25,
  maxConcurrency: 2,
  // Hold the model to the response schema on every call. Off because it costs
  // ~1.2s a message; output that does not parse is retried with the schema.
  useJsonSchema: false,
  // Stop calling the model once a day costs this much. 0 disables the cap.
  dailyBudgetUsd: 0,

  // "heuristic" only asks the model about messages that already look intense
  // or padded, which is most of what keeps this cheap. "always" sends everything.
  triageMode: 'heuristic',
  // Local score a message needs before a tone call is worth making.
  triageThreshold: 2,
  // Model severity (0-3) required before a tone rewrite is applied.
  minSeverity: 2,

  // Condensing only applies to messages at least this long...
  condenseMinWords: 45,
  // ...and only if the rewrite comes back at most this fraction of the length.
  condenseMaxRatio: 0.7,
  // Set false to soften tone but never compress.
  condenseEnabled: true,

  // Messages longer than this are left alone.
  maxChars: 4000,
  // Hide a message the moment local triage suspects it, rather than letting
  // the original sit on screen while the model answers. It is restored in full
  // if the model disagrees.
  holdWhilePending: true,
  // Keep rewrites in the renderer's localStorage as well as on disk here, so a
  // reload or a workspace switch repaints them without a round trip. Set false
  // to leave nothing behind in Slack's own storage.
  persistVerdicts: true,

  // Your own display names, so your messages are never rewritten. Usually
  // detected automatically from the Slack UI; this is the fallback.
  selfNames: [],
  // Senders and channels to leave completely untouched.
  ignoreSenders: [],
  ignoreChannels: [],
  // Settings that differ in one channel: { "#eng-oncall": { "minSeverity": 3 } }.
  // Edited with `slacken channel`, from the menu bar, or here by hand.
  channelOverrides: {},

  // Rewrite a notification's body before it is shown. Only works where Slack
  // raises notifications from its renderer; the menu counts how many it saw.
  rewriteNotifications: true,
  // Offer a flatter wording above the composer when your own draft reads
  // sharp. Off by default; it never edits or sends anything by itself.
  draftCheck: false,

  // Append every rewrite, and every original you ask for back, to
  // ~/.slacken/history.jsonl. Read it with `slacken history`.
  historyEnabled: true,
  historyMaxEntries: 2000,

  // Ask GitHub once a day whether there is a newer Slacken. Off by default:
  // nothing else here talks to anything but your own machine.
  checkUpdates: false,

  cacheTtlHours: 168,
  cacheMaxEntries: 5000,
  verbose: false,
};

export function loadConfig(file = CONFIG_PATH) {
  return { ...DEFAULTS, ...validated(readConfigFile(file), file) };
}

// Settings outside SETTINGS that are still numbers the daemon depends on, and
// the smallest value each can take.
const NUMERIC_MINIMUMS = {
  cdpPort: 1,
  httpPort: 1,
  requestTimeoutMs: 1000,
  retries: 0,
  batchSize: 1,
  batchWindowMs: 0,
  batchWindowIdleMs: 0,
  maxConcurrency: 1,
  historyMaxEntries: 10,
  cacheTtlHours: 0,
  cacheMaxEntries: 0,
};

/*
 * A hand-edited file can hold anything. A value that would break the daemon
 * (a batchSize of 0, a threshold that is a string) falls back to its default
 * with a warning, rather than failing later somewhere less obvious.
 */
function validated(raw, file) {
  const out = { ...raw };
  const reject = (key, why) => {
    console.warn(`[slacken] ignoring ${key} in ${file}: ${why}; using ${JSON.stringify(DEFAULTS[key])}`);
    delete out[key];
  };
  for (const [key, value] of Object.entries(raw)) {
    if (SETTINGS[key]) {
      try {
        out[key] = coerce(key, value);
      } catch (err) {
        reject(key, err.message);
      }
    } else if (key in NUMERIC_MINIMUMS) {
      const n = Number(value);
      if (typeof value === 'boolean' || !Number.isFinite(n) || n < NUMERIC_MINIMUMS[key]) {
        reject(key, `expected a number of at least ${NUMERIC_MINIMUMS[key]}`);
      } else {
        out[key] = n;
      }
    } else if (key === 'claudeArgs' && !Array.isArray(value)) {
      reject(key, 'expected a list of arguments');
    } else if (key === 'targetUrlPattern') {
      try {
        new RegExp(value, 'i'); // eslint-disable-line no-new
      } catch (err) {
        reject(key, err.message);
      }
    }
  }
  return out;
}

function readConfigFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[slacken] ignoring unreadable ${file}: ${err.message}`);
    }
    return {};
  }
}

export function writeDefaultConfig() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    writeConfigFile(CONFIG_PATH, { configVersion: CONFIG_VERSION, ...DEFAULTS });
    return CONFIG_PATH;
  }
  migrateConfig(CONFIG_PATH);
  return CONFIG_PATH;
}

// Bring a file from an older Slacken up to date, once, and say what moved.
export function migrateConfig(file = CONFIG_PATH) {
  const raw = readConfigFile(file);
  // Missing, empty or unreadable: leave it exactly as it is.
  if (!Object.keys(raw).length) return { changed: [] };
  if (Number(raw.configVersion) >= CONFIG_VERSION) return { changed: [] };

  const next = { ...raw };
  const changed = [];
  for (const [key, was] of Object.entries(SUPERSEDED_DEFAULTS)) {
    if (!(key in raw) || !same(raw[key], was)) continue;
    next[key] = DEFAULTS[key];
    changed.push(key);
  }
  next.configVersion = CONFIG_VERSION;
  try {
    writeConfigFile(file, next);
  } catch (err) {
    console.warn(`[slacken] could not bring ${file} up to date: ${err.message}`);
    return { changed: [] };
  }
  for (const key of changed) {
    console.log(`[slacken] ${key} was still set to the old default; it is now `
      + `${JSON.stringify(DEFAULTS[key])} — set it back in ${file} if you want it`);
  }
  return { changed };
}

function writeConfigFile(file, values) {
  writeFileAtomic(file, JSON.stringify(values, null, 2) + '\n');
}

/*
 * The running configuration, and the only thing allowed to change it. The
 * menu bar, the button in Slack and the terminal all go through here: a
 * change is validated, written to disk, and announced.
 *
 * `values` is mutated in place: the moderator, attacher and server hold that
 * same object, so a change applies to them immediately.
 */
export class ConfigStore {
  constructor({ file = CONFIG_PATH, values = null, persist = true } = {}) {
    this.file = file;
    this.persist = persist;
    this.values = values || loadConfig(file);
    this.listeners = new Set();
  }

  // Returns the keys that moved and anything refused. Nothing is applied if
  // any of the patch is invalid.
  update(patch) {
    const { values, errors } = coerceAll(patch);
    if (errors.length) return { changed: [], errors, values: this.values };
    const changed = [];
    for (const [key, value] of Object.entries(values)) {
      if (same(this.values[key], value)) continue;
      this.values[key] = value;
      changed.push(key);
    }
    if (changed.length) {
      this.save(changed);
      this.announce(changed);
    }
    return { changed, errors, values: this.values };
  }

  // Idempotent: ignoring an already-ignored channel changes nothing.
  setIgnored(key, value, ignored) {
    const entry = String(value ?? '').trim();
    if (!entry) return { changed: [], errors: [{ key, message: 'nothing to ignore' }], values: this.values };
    return this.update({ [key]: withEntry(this.values[key], entry, ignored) });
  }

  isIgnored(key, value) {
    return inList(this.values[key], value);
  }

  // Merges a patch into one channel's overrides, leaving other channels as
  // they were, so two clients cannot overwrite each other.
  setChannel(channel, patch) {
    const name = String(channel ?? '').trim();
    if (!name) {
      return { changed: [], errors: [{ key: 'channelOverrides', message: 'no channel named' }], values: this.values };
    }
    const { values, errors } = coerceChannelPatch(patch);
    if (errors.length) return { changed: [], errors, values: this.values };

    const next = {};
    let merged = false;
    for (const [existing, current] of Object.entries(this.values.channelOverrides || {})) {
      if (channelKey(existing) === channelKey(name)) {
        // Keep the name as first written, whatever case it was typed in today.
        const combined = { ...current, ...values };
        if (Object.keys(combined).length) next[existing] = combined;
        merged = true;
      } else {
        next[existing] = current;
      }
    }
    if (!merged && Object.keys(values).length) next[name] = values;
    return this.update({ channelOverrides: next });
  }

  clearChannel(channel) {
    const next = {};
    for (const [existing, current] of Object.entries(this.values.channelOverrides || {})) {
      if (channelKey(existing) !== channelKey(channel)) next[existing] = current;
    }
    return this.update({ channelOverrides: next });
  }

  // What is actually in force in one channel, overrides included.
  forChannel(channel) {
    return forChannel(this.values, channel);
  }

  save(changed) {
    if (!this.persist) return;
    try {
      // Merged over what is on disk, so keys we do not know about survive.
      const merged = { ...DEFAULTS, ...readConfigFile(this.file) };
      for (const key of changed) merged[key] = this.values[key];
      writeConfigFile(this.file, merged);
    } catch (err) {
      console.warn(`[slacken] could not write ${this.file}: ${err.message}`);
    }
  }

  announce(changed) {
    for (const listener of this.listeners) {
      try {
        listener(changed, this.values);
      } catch {
        // One bad listener must not stop the others hearing about it.
      }
    }
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function same(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  // Compared by value: the per-channel map is a new object on every edit.
  if (isPlainObject(a) && isPlainObject(b)) {
    return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
  }
  return a === b;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sortKeys(value) {
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

// What the page script needs for triage, plus the pause state, so a page
// injected during a pause starts paused.
export function pageConfig(config, { paused = false } = {}) {
  return {
    paused,
    triageMode: config.triageMode,
    triageThreshold: config.triageThreshold,
    condenseEnabled: config.condenseEnabled,
    condenseMinWords: config.condenseMinWords,
    maxChars: config.maxChars,
    minSeverity: config.minSeverity,
    condenseMaxRatio: config.condenseMaxRatio,
    channelOverrides: config.channelOverrides || {},
    rewriteNotifications: config.rewriteNotifications,
    draftCheck: config.draftCheck,
    holdWhilePending: config.holdWhilePending,
    persistVerdicts: config.persistVerdicts,
    selfNames: config.selfNames,
    ignoreSenders: config.ignoreSenders,
    ignoreChannels: config.ignoreChannels,
    requestTimeoutMs: config.requestTimeoutMs,
    verbose: config.verbose,
  };
}
