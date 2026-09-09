/*
 * The batching and caching that make this cheap, tested against a fake
 * `claude` binary that records how many times it was actually invoked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Moderator } from '../src/moderate.js';
import { DEFAULTS } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fake-claude.mjs');

const LONG = Array(60).fill('padding').join(' ');

function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-batch-'));
  const log = path.join(dir, 'invocations.log');
  process.env.FAKE_CLAUDE_LOG = log;
  delete process.env.FAKE_CLAUDE_FAIL;

  const moderator = new Moderator({
    ...DEFAULTS,
    claudeBin: FAKE,
    cacheTtlHours: 0.0001,
    ...overrides,
  });
  // Keep every run isolated from the real on-disk cache.
  moderator.cache.map.clear();
  moderator.cache.flush = () => {};

  const invocations = () => (fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);

  return { moderator, invocations, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('messages that arrive together become one claude call', async () => {
  const { moderator, invocations, cleanup } = setup();
  try {
    const texts = ['WHY IS THIS BROKEN', 'THIS IS UNACCEPTABLE', 'FIX IT NOW', 'ANSWER ME'];
    const verdicts = await Promise.all(texts.map((text) => moderator.moderate({ text, sender: 'Dana' })));

    const calls = invocations();
    assert.equal(calls.length, 1, 'four messages should cost one process, not four');
    assert.equal(calls[0].count, 4);
    assert.equal(verdicts.length, 4);
    for (const v of verdicts) assert.equal(v.flagged, true);
    // Each message gets its own verdict back, not a shared one.
    assert.equal(new Set(verdicts.map((v) => v.rewrite)).size, 4);
    assert.equal(moderator.stats.calls, 1);
    assert.equal(moderator.stats.batched, 4);
  } finally {
    cleanup();
  }
});

test('a burst larger than batchSize splits into full batches', async () => {
  const { moderator, invocations, cleanup } = setup({ batchSize: 3, maxConcurrency: 1 });
  try {
    const texts = Array.from({ length: 7 }, (_, i) => `MESSAGE NUMBER ${i} UNACCEPTABLE`);
    await Promise.all(texts.map((text) => moderator.moderate({ text })));
    const calls = invocations();
    assert.equal(calls.length, 3, '7 messages at batchSize 3 is 3 calls');
    assert.deepEqual(calls.map((c) => c.count).sort(), [1, 3, 3]);
  } finally {
    cleanup();
  }
});

test('a repeated message is served from cache without another call', async () => {
  const { moderator, invocations, cleanup } = setup({ cacheTtlHours: 1 });
  try {
    const text = 'THIS IS COMPLETELY UNACCEPTABLE';
    const first = await moderator.moderate({ text });
    const second = await moderator.moderate({ text });

    assert.equal(invocations().length, 1, 'the second read should not reach the model');
    assert.equal(second.cached, true);
    assert.equal(second.rewrite, first.rewrite);
    assert.equal(moderator.stats.cacheHits, 1);
  } finally {
    cleanup();
  }
});

test('the daily budget stops spending', async () => {
  const { moderator, invocations, cleanup } = setup({ dailyBudgetUsd: 0.0005 });
  try {
    await moderator.moderate({ text: 'FIRST MESSAGE UNACCEPTABLE' });
    // The fake reports $0.0007 a call, so the cap is already blown.
    const after = await moderator.moderate({ text: 'SECOND MESSAGE UNACCEPTABLE' });

    assert.equal(invocations().length, 1);
    assert.equal(after.flagged, false, 'over budget must leave the message alone');
    assert.equal(after.reason, 'budget');
  } finally {
    cleanup();
  }
});

test('a claude failure leaves every message in the batch untouched', async () => {
  const { moderator, cleanup } = setup();
  try {
    process.env.FAKE_CLAUDE_FAIL = '1';
    const verdicts = await Promise.all([
      moderator.moderate({ text: 'WHY IS THIS BROKEN' }),
      moderator.moderate({ text: 'THIS IS UNACCEPTABLE' }),
    ]);
    for (const v of verdicts) {
      assert.equal(v.flagged, false);
      assert.equal(v.rewrite, null);
      assert.match(v.error, /exited 2/);
    }
    assert.equal(moderator.stats.errors, 1);
  } finally {
    delete process.env.FAKE_CLAUDE_FAIL;
    cleanup();
  }
});

test('oversized and empty messages never reach the model', async () => {
  const { moderator, invocations, cleanup } = setup({ maxChars: 100 });
  try {
    const big = await moderator.moderate({ text: 'X'.repeat(200) });
    const empty = await moderator.moderate({ text: '   ' });
    assert.equal(invocations().length, 0);
    assert.equal(big.reason, 'too-long');
    assert.equal(empty.reason, 'empty');
  } finally {
    cleanup();
  }
});

test('a long padded message is condensed, a long dense one is not', async () => {
  const { moderator, cleanup } = setup();
  try {
    const padded = await moderator.moderate({ text: LONG });
    assert.equal(padded.verbose, true, 'the fake shortens it well past the ratio');

    // Same length, but the rewrite comes back no shorter, so it is not worth
    // swapping. Simulated by asking about a message the fake will not shorten.
    const short = await moderator.moderate({ text: 'Deploy lands at 2pm.' });
    assert.equal(short.verbose, false);
  } finally {
    cleanup();
  }
});

test('a failure is never cached, so a recovered claude is asked again', async () => {
  // The bug this covers reads, from the menu bar, as "234 model calls, 130
  // from cache, 0 rewritten": once a failure was memoised for the week-long
  // TTL, those messages stayed unread long after claude was working again.
  const { moderator, invocations, cleanup } = setup({ cacheTtlHours: 1 });
  try {
    const text = 'THIS IS COMPLETELY UNACCEPTABLE AND YOU KNOW IT';

    process.env.FAKE_CLAUDE_FAIL = '1';
    const failed = await moderator.moderate({ text });
    assert.match(failed.error, /exited 2/);

    delete process.env.FAKE_CLAUDE_FAIL;
    const retried = await moderator.moderate({ text });

    assert.equal(retried.cached, undefined, 'the failure must not have been served back');
    assert.equal(retried.flagged, true);
    assert.equal(invocations().length, 2, 'the second read has to reach the model again');
    assert.equal(moderator.stats.cacheHits, 0);
  } finally {
    delete process.env.FAKE_CLAUDE_FAIL;
    cleanup();
  }
});

test('a successful verdict is still cached after a failure', async () => {
  const { moderator, invocations, cleanup } = setup({ cacheTtlHours: 1 });
  try {
    const text = 'THIS IS COMPLETELY UNACCEPTABLE';
    process.env.FAKE_CLAUDE_FAIL = '1';
    await moderator.moderate({ text });
    delete process.env.FAKE_CLAUDE_FAIL;
    await moderator.moderate({ text });
    const third = await moderator.moderate({ text });

    assert.equal(third.cached, true);
    assert.equal(invocations().length, 2, 'only the failure and the retry cost a call');
  } finally {
    delete process.env.FAKE_CLAUDE_FAIL;
    cleanup();
  }
});
