import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = path.join(os.homedir(), '.slackcensor');
export const CONFIG_PATH = path.join(HOME_DIR, 'config.json');

export const DEFAULTS = {
  // Chrome DevTools Protocol port that Slack.app is launched with.
  cdpPort: 9222,
  // Which DevTools page targets to inject into. Widen this if your workspace
  // lives on a custom domain.
  targetUrlPattern: '^https://([a-z0-9-]+\\.)*slack\\.com/',
  // Local HTTP API, used by `slackcensor test` and health checks. Loopback only.
  httpPort: 8787,

  // Which model does the rewriting. Haiku keeps it cheap and fast; messages
  // arrive faster than you read them.
  model: 'claude-haiku-4-5-20251001',
  claudeBin: 'claude',
  claudeArgs: [],
  requestTimeoutMs: 20000,
  maxConcurrency: 2,

  // "heuristic" only asks Claude about messages that look heated (cheap).
  // "always" sends every incoming message.
  triageMode: 'heuristic',
  // Minimum in-page heuristic score before a message is worth a model call.
  triageThreshold: 2,
  // Minimum severity (0-3) the model must report before we replace anything.
  minSeverity: 2,
  // Messages longer than this are left alone.
  maxChars: 4000,

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
      console.warn(`[slackcensor] ignoring unreadable ${CONFIG_PATH}: ${err.message}`);
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

// Only the fields the injected page script needs to make triage decisions.
export function pageConfig(config) {
  return {
    triageMode: config.triageMode,
    triageThreshold: config.triageThreshold,
    maxChars: config.maxChars,
    selfNames: config.selfNames,
    ignoreSenders: config.ignoreSenders,
    ignoreChannels: config.ignoreChannels,
    requestTimeoutMs: config.requestTimeoutMs,
    verbose: config.verbose,
  };
}
