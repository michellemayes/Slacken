import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { HOME_DIR } from './config.js';
import { resolveClaudeBin } from './claude-bin.js';
import { writeFileAtomic } from './fsutil.js';

const execFileAsync = promisify(execFile);

export const LABEL = 'com.slacken.agent';
const PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
export const PLIST_PATH = path.join(PLIST_DIR, `${LABEL}.plist`);
export const LOG_PATH = path.join(HOME_DIR, 'agent.log');

// systemd's equivalent, for the same job on Linux: start at login, restart on
// a crash, and leave a deliberate stop stopped.
export const UNIT_NAME = 'slacken.service';
const UNIT_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'systemd',
  'user',
);
export const UNIT_PATH = path.join(UNIT_DIR, UNIT_NAME);

// Where the agent lives on this platform, whatever kind of thing it is.
export function agentPath() {
  if (process.platform === 'darwin') return PLIST_PATH;
  if (process.platform === 'linux') return UNIT_PATH;
  return null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'bin', 'slacken.js');

const xml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// A double-quoted systemd word, so a path with a space in it stays one
// argument. `%` and `$` would otherwise be expanded by systemd itself.
const unitWord = (s) => `"${String(s)
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/%/g, '%%')
  .replace(/\$/g, '$$$$')}"`;

// launchd gives an agent a bare PATH, so `claude` would not be found. Resolve
// it now — through PATH, the usual install locations and the login shell, the
// same way the daemon itself does — and bake its directory into the plist.
async function resolveClaudeDir(claudeBin) {
  const { path: file } = await resolveClaudeBin(claudeBin);
  return file ? path.dirname(file) : null;
}

export async function buildPlist(config) {
  const claudeDir = await resolveClaudeDir(config.claudeBin);
  const pathEntries = [
    claudeDir,
    path.dirname(process.execPath),
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter(Boolean);
  const uniquePath = [...new Set(pathEntries)].join(':');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.resolve(ENTRY))}</string>
    <string>start</string>
    <string>--force</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(uniquePath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <!-- Not Background: launchd throttles those, and messages are held on
       screen while this job works. -->
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(LOG_PATH)}</string>
</dict>
</plist>
`;
}

// A user unit, since it drives the Slack you are logged in to. PATH is spelled
// out for the same reason as in the plist.
export async function buildUnit(config) {
  const claudeDir = await resolveClaudeDir(config.claudeBin);
  const pathEntries = [
    claudeDir,
    path.dirname(process.execPath),
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter(Boolean);
  const uniquePath = [...new Set(pathEntries)].join(':');

  return `[Unit]
Description=Slacken — a calmer reading layer for Slack
Documentation=https://github.com/michellemayes/Slacken
After=graphical-session.target

[Service]
Type=simple
Environment=${unitWord(`PATH=${uniquePath}`)}
ExecStart=${unitWord(process.execPath)} ${unitWord(path.resolve(ENTRY))} start --force
# on-failure, not always: a deliberate \`slacken stop\` stays stopped.
Restart=on-failure
RestartSec=3
StandardOutput=append:${LOG_PATH}
StandardError=append:${LOG_PATH}

