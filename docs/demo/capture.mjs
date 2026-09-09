/*
 * Produces the images in docs/images/ that the README shows.
 *
 * Nothing here mocks the part being photographed. It serves the demo workspace
 * in docs/demo/workspace.html, runs the real Attacher against a headless
 * Chromium, injects the real client/inject.js, and lets it triage, hold,
 * replace and reveal exactly as it does inside Slack. Every badge, hidden
 * original and reveal toggle in the images was drawn by the shipped page
 * script, and the menu image is rendered from the real menuModel() output.
 *
 * What is staged is the workspace (a fake channel, so no one's real messages
 * end up in a README) and the verdicts: a stub stands in for `claude -p` and
 * returns fixed rewrites, so re-running this produces the same pictures rather
 * than a fresh sample of the model.
 *
 * Run: node docs/demo/capture.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Attacher } from '../../src/attach.js';
import { State } from '../../src/state.js';
import { CdpSession, listTargets, devtoolsVersion } from '../../src/cdp.js';
import { DEFAULTS } from '../../src/config.js';
import { menuModel } from '../../src/menubar.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'images');

// Same search order as the end-to-end test, so this runs on a dev Mac, on CI,
// and in a container that only has a Playwright browser.
const CHROME_CANDIDATES = [
  process.env.SLACKEN_TEST_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const CHROME = CHROME_CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } })
  || (fs.existsSync('/opt/pw-browsers')
    ? fs.readdirSync('/opt/pw-browsers')
      .map((d) => path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome'))
      .find((p) => fs.existsSync(p))
    : null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, { timeoutMs = 20000, everyMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

/* ------------------------------------------------------------- the verdicts */

// What the model would say about the three messages that clear local triage.
// Fixed so the images are reproducible; the shapes are the ones src/moderate.js
// gates on.
const VERDICTS = [
  {
    match: /^WHY is the deploy/,
    verdict: {
      flagged: true, hostile: true, verbose: false,
      tone: ['aggressive', 'accusatory'], severity: 2,
      rewrite: "The deploy is still broken and I've asked about it three times. I need it fixed by 3pm today.",
      note: 'shouting and blame; the 3pm deadline and the count are kept',
    },
  },
  {
    match: /^Hey team! I wanted to take a moment/,
    verdict: {
      flagged: true, hostile: false, verbose: true,
      tone: ['padded'], severity: 2,
      rewrite: 'We should revisit the retry logic before the next release.',
      note: '66 words of throat-clearing around one suggestion',
    },
  },
];

const CLEAN = { flagged: false, hostile: false, verbose: false, tone: [], severity: 0, rewrite: null, note: null };

/* ------------------------------------------------------------------ chrome */

async function startChrome(url) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-shots-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
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

async function openProbe(cdpPort, url) {
  const target = await waitFor('the page target', async () => {
    const targets = await listTargets(cdpPort);
    return targets.find((t) => t.type === 'page' && t.url.startsWith(url)) || null;
  });
  const probe = new CdpSession(target.webSocketDebuggerUrl);
  await probe.connect();
  await probe.send('Page.enable');
  await probe.send('Runtime.enable');
  return probe;
}

async function evaluate(probe, expression) {
  const { result } = await probe.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.value;
}

