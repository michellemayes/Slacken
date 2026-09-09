#!/usr/bin/env node
/*
 * Stands in for the `claude` binary so batching can be tested without paying
 * for or waiting on a model. Reads the batch payload on stdin, records the
 * invocation, and answers in the same envelope shape `claude -p
 * --output-format json` uses.
 */
import fs from 'node:fs';

const log = process.env.FAKE_CLAUDE_LOG;
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  let items = [];
  try { items = JSON.parse(stdin); } catch { /* leave empty */ }

  // The arguments matter as much as the payload: whether a call was held to
  // the response schema is the difference between the fast path and the retry
  // that exists to catch it going wrong.
  const schema = process.argv.includes('--json-schema');
  if (log) {
    fs.appendFileSync(log, `${JSON.stringify({
      count: items.length,
      ids: items.map((i) => i.id),
      schema,
    })}\n`);
  }

  if (process.env.FAKE_CLAUDE_FAIL === '1') {
    process.stderr.write(`${process.env.FAKE_CLAUDE_MESSAGE || 'simulated failure'}\n`);
    process.exit(2);
  }

  // Fail the first N invocations and then work, so a retry can be told apart
  // from a call that was always going to succeed. The count is kept in a file
  // because each invocation is a new process.
  const failTimes = Number(process.env.FAKE_CLAUDE_FAIL_TIMES || 0);
  if (failTimes > 0) {
    const counter = process.env.FAKE_CLAUDE_COUNTER;
    let failed = 0;
    try { failed = Number(fs.readFileSync(counter, 'utf8')) || 0; } catch { failed = 0; }
    if (failed < failTimes) {
      fs.writeFileSync(counter, String(failed + 1));
      process.stderr.write(`${process.env.FAKE_CLAUDE_MESSAGE || 'simulated transient failure'}\n`);
      process.exit(2);
    }
  }

  // Well-formed envelope, unusable answer: what a model that ignored the
  // format looks like, and the only thing the schema retry exists for. '1'
  // behaves once it is held to the schema, the way a real one does; 'always'
  // never does, which is the case the retry has to give up on.
  const unparseable = process.env.FAKE_CLAUDE_UNPARSEABLE;
  if (unparseable === 'always' || (unparseable === '1' && !schema)) {
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0.0002,
      result: 'Sure! Here are the verdicts you asked for.',
    }));
    return;
  }

  const verdicts = items.map((item) => ({
    id: item.id,
    hostile: /[A-Z]{3,}|unacceptable/.test(item.text),
    verbose: item.text.split(/\s+/).length >= 45,
    tone: ['aggressive'],
    severity: 2,
    rewrite: `REWRITTEN ${item.id}`,
    note: 'test',
  }));

  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.0007,
    result: JSON.stringify({ verdicts }),
  }));

  // The real claude prints the whole envelope and then takes its time going
  // away. Nothing worth waiting for happens in that window, which is the
  // point: this is here so a test can prove nobody waits for it.
  const linger = Number(process.env.FAKE_CLAUDE_LINGER_MS || 0);
  if (linger > 0) setTimeout(() => {}, linger);
});
