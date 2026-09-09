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

  if (log) fs.appendFileSync(log, `${JSON.stringify({ count: items.length, ids: items.map((i) => i.id) })}\n`);

  if (process.env.FAKE_CLAUDE_FAIL === '1') {
    process.stderr.write('simulated failure\n');
    process.exit(2);
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
});
