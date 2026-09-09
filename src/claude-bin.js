/*
 * Finding `claude`.
 *
 * The daemon spawns `claude` as a child process, and a child process is given
 * the PATH of whoever started the parent — which, when the parent was started
 * by launchd, by systemd or by double-clicking something in Finder, is a bare
 * `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. The claude CLI is not
 * installed there by any of its installers. So the daemon you launched from a
 * terminal works and the same daemon at login says "claude is not on the PATH
 * this is running with", which is true and useless: claude is installed, it is
 * two directories away, and the person reading that line did nothing wrong.
 *
 * So do not ask the PATH and stop. Ask the PATH, then the handful of places
 * the installers actually use, then the login shell — which is where a PATH
 * set by nvm, asdf, mise or a hand-edited profile lives, and the only way to
 * find that out is to start one.
 *
 * And then write down the answer. A claude somewhere none of that reaches —
 * inside another app's bundle, say — is found by the terminal you installed
 * from and by nothing else, which is how `slacken doctor` comes to report a
 * claude it can run while the daemon two feet away cannot find one. The note
 * in ~/.slacken/claude.json is how the process that knows tells the one that
 * does not, without either of them being restarted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Long enough that a run of failing calls does not start a login shell each
// time, short enough that installing claude fixes this without a restart.
const MISS_TTL_MS = 60_000;

const memo = new Map();

// Where one Slacken leaves the answer for the next one. Derived from `home`
// rather than imported so that a test with its own home gets its own note.
export const noteFile = (home = os.homedir()) => path.join(home, '.slacken', 'claude.json');

function readNote(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// When the note was last written, or 0. One stat, so a cached miss can notice
// that someone has since worked out where claude is.
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
  // Verified, not trusted: claude may have been moved or uninstalled since,
  // and a note pointing at nothing is worse than no note at all.
  return isRunnable(note.path) ? note.path : null;
}

/*
 * Leave the answer where a daemon with no PATH can read it.
 *
 * Only when it changes: the file's mtime is what tells another process its
 * cached "not found" is worth re-checking, so rewriting the same answer every
 * lookup would make that signal mean nothing.
 */
function remember(bin, found, file) {
  try {
    const note = readNote(file);
    if (note && note.bin === bin && note.path === found) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ bin, path: found, at: Date.now() }) + '\n');
  } catch {
    // A read-only home, or no home at all. Everything still works; the next
    // process just has to do its own looking.
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

/*
 * Where the installers put it, newest first.
 *
 * `~/.local/bin` is the native installer, `~/.claude/local` the older local
 * one, the two `bin`s are npm-global under Homebrew and not, and the rest are
 * the alternative package managers people install a CLI with.
 */
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

// Single-quote for `sh -c`, so a claudeBin with a space or a quote in it is a
// filename to look up and not something the shell reads.
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/*
 * The last resort: ask the shell you actually log in to.
 *
 * `-lc` and not `-lic`: a login shell sources the profile, which is where a
 * version manager puts its PATH, while an interactive one can block on a
 * prompt and would leave this hanging. Whatever the profile prints goes to
 * stdout too, so the answer is the last usable line rather than the first.
 */
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

/*
 * Where `claude` is, and how that was worked out.
 *
 * Returns { path, source, searched }; `path` is null when it is genuinely not
 * installed anywhere this knows to look, and `searched` is what to tell
 * someone about that, because "not found" without "I looked here" is a
 * message you cannot act on.
 */
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
    // A hit stays a hit. A miss is only reused while it is still plausibly
    // true: it expires on its own, and it expires early if someone has
    // written down where claude is since — which is one stat to find out,
    // and the difference between `slacken doctor` fixing this and a restart.
    if (cached.result.path) return cached.result;
    if (now - cached.at < MISS_TTL_MS && noteStamp(note) <= cached.at) return cached.result;
  }

  const result = await lookUp(bin, { home, env, note });
  if (useCache) memo.set(bin, { at: now, note, result });
  return result;
}

async function lookUp(bin, { home, env, note }) {
  // A configured path is a decision, not a hint: if it is wrong, say so about
  // that path rather than quietly running some other claude instead.
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

  // Before the login shell, because reading a file someone else already filled
  // in beats starting a shell to work the same thing out again — and if what
  // it names has since moved, it does not answer and the shell still runs.
  const noted = remembered(bin, note);
  searched.push(note);
  if (noted) return { path: noted, source: 'remembered', searched };

  const fromShell = await fromLoginShell(bin, env);
  if (env.SHELL) searched.push(`${env.SHELL} -lc 'command -v ${bin}'`);
  if (fromShell) return found(fromShell, 'login-shell');

  return { path: null, source: null, searched };
}

// Said once, in the terms the fix is in. `classifyError` reads "not found" out
// of this, so the menu bar and `slacken doctor` both know what kind of failure
// it is.
export function notFoundMessage(bin, searched = []) {
  const where = searched.length ? ` Looked in: ${searched.join(', ')}.` : '';
  return `could not run ${bin}: not found on PATH or where the installers put it.${where}`
    + ' If it lives somewhere else, set "claudeBin" to its full path'
    + ' in ~/.slacken/config.json.';
}

/*
 * The PATH a spawned `claude` gets.
 *
 * Knowing the full path to claude is not quite enough. An npm-installed one is
 * a script whose shebang is `#!/usr/bin/env node`, so running it needs node on
 * the PATH as well — and the daemon inherited the same bare PATH that made
 * claude hard to find. So the dirs we know about are appended: appended, not
 * prepended, so an existing PATH still decides which node is yours.
 */
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
