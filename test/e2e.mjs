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
import { State } from '../src/state.js';
import { CdpSession, listTargets, devtoolsVersion } from '../src/cdp.js';
import { DEFAULTS } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Any Chromium will do. Checked in order so this runs unchanged on a dev Mac,
// on CI, and in a container with only a Playwright browser installed.
const CHROME_CANDIDATES = [
  process.env.SLACKEN_TEST_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].filter(Boolean);

const CHROME = CHROME_CANDIDATES.find((p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}) || (fs.existsSync('/opt/pw-browsers')
  ? fs.readdirSync('/opt/pw-browsers')
    .map((d) => path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome'))
    .find((p) => fs.existsSync(p))
  : null);

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

// Port 0 lets Chrome pick a free port and write it to DevToolsActivePort.
// Picking a random port ourselves means occasionally attaching to a Chrome
// left over from an earlier run, which fails in a confusing way.
async function startChrome(url) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-test-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    url,
  ], { stdio: 'ignore' });

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const cdpPort = await waitFor('chrome to publish its debug port', async () => {
    try {
      const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
      if (!port) return null;
      await devtoolsVersion(port);
      return port;
    } catch {
      return null;
    }
  });
  return { child, userDataDir, cdpPort };
}

test('injected script rewrites heated messages and leaves the rest alone', async (t) => {
  if (!CHROME) {
    t.skip(`no chromium found; tried ${CHROME_CANDIDATES.join(', ')}`);
    return;
  }

  const { server, port } = await serveFixture();
  const url = `http://127.0.0.1:${port}/`;
  const chrome = await startChrome(url);
  const { cdpPort } = chrome;

  const asked = [];
  let holdRelease;
  const heldTurn = new Promise((resolve) => { holdRelease = resolve; });
  let pauseRelease;
  const pausedTurn = new Promise((resolve) => { pauseRelease = resolve; });

  const CLEAN = { flagged: false, hostile: false, verbose: false, tone: [], severity: 0, rewrite: null, note: null };

  const moderator = {
    stats: {},
    async moderate({ text, sender, channel }) {
      // The real Moderator refuses before it reaches the model; this stub
      // stands in for both, so it has to refuse in the same place.
      if (pauseState.paused) return { ...CLEAN, reason: 'paused' };
      asked.push({ text, sender, channel });

      // The message used to test what happens when a verdict lands after a
      // pause has already begun: it is held open until the test says so.
      if (text.startsWith('HOLD EVERYTHING')) await pausedTurn;

      // The message used to test the optimistic hold: block until the test
      // has had a chance to look at the mid-flight state, then come back clean.
      if (text.startsWith('PLEASE take a look')) {
        await heldTurn;
        return { ...CLEAN };
      }

      const verbose = text.split(/\s+/).length >= 45;
      return {
        flagged: true,
        hostile: !verbose,
        verbose,
        tone: verbose ? ['padded', 'ai-slop'] : ['aggressive', 'urgent'],
        severity: 2,
        rewrite: verbose ? 'CONDENSED to one sentence.' : `NEUTRAL(${text.length})`,
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
  // Named for what it holds, not just `state`: the DOM snapshots below use
  // that name for something else entirely.
  const pauseState = new State({ persist: false });
  const attacher = new Attacher({ config, moderator, state: pauseState, onEvent: (e) => events.push(e) });

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
        const panel = item.querySelector('.slacken-panel');
        return {
          state: item.getAttribute('data-slacken'),
          hold: item.getAttribute('data-slacken-hold'),
          bodyState: body ? body.getAttribute('data-slacken-body') : null,
          bodyVisible: body ? body.offsetParent !== null : null,
          rewrite: panel ? panel.querySelector('.slacken-rewrite').textContent : null,
          action: panel ? (panel.querySelector('.slacken-action') || {}).textContent ?? null : null,
          label: panel ? (panel.querySelector('.slacken-badge span:nth-child(2)') || {}).textContent ?? null : null,
          pending: panel ? panel.dataset.pending === '1' : false,
          reserved: panel ? panel.style.minHeight : null,
        };
      };
      return JSON.stringify({
        heated: pick('msg-heated'),
        grouped: pick('msg-grouped'),
        neutral: pick('msg-neutral'),
        mine: pick('msg-mine'),
        slop: pick('msg-slop'),
        dense: pick('msg-dense'),
        code: pick('msg-code'),
        hold: pick('msg-hold'),
        arrived: pick('msg-arrived'),
        inflight: pick('msg-inflight'),
      });
    })()`);

    const state = JSON.parse(await waitFor('heated and padded messages handled', async () => {
      const raw = await snapshot();
      const p = JSON.parse(raw);
      return p.heated?.state === 'done' && p.grouped?.state === 'done' && p.slop?.state === 'done'
        ? raw : null;
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

    await t.test('a padded message is condensed to one sentence', () => {
      assert.equal(state.slop.state, 'done');
      assert.equal(state.slop.bodyState, 'hidden');
      assert.equal(state.slop.rewrite, 'CONDENSED to one sentence.');
      assert.equal(state.slop.label, 'condensed', 'the badge should say what it did');
      assert.ok(asked.some((a) => a.text.startsWith('Hey team! I wanted to take a moment')));
    });

    await t.test('a long but fact-dense message is left alone', () => {
      assert.equal(state.dense.state, 'clean');
      assert.equal(state.dense.rewrite, null);
      assert.ok(
        !asked.some((a) => a.text.startsWith('Migration 0042')),
        'length alone must not trigger a condense; that message is all facts',
      );
    });

    await t.test('a message containing a code block is never condensed', () => {
      assert.equal(state.code.state, 'clean');
      assert.ok(
        !asked.some((a) => a.text.includes('retry(3,')),
        'padding phrases around a code block must not cost a call',
      );
    });

    await t.test('a suspected message is hidden the moment triage suspects it', async () => {
      assert.equal(state.hold.pending, true, 'the hold panel should be up');
      assert.equal(state.hold.bodyState, 'hidden', 'you should not be reading it yet');
      assert.equal(state.hold.bodyVisible, false);
      assert.match(
        state.hold.reserved,
        /^\d+(\.\d+)?px$/,
        'the hold should keep the message\'s height so the page does not jump',
      );
    });

    await t.test('a hold that runs long says so, but only after a beat', async () => {
      // Silence first: a cached verdict lands inside PENDING_LABEL_MS and swaps
      // straight in, so a fast answer never flashes a placeholder on the way.
      const placeholder = await waitFor('the placeholder to appear', async () => {
        const p = JSON.parse(await snapshot());
        return p.hold.rewrite === 'checking…' ? p.hold : null;
      });
      assert.equal(placeholder.bodyVisible, false, 'still not readable');
    });

    await t.test('a held message the model clears is restored in full', async () => {
      holdRelease();
      const restored = await waitFor('hold released', async () => {
        const p = JSON.parse(await snapshot());
        return p.hold.state === 'clean' ? p.hold : null;
      });
      assert.equal(restored.bodyState, null, 'our attribute should be gone entirely');
      assert.equal(restored.bodyVisible, true);
      assert.equal(restored.rewrite, null, 'no panel should be left behind');
    });

    await t.test('clicking the badge reveals the original, clicking again hides it', async () => {
      await read(`document.querySelector('#msg-heated .slacken-badge').click()`);
      let after = JSON.parse(await snapshot());
      assert.equal(after.heated.bodyState, 'shown');
      assert.equal(after.heated.bodyVisible, true);
      assert.equal(after.heated.action, 'hide original');

      await read(`document.querySelector('#msg-heated .slacken-badge').click()`);
      after = JSON.parse(await snapshot());
      assert.equal(after.heated.bodyState, 'hidden');
      assert.equal(after.heated.bodyVisible, false);
      assert.equal(after.heated.action, 'show original');
    });

    await t.test('a body Slack re-renders comes back already hidden', async () => {
      // The flash this guards against: Slack replaces the message body, our
      // attribute goes with it, and the original paints at full opacity until
      // something notices. The hold lives on the list item, so the replacement
      // is hidden by the cascade before it can be painted at all.
      const visible = await read(`(() => {
        const item = document.getElementById('msg-heated');
        const body = item.querySelector('.c-message_kit__blocks');
        const fresh = body.cloneNode(true);
        fresh.removeAttribute('data-slacken-body');
        body.replaceWith(fresh);
        // Read back in the same task, before any observer or timer could run.
        return fresh.offsetParent !== null;
      })()`);
      assert.equal(visible, false, 'the re-rendered original must never be readable');

      const after = JSON.parse(await snapshot());
      assert.equal(after.heated.hold, '1');
      assert.match(after.heated.rewrite, /^NEUTRAL\(/, 'the rewrite should still be up');
    });

    await t.test('a re-render that drops our panel is repaired', async () => {
      await read(`document.querySelector('#msg-heated .slacken-panel').remove()`);
      const repaired = await waitFor('panel re-applied', async () => {
        const parsed = JSON.parse(await snapshot());
        return parsed.heated.rewrite ? parsed.heated : null;
      });
      assert.match(repaired.rewrite, /^NEUTRAL\(/);
      assert.equal(repaired.bodyState, 'hidden');
      // Repair comes from the in-page cache, not another model call.
      assert.equal(asked.filter((a) => a.text.startsWith('WHY is the deploy')).length, 1);
    });

    // Everything below is the pause: the menu bar item's only real job is
    // flipping this, so this is the behaviour behind that click.
    await t.test('pausing shows every rewritten message as it was written', async () => {
      pauseState.setPaused(true);
      const paused = await waitFor('originals revealed', async () => {
        const p = JSON.parse(await snapshot());
        return p.heated.bodyState === 'shown' && p.slop.bodyState === 'shown' ? p : null;
      });
      assert.equal(paused.heated.bodyVisible, true);
      assert.equal(paused.heated.action, 'hide original', 'the badge has to agree with what is on screen');
      assert.equal(paused.slop.bodyVisible, true);
    });

    // Slack renders new messages by appending to the virtual list; this does
    // the same thing to the fixture.
    const arrive = (id, text) => read(`(() => {
      const item = document.getElementById('msg-heated').cloneNode(true);
      item.id = ${JSON.stringify(id)};
      item.removeAttribute('data-slacken');
      item.removeAttribute('data-slacken-hash');
      item.querySelectorAll('.slacken-panel').forEach((el) => el.remove());
      const body = item.querySelector('.c-message_kit__blocks');
      body.removeAttribute('data-slacken-body');
      item.querySelector('.p-rich_text_section').textContent = ${JSON.stringify(text)};
      document.querySelector('.c-virtual_list__scroll_container').appendChild(item);
    })()`);

    await t.test('a message that arrives during a pause is never sent to the model', async () => {
      const before = asked.length;
      await arrive('msg-arrived', 'THIS IS COMPLETELY UNACCEPTABLE!! Why has NOBODY fixed the build??');

      // Long enough for a scan to have run and not asked about it.
      await sleep(1500);
      const arrived = JSON.parse(await snapshot()).arrived;
      assert.ok(arrived, 'the new message should be in the DOM');
      assert.equal(arrived.state, null, 'a paused Slacken should not even triage');
      assert.equal(arrived.bodyVisible, true, 'and it must be readable as written');
      assert.equal(asked.length, before, 'a pause has to be free');
    });

    await t.test('resuming picks up what the pause let through', async () => {
      pauseState.setPaused(false);
      const arrived = await waitFor('the message that arrived during the pause', async () => {
        const p = JSON.parse(await snapshot()).arrived;
        return p?.state === 'done' ? p : null;
      });
      assert.match(arrived.rewrite, /^NEUTRAL\(/);
      assert.equal(arrived.bodyState, 'hidden');

      // A message decided before the pause keeps its verdict rather than
      // costing a second call to reach the same answer.
      const heated = JSON.parse(await snapshot()).heated;
      assert.equal(heated.bodyState, 'hidden');
      assert.equal(heated.action, 'show original');
      assert.equal(asked.filter((a) => a.text.startsWith('WHY is the deploy')).length, 1);
    });

    await t.test('a verdict that lands during a pause is thrown away, not remembered', async () => {
      const text = 'HOLD EVERYTHING RIGHT NOW, the build is COMPLETELY BROKEN!!';
      await arrive('msg-inflight', text);
      await waitFor('the message to be sent for moderation', () => asked.some((a) => a.text === text));

      // The verdict is still in flight. Pause, then let it come back: it is a
      // real rewrite, and applying it would be Slacken changing the screen
      // after being told to stop.
      pauseState.setPaused(true);
      pauseRelease();
      await sleep(1000);

      const during = JSON.parse(await snapshot()).inflight;
      assert.equal(during.rewrite, null, 'nothing should have been swapped in');
      assert.equal(during.bodyVisible, true);

      // ...and forgetting it is what lets the message be looked at again.
      pauseState.setPaused(false);
      const after = await waitFor('the message examined again after resuming', async () => {
        const p = JSON.parse(await snapshot()).inflight;
        return p?.state === 'done' ? p : null;
      });
      assert.match(after.rewrite, /^NEUTRAL\(/);
      assert.equal(asked.filter((a) => a.text === text).length, 2, 'it has to actually be re-asked');
    });
  } finally {
    holdRelease?.();
    pauseRelease?.();
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
