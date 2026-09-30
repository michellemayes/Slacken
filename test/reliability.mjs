/*
 * Failure paths: what happens when a request handler throws, a devtools
 * target stops answering, a config file holds nonsense, or a file is being
 * rewritten when the process dies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createServer } from '../src/server.js';
import { CdpSession } from '../src/cdp.js';
import { DEFAULTS, ConfigStore, loadConfig } from '../src/config.js';
import { State } from '../src/state.js';
import { History } from '../src/history.js';
import { Cache } from '../src/cache.js';
import { trimLog } from '../src/agent.js';
import { writeFileAtomic } from '../src/fsutil.js';

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-reliability-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/* ---------------------------------------------------------------- server */

test('a handler that throws answers 500 and leaves the server running', async () => {
  const store = new ConfigStore({ values: { ...DEFAULTS, httpPort: 0 }, persist: false });
  const server = await createServer({
    config: store.values,
    moderator: {
      stats: {},
      lastError: null,
      whereIsClaude: async () => ({}),
      moderate: async () => { throw new Error('model exploded'); },
    },
    state: new State({ persist: false }),
    store,
    getStatus: () => ({ attached: 0 }),
    reinject: async () => { throw new Error('no windows'); },
    inspect: async () => { throw new Error('page went away'); },
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const inspect = await fetch(`${base}/inspect`);
    assert.equal(inspect.status, 500);
    assert.match((await inspect.json()).error, /page went away/);

    const moderate = await fetch(`${base}/moderate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(moderate.status, 500);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200, 'still answering after two failures');
  } finally {
    server.close();
  }
});

/* ------------------------------------------------------------------- cdp */

async function silentDevtools() {
  // Accepts the connection and never answers a command.
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));
  return { url: `ws://127.0.0.1:${wss.address().port}`, close: () => wss.close() };
}

test('a devtools command that is never answered times out instead of hanging', async () => {
  const devtools = await silentDevtools();
  const session = new CdpSession(devtools.url);
  try {
    await session.connect();
    await assert.rejects(
      session.send('Runtime.evaluate', { expression: '1' }, { timeoutMs: 150 }),
      /Runtime.evaluate timed out after 150ms/,
    );
    assert.equal(session.pending.size, 0, 'nothing left waiting');
  } finally {
    session.close();
    devtools.close();
  }
});

test('commands in flight fail when the connection drops', async () => {
  const devtools = await silentDevtools();
  const session = new CdpSession(devtools.url);
  try {
    await session.connect();
    const inFlight = session.send('Page.enable');
    session.ws.terminate();
    await assert.rejects(inFlight, /cdp connection closed/);
    await assert.rejects(session.send('Page.enable'), /not open/);
  } finally {
    devtools.close();
  }
});

/* ---------------------------------------------------------------- config */

test('a config file holding nonsense falls back to the defaults, key by key', () => {
  const { dir, cleanup } = tempDir();
  const warn = console.warn;
  const warnings = [];
  console.warn = (line) => warnings.push(line);
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({
      batchSize: 0,
      minSeverity: 'high',
      triageMode: 'sometimes',
      requestTimeoutMs: '30000',
      condenseEnabled: 'off',
      targetUrlPattern: '([',
      model: 'claude-haiku-4-5-20251001',
      somethingWeDoNotKnowAbout: 'kept',
    }));
    const config = loadConfig(file);
    assert.equal(config.batchSize, DEFAULTS.batchSize);
    assert.equal(config.minSeverity, DEFAULTS.minSeverity);
    assert.equal(config.triageMode, DEFAULTS.triageMode);
    assert.equal(config.targetUrlPattern, DEFAULTS.targetUrlPattern);
    assert.equal(config.requestTimeoutMs, 30000, 'a number written as a string is still a number');
    assert.equal(config.condenseEnabled, false, 'written the way `slacken set` accepts it');
    assert.equal(config.somethingWeDoNotKnowAbout, 'kept');
    assert.equal(warnings.length, 4, warnings.join('\n'));
    assert.ok(warnings.every((w) => w.includes(file)), 'each warning names the file to fix');
  } finally {
    console.warn = warn;
    cleanup();
  }
});

test('a patch with a bad value in it changes nothing at all', () => {
  const store = new ConfigStore({ values: { ...DEFAULTS }, persist: false });
  const heard = [];
  store.onChange((changed) => heard.push(changed));
  const { changed, errors } = store.update({ triageMode: 'always', minSeverity: 9 });
  assert.deepEqual(changed, []);
  assert.equal(errors.length, 1);
  assert.equal(store.values.triageMode, DEFAULTS.triageMode, 'the valid half was not applied either');
  assert.deepEqual(heard, []);
});

/* ----------------------------------------------------------------- files */

test('an atomic write leaves the new content and no temp file behind', () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = path.join(dir, 'nested', 'state.json');
    writeFileAtomic(file, 'one');
    writeFileAtomic(file, 'two');
    assert.equal(fs.readFileSync(file, 'utf8'), 'two');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
  } finally {
    cleanup();
  }
});

test('the history is trimmed on the first write, not only after two hundred', () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = path.join(dir, 'history.jsonl');
    const old = Array.from({ length: 50 }, (_, i) => JSON.stringify({ kind: 'softened', n: i }));
    fs.writeFileSync(file, old.join('\n') + '\n');
    const history = new History({ file, maxEntries: 10 });
    history.record({ kind: 'revealed' });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 10);
    assert.equal(JSON.parse(lines.at(-1)).kind, 'revealed', 'the newest entry survives the trim');
  } finally {
    cleanup();
  }
});

test('the agent log is cut back to its tail, starting on a whole line', () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = path.join(dir, 'agent.log');
    const lines = Array.from({ length: 2000 }, (_, i) => `[slacken] line ${i}`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    assert.equal(trimLog(file, { maxBytes: 1000, keepBytes: 200 }), true);
    const kept = fs.readFileSync(file, 'utf8');
    assert.ok(kept.length <= 200);
    assert.match(kept, /^\[slacken\] line \d+\n/, 'no half line at the top');
    assert.ok(kept.endsWith('[slacken] line 1999\n'));
    assert.equal(trimLog(file, { maxBytes: 1000, keepBytes: 200 }), false, 'small enough now');
  } finally {
    cleanup();
  }
});

test('the verdict cache evicts what was used least recently, not what was stored first', () => {
  const cache = new Cache({ ttlHours: 1, maxEntries: 2 });
  cache.map.clear();
  cache.flush = () => {};
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('a'), 1, 'recently read, so kept');
  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('c'), 3);
});
