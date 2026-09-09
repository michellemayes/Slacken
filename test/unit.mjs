/* Parsing and gating around whatever `claude -p` hands back. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse, normalize } from '../src/moderate.js';
import { devtoolsMessage } from '../src/cdp.js';
import { RepeatLog, logEvent } from '../src/cli.js';
import { Cache } from '../src/cache.js';

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

/* ------------------------------------------------- reporting what failed */

test('a refused devtools connection says what to do about it', () => {
  const err = new Error('fetch failed');
  err.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:9222' };
  const message = devtoolsMessage(err, 9222);
  // "fetch failed", repeated every four seconds, is the message this replaces.
  assert.match(message, /nothing is listening on 127\.0\.0\.1:9222/);
  assert.match(message, /slacken launch/);
});

test('an unrecognised devtools failure still carries its cause', () => {
  const err = new Error('fetch failed');
  err.cause = { code: 'EHOSTUNREACH', message: 'no route to host' };
  assert.equal(devtoolsMessage(err, 9222), 'fetch failed: no route to host');
});

test('RepeatLog says a new failure once and then goes quiet', () => {
  let now = 0;
  const log = new RepeatLog({ summariseAfterMs: 60_000, now: () => now });

  assert.equal(log.fail('poll', 'boom'), 'boom');
  for (let i = 0; i < 200; i += 1) {
    now += 4000;
    if (now < 60_000) assert.equal(log.fail('poll', 'boom'), null);
    else break;
  }
});

test('RepeatLog summarises a failure that will not stop', () => {
  let now = 0;
  const log = new RepeatLog({ summariseAfterMs: 60_000, now: () => now });
  log.fail('poll', 'boom');
  now = 30_000;
  assert.equal(log.fail('poll', 'boom'), null);
  now = 61_000;
  const line = log.fail('poll', 'boom');
  assert.match(line, /still failing after 3 tries over 1m: boom/);
});

test('RepeatLog reports a different message straight away', () => {
  const log = new RepeatLog();
  assert.equal(log.fail('model', 'claude exited 1'), 'claude exited 1');
  assert.equal(log.fail('model', 'claude exited 1'), null);
  assert.equal(log.fail('model', 'claude timed out'), 'claude timed out');
});

test('RepeatLog announces recovery, and only once', () => {
  let now = 0;
  const log = new RepeatLog({ now: () => now });
  log.fail('poll', 'boom');
  now = 8000;
  log.fail('poll', 'boom');
  assert.match(log.ok('poll'), /recovered after 2 failures over 8s/);
  assert.equal(log.ok('poll'), null, 'nothing to recover from twice');
});

test('a zero TTL turns the cache off rather than emptying it onto disk', () => {
  const off = new Cache({ ttlHours: 0, maxEntries: 5000 });
  assert.equal(off.enabled, false);
  off.set('k', { rewrite: 'x' });
  assert.equal(off.map.size, 0, 'a disabled cache holds nothing');
  assert.equal(off.get('k'), null);
  // The important half: flush() must not write an empty file over real entries.
  assert.equal(off.flush(), undefined);
  assert.equal(off.flushTimer, null, 'and must never schedule a write');
});

// Captures what a run of events would actually put in the log.
function capture(events, { config = {}, report = new RepeatLog() } = {}) {
  const lines = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (line) => lines.push(line);
  console.warn = (line) => lines.push(line);
  try {
    for (const event of events) logEvent(event, config, report);
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return lines;
}

test('a model that fails on every message says so, once', () => {
  // The reported symptom: the menu bar counted 234 errors and the log it sent
  // you to had not one word about any of them.
  const failed = {
    type: 'verdict',
    sender: 'Josh',
    channel: 'teamnami-crowddeny',
    text: 'whatever',
    verdict: { flagged: false, tone: [], error: "claude exited 1: unknown option '--json-schema'" },
  };
  const lines = capture(Array.from({ length: 234 }, () => failed));

  assert.ok(lines.length >= 1, 'the log must not be silent about 234 failures');
  assert.ok(lines.length < 10, `234 identical failures should not be 234 lines (got ${lines.length})`);
  assert.match(lines[0], /the model could not judge a message: claude exited 1: unknown option/);
});

test('the log says when the model started working again', () => {
  const report = new RepeatLog();
  const lines = capture([
    { type: 'verdict', channel: 'c', text: 't', verdict: { flagged: false, tone: [], error: 'claude timed out' } },
    { type: 'verdict', channel: 'c', text: 't', verdict: { flagged: false, tone: [], error: 'claude timed out' } },
    { type: 'verdict', sender: 'Ann', channel: 'c', text: 't', verdict: { flagged: true, verbose: true, tone: ['padded'] } },
  ], { report });

  assert.match(lines[0], /claude timed out/);
  assert.match(lines[1], /the model is answering again — recovered after 2 failures/);
  assert.match(lines[2], /condensed Ann in c \(padded\)/);
});

test('a dead debug port is reported once, not every four seconds', () => {
  const report = new RepeatLog();
  const dead = { type: 'poll-error', message: 'nothing is listening on 127.0.0.1:9222 — Slack is not running with its debug port open (run: slacken launch)' };
  const lines = capture([...Array.from({ length: 50 }, () => dead), { type: 'poll-ok' }], { report });

  assert.equal(lines.length, 2, 'one line for the outage, one for the recovery');
  assert.match(lines[0], /slacken launch/);
  assert.match(lines[1], /Slack is reachable again — recovered after 50 failures/);
});