// Clips to the element the demo page marks as the frame, at 2x, so the images
// stay sharp on the displays a README is read on.
async function shot(probe, name, { selector = '#shot', scale = 2 } = {}) {
  const rect = await evaluate(probe, `(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
  const { data } = await probe.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { ...rect, scale },
  });
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`  wrote docs/images/${name}.png (${kb} KB)`);
}

/* -------------------------------------------------------------- the menu */

// The menu bar item itself is AppKit and only exists on a Mac. Everything it
// says, though, is decided by menuModel() in Node — so the image is drawn from
// that same JSON rather than from a description of it.
function menuHtml(model) {
  const rows = model.items.map((item) => {
    if (item.separator) return '<li class="sep"></li>';
    const cls = item.enabled === false ? 'info' : 'action';
    const key = item.key ? `<span class="key">⌘${item.key.toUpperCase()}</span>` : '';
    return `<li class="${cls}">${escapeHtml(item.label)}${key}</li>`;
  }).join('\n');

  return `<!doctype html>
<meta charset="utf-8">
<title>Slacken menu</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "SF Pro Text", -apple-system, "Helvetica Neue", "Liberation Sans", Arial, sans-serif; }
  #shot { width: 420px; padding: 0 0 22px; background: #cfd4dc; }
  .menubar {
    height: 26px; display: flex; align-items: center; justify-content: space-between;
    padding: 0 12px; background: rgba(255,255,255,.72);
    border-bottom: 1px solid rgba(0,0,0,.12);
    font-size: 12px; color: #1d1d1f;
  }
  .menubar .side { display: flex; align-items: center; gap: 14px; }
  .menubar .item { opacity: .55; }
  .menubar .app { font-weight: 700; opacity: .8; }
  .menubar .slacken {
    display: flex; align-items: center; gap: 6px;
    padding: 2px 7px; border-radius: 5px;
    background: rgba(0,0,0,.10);
    opacity: ${model.dimmed ? '.45' : '1'};
  }
  .menu {
    width: 296px; margin: 5px 12px 0 auto;
    background: rgba(246,246,246,.98);
    border: 1px solid rgba(0,0,0,.12);
    border-radius: 8px;
    box-shadow: 0 12px 34px rgba(0,0,0,.28);
    padding: 5px 0;
    list-style: none;
    font-size: 13px;
    color: #1d1d1f;
  }
  .menu li { padding: 3px 14px; display: flex; justify-content: space-between; gap: 12px; }
  .menu li.info { color: #8b8b8f; }
  .menu li.sep { padding: 0; margin: 5px 12px; border-top: 1px solid rgba(0,0,0,.10); }
  .menu .key { color: #a0a0a4; }
</style>
<div id="shot">
  <div class="menubar">
    <span class="side">
      <span class="app">Slack</span>
      <span class="item">File</span>
      <span class="item">Edit</span>
    </span>
    <span class="side">
      <span class="slacken">${bubbleSvg()}</span>
      <span class="item">Thu 10:14</span>
    </span>
  </div>
  <ul class="menu">
${rows}
  </ul>
</div>`;
}

// Stands in for the SF Symbol the helper actually asks for (text.bubble),
// which is not a font this renderer has.
function bubbleSvg() {
  return '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="#1d1d1f" stroke-width="1.3">'
    + '<path d="M2 4.2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4.6a2 2 0 0 1-2 2H6.6L3.4 13.4V10.8H4a2 2 0 0 1-2-2z"/>'
    + '<path d="M5 5.6h6M5 7.8h4" stroke-linecap="round"/></svg>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/* -------------------------------------------------------------------- main */

async function main() {
  if (!CHROME) {
    console.error(`No Chromium found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`);
    console.error('Set SLACKEN_TEST_CHROME to the browser binary and try again.');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // The demo workspace, plus the menu rendered from the real menuModel().
  const workspace = fs.readFileSync(path.join(HERE, 'workspace.html'));
  const menu = menuHtml(menuModel({
    paused: false,
    attached: 1,
    model: 'claude-haiku-4-5',
    triageMode: 'heuristic',
    uptimeMs: 74 * 60 * 1000,
    stats: { batched: 12, cacheHits: 38, softened: 5, condensed: 3, calls: 4, costUsd: 0.0104 },
  }));

  const server = http.createServer((req, res) => {
    const isMenu = req.url.startsWith('/menu');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(isMenu ? menu : workspace);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const chrome = await startChrome(`${base}/`);
  const state = new State({ persist: false });
  // Start paused so the first image is the channel exactly as it was written.
  state.setPaused(true);

  const moderator = {
    stats: {},
    async moderate({ text }) {
      if (state.paused) return { ...CLEAN, reason: 'paused' };
      const hit = VERDICTS.find((v) => v.match.test(text));
      // A message can clear local triage and still come back clean; that is
      // the path that restores the original in full.
      return hit ? { ...hit.verdict } : { ...CLEAN };
    },
  };

  const events = [];
  const attacher = new Attacher({
    config: { ...DEFAULTS, cdpPort: chrome.cdpPort, targetUrlPattern: '^http://127\\.0\\.0\\.1:' },
    moderator,
    state,
    onEvent: (e) => events.push(e),
  });

  let probe;
  let menuProbe;
  try {
    await attacher.start();
    await waitFor('attach', () => events.some((e) => e.type === 'attached'));

    probe = await openProbe(chrome.cdpPort, `${base}/`);
    await probe.send('Emulation.setDeviceMetricsOverride', {
      width: 1060, height: 760, deviceScaleFactor: 1, mobile: false,
    });

    const states = () => evaluate(probe, `JSON.stringify(
      Array.from(document.querySelectorAll('[data-qa="virtual-list-item"]'))
        .map((el) => [el.id, el.getAttribute('data-slacken')])
    )`);

    // 1. Paused: every message as its sender wrote it. A paused page script
    // examines nothing, so the proof it is running is its injected stylesheet.
    await waitFor('the page script to be injected', () => evaluate(probe, `!!document.getElementById('slacken-style')`));
    await sleep(400);
    console.log('capturing…');
    await shot(probe, 'channel-original');

    // 2. Running: the two suspect messages replaced, the rest untouched.
    state.setPaused(false);
    await waitFor('both rewrites to land', async () => {
      const seen = Object.fromEntries(JSON.parse(await states()));
      return seen['msg-heated'] === 'done' && seen['msg-slop'] === 'done';
    });
    await sleep(250);
    await shot(probe, 'channel-rewritten');

    // 3. One original revealed, by clicking the badge the page script drew.
    await evaluate(probe, `document.querySelector('#msg-heated .slacken-badge').click()`);
    await sleep(250);
    await shot(probe, 'channel-revealed');

    // 4. The menu bar item, from the real menu model.
    const menuTarget = await probe.send('Target.createTarget', { url: `${base}/menu` });
    menuProbe = await openProbe(chrome.cdpPort, `${base}/menu`);
    await menuProbe.send('Emulation.setDeviceMetricsOverride', {
      width: 640, height: 560, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(250);
    await shot(menuProbe, 'menu-bar');
    await probe.send('Target.closeTarget', { targetId: menuTarget.targetId }).catch(() => {});
  } finally {
    probe?.close();
    menuProbe?.close();
    attacher.stop?.();
    chrome.child.kill('SIGKILL');
    server.close();
    fs.rmSync(chrome.userDataDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1); },
);
