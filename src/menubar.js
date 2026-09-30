import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { HOME_DIR, CONFIG_PATH } from './config.js';
import { SETTINGS, CHANNEL_KEYS, forChannel } from './settings.js';
import { HISTORY_PATH } from './history.js';
import { LOG_PATH } from './agent.js';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_PATH = path.join(HERE, '..', 'menubar', 'SlackenMenuBar.swift');
export const BUILD_DIR = path.join(HOME_DIR, 'menubar');

/*
 * The menu bar item is a small AppKit helper that draws whatever menu it is
 * given and posts whatever body a clicked item carries. Everything it says is
 * decided here, in Node, where it is testable on any platform.
 */

const ICON_RUNNING = 'text.bubble';
const ICON_PAUSED = 'pause.circle';
const ICON_IDLE = 'exclamationmark.triangle';

export function menuModel(status) {
  const {
    paused = false,
    attached = 0,
    model = '',
    triageMode = 'heuristic',
    uptimeMs = 0,
    dailyBudgetUsd = 0,
    stats = {},
    config = {},
    lastError = null,
    drifted = false,
  } = status || {};

  const seen = (stats.batched || 0) + (stats.cacheHits || 0);
  const rewrote = (stats.softened || 0) + (stats.condensed || 0);

  // Drift outranks the window count, which would otherwise look healthy.
  const headline = paused
    ? 'Paused — showing every message as written'
    : drifted
      ? 'Not finding messages — Slack\'s layout may have changed'
      : attached > 0
        ? `Watching ${count(attached, 'Slack window')}`
        : 'Waiting for a Slack window';

  const items = [
    { label: headline, enabled: false },
    { separator: true },
    paused
      ? { label: 'Resume', post: '/resume', key: 'p' }
      : { label: 'Pause', post: '/pause', key: 'p' },
    { separator: true },
    { label: `${count(rewrote, 'message')} rewritten of ${seen} read`, enabled: false },
    { label: `${stats.softened || 0} softened · ${stats.condensed || 0} condensed`, enabled: false },
    { label: `${count(stats.calls || 0, 'model call')} · ${stats.cacheHits || 0} from cache`, enabled: false },
    { label: `${money(stats.costUsd || 0)} today${dailyBudgetUsd > 0 ? ` of ${money(dailyBudgetUsd)}` : ''}`, enabled: false },
  ];

  // How often an original was asked for back: the one number about whether
  // the rewrites are wanted.
  if (stats.reveals) {
    items.push({ label: `${count(stats.reveals, 'original')} asked for back`, enabled: false });
  }
  // Absent while zero: some Slack builds raise notifications out of reach.
  if (stats.notifications) {
    items.push({ label: `${count(stats.notifications, 'notification')} checked before it arrived`, enabled: false });
  }

  if (lastError?.hint) items.push({ label: lastError.hint, enabled: false });
  else if (stats.errors) items.push({ label: `${count(stats.errors, 'error')} — see the log`, enabled: false });

  items.push(
    { separator: true },
    { label: `${model || 'no model set'} · triage ${triageMode}`, enabled: false },
    { label: `Running for ${duration(uptimeMs)}`, enabled: false },
    { separator: true },
    { label: 'Settings', submenu: settingsMenu(config) },
    { label: 'Recent changes…', open: HISTORY_PATH },
    { label: 'Open log…', open: LOG_PATH },
    { separator: true },
    // Picks up an upgrade on disk or a claude that moved since login.
    { label: 'Restart Slacken', post: '/restart' },
    { label: 'Hide menu bar item', quit: true },
  );

  return {
    icon: paused ? ICON_PAUSED : drifted || attached === 0 ? ICON_IDLE : ICON_RUNNING,
    // Drawn instead of the icon on a Mac too old for SF Symbols.
    fallback: paused ? 'Slacken ‖' : 'Slacken',
    tooltip: `Slacken — ${headline}`,
    // Dimmed whenever nothing is being changed.
    dimmed: paused || attached === 0,
    items,
  };
}

/* --------------------------------------------------------------- settings */

