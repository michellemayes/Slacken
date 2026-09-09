/*
 * End-to-end test of the injection path: a real Chromium, a fake Slack DOM,
 * the real Attacher, and a stub moderator standing in for `claude -p`.
 *
 * This exercises everything except Slack itself: CDP attach, script injection,
 * the binding round trip, triage, DOM replacement, and the reveal toggle.
 *
 * Run: node --test test/e2e.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Attacher } from '../src/attach.js';
import { CdpSession, listTargets, devtoolsVersion } from '../src/cdp.js';
import { DEFAULTS } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.SLACKCENSOR_TEST_CHROME
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, { timeoutMs = 20000, everyMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

function serveFixture() {
  const html = fs.readFileSync(path.join(HERE, 'fixture.html'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function startChrome(cdpPort, url) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slackcensor-test-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    url,
  ], { stdio: 'ignore' });

  await waitFor('devtools endpoint', async () => {
    try {
      await devtoolsVersion(cdpPort);
      return true;
    } catch {
      return false;
    }
  });
  return { child, userDataDir };
}

test('injected script rewrites heated messages and leaves the rest alone', async (t) => {
  if (!fs.existsSync(CHROME)) {
    t.skip(`no chromium at ${CHROME}`);
    return;
  }

  const cdpPort = 9000 + Math.floor(Math.random() * 900);
  const { server, port } = await serveFixture();
  const url = `http://127.0.0.1:${port}/`;
  const chrome = await startChrome(cdpPort, url);

  const asked = [];
  const moderator = {
    stats: {},
    async moderate({ text, sender, channel }) {
      asked.push({ text, sender, channel });
      return {
        flagged: true,
        tone: ['aggressive', 'urgent'],
        severity: 2,
        rewrite: `NEUTRAL(${text.length})`,
        note: 'test rewrite',
      };
    },
  };

  const config = {
    ...DEFAULTS,
    cdpPort,
    targetUrlPattern: '^http://127\\.0\\.0\\.1:',
    triageThreshold: 2,
  };

  const events = [];
  const attacher = new Attacher({ config, moderator, onEvent: (e) => events.push(e) });

  let probe;
  try {
    await attacher.start();
    await waitFor('attach', () => events.some((e) => e.type === 'attached'));

    const targets = await listTargets(cdpPort);
    const page = targets.find((x) => x.type === 'page' && x.url.startsWith(url));
    assert.ok(page, 'fixture page target should exist');
    probe = new CdpSession(page.webSocketDebuggerUrl);
    await probe.connect();

    const read = async (expression) => {
      const { result } = await probe.send('Runtime.evaluate', { expression, returnByValue: true });
      return result.value;
    };

    const snapshot = () => read(`(() => {
      const pick = (id) => {
        const item = document.getElementById(id);
        if (!item) return null;
        const body = item.querySelector('.c-message_kit__blocks');
        const panel = item.querySelector('.slackcensor-panel');
        return {
          state: item.getAttribute('data-slackcensor'),
          bodyState: body ? body.getAttribute('data-slackcensor-body') : null,
          bodyVisible: body ? body.offsetParent !== null : null,
          rewrite: panel ? panel.querySelector('.slackcensor-rewrite').textContent : null,
          action: panel ? panel.querySelector('.slackcensor-action').textContent : null,
        };
      };
      return JSON.stringify({
        heated: pick('msg-heated'),
        grouped: pick('msg-grouped'),
        neutral: pick('msg-neutral'),
        mine: pick('msg-mine'),
      });
    })()`);

    const state = JSON.parse(await waitFor('both heated messages rewritten', async () => {
      const raw = await snapshot();
      const parsed = JSON.parse(raw);
      return parsed.heated?.state === 'done' && parsed.grouped?.state === 'done' ? raw : null;
    }));

    await t.test('the heated message is replaced and its original hidden', () => {
      assert.equal(state.heated.bodyState, 'hidden');
      assert.equal(state.heated.bodyVisible, false);
      assert.match(state.heated.rewrite, /^NEUTRAL\(/);
      assert.equal(state.heated.action, 'show original');
    });

    await t.test('a grouped follow-up inherits the sender above it', () => {
      const grouped = asked.find((a) => a.text.startsWith('I already asked'));
      assert.ok(grouped, 'grouped message should have been sent for moderation');
      assert.equal(grouped.sender, 'Dana Wu');
      assert.equal(grouped.channel, '#eng-oncall');
    });

    await t.test('a neutral message is never sent to the model', () => {
      assert.equal(state.neutral.state, 'clean');
      assert.equal(state.neutral.rewrite, null);
      assert.ok(!asked.some((a) => a.text.startsWith('Deploy is queued')));
    });

    await t.test('my own heated message is skipped', () => {
      assert.equal(state.mine.state, 'skipped');
      assert.equal(state.mine.rewrite, null);
      assert.ok(!asked.some((a) => a.text.startsWith('URGENT: I need this')));
    });

    await t.test('clicking the badge reveals the original, clicking again hides it', async () => {
      await read(`document.querySelector('#msg-heated .slackcensor-badge').click()`);
      let after = JSON.parse(await snapshot());
      assert.equal(after.heated.bodyState, 'shown');
      assert.equal(after.heated.bodyVisible, true);
      assert.equal(after.heated.action, 'hide original');

      await read(`document.querySelector('#msg-heated .slackcensor-badge').click()`);
      after = JSON.parse(await snapshot());
      assert.equal(after.heated.bodyState, 'hidden');
      assert.equal(after.heated.bodyVisible, false);
      assert.equal(after.heated.action, 'show original');
    });

    await t.test('a re-render that drops our panel is repaired', async () => {
      await read(`document.querySelector('#msg-heated .slackcensor-panel').remove()`);
      const repaired = await waitFor('panel re-applied', async () => {
        const parsed = JSON.parse(await snapshot());
        return parsed.heated.rewrite ? parsed.heated : null;
      });
      assert.match(repaired.rewrite, /^NEUTRAL\(/);
      assert.equal(repaired.bodyState, 'hidden');
      // Repair comes from the in-page cache, not another model call.
      assert.equal(asked.filter((a) => a.text.startsWith('WHY is the deploy')).length, 1);
    });
  } finally {
    probe?.close();
    attacher.stop();
    server.close();
    chrome.child.kill('SIGKILL');
    try {
      fs.rmSync(chrome.userDataDir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
});
