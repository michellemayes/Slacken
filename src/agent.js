import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { HOME_DIR } from './config.js';

const execFileAsync = promisify(execFile);

export const LABEL = 'com.slacken.agent';
const PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
export const PLIST_PATH = path.join(PLIST_DIR, `${LABEL}.plist`);
export const LOG_PATH = path.join(HOME_DIR, 'agent.log');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'bin', 'slacken.js');

const xml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// launchd gives an agent a bare PATH, so `claude` would not be found. Resolve
// it now and bake its directory into the plist.
async function resolveClaudeDir(claudeBin) {
  if (claudeBin.includes('/')) return path.dirname(path.resolve(claudeBin));
  try {
    const { stdout } = await execFileAsync('/usr/bin/which', [claudeBin]);
    const found = stdout.trim();
    if (found) return path.dirname(found);
  } catch {
    // Fall through to the standard locations below.
  }
  return null;
}

export async function buildPlist(config) {
  const claudeDir = await resolveClaudeDir(config.claudeBin);
  const pathEntries = [
    claudeDir,
    path.dirname(process.execPath),
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
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(LOG_PATH)}</string>
</dict>
</plist>
`;
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
  if (process.platform !== 'darwin') {
    throw new Error('LaunchAgents are a macOS feature; this is not macOS.');
  }
  fs.mkdirSync(PLIST_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(PLIST_PATH, await buildPlist(config));

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

export async function uninstallAgent() {
  const domain = `gui/${process.getuid()}`;
  await launchctl(['bootout', `${domain}/${LABEL}`]);
  await launchctl(['unload', '-w', PLIST_PATH]);
  const existed = fs.existsSync(PLIST_PATH);
  if (existed) fs.unlinkSync(PLIST_PATH);
  return { removed: existed, plist: PLIST_PATH };
}

export async function agentStatus() {
  const installed = fs.existsSync(PLIST_PATH);
  if (!installed) return { installed: false };
  const res = await launchctl(['print', `gui/${process.getuid()}/${LABEL}`]);
  const pid = res.out.match(/\bpid = (\d+)/)?.[1] ?? null;
  const lastExit = res.out.match(/last exit code = (\d+)/)?.[1] ?? null;
  return { installed: true, running: Boolean(pid), pid, lastExit, plist: PLIST_PATH, log: LOG_PATH };
}
