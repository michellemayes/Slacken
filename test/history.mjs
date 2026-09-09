/*
 * The record of what was changed.
 *
 * The counts in the menu bar say whether Slacken is doing anything. This is
 * the file that says what it did, which is the question you only think to ask
 * once the message has scrolled away.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { History, formatEntry } from '../src/history.js';

function tempHistory(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slacken-history-'));
  const file = path.join(dir, 'history.jsonl');
  const values = { historyEnabled: true, historyMaxEntries: 2000, ...config };
  return {
    file,
    values,
    history: new History({ file, config: values }),
    lines: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const VERDICT = {
  flagged: true, hostile: true, verbose: false, tone: ['aggressive'],
  severity: 3, rewrite: 'The deploy is still broken; it is needed by 3pm.', note: 'removed hostility',
};

test('a rewrite is recorded with both texts', () => {
  const { history, lines, cleanup } = tempHistory();
  try {
    history.recordVerdict({
      sender: 'Dana Wu',
      channel: '#eng-oncall',
      text: 'WHY is the deploy STILL broken?? I need it by 3pm.',
      verdict: VERDICT,
    });
    const [entry] = lines().map((l) => JSON.parse(l));
    assert.equal(entry.kind, 'softened');
    assert.equal(entry.sender, 'Dana Wu');
    assert.equal(entry.channel, '#eng-oncall');
    assert.equal(entry.severity, 3);
    assert.match(entry.original, /^WHY is the deploy/);
    assert.equal(entry.rewrite, VERDICT.rewrite);
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    cleanup();
  }
});

test('a message that was left alone is not a record of anything', () => {
  const { history, lines, cleanup } = tempHistory();
  try {
    history.recordVerdict({
      sender: 'Sam',
      text: 'Deploy is queued behind the migration.',
      verdict: { flagged: false, rewrite: null, tone: [] },
    });
    assert.deepEqual(lines(), [], 'most messages have nothing done to them');
  } finally {
    cleanup();
  }
});

test('both transformations are named, not just the first one', () => {
  const { history, lines, cleanup } = tempHistory();
  try {
    history.recordVerdict({
      text: 'x',
      verdict: { ...VERDICT, verbose: true },
    });
    assert.equal(JSON.parse(lines()[0]).kind, 'softened+condensed');
  } finally {
    cleanup();
  }
});

test('asking for an original back is recorded too', () => {
  const { history, cleanup } = tempHistory();
  try {
    history.recordReveal({ sender: 'Dana Wu', channel: '#eng-oncall', kind: 'condensed' });
    const [entry] = history.read();
    assert.equal(entry.kind, 'revealed');
    assert.equal(entry.of, 'condensed');
    assert.equal(entry.sender, 'Dana Wu');
  } finally {
    cleanup();
  }
});

test('turning the record off stops the next line being written, not the next daemon', () => {
  const { history, values, lines, cleanup } = tempHistory();
  try {
    history.recordVerdict({ text: 'one', verdict: VERDICT });
    // The menu bar writes into the same config object the daemon is holding.
    values.historyEnabled = false;
    history.recordVerdict({ text: 'two', verdict: VERDICT });
    assert.equal(lines().length, 1);

    values.historyEnabled = true;
    history.recordVerdict({ text: 'three', verdict: VERDICT });
    assert.equal(lines().length, 2);
  } finally {
    cleanup();
  }
});

test('a very long message is stored shortened, not whole', () => {
  const { history, cleanup } = tempHistory();
  try {
    const huge = 'x'.repeat(50_000);
    history.recordVerdict({ text: huge, verdict: { ...VERDICT, rewrite: huge } });
    const [entry] = history.read();
    assert.ok(entry.original.length < 2100, 'a pasted stack trace must not become the record');
    assert.ok(entry.original.endsWith('…'));
  } finally {
    cleanup();
  }
});

test('the file is capped, keeping the most recent', () => {
  const { history, lines, cleanup } = tempHistory({ historyMaxEntries: 10 });
  try {
    for (let i = 0; i < 40; i += 1) {
      history.recordVerdict({ text: `message ${i}`, verdict: { ...VERDICT, rewrite: `rewrite ${i}` } });
    }
    history.trim();
    const kept = lines().map((l) => JSON.parse(l));
    assert.equal(kept.length, 10);
    assert.equal(kept.at(-1).rewrite, 'rewrite 39', 'the newest is the one worth keeping');
  } finally {
    cleanup();
  }
});

test('reading the most recent few reads the end of the file', () => {
  const { history, cleanup } = tempHistory();
  try {
    for (let i = 0; i < 5; i += 1) {
      history.recordVerdict({ text: `m${i}`, verdict: { ...VERDICT, rewrite: `r${i}` } });
    }
    const recent = history.read({ limit: 2 });
    assert.deepEqual(recent.map((e) => e.rewrite), ['r3', 'r4']);
  } finally {
    cleanup();
  }
});

test('a half-written line does not stop the rest being read', () => {
  const { file, history, cleanup } = tempHistory();
  try {
    history.recordVerdict({ text: 'good', verdict: VERDICT });
    fs.appendFileSync(file, '{"at":"2026-01-01T00:00:00.000Z","kind":"soft\n');
    history.recordVerdict({ text: 'also good', verdict: VERDICT });
    assert.equal(history.read().length, 2, 'a daemon killed mid-append costs one line, not the file');
  } finally {
    cleanup();
  }
});

test('no history file is not an error, it is an empty history', () => {
  const { history, cleanup } = tempHistory();
  try {
    assert.deepEqual(history.read(), []);
  } finally {
    cleanup();
  }
});

test('an entry reads as a line a person can scan', () => {
  const line = formatEntry({
    at: '2026-09-09T14:03:21.000Z',
    kind: 'condensed',
    sender: 'Priya Nair',
    channel: '#eng',
    note: 'dropped filler',
    original: 'Hey team!  I wanted to take a moment to circle back.',
    rewrite: 'Revisit the retry logic before the release.',
  });
  assert.match(line, /2026-09-09 14:03:21/);
  assert.match(line, /condensed\s+Priya Nair in #eng/);
  assert.match(line, /was:  Hey team! I wanted/, 'collapsed to one line so a paragraph does not break the column');
  assert.match(line, /now:  Revisit the retry logic/);

  const reveal = formatEntry({ at: '2026-09-09T14:04:00.000Z', kind: 'revealed', sender: 'Dana', channel: '#eng', of: 'softened' });
  assert.match(reveal, /original asked for  Dana in #eng \(softened\)/);
});
