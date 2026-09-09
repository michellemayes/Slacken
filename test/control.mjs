/*
 * Pausing, and the menu the menu bar item draws.
 *
 * The menu bar helper itself is a few hundred lines of AppKit that only run on
 * a Mac with a screen. Everything it says is decided here instead, so the part
 * that can be wrong is the part that is tested.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { State } from '../src/state.js';
import { Moderator } from '../src/moderate.js';
import { createServer } from '../src/server.js';
import { menuModel, buildHelper, MenuBar } from '../src/menubar.js';
import { DEFAULTS } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fake-claude.mjs');

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-state-'));
  const file = path.join(dir, 'state.json');
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/* ------------------------------------------------------------------ state */

test('a fresh install is not paused', () => {
  const state = new State({ persist: false });
  assert.equal(state.paused, false);
  assert.equal(state.pausedAt, null);
});

test('a pause survives the daemon being restarted', () => {
  const { file, cleanup } = tempState();
  try {
    const first = new State({ file });
    first.setPaused(true);
    assert.ok(fs.existsSync(file), 'the pause has to reach disk to survive a restart');

    // The login agent restarts the daemon whenever it exits. A pause that
    // quietly un-paused itself would leave you reading a rewritten feed you
    // believed you had turned off.
    const second = new State({ file });
    assert.equal(second.paused, true);
    assert.equal(typeof second.pausedAt, 'number');

    second.setPaused(false);
    assert.equal(new State({ file }).paused, false);
  } finally {
    cleanup();
  }
});

test('a corrupt state file is not a crash, it is just not paused', () => {
  const { file, cleanup } = tempState();
  try {
    fs.writeFileSync(file, '{ not json');
    assert.equal(new State({ file }).paused, false);
  } finally {
    cleanup();
  }
});

test('listeners hear real changes and not repeats', () => {
  const state = new State({ persist: false });
  const heard = [];
  state.onChange((paused) => heard.push(paused));

  assert.equal(state.setPaused(true), true);
  assert.equal(state.setPaused(true), false, 'pausing twice is one pause');
  assert.equal(state.setPaused(false), true);
  assert.deepEqual(heard, [true, false]);
});

test('a listener that throws does not silence the others', () => {
  const state = new State({ persist: false });
  const heard = [];
  state.onChange(() => { throw new Error('a Slack window went away mid-broadcast'); });
  state.onChange((paused) => heard.push(paused));
  state.setPaused(true);
  assert.deepEqual(heard, [true]);
});

test('unsubscribing stops the calls', () => {
  const state = new State({ persist: false });
  const heard = [];
  const off = state.onChange((paused) => heard.push(paused));
  state.setPaused(true);
  off();
  state.setPaused(false);
  assert.deepEqual(heard, [true]);
});

/* -------------------------------------------------------------- moderator */

function moderator(state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-pause-'));
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'invocations.log');
  delete process.env.FAKE_CLAUDE_FAIL;

  const mod = new Moderator({ ...DEFAULTS, claudeBin: FAKE }, state);
  mod.cache.map.clear();
  mod.cache.flush = () => {};

  const calls = () => (fs.existsSync(process.env.FAKE_CLAUDE_LOG)
    ? fs.readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf8').trim().split('\n').filter(Boolean).length
    : 0);
  return { mod, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a paused Slacken never calls the model', async () => {
  const state = new State({ persist: false });
  state.setPaused(true);
  const { mod, calls, cleanup } = moderator(state);
  try {
    const verdict = await mod.moderate({ text: 'WHY IS THIS STILL BROKEN', sender: 'Dana' });
    assert.equal(verdict.flagged, false);
    assert.equal(verdict.rewrite, null, 'nothing to swap in means the words stay as written');
    assert.equal(verdict.reason, 'paused');
    assert.equal(calls(), 0, 'a pause should cost nothing at all');
    assert.equal(mod.stats.calls, 0);
  } finally {
    cleanup();
  }
});

