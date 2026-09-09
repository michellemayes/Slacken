import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { devtoolsVersion } from './cdp.js';

const execFileAsync = promisify(execFile);

const CANDIDATES = [
  '/Applications/Slack.app',
  path.join(os.homedir(), 'Applications', 'Slack.app'),
];

export function findSlackApp() {
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(path.join(candidate, 'Contents', 'MacOS', 'Slack'))) return candidate;
  }
  return null;
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
  try {
    const { stdout } = await execFileAsync('/usr/bin/pgrep', ['-x', 'Slack']);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function quitSlack({ timeoutMs = 15000 } = {}) {
  try {
    await execFileAsync('/usr/bin/osascript', ['-e', 'tell application "Slack" to quit']);
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
  if (process.platform !== 'darwin') {
    throw new Error('SlackCensor launches the macOS Slack desktop app; this is not macOS.');
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

  const app = findSlackApp();
  if (!app) {
    throw new Error(`Could not find Slack.app in ${CANDIDATES.join(' or ')}.`);
  }

  const bin = path.join(app, 'Contents', 'MacOS', 'Slack');
  const child = spawn(bin, [`--remote-debugging-port=${cdpPort}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await isDebugPortOpen(cdpPort)) return { started: true, app };
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
