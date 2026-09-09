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
 * The menu bar item is a small AppKit program, and everything interesting
 * about it lives here rather than there.
 *
 * The helper knows how to draw a menu and how to report a click. What the menu
 * says — the wording, the counts, which action the toggle offers — is decided
 * in Node and handed over as JSON. That keeps the Swift small enough to read
 * in one sitting, and keeps the part that can actually be wrong under test on
 * every platform, not just on a Mac with a screen.
 *
 * Settings work the same way. A settings item carries the value it would set
 * and the endpoint to send it to, so the helper never has to know what a
 * setting means, what a legal value for it is, or which one is in force: it
 * draws the checkmark it is told to draw and posts the body it was given.
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

  // Drift outranks the count: a daemon happily watching three windows and
  // finding nothing in any of them is the failure this line exists to catch,
  // and "Watching 3 Slack windows" is exactly what it looks like otherwise.
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

  // How often you asked for the words back. The one number here that is about
  // whether Slacken is getting it right rather than how much it is doing.
  if (stats.reveals) {
    items.push({ label: `${count(stats.reveals, 'original')} asked for back`, enabled: false });
  }
  // Only worth saying once there is any evidence either way: on a Slack that
  // raises its notifications somewhere we cannot reach, this stays at zero and
  // says so by being absent.
  if (stats.notifications) {
    items.push({ label: `${count(stats.notifications, 'notification')} checked before it arrived`, enabled: false });
  }

  // Only worth a line when there is something to say.
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
    // Off and on again, for the times that is genuinely the fix: a claude that
    // moved after login, an upgrade sitting on disk unread, a daemon that has
    // been up all week. The icon goes away with the daemon and comes back with
    // it, which is the honest thing for it to do.
    { label: 'Restart Slacken', post: '/restart' },
    { label: 'Hide menu bar item', quit: true },
  );

  return {
    icon: paused ? ICON_PAUSED : drifted || attached === 0 ? ICON_IDLE : ICON_RUNNING,
    // Drawn instead of the icon on a Mac too old for SF Symbols.
    fallback: paused ? 'Slacken ‖' : 'Slacken',
    tooltip: `Slacken — ${headline}`,
    // Paused and unattached both mean nothing is being changed right now, and
    // the icon dims to say so without needing the menu opened.
    dimmed: paused || attached === 0,
    items,
  };
}

/* --------------------------------------------------------------- settings */

/*
 * Everything you would otherwise open the config file to change.
 *
 * Only settings that take effect on a running daemon are here. A port or a URL
 * pattern cannot be changed under a live connection, so those stay in the file
 * — and the file is one click away at the bottom for exactly that reason.
 */
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
    // The value to set, not the change to make: two clicks racing each other
    // land on the same answer instead of flipping it twice.
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

  // A value set by hand in the config file is not one of the choices offered,
  // and must not disappear from the menu — or silently lose its checkmark —
  // just because we did not think to offer it.
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
    // Clicking an entry stops it being ignored, which is the only thing you
    // can do to one from here. Adding a channel happens in Slack, where you
    // can see which channel you mean.
    post: '/ignore',
    body: { list: key, value: entry, ignored: false },
  }));

  if (!items.length) items.push({ label: spec.empty, enabled: false });
  else items.push({ separator: true }, { label: 'Click one to stop ignoring it', enabled: false });

  return { label: `${spec.label}: ${entries.length || 'none'}`, submenu: items };
}

/*
 * The channels that have been told to behave differently.
 *
 * A channel gets in here by being given a setting of its own, not by being
 * read: a submenu of every channel you have ever opened would be a list of
 * your Slack, drawn in the menu bar, which is nobody's idea of a settings
 * screen. Each one carries the same choices as the global setting it
 * overrides, so there is nothing new to learn, and a way back to the global
 * answer, because an override you cannot remove is a trap.
 */
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

// Built on demand and cached by the hash of the source, so editing the Swift
// rebuilds it and an unchanged one never pays for a compile.
export async function buildHelper({
  sourcePath = SOURCE_PATH,
  buildDir = BUILD_DIR,
  // Overridable so the caching and cleanup around the compile can be tested
  // on a machine that has no Swift on it.
  compiler = 'swiftc',
} = {}) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const stamp = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
  const binary = path.join(buildDir, `SlackenMenuBar-${stamp}`);
  if (fs.existsSync(binary)) return binary;

  fs.mkdirSync(buildDir, { recursive: true });
  // A partial binary from an interrupted compile must never look like a
  // finished one, so build beside the real name and move it into place.
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

// A helper that keeps falling over should not be restarted forever; two goes
// is enough to ride out a transient failure and few enough to be obvious.
const MAX_RESTARTS = 2;

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
    // stdin is the lifeline: the helper exits the moment this pipe closes, so
    // a daemon that is killed outright cannot leave an icon behind.
    this.child = spawn(binary, ['--port', String(this.config.httpPort)], {
      stdio: ['pipe', 'ignore', 'pipe'],
      // The token goes in the environment rather than in argv, where `ps`
      // would show it to every process on the machine — which is the thing
      // the token exists to keep the control API away from.
      env: { ...process.env, ...(this.token ? { SLACKEN_TOKEN: this.token } : {}) },
    });
    this.child.stderr.on('data', (d) => {
      this.onEvent({ type: 'menubar-error', message: String(d).trim() });
    });
    this.child.on('error', (err) => {
      this.onEvent({ type: 'menubar-error', message: err.message });
    });
    this.child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopped) return;
      // "Hide menu bar item" quits cleanly and means it. A crash does not, and
      // is worth another go or two before we leave the user without an icon.
      const crashed = code !== 0 || signal !== null;
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
    // Closing stdin is the way it is asked to go, and the way it notices a
    // daemon that died without asking. SIGTERM is only a backstop for a helper
    // wedged badly enough not to see the EOF, and is unref'd so waiting for it
    // can never hold the daemon open past its own exit.
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 500);
    timer.unref?.();
  }
}
