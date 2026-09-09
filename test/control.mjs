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
import { menuModel, settingsMenu, buildHelper, MenuBar } from '../src/menubar.js';
import { DEFAULTS, ConfigStore, loadConfig } from '../src/config.js';
import { coerce, coerceAll, withEntry, inList, invalidatesCache, forChannel, gateSignature } from '../src/settings.js';
import { Attacher } from '../src/attach.js';
import { loadToken, readToken, tokenMatches } from '../src/auth.js';
import { VERSION } from '../src/version.js';

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

async function withServer(run, { paused = false, stoppable = true, token = null, values = {} } = {}) {
  const state = new State({ persist: false });
  state.setPaused(paused);
  const { mod, cleanup } = moderator(state);
  let attached = 1;
  let drifted = false;
  const stops = [];

  const store = new ConfigStore({ values: { ...DEFAULTS, httpPort: 0, ...values }, persist: false });
  const server = await createServer({
    config: store.values,
    moderator: mod,
    state,
    store,
    getStatus: () => ({ attached, drifted }),
    reinject: async () => {},
    inspect: async () => [{ target: 'w1', channel: '#eng-oncall', rows: [] }],
    onStop: stoppable ? (reason) => stops.push(reason) : undefined,
    token,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = token ? { authorization: `Bearer ${token}` } : {};
  const raw = (p, init = {}) => fetch(`${base}${p}`, {
    ...init,
    headers: { ...auth, ...(init.headers || {}) },
  });
  const get = async (p) => (await raw(p)).json();
  const post = async (p) => (await raw(p, { method: 'POST' })).json();
  const postJson = async (p, body) => (await raw(p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).json();

  try {
    await run({
      base,
      raw,
      get,
      post,
      postJson,
      mod,
      state,
      store,
      stops,
      setAttached: (n) => { attached = n; },
      setDrifted: (v) => { drifted = v; },
    });
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

test('/status answers for itself, not for whoever is asking', async () => {
  await withServer(async ({ get }) => {
    const status = await get('/status');
    // Both exist so that `slacken doctor` can compare them with its own: the
    // process being asked is not the process asking, and the two disagreeing
    // is the failure that otherwise looks like nothing happening at all.
    assert.equal(status.version, VERSION, 'which Slacken is actually running');
    assert.equal(status.claude.bin, FAKE, 'the claude this daemon was told to use');
    assert.equal(status.claude.path, FAKE, 'and where this process, not the asker, finds it');
    assert.ok(Array.isArray(status.claude.searched));
  });
});

test('/inspect reports what each window makes of the messages on it', async () => {
  await withServer(async ({ get }) => {
    const res = await get('/inspect');
    assert.equal(res.windows.length, 1);
    assert.equal(res.windows[0].channel, '#eng-oncall');
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

test('/stop shuts the daemon down, and answers before it does', async () => {
  await withServer(async ({ post, stops }) => {
    // The terminal is not the only way Slacken gets started, so it must not be
    // the only way it can be stopped.
    assert.deepEqual(await post('/stop'), { ok: true, stopping: true });
    // The reply is written before the shutdown runs; give the 'finish' event
    // the tick it needs.
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(stops, ['a stop request']);
  });
});

test('a daemon with no way to stop itself says so rather than pretending', async () => {
  await withServer(async ({ post }) => {
    assert.deepEqual(await post('/stop'), { error: 'this daemon cannot stop itself' });
  }, { stoppable: false });
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

test('every menu item is a separator, a label, a submenu, or a thing you can click', () => {
  const check = (items) => {
    for (const item of items) {
      if (item.separator) continue;
      assert.equal(typeof item.label, 'string');
      assert.ok(item.label.length > 0);
      if (item.submenu) {
        assert.ok(item.submenu.length > 0, 'a submenu with nothing in it is a dead end');
        check(item.submenu);
        continue;
      }
      const clickable = Boolean(item.post || item.open || item.quit);
      assert.equal(clickable, item.enabled !== false, 'a clickable item must not be drawn as a label');
    }
  };
  check(menuModel({ ...STATUS, config: { ...DEFAULTS } }).items);
});

/* ---------------------------------------------------------------- settings */

function tempConfig(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-config-'));
  const file = path.join(dir, 'config.json');
  if (initial) fs.writeFileSync(file, JSON.stringify(initial, null, 2));
  return { file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a setting only accepts values that mean something', () => {
  assert.equal(coerce('triageMode', 'always'), 'always');
  assert.throws(() => coerce('triageMode', 'sometimes'), /heuristic, always/);

  assert.equal(coerce('condenseEnabled', 'off'), false);
  assert.equal(coerce('condenseEnabled', true), true);
  assert.throws(() => coerce('condenseEnabled', 'maybe'), /on or off/);

  assert.equal(coerce('condenseMinWords', '60'), 60);
  assert.throws(() => coerce('condenseMinWords', '2'), /between 10 and 500/);
  assert.throws(() => coerce('condenseMinWords', 'lots'), /a number/);

  assert.equal(coerce('dailyBudgetUsd', '0.5'), 0.5);
  assert.deepEqual(coerce('ignoreChannels', '#eng, #random ,'), ['#eng', '#random']);
  assert.deepEqual(coerce('ignoreChannels', ['#eng', '#ENG']), ['#eng'], 'one channel, however it is typed');
});

test('settings that cannot be changed under a running daemon say so', () => {
  // Changing the debug port on a live connection would be a lie, not a change.
  for (const key of ['cdpPort', 'httpPort', 'targetUrlPattern', 'claudeBin']) {
    assert.throws(() => coerce(key, '1'), /cannot be changed while Slacken runs/);
  }
});

test('a patch with one bad value in it is refused whole', () => {
  const { values, errors } = coerceAll({ triageMode: 'always', minSeverity: 9 });
  assert.equal(values.triageMode, 'always');
  assert.equal(values.minSeverity, undefined);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /between 0 and 3/);
});

test('an ignore list is edited by entry, case-insensitively', () => {
  assert.deepEqual(withEntry([], '#eng', true), ['#eng']);
  assert.deepEqual(withEntry(['#eng'], '#ENG', true), ['#ENG'], 'ignoring twice ignores once');
  assert.deepEqual(withEntry(['#eng', '#ops'], '#ENG', false), ['#ops']);
  assert.deepEqual(withEntry(['#eng'], '   ', true), ['#eng'], 'nothing to add is not an empty entry');
  assert.equal(inList(['#Eng'], '#eng'), true);
  assert.equal(inList(['#eng'], null), false);
});

test('a change reaches disk, and leaves the rest of the file alone', () => {
  const { file, read, cleanup } = tempConfig({ cdpPort: 9333, somethingWeDoNotKnowAbout: 'keep me' });
  try {
    const store = new ConfigStore({ file });
    assert.equal(store.values.cdpPort, 9333, 'the file wins over the defaults');

    const { changed, errors } = store.update({ triageMode: 'always', condenseMinWords: 60 });
    assert.deepEqual(changed.sort(), ['condenseMinWords', 'triageMode']);
    assert.deepEqual(errors, []);

    const onDisk = read();
    assert.equal(onDisk.triageMode, 'always');
    assert.equal(onDisk.condenseMinWords, 60);
    assert.equal(onDisk.cdpPort, 9333, 'a setting we did not touch must survive being written around');
    assert.equal(onDisk.somethingWeDoNotKnowAbout, 'keep me');

    // The point of writing it: a restart reads the change back.
    assert.equal(loadConfig(file).triageMode, 'always');
  } finally {
    cleanup();
  }
});

test('the config object handed out at startup is the one that changes', () => {
  const store = new ConfigStore({ persist: false });
  // The moderator and the attacher were given this object and read fields off
  // it as they work; replacing it would leave them on the old settings.
  const held = store.values;
  store.update({ model: 'claude-opus-5' });
  assert.equal(held.model, 'claude-opus-5');
  assert.equal(held, store.values);
});

test('a change nobody asked for is not announced', () => {
  const store = new ConfigStore({ persist: false, values: { ...DEFAULTS } });
  const heard = [];
  store.onChange((changed) => heard.push(changed));

  store.update({ triageMode: 'always' });
  store.update({ triageMode: 'always' });
  assert.deepEqual(heard, [['triageMode']], 'setting a setting to what it already is changes nothing');

  const bad = store.update({ triageMode: 'nonsense' });
  assert.equal(bad.changed.length, 0);
  assert.equal(bad.errors.length, 1);
  assert.equal(store.values.triageMode, 'always', 'a refused value leaves the old one standing');
});

test('ignoring a channel is idempotent, and reversible', () => {
  const store = new ConfigStore({ persist: false, values: { ...DEFAULTS, ignoreChannels: [] } });
  store.setIgnored('ignoreChannels', '#eng-oncall', true);
  store.setIgnored('ignoreChannels', '#eng-oncall', true);
  assert.deepEqual(store.values.ignoreChannels, ['#eng-oncall']);
  assert.equal(store.isIgnored('ignoreChannels', '#ENG-ONCALL'), true);

  store.setIgnored('ignoreChannels', '#eng-oncall', false);
  assert.deepEqual(store.values.ignoreChannels, []);
});

test('moving a threshold is what makes the cached verdicts wrong', () => {
  // A verdict was judged against these, so a cached one no longer answers the
  // question. Everything else leaves the cache worth keeping.
  assert.equal(invalidatesCache(['minSeverity']), true);
  assert.equal(invalidatesCache(['condenseMinWords']), true);
  assert.equal(invalidatesCache(['verbose', 'holdWhilePending']), false);
});

/* --------------------------------------------------------- settings menu */

function findItem(items, prefix) {
  return items.find((i) => typeof i.label === 'string' && i.label.startsWith(prefix));
}

test('the settings menu shows what each setting is set to without opening it', () => {
  const items = settingsMenu({ ...DEFAULTS, model: 'claude-opus-5', dailyBudgetUsd: 0.5 });
  assert.equal(findItem(items, 'Model').label, 'Model: Opus 5');
  assert.equal(findItem(items, 'Daily budget').label, 'Daily budget: $0.50');
  assert.equal(findItem(items, 'Look at:').label, 'Look at: flagged only');
});

test('exactly one choice is ticked, and clicking another sets it', () => {
  const items = settingsMenu({ ...DEFAULTS, triageMode: 'heuristic' });
  const choices = findItem(items, 'Look at:').submenu;
  assert.deepEqual(choices.filter((c) => c.checked).map((c) => c.body.triageMode), ['heuristic']);

  const other = choices.find((c) => !c.checked);
  assert.equal(other.post, '/config');
  assert.deepEqual(other.body, { triageMode: 'always' });
});

test('a toggle carries the value it would set, not the flip', () => {
  // Two clicks racing each other should land on the same answer rather than
  // undoing one another.
  const on = findItem(settingsMenu({ ...DEFAULTS, condenseEnabled: true }), 'Condense padded');
  assert.equal(on.checked, true);
  assert.deepEqual(on.body, { condenseEnabled: false });

  const off = findItem(settingsMenu({ ...DEFAULTS, condenseEnabled: false }), 'Condense padded');
  assert.equal(off.checked, false);
  assert.deepEqual(off.body, { condenseEnabled: true });
});

test('a value set by hand in the config file still shows up in the menu', () => {
  const items = settingsMenu({ ...DEFAULTS, model: 'claude-something-else', condenseMinWords: 33 });
  assert.equal(findItem(items, 'Model').label, 'Model: claude-something-else');
  const words = findItem(items, 'Condense messages over');
  assert.equal(words.label, 'Condense messages over: 33');
  assert.ok(words.submenu.some((i) => i.label === 'Set to 33 in the config file'));
  assert.ok(!words.submenu.some((i) => i.checked), 'nothing offered is the value in force');
});

test('ignored channels are listed, and clicking one stops ignoring it', () => {
  const empty = findItem(settingsMenu({ ...DEFAULTS, ignoreChannels: [] }), 'Ignored channels');
  assert.equal(empty.label, 'Ignored channels: none');
  assert.deepEqual(empty.submenu.map((i) => i.label), ['No channels ignored']);

  const listed = findItem(settingsMenu({ ...DEFAULTS, ignoreChannels: ['#eng', '#ops'] }), 'Ignored channels');
  assert.equal(listed.label, 'Ignored channels: 2');
  const entry = listed.submenu[0];
  assert.equal(entry.label, '#eng');
  assert.equal(entry.checked, true);
  assert.equal(entry.post, '/ignore');
  assert.deepEqual(entry.body, { list: 'ignoreChannels', value: '#eng', ignored: false });
});

test('the menu still draws with no settings to draw from', () => {
  assert.ok(menuModel(STATUS).items.some((i) => i.submenu));
});

/* ------------------------------------------------- settings over the API */

test('/config reports the settings in force and changes them', async () => {
  await withServer(async ({ get, postJson, store }) => {
    assert.equal((await get('/config')).config.triageMode, DEFAULTS.triageMode);

    const res = await postJson('/config', { triageMode: 'always', minSeverity: 3 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.changed.sort(), ['minSeverity', 'triageMode']);
    assert.equal(store.values.triageMode, 'always', 'the daemon has to be changed, not just answered');
    assert.equal((await get('/status')).config.minSeverity, 3);
  });
});

test('/config refuses a bad value and says which one', async () => {
  await withServer(async ({ postJson, store }) => {
    const res = await postJson('/config', { triageMode: 'sometimes' });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0].key, 'triageMode');
    assert.equal(store.values.triageMode, DEFAULTS.triageMode);
  });
});

test('/ignore adds and removes one entry without touching the rest', async () => {
  await withServer(async ({ postJson, store }) => {
    store.update({ ignoreChannels: ['#ops'] });

    const added = await postJson('/ignore', { list: 'ignoreChannels', value: '#eng-oncall' });
    assert.equal(added.ok, true);
    assert.deepEqual(added.ignoreChannels, ['#ops', '#eng-oncall']);

    const removed = await postJson('/ignore', { list: 'ignoreChannels', value: '#ops', ignored: false });
    assert.deepEqual(removed.ignoreChannels, ['#eng-oncall'], 'the other entry is not collateral');

    const bad = await postJson('/ignore', { list: 'somethingElse', value: '#eng' });
    assert.match(bad.error, /ignoreChannels or ignoreSenders/);
  });
});

test('the menu bar and the daemon cannot disagree about a setting', async () => {
  await withServer(async ({ get, postJson }) => {
    await postJson('/config', { condenseEnabled: false });
    const menu = await get('/menubar');
    const settings = menu.items.find((i) => i.label === 'Settings');
    const toggle = findItem(settings.submenu, 'Condense padded');
    assert.equal(toggle.checked, false);
    assert.deepEqual(toggle.body, { condenseEnabled: true });
  });
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


/* ------------------------------------------------------------------ token */

/*
 * Loopback is not a permission.
 *
 * Everything running on this machine can reach 127.0.0.1, and behind the
 * control API is what you have been reading, what it cost, and an endpoint
 * that will spend your Claude account on any text at all.
 */
test('every endpoint but /health needs the token', async () => {
  await withServer(async ({ raw, base }) => {
    const open = await fetch(`${base}/health`);
    assert.equal(open.status, 200, '/health is how a second start finds the first');
    assert.equal((await open.json()).ok, true);

    for (const [method, path] of [['GET', '/status'], ['GET', '/menubar'], ['GET', '/config'],
      ['POST', '/pause'], ['POST', '/config'], ['POST', '/channel'], ['POST', '/moderate'], ['POST', '/stop']]) {
      const res = await fetch(`${base}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path} should need the token`);
    }

    // And with it, everything works exactly as it did.
    assert.equal((await (await raw('/status')).json()).attached, 1);
  }, { token: 'a-test-token' });
});

test('a wrong token is refused, and nothing is changed on the way', async () => {
  await withServer(async ({ base, store }) => {
    const res = await fetch(`${base}/config`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-the-token', 'content-type': 'application/json' },
      body: JSON.stringify({ triageMode: 'always' }),
    });
    assert.equal(res.status, 401);
    assert.equal(store.values.triageMode, 'heuristic', 'a refused request is not a half-applied one');
  }, { token: 'a-test-token' });
});

test('the token is written once, kept private, and read back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-token-'));
  const file = path.join(dir, 'token');
  try {
    const first = loadToken(file);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(loadToken(file), first, 'a second start uses the token the first one wrote');
    assert.equal(readToken(file), first);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o077, 0, 'nobody else on this machine may read it');
    }
    assert.equal(tokenMatches(first, first), true);
    // Changed rather than replaced with a fixed character: one time in
    // sixteen a random hex token already ends in the character you picked,
    // and a test that passes fifteen times in sixteen is worse than no test.
    const wrong = first.slice(0, -1) + (first.endsWith('0') ? '1' : '0');
    assert.equal(tokenMatches(first, wrong), false);
    assert.equal(tokenMatches(first, 'short'), false);
    assert.equal(tokenMatches(null, undefined), true, 'a daemon with no token asks for none');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------- per-channel */

test('a channel can be told to behave differently, one setting at a time', async () => {
  await withServer(async ({ postJson, store }) => {
    const first = await postJson('/channel', { channel: '#eng-oncall', settings: { minSeverity: 3 } });
    assert.equal(first.ok, true);
    assert.deepEqual(store.values.channelOverrides['#eng-oncall'], { minSeverity: 3 });

    // A second setting joins the first rather than replacing it.
    const second = await postJson('/channel', { channel: '#eng-oncall', settings: { condenseEnabled: false } });
    assert.equal(second.ok, true);
    assert.deepEqual(store.values.channelOverrides['#eng-oncall'], { minSeverity: 3, condenseEnabled: false });

    // And the global settings are untouched by any of it.
    assert.equal(store.values.minSeverity, DEFAULTS.minSeverity);
    assert.equal(forChannel(store.values, '#ENG-ONCALL').minSeverity, 3, 'one channel, however you type it');
    assert.equal(forChannel(store.values, '#other').minSeverity, DEFAULTS.minSeverity);
  });
});

test('a channel setting that cannot honestly differ per channel is refused', async () => {
  await withServer(async ({ postJson, store }) => {
    const res = await postJson('/channel', { channel: '#eng', settings: { model: 'claude-opus-5' } });
    assert.equal(res.ok, false);
    assert.match(res.errors[0].message, /cannot differ per channel/);
    assert.equal(store.values.channelOverrides['#eng'], undefined);

    const bad = await postJson('/channel', { channel: '#eng', settings: { minSeverity: 9 } });
    assert.equal(bad.ok, false);
    assert.match(bad.errors[0].message, /between 0 and 3/);
    assert.equal(store.values.channelOverrides['#eng'], undefined, 'a refused value leaves no channel behind');
  });
});

test('clearing a channel puts it back to the global settings', async () => {
  await withServer(async ({ postJson, store }) => {
    await postJson('/channel', { channel: '#eng', settings: { minSeverity: 3 } });
    await postJson('/channel', { channel: '#design', settings: { condenseEnabled: false } });
    const cleared = await postJson('/channel', { channel: '#eng', clear: true });

    assert.equal(cleared.ok, true);
    assert.equal(store.values.channelOverrides['#eng'], undefined);
    assert.deepEqual(store.values.channelOverrides['#design'], { condenseEnabled: false },
      'the other channel is not collateral');
  });
});

test('the same message in two channels is two cache keys, and the same one is one', () => {
  const config = { ...DEFAULTS, channelOverrides: { '#loud': { minSeverity: 3 } } };
  assert.notEqual(gateSignature(config, '#loud'), gateSignature(config, '#quiet'));
  assert.equal(gateSignature(config, '#quiet'), gateSignature(config, '#anywhere-else'));
});

/* ------------------------------------------------------------ what it says */

test('the menu says when Slack has stopped looking like Slack', () => {
  const running = menuModel({ attached: 2, stats: {}, config: DEFAULTS });
  assert.match(running.items[0].label, /Watching 2 Slack windows/);
  assert.equal(running.dimmed, false);

  const drifted = menuModel({ attached: 2, drifted: true, stats: {}, config: DEFAULTS });
  assert.match(drifted.items[0].label, /layout may have changed/);
  assert.notEqual(drifted.icon, running.icon, 'the icon has to say it without being opened');
});

test('the menu names the error rather than counting errors', () => {
  const counted = menuModel({ attached: 1, stats: { errors: 3 }, config: DEFAULTS });
  assert.ok(counted.items.some((i) => /3 errors/.test(i.label || '')));

  const named = menuModel({
    attached: 1,
    stats: { errors: 3 },
    config: DEFAULTS,
    lastError: { kind: 'auth', hint: 'Not signed in to Claude — run: claude login' },
  });
  assert.ok(named.items.some((i) => /claude login/.test(i.label || '')));
  assert.ok(!named.items.some((i) => /3 errors/.test(i.label || '')),
    'the thing you can do about it beats the number of times it happened');
});

test('the menu counts the originals that were asked for', () => {
  const quiet = menuModel({ attached: 1, stats: {}, config: DEFAULTS });
  assert.ok(!quiet.items.some((i) => /asked for back/.test(i.label || '')),
    'nothing to say before anyone has clicked a badge');
  const asked = menuModel({ attached: 1, stats: { reveals: 4 }, config: DEFAULTS });
  assert.ok(asked.items.some((i) => /4 originals asked for back/.test(i.label || '')));
});

test('a channel with settings of its own is in the settings menu, with a way back', () => {
  const config = { ...DEFAULTS, channelOverrides: { '#eng': { minSeverity: 3 } } };
  const entry = settingsMenu(config).find((i) => /Per-channel settings/.test(i.label || ''));
  assert.match(entry.label, /: 1$/);

  const channel = entry.submenu[0];
  assert.match(channel.label, /^#eng — /);
  const back = channel.submenu.find((i) => i.label === 'Same as everywhere else');
  assert.deepEqual(back.body, { channel: '#eng', clear: true });

  // Every choice posts the value it would set, exactly like the global ones.
  const severity = channel.submenu.find((i) => /Soften when it is/.test(i.label || ''));
  const chosen = severity.submenu.find((i) => i.checked);
  assert.deepEqual(chosen.body, { channel: '#eng', settings: { minSeverity: 3 } });

  const none = settingsMenu(DEFAULTS).find((i) => /Per-channel settings/.test(i.label || ''));
  assert.match(none.label, /none$/);
});

/* --------------------------------------------------------------- drift */

test('drift is list items with no message bodies in them, and nothing else', () => {
  const attacher = new Attacher({ config: { ...DEFAULTS }, moderator: { stats: {} } });
  assert.equal(attacher.drifted, false, 'a page that has said nothing yet is not evidence');

  attacher.health = { at: Date.now(), items: 0, bodies: 0 };
  assert.equal(attacher.drifted, false, 'an empty channel looks exactly like this');

  attacher.health = { at: Date.now(), items: 12, bodies: 12 };
  assert.equal(attacher.drifted, false);

  attacher.health = { at: Date.now(), items: 12, bodies: 0 };
  assert.equal(attacher.drifted, true, 'the list is there and the words are not');

  attacher.health = { at: Date.now() - 10 * 60_000, items: 12, bodies: 0 };
  assert.equal(attacher.drifted, false, 'ten minutes later it is not news, it is history');
});
