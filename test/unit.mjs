/* Parsing and gating around whatever `claude -p` hands back. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse, normalize } from '../src/moderate.js';
import { compareVersions, checkForUpdate } from '../src/version.js';

const SOFTEN = {
  id: 'm0',
  hostile: true,
  verbose: false,
  tone: ['aggressive', 'urgent'],
  severity: 2,
  rewrite: 'Could you look at the deploy? I need it by 3pm.',
  note: 'removed shouting',
};

const PADDED = Array(60).fill('padding').join(' ');
const CONDENSE = {
  id: 'm1',
  hostile: false,
  verbose: true,
  tone: ['padded', 'ai-slop'],
  severity: 2,
  rewrite: 'Staging is unstable.',
  note: 'cut filler',
};

const envelope = (obj, cost = 0.0007) => JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: cost,
  result: typeof obj === 'string' ? obj : JSON.stringify(obj),
});

test('parseResponse unwraps the envelope and reports the cost', () => {
  const { verdicts, costUsd } = parseResponse(envelope({ verdicts: [SOFTEN, CONDENSE] }, 0.0012));
  assert.equal(verdicts.length, 2);
  assert.deepEqual(verdicts[0], SOFTEN);
  assert.equal(costUsd, 0.0012);
});

test('parseResponse survives a fenced or chatty result', () => {
  const body = `Here you go:\n\`\`\`json\n${JSON.stringify({ verdicts: [SOFTEN] })}\n\`\`\`\nHope that helps.`;
  assert.deepEqual(parseResponse(envelope(body)).verdicts, [SOFTEN]);
});

test('parseResponse handles a bare object with no envelope', () => {
  assert.deepEqual(parseResponse(JSON.stringify({ verdicts: [SOFTEN] })).verdicts, [SOFTEN]);
});

test('parseResponse is not confused by braces inside strings', () => {
  const tricky = { ...SOFTEN, rewrite: 'Check the config: {"retries": 3} please.' };
  assert.deepEqual(parseResponse(envelope({ verdicts: [tricky] })).verdicts, [tricky]);
});

test('parseResponse returns null verdicts when there is no usable object', () => {
  assert.equal(parseResponse('I refuse to answer.').verdicts, null);
  assert.equal(parseResponse('').verdicts, null);
  assert.equal(parseResponse(envelope({ nope: true })).verdicts, null);
});

test('normalize keeps a genuine soften', () => {
  const out = normalize(SOFTEN, { minSeverity: 2 }, 'WHY IS THIS STILL BROKEN');
  assert.equal(out.flagged, true);
  assert.equal(out.hostile, true);
  assert.equal(out.verbose, false);
  assert.equal(out.rewrite, SOFTEN.rewrite);
});

test('normalize drops a soften below the severity floor', () => {
  const out = normalize({ ...SOFTEN, severity: 1 }, { minSeverity: 2 }, 'mild');
  assert.equal(out.flagged, false);
  assert.equal(out.rewrite, null, 'nothing to swap in means nothing gets swapped');
});

test('normalize drops any verdict with no rewrite text', () => {
  for (const rewrite of [null, '', '   ', 42]) {
    const out = normalize({ ...SOFTEN, rewrite }, { minSeverity: 2 }, 'text');
    assert.equal(out.flagged, false);
    assert.equal(out.rewrite, null);
  }
});

test('normalize keeps a condense of a long padded message', () => {
  const out = normalize(CONDENSE, { condenseMinWords: 45, condenseMaxRatio: 0.7 }, PADDED);
  assert.equal(out.flagged, true);
  assert.equal(out.verbose, true);
  assert.equal(out.hostile, false);
  assert.equal(out.rewrite, 'Staging is unstable.');
});

test('normalize refuses to condense a message that was never long', () => {
  const out = normalize(CONDENSE, { condenseMinWords: 45 }, 'Staging is a bit flaky today, worth a look.');
  assert.equal(out.flagged, false, 'a short message has no padding worth cutting');
  assert.equal(out.verbose, false);
});

test('normalize refuses a condense that did not actually shorten anything', () => {
  const barelyShorter = { ...CONDENSE, rewrite: Array(50).fill('padding').join(' ') };
  const out = normalize(barelyShorter, { condenseMinWords: 45, condenseMaxRatio: 0.7 }, PADDED);
  assert.equal(out.flagged, false, 'swapping 60 words for 50 is all cost and no benefit');
});

test('normalize handles a message that is both hostile and padded', () => {
  const both = { ...CONDENSE, hostile: true, severity: 3, rewrite: 'Staging is broken.' };
  const out = normalize(both, { minSeverity: 2, condenseMinWords: 45 }, PADDED);
  assert.equal(out.hostile, true);
  assert.equal(out.verbose, true);
});

test('normalize clamps severity and filters unknown tone labels', () => {
  const out = normalize({ ...SOFTEN, severity: 9, tone: ['aggressive', 'spicy', 7] }, { minSeverity: 2 }, 'x');
  assert.equal(out.severity, 3);
  assert.deepEqual(out.tone, ['aggressive']);
});

test('normalize tolerates a garbage severity', () => {
  const out = normalize({ ...SOFTEN, severity: 'very bad' }, { minSeverity: 2 }, 'x');
  assert.equal(out.severity, 0);
  assert.equal(out.flagged, false);
});


/* ------------------------------------------------------------- versions */

test('a newer version is recognised, numerically', () => {
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0, '10 is not less than 9 because it starts with a 1');
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.ok(compareVersions('0.2.0', '0.2.1') < 0);
  // A tag with a suffix is still comparable, and never newer than the release.
  assert.ok(compareVersions('0.2.0', '0.2.0-rc1') > 0);
});

test('the update check does nothing at all unless it has been turned on', async () => {
  // The only thing in Slacken that talks to anything but your own machine, so
  // "off" has to mean no request rather than a request whose answer is
  // ignored.
  let asked = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { asked = true; throw new Error('should not have been called'); };
  try {
    assert.equal(await checkForUpdate({ checkUpdates: false }), null);
    assert.equal(asked, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