// Every setting that applies to a running daemon; the rest are one click away
// in the config file.
export function settingsMenu(config) {
  return [
    { label: 'What gets rewritten', enabled: false },
    choice('triageMode', config),
    choice('triageThreshold', config),
    choice('minSeverity', config),
    { separator: true },
    toggle('condenseEnabled', config),
    choice('condenseMinWords', config),
    { separator: true },
    { label: 'Where it is left alone', enabled: false },
    list('ignoreChannels', config),
    list('ignoreSenders', config),
    channels(config),
    { separator: true },
    { label: 'What it costs', enabled: false },
    choice('model', config),
    choice('dailyBudgetUsd', config),
    { separator: true },
    toggle('holdWhilePending', config),
    toggle('persistVerdicts', config),
    toggle('rewriteNotifications', config),
    toggle('draftCheck', config),
    toggle('historyEnabled', config),
    toggle('verbose', config),
    { separator: true },
    { label: 'Everything else…', open: CONFIG_PATH },
  ];
}

function toggle(key, config) {
  const on = Boolean(config[key]);
  return {
    label: SETTINGS[key].label,
    checked: on,
    post: '/config',
    // The value to set rather than a flip, so two racing clicks agree.
    body: { [key]: !on },
  };
}

function choice(key, config) {
  const spec = SETTINGS[key];
  const current = config[key];
  const known = spec.choices.find((c) => c.value === current);

  const items = spec.choices.map((c) => ({
    label: c.label,
    checked: c.value === current,
    post: '/config',
    body: { [key]: c.value },
  }));

  // A hand-set value that is not one of the choices is still shown.
  if (!known && current !== undefined) {
    items.push({ separator: true }, { label: `Set to ${format(current)} in the config file`, enabled: false });
  }

  return { label: `${spec.label}: ${known ? known.short : format(current)}`, submenu: items };
}

function list(key, config) {
  const spec = SETTINGS[key];
  const entries = Array.isArray(config[key]) ? config[key] : [];

  const items = entries.map((entry) => ({
    label: entry,
    checked: true,
    // Clicking an entry un-ignores it. Adding one happens from inside Slack.
    post: '/ignore',
    body: { list: key, value: entry, ignored: false },
  }));

  if (!items.length) items.push({ label: spec.empty, enabled: false });
  else items.push({ separator: true }, { label: 'Click one to stop ignoring it', enabled: false });

  return { label: `${spec.label}: ${entries.length || 'none'}`, submenu: items };
}

// Channels with settings of their own, each with the same choices as the
// global setting and a way back to it.
export function channels(config) {
  const overrides = config.channelOverrides || {};
  const names = Object.keys(overrides);

  const items = names.map((name) => {
    const effective = forChannel(config, name);
    const own = overrides[name] || {};
    return {
      label: `${name} — ${summarise(own)}`,
      submenu: [
        ...CHANNEL_KEYS
          .filter((key) => SETTINGS[key]?.choices)
          .map((key) => channelChoice(name, key, effective, own)),
        { separator: true },
        {
          label: 'Same as everywhere else',
          post: '/channel',
          body: { channel: name, clear: true },
        },
      ],
    };
  });

  if (!items.length) {
    items.push(
      { label: SETTINGS.channelOverrides.empty, enabled: false },
      { separator: true },
      { label: 'slacken channel #name minSeverity 3', enabled: false },
    );
  }

  return { label: `Per-channel settings: ${names.length || 'none'}`, submenu: items };
}

function channelChoice(channel, key, effective, own) {
  const spec = SETTINGS[key];
  const current = effective[key];
  const known = spec.choices.find((c) => c.value === current);
  return {
    label: `${spec.label}: ${known ? known.short : format(current)}${own[key] === undefined ? ' (global)' : ''}`,
    submenu: spec.choices.map((c) => ({
      label: c.label,
      checked: c.value === current,
      post: '/channel',
      body: { channel, settings: { [key]: c.value } },
    })),
  };
}

function summarise(own) {
  const keys = Object.keys(own);
  if (!keys.length) return 'nothing of its own';
  return keys.map((key) => {
    const spec = SETTINGS[key];
    const choice = spec?.choices?.find((c) => c.value === own[key]);
    return `${spec?.label || key}: ${choice ? choice.short : format(own[key])}`;
  }).join(', ');
}

function format(value) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value ?? 'unset');
}

