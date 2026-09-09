import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  cacheTtlHours: 168,
  cacheMaxEntries: 5000,
  verbose: false,
};

export function loadConfig() {
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[slacken] ignoring unreadable ${CONFIG_PATH}: ${err.message}`);
    }
  }
  return { ...DEFAULTS, ...onDisk };
}

export function writeDefaultConfig() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) return CONFIG_PATH;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n');
  return CONFIG_PATH;
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
    holdWhilePending: config.holdWhilePending,
    persistVerdicts: config.persistVerdicts,
    selfNames: config.selfNames,
    ignoreSenders: config.ignoreSenders,
    ignoreChannels: config.ignoreChannels,
    requestTimeoutMs: config.requestTimeoutMs,
    verbose: config.verbose,
  };
}
