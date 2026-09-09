/* Parsing and gating around whatever `claude -p` hands back. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, normalize } from '../src/moderate.js';

const VERDICT = {
  flagged: true,
  tone: ['aggressive', 'urgent'],
  severity: 2,
  rewrite: 'Could you look at the deploy? I need it by 3pm.',
  note: 'removed shouting',
};

test('parseVerdict unwraps the --output-format json envelope', () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(VERDICT),
  });
  assert.deepEqual(parseVerdict(stdout), VERDICT);
});

test('parseVerdict survives a fenced or chatty result', () => {
  const stdout = JSON.stringify({
    result: `Here you go:\n\`\`\`json\n${JSON.stringify(VERDICT)}\n\`\`\`\nHope that helps.`,
  });
  assert.deepEqual(parseVerdict(stdout), VERDICT);
});

test('parseVerdict handles a bare object with no envelope', () => {
  assert.deepEqual(parseVerdict(JSON.stringify(VERDICT)), VERDICT);
});

test('parseVerdict is not confused by braces inside strings', () => {
  const tricky = { ...VERDICT, rewrite: 'Check the config: {"retries": 3} please.' };
  assert.deepEqual(parseVerdict(JSON.stringify({ result: JSON.stringify(tricky) })), tricky);
});

test('parseVerdict returns null when there is no object at all', () => {
  assert.equal(parseVerdict('I refuse to answer.'), null);
  assert.equal(parseVerdict(''), null);
});

test('normalize keeps a genuine flag', () => {
  const out = normalize(VERDICT, 2);
  assert.equal(out.flagged, true);
  assert.equal(out.rewrite, VERDICT.rewrite);
  assert.deepEqual(out.tone, ['aggressive', 'urgent']);
});

test('normalize drops a flag below the severity floor', () => {
  const out = normalize({ ...VERDICT, severity: 1 }, 2);
  assert.equal(out.flagged, false);
  assert.equal(out.rewrite, null, 'nothing to swap in means nothing gets swapped');
});

test('normalize drops a flag with no rewrite text', () => {
  for (const rewrite of [null, '', '   ', 42]) {
    const out = normalize({ ...VERDICT, rewrite }, 2);
    assert.equal(out.flagged, false);
    assert.equal(out.rewrite, null);
  }
});

test('normalize clamps severity and filters unknown tone labels', () => {
  const out = normalize({ ...VERDICT, severity: 9, tone: ['aggressive', 'spicy', 7] }, 2);
  assert.equal(out.severity, 3);
  assert.deepEqual(out.tone, ['aggressive']);
});

test('normalize tolerates a garbage severity', () => {
  const out = normalize({ ...VERDICT, severity: 'very bad' }, 2);
  assert.equal(out.severity, 0);
  assert.equal(out.flagged, false);
});
