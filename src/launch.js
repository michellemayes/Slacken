import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { devtoolsVersion } from './cdp.js';

const execFileAsync = promisify(execFile);

/*
 * Finding, quitting and relaunching Slack.
 *
 * Slack is the same Electron app everywhere, and the flag that opens the
 * debug port is the same flag; what differs is where the binary lives, what
 * the process is called, and how you ask it politely to go away. Those three
 * things are the whole of this file's platform knowledge, and they are kept
 * in one table each rather than spread through the code that uses them.
 */
const CANDIDATES = {
  darwin: () => [
    '/Applications/Slack.app/Contents/MacOS/Slack',
    path.join(os.homedir(), 'Applications', 'Slack.app', 'Contents', 'MacOS', 'Slack'),
  ],
  linux: () => [
    '/usr/bin/slack',
    '/usr/local/bin/slack',
    '/opt/slack/slack',
    // Snap and Flatpak both export a launcher that takes the same flags.
    '/snap/bin/slack',
    '/var/lib/flatpak/exports/bin/com.slack.Slack',
    path.join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'bin', 'com.slack.Slack'),
  ],
  win32: () => {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const root = path.join(local, 'slack');
    const found = [path.join(root, 'slack.exe')];
    try {
      // Squirrel installs put the running copy in app-<version> beside the stub.
      for (const entry of fs.readdirSync(root)) {
        if (entry.startsWith('app-')) found.push(path.join(root, entry, 'slack.exe'));
      }
    } catch {
      // No install here; the stub path above is still worth trying.
    }
    return found;
  },
};

// What `pgrep -x` (or tasklist) will call it.
const PROCESS_NAME = { darwin: 'Slack', linux: 'slack', win32: 'slack.exe' };

export function supportedPlatform() {
  return Boolean(CANDIDATES[process.platform]);
}

export function slackBinary() {
  const candidates = CANDIDATES[process.platform]?.() || [];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not installed here.
    }
  }
  return null;
}

// The app as a person would name it: the bundle on macOS, the binary elsewhere.
export function findSlackApp() {
  const bin = slackBinary();
  if (!bin) return null;
  if (process.platform !== 'darwin') return bin;
  const bundle = bin.replace(/\/Contents\/MacOS\/Slack$/, '');
  return bundle || bin;
}

export function slackLocations() {
  return (CANDIDATES[process.platform]?.() || []).join(', ') || 'nowhere this platform knows about';
}

export async function isDebugPortOpen(port) {
  try {
    await devtoolsVersion(port);
    return true;
  } catch {
    return false;
  }
}

export async function isSlackRunning() {
  const name = PROCESS_NAME[process.platform];
  if (!name) return false;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH']);
      return stdout.toLowerCase().includes(name.toLowerCase());
    }
    const { stdout } = await execFileAsync('/usr/bin/pgrep', ['-x', name]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/*
 * Ask Slack to quit, and wait until it has.
 *
 * Asked rather than killed, everywhere: Slack has unsent drafts in it, and a
 * SIGKILL to save a few seconds would be a poor trade. macOS has a way to ask
 * an app; elsewhere a TERM is the polite signal and Electron treats it as one.
 */
export async function quitSlack({ timeoutMs = 15000 } = {}) {
  const name = PROCESS_NAME[process.platform];
  try {
    if (process.platform === 'darwin') {
      await execFileAsync('/usr/bin/osascript', ['-e', 'tell application "Slack" to quit']);
    } else if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/IM', name]);
    } else {
      await execFileAsync('/usr/bin/pkill', ['-TERM', '-x', name]);
    }
  } catch {
    // Slack may not be scriptable or may already be gone.
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isSlackRunning())) return true;
    await sleep(400);
  }
  return false;
}

export async function launchSlack({ cdpPort, force = false }) {
  if (!supportedPlatform()) {
    throw new Error(`Slacken drives the Slack desktop app; it does not know how to on ${process.platform}.`);
  }

  if (await isDebugPortOpen(cdpPort)) {
    return { started: false, reason: 'already-listening' };
  }

  if (await isSlackRunning()) {
    if (!force) {
      throw new Error(
        `Slack is running without --remote-debugging-port=${cdpPort}. `
        + 'Quit Slack and try again, or re-run with --force to quit it for you.',
      );
    }
    const quit = await quitSlack();
    if (!quit) throw new Error('Slack did not quit in time. Quit it manually and retry.');
  }

  const bin = slackBinary();
  if (!bin) {
    throw new Error(`Could not find Slack in ${slackLocations()}.`);
  }

  const child = spawn(bin, [`--remote-debugging-port=${cdpPort}`], {
    detached: true,
    stdio: 'ignore',
    // Windows has no fork/exec, so a detached child needs a shell-free spawn
    // that does not keep a console window open behind it.
    ...(process.platform === 'win32' ? { windowsHide: true } : {}),
  });
  child.unref();

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await isDebugPortOpen(cdpPort)) return { started: true, app: findSlackApp() };
    await sleep(500);
  }
  throw new Error(
    `Slack started but nothing is listening on 127.0.0.1:${cdpPort}. `
    + 'Slack may have refused the flag, or another Slack instance was already running.',
  );
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