test('resuming brings the rewrites back', async () => {
  const state = new State({ persist: false });
  state.setPaused(true);
  const { mod, calls, cleanup } = moderator(state);
  try {
    await mod.moderate({ text: 'WHY IS THIS STILL BROKEN', sender: 'Dana' });
    state.setPaused(false);
    const verdict = await mod.moderate({ text: 'WHY IS THIS STILL BROKEN', sender: 'Dana' });
    assert.equal(verdict.flagged, true);
    assert.equal(calls(), 1);
  } finally {
    cleanup();
  }
});

test('a verdict decided while paused is never cached as a clean one', async () => {
  const state = new State({ persist: false });
  state.setPaused(true);
  const { mod, cleanup } = moderator(state);
  try {
    await mod.moderate({ text: 'WHY IS THIS STILL BROKEN', sender: 'Dana' });
    assert.equal(mod.cache.map.size, 0, 'caching a pause would outlast the pause itself');
  } finally {
    cleanup();
  }
});

/* ----------------------------------------------------------- control API */

async function withServer(run, { paused = false } = {}) {
  const state = new State({ persist: false });
  state.setPaused(paused);
  const { mod, cleanup } = moderator(state);
  let attached = 1;

  const server = await createServer({
    config: { ...DEFAULTS, httpPort: 0 },
    moderator: mod,
    state,
    getStatus: () => ({ attached }),
    reinject: async () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await fetch(`${base}${p}`)).json();
  const post = async (p) => (await fetch(`${base}${p}`, { method: 'POST' })).json();
  const postJson = async (p, body) => (await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).json();

  try {
    await run({ get, post, postJson, state, setAttached: (n) => { attached = n; } });
  } finally {
    server.close();
    cleanup();
  }
}

test('/status reports what the daemon is doing', async () => {
  await withServer(async ({ get }) => {
    const status = await get('/status');
    assert.equal(status.paused, false);
    assert.equal(status.attached, 1);
    assert.equal(status.model, DEFAULTS.model);
    assert.equal(status.triageMode, DEFAULTS.triageMode);
    assert.equal(typeof status.uptimeMs, 'number');
    assert.equal(status.stats.calls, 0);
  });
});

test('/pause and /resume move the state, and say what it became', async () => {
  await withServer(async ({ post, get, state }) => {
    assert.deepEqual(await post('/pause'), { ok: true, paused: true });
    assert.equal(state.paused, true);
    assert.equal((await get('/status')).paused, true);

    assert.deepEqual(await post('/resume'), { ok: true, paused: false });
    assert.equal(state.paused, false);
  });
});

test('/toggle is the one the menu bar clicks', async () => {
  await withServer(async ({ post }) => {
    assert.equal((await post('/toggle')).paused, true);
    assert.equal((await post('/toggle')).paused, false);
  });
});

test('/health still answers, and now says whether it is paused', async () => {
  await withServer(async ({ get, post }) => {
    const before = await get('/health');
    assert.equal(before.ok, true);
    assert.equal(before.paused, false);
    await post('/pause');
    assert.equal((await get('/health')).paused, true);
  });
});

test('/moderate respects a pause like everything else does', async () => {
  await withServer(async ({ postJson }) => {
    const verdict = await postJson('/moderate', { text: 'WHY IS THIS STILL BROKEN' });
    assert.equal(verdict.flagged, false);
    assert.equal(verdict.reason, 'paused');
  }, { paused: true });
});

test('/menubar renders a menu that matches the daemon state', async () => {
  await withServer(async ({ get, post }) => {
    const running = await get('/menubar');
    assert.equal(running.items[0].label, 'Watching 1 Slack window');
    assert.ok(running.items.some((i) => i.label === 'Pause' && i.post === '/pause'));

    await post('/pause');
    const paused = await get('/menubar');
    assert.match(paused.items[0].label, /^Paused/);
    assert.ok(paused.items.some((i) => i.label === 'Resume' && i.post === '/resume'));
    assert.equal(paused.dimmed, true);
  });
});

/* -------------------------------------------------------------- menu model */

const STATUS = {
  paused: false,
  attached: 1,
  model: 'claude-haiku-4-5',
  triageMode: 'heuristic',
  uptimeMs: 90 * 60 * 1000,
  dailyBudgetUsd: 0,
  stats: { calls: 4, batched: 12, cacheHits: 38, softened: 5, condensed: 3, errors: 0, costUsd: 0.0104 },
};

const labels = (status) => menuModel(status).items.map((i) => i.label).filter(Boolean);

test('the menu offers exactly one of pause and resume', () => {
  for (const paused of [false, true]) {
    const actions = menuModel({ ...STATUS, paused }).items.filter((i) => i.post);
    assert.equal(actions.length, 1, 'two ways to say the same thing is one too many');
    assert.equal(actions[0].post, paused ? '/resume' : '/pause');
  }
});

test('the menu says how much of what you read was not what was written', () => {
  const lines = labels(STATUS);
  assert.ok(lines.includes('8 messages rewritten of 50 read'));
  assert.ok(lines.includes('5 softened · 3 condensed'));
  assert.ok(lines.includes('4 model calls · 38 from cache'));
  assert.ok(lines.includes('$0.0104 today'));
  assert.ok(lines.includes('claude-haiku-4-5 · triage heuristic'));
});

test('the icon dims whenever nothing is being changed', () => {
  assert.equal(menuModel(STATUS).dimmed, false);
  assert.equal(menuModel({ ...STATUS, paused: true }).dimmed, true);
  assert.equal(menuModel({ ...STATUS, attached: 0 }).dimmed, true, 'attached to nothing changes nothing');
  assert.notEqual(menuModel({ ...STATUS, paused: true }).icon, menuModel(STATUS).icon);
});

test('a daily budget is shown next to what has been spent against it', () => {
  assert.ok(labels({ ...STATUS, dailyBudgetUsd: 1 }).includes('$0.0104 today of $1.00'));
  assert.ok(labels(STATUS).includes('$0.0104 today'), 'no budget set means no budget line');
});

test('errors get a line only when there are some', () => {
  assert.ok(!labels(STATUS).some((l) => /error/.test(l)));
  assert.ok(labels({ ...STATUS, stats: { ...STATUS.stats, errors: 2 } }).includes('2 errors — see the log'));
});

test('counts read as English, singular and plural', () => {
  assert.ok(labels({ ...STATUS, attached: 1 }).includes('Watching 1 Slack window'));
  assert.ok(labels({ ...STATUS, attached: 3 }).includes('Watching 3 Slack windows'));
  assert.ok(labels({ ...STATUS, stats: { ...STATUS.stats, errors: 1 } }).includes('1 error — see the log'));
  assert.ok(labels({ ...STATUS, uptimeMs: 1000 }).includes('Running for under a minute'));
  assert.ok(labels({ ...STATUS, uptimeMs: 60_000 }).includes('Running for 1 minute'));
  assert.ok(labels({ ...STATUS, uptimeMs: 90 * 60_000 }).includes('Running for 1 hour'));
  assert.ok(labels({ ...STATUS, uptimeMs: 50 * 3600_000 }).includes('Running for 2 days'));
});

test('a cost too small to print does not round away to nothing', () => {
  const cheap = { ...STATUS, stats: { ...STATUS.stats, costUsd: 0.00001 } };
  assert.ok(labels(cheap).includes('<$0.0001 today'), 'the difference between free and nearly free matters');
  const free = { ...STATUS, stats: { ...STATUS.stats, costUsd: 0 } };
  assert.ok(labels(free).includes('$0.0000 today'));
});

test('the menu survives a status with nothing in it', () => {
  const model = menuModel({});
  assert.ok(model.items.length > 0);
  assert.ok(model.items.some((i) => i.post === '/pause'));
  assert.ok(model.items.some((i) => i.quit));
  assert.equal(menuModel(undefined).items.length, model.items.length);
});

test('every menu item is a separator, a label, or a thing you can click', () => {
  for (const item of menuModel(STATUS).items) {
    if (item.separator) continue;
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 0);
    const clickable = Boolean(item.post || item.open || item.quit);
    assert.equal(clickable, item.enabled !== false, 'a clickable item must not be drawn as a label');
  }
});

