/*
 * Finding `claude` from a process that was not started by a shell.
 *
 * Every case here is the same case: the PATH is bare, because launchd, systemd
 * and Finder all hand one over. What differs is where claude actually is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveClaudeBin, knownLocations, notFoundMessage, spawnPath, isRunnable, forgetResolved,
} from '../src/claude-bin.js';
import { Moderator, classifyError, errorHint } from '../src/moderate.js';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-bin-'));
  return {
    home: dir,
    // A file that exists and can be run, which is all the lookup asks of it.
    install(rel, body = '#!/bin/sh\necho 1.0.0\n') {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      fs.chmodSync(file, 0o755);
      return file;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const bare = (extra = {}) => ({ PATH: '', ...extra });

test('a configured path is taken as the decision it is', async () => {
  const found = await resolveClaudeBin('/opt/custom/bin/claude', { useCache: false, env: bare() });
  assert.equal(found.path, '/opt/custom/bin/claude');
  assert.equal(found.source, 'configured');
});

test('a claude on the PATH is found on the PATH', async () => {
  const box = sandbox();
  try {
    const file = box.install('bin/claude');
    const found = await resolveClaudeBin('claude', {
      useCache: false,
      home: box.home,
      env: bare({ PATH: path.dirname(file) }),
    });
    assert.equal(found.path, file);
    assert.equal(found.source, 'path');
  } finally {
    box.cleanup();
  }
});

test('a bare PATH does not hide an installed claude', async () => {
  const box = sandbox();
  try {
    // Where the native installer puts it — and where launchd's PATH does not look.
    const file = box.install(path.join('.local', 'bin', 'claude'));
    const found = await resolveClaudeBin('claude', { useCache: false, home: box.home, env: bare() });
    assert.equal(found.path, file, 'this is the whole bug: installed, but not on this PATH');
    assert.equal(found.source, 'known-location');
  } finally {
    box.cleanup();
  }
});

test('the older ~/.claude/local install is looked for too', async () => {
  const box = sandbox();
  try {
    const file = box.install(path.join('.claude', 'local', 'claude'));
    const found = await resolveClaudeBin('claude', { useCache: false, home: box.home, env: bare() });
    assert.equal(found.path, file);
  } finally {
    box.cleanup();
  }
});

test('a directory named claude is not a claude to run', async () => {
  const box = sandbox();
  try {
    fs.mkdirSync(path.join(box.home, '.local', 'bin', 'claude'), { recursive: true });
    assert.equal(isRunnable(path.join(box.home, '.local', 'bin', 'claude')), false);
    const found = await resolveClaudeBin('claude', { useCache: false, home: box.home, env: bare() });
    assert.equal(found.path, null);
  } finally {
    box.cleanup();
  }
});

test('a PATH that only the login shell knows about still counts', async () => {
  const box = sandbox();
  try {
    const claude = box.install(path.join('versions', 'node', 'bin', 'claude'));
    // Stands in for a profile that sets PATH from a version manager: it prints
    // its own noise first, the way a real one does.
    const shell = box.install('fake-shell', `#!/bin/sh\necho "Welcome back"\necho ${claude}\n`);

    const found = await resolveClaudeBin('claude', {
      useCache: false,
      home: box.home,
      env: bare({ SHELL: shell }),
    });
    assert.equal(found.path, claude, 'the answer is the last usable line, not the greeting');
    assert.equal(found.source, 'login-shell');
  } finally {
    box.cleanup();
  }
});

test('not finding it says where it looked, and what to do about it', async () => {
  const box = sandbox();
  try {
    const found = await resolveClaudeBin('claude', { useCache: false, home: box.home, env: bare() });
    assert.equal(found.path, null);
    assert.ok(found.searched.includes('PATH'));
    assert.ok(found.searched.some((p) => p.includes(path.join('.local', 'bin'))));

    const message = notFoundMessage('claude', found.searched);
    assert.match(message, /claudeBin/, 'the fix belongs in the message');
    assert.equal(classifyError(message), 'missing', 'and it has to classify as what it is');
  } finally {
    box.cleanup();
  }
});

test('the resolved answer is remembered, and a miss is not remembered for long', async () => {
  const box = sandbox();
  try {
    forgetResolved();
    const miss = await resolveClaudeBin('claude', { home: box.home, env: bare(), now: 0 });
    assert.equal(miss.path, null);

    box.install(path.join('.local', 'bin', 'claude'));
    const stillMissing = await resolveClaudeBin('claude', { home: box.home, env: bare(), now: 1000 });
    assert.equal(stillMissing.path, null, 'a second failing call does not start another login shell');

    const later = await resolveClaudeBin('claude', { home: box.home, env: bare(), now: 120_000 });
    assert.ok(later.path, 'but installing claude fixes this without a restart');
  } finally {
    forgetResolved();
    box.cleanup();
  }
});

test('a spawned claude gets node on its PATH as well', () => {
  const dirs = spawnPath('/opt/custom/bin/claude', { PATH: '/usr/bin' }).split(path.delimiter);
  assert.equal(dirs[0], '/usr/bin', 'an existing PATH still decides which node is yours');
  assert.ok(dirs.includes('/opt/custom/bin'));
  assert.ok(dirs.includes(path.dirname(process.execPath)), 'an npm claude is a #!/usr/bin/env node script');
  assert.equal(new Set(dirs).size, dirs.length, 'no duplicate PATH entries');
});

test('a claude that is nowhere is reported as missing, not as a mystery', async () => {
  forgetResolved();
  const moderator = new Moderator({
    claudeBin: 'claude-that-is-not-installed-anywhere',
    model: 'claude-haiku-4-5-20251001',
    claudeArgs: [],
    retries: 1,
    requestTimeoutMs: 5000,
    batchSize: 1,
    batchWindowMs: 0,
    maxConcurrency: 1,
    maxChars: 4000,
    cacheTtlHours: 0,
    triageMode: 'always',
  });
  moderator.cache.map.clear();
  moderator.cache.flush = () => {};

  const verdict = await moderator.moderate({ text: 'THIS IS UNACCEPTABLE' });
  assert.ok(verdict.error, 'the message is left exactly as written');
  assert.equal(moderator.lastError.kind, 'missing');
  assert.equal(moderator.stats.retries, 0, 'looking again would look in the same places');
  assert.match(errorHint('missing'), /doctor/, 'the menu bar sends you somewhere that can explain');
  forgetResolved();
});