export function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function money(usd) {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd > 0 && usd < 0.0001) return '<$0.0001';
  return `$${usd.toFixed(4)}`;
}

function duration(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return count(mins, 'minute');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return count(hours, 'hour');
  return count(Math.floor(hours / 24), 'day');
}

/* ------------------------------------------------------------------ build */

// Built on demand and cached by a hash of the source.
export async function buildHelper({
  sourcePath = SOURCE_PATH,
  buildDir = BUILD_DIR,
  // Overridable for tests on machines without Swift.
  compiler = 'swiftc',
} = {}) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const stamp = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
  const binary = path.join(buildDir, `SlackenMenuBar-${stamp}`);
  if (fs.existsSync(binary)) return binary;

  fs.mkdirSync(buildDir, { recursive: true });
  // Built beside the real name, so an interrupted compile never looks finished.
  const temp = `${binary}.building`;
  try {
    await execFileAsync(compiler, ['-O', '-o', temp, sourcePath], { timeout: 180_000 });
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw new Error(swiftcMessage(err));
  }
  fs.renameSync(temp, binary);

  // Drop the builds left over from earlier versions of the source.
  for (const entry of fs.readdirSync(buildDir)) {
    if (entry.startsWith('SlackenMenuBar-') && entry !== path.basename(binary)) {
      fs.rmSync(path.join(buildDir, entry), { force: true });
    }
  }
  return binary;
}

function swiftcMessage(err) {
  if (err.code === 'ENOENT') {
    return 'swiftc is not installed. Run: xcode-select --install';
  }
  const detail = String(err.stderr || err.message).trim().split('\n').slice(-3).join(' ');
  return `swiftc failed: ${detail.slice(0, 300)}`;
}

/* ------------------------------------------------------------------- host */

// Crash restarts allowed in a row. A helper that stays up for STABLE_MS
// earns its allowance back, so rare crashes over weeks never exhaust it.
const MAX_RESTARTS = 2;
const STABLE_MS = 10 * 60_000;

export class MenuBar {
  constructor({ config, onEvent, token = null, restartDelayMs = 2000 }) {
    this.config = config;
    this.token = token;
    this.onEvent = onEvent || (() => {});
    this.restartDelayMs = restartDelayMs;
    this.child = null;
    this.binary = null;
    this.restarts = 0;
    this.stopped = false;
  }

  async start() {
    if (process.platform !== 'darwin') return false;
    let binary;
    try {
      binary = await buildHelper();
    } catch (err) {
      this.onEvent({ type: 'menubar-unavailable', message: err.message });
      return false;
    }
    this.binary = binary;
    this.spawn(binary);
    return true;
  }

  spawn(binary) {
    if (this.stopped) return;
    // The helper exits when its stdin closes, so a daemon killed outright
    // cannot leave an icon behind.
    const child = spawn(binary, ['--port', String(this.config.httpPort)], {
      stdio: ['pipe', 'ignore', 'pipe'],
      // In the environment rather than argv, where `ps` would show it.
      env: { ...process.env, ...(this.token ? { SLACKEN_TOKEN: this.token } : {}) },
    });
    this.child = child;
    const startedAt = Date.now();
    // Writing to or closing the pipe of a helper that has already died raises
    // EPIPE here; unhandled, that would take the daemon down with it.
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => {
      this.onEvent({ type: 'menubar-error', message: String(d).trim() });
    });
    child.on('error', (err) => {
      this.onEvent({ type: 'menubar-error', message: err.message });
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      // "Hide menu bar item" exits cleanly and is respected; a crash is retried.
      const crashed = code !== 0 || signal !== null;
      if (Date.now() - startedAt >= STABLE_MS) this.restarts = 0;
      if (crashed && this.restarts < MAX_RESTARTS) {
        this.restarts += 1;
        this.onEvent({ type: 'menubar-error', message: `helper exited (${signal || code}), restarting` });
        const timer = setTimeout(() => this.spawn(this.binary), this.restartDelayMs);
        timer.unref?.();
        return;
      }
      this.onEvent({ type: 'menubar-exited', crashed });
    });
  }

  stop() {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    this.child = null;
    // Closing stdin asks it to go; SIGTERM is the backstop for a wedged one.
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 500);
    timer.unref?.();
  }
}
