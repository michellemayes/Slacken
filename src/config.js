import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coerceAll, coerceChannelPatch, inList, withEntry, channelKey, forChannel } from './settings.js';

export const HOME_DIR = path.join(os.homedir(), '.slacken');
export const CONFIG_PATH = path.join(HOME_DIR, 'config.json');

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
  maxConcurrency: 2,
  // Guarantees well-formed JSON back, at a small token cost.
  useJsonSchema: true,
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

  // Rewrite the body of a Slack notification before it is shown, rather than
  // catching the message only once you are looking at the channel. Depends on
  // Slack raising notifications from its renderer; the menu says how many have
  // actually been seen, so you can tell whether it is doing anything.
  rewriteNotifications: true,
  // Look at what you are about to send, and offer a flatter wording if it
  // reads sharp. Off by default: Slacken's whole promise is that it does not
  // touch what you write, and this is the one thing that comes near it. It
  // never edits or sends anything on its own even when it is on.
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
  return { ...DEFAULTS, ...readConfigFile(file) };
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
  if (fs.existsSync(CONFIG_PATH)) return CONFIG_PATH;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n');
  return CONFIG_PATH;
}

/*
 * The running configuration, and the only thing allowed to change it.
 *
 * Settings are adjusted from the menu bar, from a button inside Slack and from
 * the terminal, which means three places could each hold their own idea of
 * what Slacken is currently doing. They do not: they all go through one store,
 * which validates the change, writes it to the config file so it survives a
 * restart, and tells everyone holding the config that it moved.
 *
 * The values object is mutated in place rather than replaced. The moderator,
 * the attacher and the HTTP server were handed that object at startup and read
 * fields off it as they work, so a change lands on a message being judged
 * right now, without any of them subscribing to anything.
 */
export class ConfigStore {
  constructor({ file = CONFIG_PATH, values = null, persist = true } = {}) {
    this.file = file;
    this.persist = persist;
    this.values = values || loadConfig(file);
    this.listeners = new Set();
  }

  // Returns the keys that actually moved, plus anything it refused and why.
  // A patch is validated whole before any of it is applied: a menu click that
  // carries one bad value must not leave the other half of it applied.
  update(patch) {
    const { values, errors } = coerceAll(patch);
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

  // Adding the channel you are reading to the ignore list is the one change
  // that arrives from inside Slack, and the one that has to be idempotent:
  // clicking an already-ignoring button twice should not add it twice.
  setIgnored(key, value, ignored) {
    const entry = String(value ?? '').trim();
    if (!entry) return { changed: [], errors: [{ key, message: 'nothing to ignore' }], values: this.values };
    return this.update({ [key]: withEntry(this.values[key], entry, ignored) });
  }

  isIgnored(key, value) {
    return inList(this.values[key], value);
  }

  /*
   * Per-channel settings, edited one key at a time.
   *
   * Handed the whole map, two clients would overwrite each other's channels
   * the way they would overwrite each other's ignore list, so this merges the
   * patch into the channel that is named and leaves the rest of the map
   * exactly as it was. A patch that empties a channel removes it: an entry
   * that overrides nothing is not a setting, it is a name in a file.
   */
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
        // Keep the name it was first written under, so a channel does not
        // change case in the file because of how it was typed today.
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
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Merged over what is on disk, so keys we do not know about — and keys
      // an older version wrote — survive being edited from the menu.
      const merged = { ...DEFAULTS, ...readConfigFile(this.file) };
      for (const key of changed) merged[key] = this.values[key];
      // Written beside the real file and moved into place: a daemon killed
      // mid-write must not leave a half-written config to be read at login.
      const temp = `${this.file}.writing`;
      fs.writeFileSync(temp, JSON.stringify(merged, null, 2) + '\n');
      fs.renameSync(temp, this.file);
    } catch (err) {
      console.warn(`[slacken] could not write ${this.file}: ${err.message}`);
    }
  }

  announce(changed) {
    for (const listener of this.listeners) {
      try {
        listener(changed, this.values);
      } catch {
        // A listener that throws must not stop the others being told.
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
  // The per-channel map arrives as a whole new object every time it is
  // touched, so identity would report a change on every click.
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

// Only the fields the injected page script needs to make triage decisions,
// plus whether Slacken is paused right now — a page injected during a pause
// must not start rewriting before the daemon gets a chance to tell it.
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
