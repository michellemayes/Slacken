import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { HOME_DIR, CONFIG_PATH } from './config.js';
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
  } = status || {};

  const seen = (stats.batched || 0) + (stats.cacheHits || 0);
  const rewrote = (stats.softened || 0) + (stats.condensed || 0);

  const headline = paused
    ? 'Paused — showing every message as written'
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

  // Only worth a line when there is something to say.
  if (stats.errors) items.push({ label: `${count(stats.errors, 'error')} — see the log`, enabled: false });

  items.push(
    { separator: true },
    { label: `${model || 'no model set'} · triage ${triageMode}`, enabled: false },
    { label: `Running for ${duration(uptimeMs)}`, enabled: false },
    { separator: true },
    { label: 'Open config…', open: CONFIG_PATH },
    { label: 'Open log…', open: LOG_PATH },
    { separator: true },
    { label: 'Hide menu bar item', quit: true },
  );

  return {
    icon: paused ? ICON_PAUSED : attached > 0 ? ICON_RUNNING : ICON_IDLE,
    // Drawn instead of the icon on a Mac too old for SF Symbols.
    fallback: paused ? 'Slacken ‖' : 'Slacken',
    tooltip: `Slacken — ${headline}`,
    // Paused and unattached both mean nothing is being changed right now, and
    // the icon dims to say so without needing the menu opened.
    dimmed: paused || attached === 0,
    items,
  };
}

function count(n, noun) {
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
  constructor({ config, onEvent, restartDelayMs = 2000 }) {
    this.config = config;
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