[Install]
WantedBy=default.target
`;
}

// The plist or unit as it would be written today, with today's claude in it.
export async function rewriteAgentFile(config) {
  if (process.platform === 'linux') {
    writeFileAtomic(UNIT_PATH, await buildUnit(config));
    return UNIT_PATH;
  }
  writeFileAtomic(PLIST_PATH, await buildPlist(config));
  return PLIST_PATH;
}

async function systemctl(args) {
  try {
    const { stdout, stderr } = await execFileAsync('systemctl', ['--user', ...args]);
    return { ok: true, out: (stdout + stderr).trim() };
  } catch (err) {
    return { ok: false, out: ((err.stdout || '') + (err.stderr || '') + err.message).trim() };
  }
}

export function agentInstalled() {
  const file = agentPath();
  return Boolean(file) && fs.existsSync(file);
}

async function launchctl(args) {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/launchctl', args);
    return { ok: true, out: (stdout + stderr).trim() };
  } catch (err) {
    return { ok: false, out: (err.stdout || '') + (err.stderr || '') + err.message };
  }
}

export async function installAgent(config) {
  if (process.platform === 'linux') return installUnit(config);
  if (process.platform !== 'darwin') {
    throw new Error(`Slacken cannot install a login agent on ${process.platform}; `
      + 'run `slacken start` from a terminal, or from your own startup scripts.');
  }
  fs.mkdirSync(HOME_DIR, { recursive: true });
  writeFileAtomic(PLIST_PATH, await buildPlist(config));

  const domain = `gui/${process.getuid()}`;
  // Replace any previous copy before loading the new one.
  await launchctl(['bootout', `${domain}/${LABEL}`]);
  let res = await launchctl(['bootstrap', domain, PLIST_PATH]);
  if (!res.ok) {
    // Older macOS, or a domain that refuses bootstrap.
    res = await launchctl(['load', '-w', PLIST_PATH]);
  }
  if (!res.ok) throw new Error(`launchctl refused the agent: ${res.out.trim().slice(0, 300)}`);
  return { plist: PLIST_PATH, log: LOG_PATH };
}

async function installUnit(config) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  writeFileAtomic(UNIT_PATH, await buildUnit(config));

  await systemctl(['daemon-reload']);
  const res = await systemctl(['enable', '--now', UNIT_NAME]);
  if (!res.ok) throw new Error(`systemd refused the unit: ${res.out.slice(0, 300)}`);
  return { plist: UNIT_PATH, log: LOG_PATH };
}

export async function uninstallAgent() {
  if (process.platform === 'linux') {
    await systemctl(['disable', '--now', UNIT_NAME]);
    const existed = fs.existsSync(UNIT_PATH);
    if (existed) fs.unlinkSync(UNIT_PATH);
    await systemctl(['daemon-reload']);
    return { removed: existed, plist: UNIT_PATH };
  }
  const domain = `gui/${process.getuid()}`;
  await launchctl(['bootout', `${domain}/${LABEL}`]);
  await launchctl(['unload', '-w', PLIST_PATH]);
  const existed = fs.existsSync(PLIST_PATH);
  if (existed) fs.unlinkSync(PLIST_PATH);
  return { removed: existed, plist: PLIST_PATH };
}

/*
 * Bring the agent's daemon back without logging out. The plist or unit is
 * rewritten first, because the agent's PATH is baked in at install time: a
 * claude that has moved since would fail every call until it is.
 */
export async function restartAgent(config = null) {
  if (!agentInstalled()) throw new Error("no login agent is installed (run 'slacken agent install')");
  if (config) await rewriteAgentFile(config);
  if (process.platform === 'linux') {
    if (config) await systemctl(['daemon-reload']);
    const res = await systemctl(['restart', UNIT_NAME]);
    if (!res.ok) throw new Error(`systemd would not restart the unit: ${res.out.slice(0, 300)}`);
    return { plist: UNIT_PATH, log: LOG_PATH };
  }
  const domain = `gui/${process.getuid()}`;
  let res = await launchctl(['kickstart', '-k', `${domain}/${LABEL}`]);
  if (!res.ok) {
    // Older macOS has no kickstart; load it from scratch instead.
    await launchctl(['bootout', `${domain}/${LABEL}`]);
    res = await launchctl(['bootstrap', domain, PLIST_PATH]);
  }
  if (!res.ok) throw new Error(`launchctl would not restart the agent: ${res.out.trim().slice(0, 300)}`);
  return { plist: PLIST_PATH, log: LOG_PATH };
}

export async function agentStatus() {
  if (process.platform === 'linux') {
    const installed = fs.existsSync(UNIT_PATH);
    if (!installed) return { installed: false };
    const state = await systemctl(['show', UNIT_NAME, '--property=MainPID', '--property=ExecMainStatus']);
    const pid = state.out.match(/MainPID=(\d+)/)?.[1];
    const exit = state.out.match(/ExecMainStatus=(\d+)/)?.[1];
    return {
      installed: true,
      running: Boolean(pid) && pid !== '0',
      pid: pid === '0' ? null : pid,
      lastExit: exit && exit !== '0' ? exit : null,
      plist: UNIT_PATH,
      log: LOG_PATH,
    };
  }
  const installed = fs.existsSync(PLIST_PATH);
  if (!installed) return { installed: false };
  const res = await launchctl(['print', `gui/${process.getuid()}/${LABEL}`]);
  const pid = res.out.match(/\bpid = (\d+)/)?.[1] ?? null;
  const lastExit = res.out.match(/last exit code = (\d+)/)?.[1] ?? null;
  return { installed: true, running: Boolean(pid), pid, lastExit, plist: PLIST_PATH, log: LOG_PATH };
}

/*
 * launchd and systemd append to the agent log forever. Called at startup:
 * past maxBytes, keep the last keepBytes (from a whole line) and drop the
 * rest. Truncated in place, because the supervisor holds the file open in
 * append mode and would keep writing to a renamed one.
 */
export function trimLog(file = LOG_PATH, { maxBytes = 5 * 1024 * 1024, keepBytes = 1024 * 1024 } = {}) {
  let fd;
  try {
    const { size } = fs.statSync(file);
    if (size <= maxBytes) return false;
    fd = fs.openSync(file, 'r+');
    const tail = Buffer.alloc(Math.min(keepBytes, size));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const start = tail.indexOf(10) + 1;
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, tail, start, tail.length - start, 0);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