/* ------------------------------------------------------- building the helper */

// The AppKit source is compiled on demand and cached by its hash. Nothing here
// needs Swift: what is being tested is the caching, not the compiler.
function fakeCompiler(dir, { fails = false } = {}) {
  const bin = path.join(dir, 'fake-swiftc.mjs');
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs';
const out = process.argv[process.argv.indexOf('-o') + 1];
fs.appendFileSync(${JSON.stringify(path.join(dir, 'compiles.log'))}, out + '\\n');
${fails ? 'process.stderr.write("error: it does not compile\\\\n"); process.exit(1);' : "fs.writeFileSync(out, 'binary');"}
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function compileCount(dir) {
  const log = path.join(dir, 'compiles.log');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

test('the helper is compiled once and then reused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-build-'));
  try {
    const sourcePath = path.join(dir, 'Helper.swift');
    fs.writeFileSync(sourcePath, '// v1');
    const buildDir = path.join(dir, 'out');
    const compiler = fakeCompiler(dir);

    const first = await buildHelper({ sourcePath, buildDir, compiler });
    const again = await buildHelper({ sourcePath, buildDir, compiler });
    assert.equal(again, first, 'unchanged source should give the same binary');
    assert.equal(compileCount(dir), 1, 'the daemon calls this on every start; it must not recompile');

    // Editing the Swift has to produce a new binary, and retire the old one.
    fs.writeFileSync(sourcePath, '// v2');
    const rebuilt = await buildHelper({ sourcePath, buildDir, compiler });
    assert.notEqual(rebuilt, first);
    assert.equal(compileCount(dir), 2);
    assert.deepEqual(fs.readdirSync(buildDir), [path.basename(rebuilt)], 'stale builds should be cleaned up');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a compiler that fails leaves nothing behind that looks finished', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-build-'));
  try {
    const sourcePath = path.join(dir, 'Helper.swift');
    fs.writeFileSync(sourcePath, '// broken');
    const buildDir = path.join(dir, 'out');

    await assert.rejects(
      buildHelper({ sourcePath, buildDir, compiler: fakeCompiler(dir, { fails: true }) }),
      /does not compile/,
    );
    assert.deepEqual(fs.readdirSync(buildDir), [], 'a half-built binary must never be mistaken for a real one');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing swiftc says how to get one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-build-'));
  try {
    const sourcePath = path.join(dir, 'Helper.swift');
    fs.writeFileSync(sourcePath, '// v1');
    await assert.rejects(
      buildHelper({ sourcePath, buildDir: path.join(dir, 'out'), compiler: path.join(dir, 'nope') }),
      /xcode-select --install/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------- supervising the helper */

function helperScript(dir, body) {
  const bin = path.join(dir, 'helper.mjs');
  fs.writeFileSync(bin, `#!/usr/bin/env node\nimport fs from 'node:fs';\n${body}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function supervisor(dir, body) {
  const events = [];
  const bar = new MenuBar({
    config: { ...DEFAULTS },
    onEvent: (e) => events.push(e),
    restartDelayMs: 10,
  });
  bar.binary = helperScript(dir, body);
  bar.spawn(bar.binary);
  return { bar, events };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('the helper is told to go when the daemon stops', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-helper-'));
  try {
    // A real helper exits when stdin closes; this one records that it did.
    const marker = path.join(dir, 'saw-eof');
    const { bar } = supervisor(dir, `
      process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'bye'); process.exit(0); });
      process.stdin.resume();
    `);
    await settle(300);
    bar.stop();
    await settle(300);
    assert.ok(fs.existsSync(marker), 'closing stdin is what stops an icon outliving the daemon');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hiding the menu bar item is respected, not undone by a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-helper-'));
  try {
    const { events } = supervisor(dir, 'process.exit(0);');
    await settle(400);
    const exited = events.filter((e) => e.type === 'menubar-exited');
    assert.equal(exited.length, 1);
    assert.equal(exited[0].crashed, false, 'a clean exit means the user asked for it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a crashing helper is retried, but not forever', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-helper-'));
  try {
    const log = path.join(dir, 'starts.log');
    const { events } = supervisor(dir, `fs.appendFileSync(${JSON.stringify(log)}, 'x'); process.exit(3);`);
    await settle(800);
    assert.equal(fs.readFileSync(log, 'utf8').length, 3, 'one go plus two retries');
    const exited = events.filter((e) => e.type === 'menubar-exited');
    assert.equal(exited.length, 1);
    assert.equal(exited[0].crashed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
