/*
 * Finding `claude`.
 *
 * A daemon started by launchd, systemd or Finder gets a bare PATH that none
 * of claude's installers use. So look on the PATH, then where the installers
 * put it, then ask the login shell (where nvm, asdf or a profile set PATH).
 *
 * Whatever is found is noted in ~/.slacken/claude.json, so a terminal that
 * can find claude tells a daemon that cannot, without restarting either.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileAtomic } from './fsutil.js';

const execFileAsync = promisify(execFile);

// How long a miss is trusted before looking again, so failing calls do not
// start a login shell each time but installing claude needs no restart.
const MISS_TTL_MS = 60_000;

const memo = new Map();

// Derived from `home` so a test with its own home gets its own note.
export const noteFile = (home = os.homedir()) => path.join(home, '.slacken', 'claude.json');

function readNote(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// When the note was last written, or 0; lets a cached miss notice a new note.
function noteStamp(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function remembered(bin, file) {
  const note = readNote(file);
  if (!note || note.bin !== bin || typeof note.path !== 'string') return null;
  // Verified, since claude may have moved since the note was written.
  return isRunnable(note.path) ? note.path : null;
}

// Written only when the answer changes: the file's mtime is what tells
// another process its cached miss is worth re-checking.
function remember(bin, found, file) {
  try {
    const note = readNote(file);
    if (note && note.bin === bin && note.path === found) return;
    writeFileAtomic(file, JSON.stringify({ bin, path: found, at: Date.now() }) + '\n');
  } catch {
    // A read-only home; the next process does its own looking.
  }
}

export function isRunnable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Where the installers put it: the native installer, the older local one,
// npm-global with and without Homebrew, then other package managers.
export function knownLocations(bin = 'claude', home = os.homedir()) {
  return [
    path.join(home, '.local', 'bin', bin),
    path.join(home, '.claude', 'local', bin),
    '/opt/homebrew/bin/' + bin,
    '/usr/local/bin/' + bin,
    path.join(home, '.bun', 'bin', bin),
    path.join(home, '.volta', 'bin', bin),
    '/usr/bin/' + bin,
  ];
}

function onSearchPath(bin, env) {
  const entries = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of entries) {
    const file = path.join(dir, bin);
    if (isRunnable(file)) return file;
  }
  return null;
}

// Single-quoted for the shell, so claudeBin is only ever a name to look up.
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// Last resort: ask the login shell. `-lc`, not `-lic`, since an interactive
// shell can block on a prompt. Profiles can print, so take the last line.
async function fromLoginShell(bin, env) {
  const shell = env.SHELL;
  if (process.platform === 'win32' || !shell || !isRunnable(shell)) return null;
  try {
    const { stdout } = await execFileAsync(shell, ['-lc', `command -v ${shellQuote(bin)}`], {
      timeout: 5000,
      env,
    });
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].startsWith('/') && isRunnable(lines[i])) return lines[i];
    }
  } catch {
    // No shell, a profile that fails, or a name it does not know either.
  }
  return null;
}

// Returns { path, source, searched }. `path` is null when claude is nowhere
// this knows to look; `searched` says where it looked.
export async function resolveClaudeBin(bin = 'claude', options = {}) {
  const {
    home = os.homedir(),
    env = process.env,
    useCache = true,
    now = Date.now(),
    note = noteFile(home),
  } = options;

  const cached = useCache ? memo.get(bin) : null;
  if (cached && cached.note === note) {
    // A hit is kept. A miss expires after MISS_TTL_MS, or as soon as another
    // process writes a newer note.
    if (cached.result.path) return cached.result;
    if (now - cached.at < MISS_TTL_MS && noteStamp(note) <= cached.at) return cached.result;
  }

  const result = await lookUp(bin, { home, env, note });
  if (useCache) memo.set(bin, { at: now, note, result });
  return result;
}

async function lookUp(bin, { home, env, note }) {
  // A configured path is used as given, never swapped for another claude.
  if (bin.includes('/') || bin.includes('\\')) {
    const file = path.resolve(bin);
    return { path: file, source: 'configured', searched: [file] };
  }

  const searched = [];

  const found = (file, source) => {
    remember(bin, file, note);
    return { path: file, source, searched };
  };

  const onPath = onSearchPath(bin, env);
  searched.push('PATH');
  if (onPath) return found(onPath, 'path');

  for (const file of knownLocations(bin, home)) {
    searched.push(file);
    if (isRunnable(file)) return found(file, 'known-location');
  }

  // Before the login shell, which is slower to ask.
  const noted = remembered(bin, note);
  searched.push(note);
  if (noted) return { path: noted, source: 'remembered', searched };

  const fromShell = await fromLoginShell(bin, env);
  if (env.SHELL) searched.push(`${env.SHELL} -lc 'command -v ${bin}'`);
  if (fromShell) return found(fromShell, 'login-shell');

  return { path: null, source: null, searched };
}

// `classifyError` reads "not found" out of this to name the failure.
export function notFoundMessage(bin, searched = []) {
  const where = searched.length ? ` Looked in: ${searched.join(', ')}.` : '';
  return `could not run ${bin}: not found on PATH or where the installers put it.${where}`
    + ' If it lives somewhere else, set "claudeBin" to its full path'
    + ' in ~/.slacken/config.json.';
}

// The PATH a spawned claude gets. An npm-installed claude runs through
// `#!/usr/bin/env node`, so node must be findable too. Appended rather than
// prepended, so an existing PATH still decides which node is used.
export function spawnPath(binPath, env = process.env) {
  const existing = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const extra = [
    binPath ? path.dirname(binPath) : null,
    path.dirname(process.execPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter(Boolean);
  return [...new Set([...existing, ...extra])].join(path.delimiter);
}

// For tests, and for anything that changes claudeBin while running.
export function forgetResolved() {
  memo.clear();
}
