/* The LaunchAgent plist. Generated on any platform; only loading it is macOS-only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildPlist, LABEL } from '../src/agent.js';
import { DEFAULTS } from '../src/config.js';

test('the plist names the agent and runs the real entry point', async () => {
  const plist = await buildPlist({ ...DEFAULTS });
  assert.match(plist, /^<\?xml version="1\.0"/);
  assert.ok(plist.includes(`<string>${LABEL}</string>`));
  assert.ok(plist.includes(path.join('bin', 'slacken.js')));
  assert.ok(plist.includes('<key>RunAtLoad</key>'));
});

test('the plist carries a PATH, since launchd does not provide a useful one', async () => {
  const plist = await buildPlist({ ...DEFAULTS });
  const pathLine = plist.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/);
  assert.ok(pathLine, 'a PATH must be baked in or claude will not be found');

  const dirs = pathLine[1].split(':');
  assert.ok(dirs.includes(path.dirname(process.execPath)), 'node must be reachable');
  assert.ok(dirs.includes('/usr/local/bin'));
  assert.equal(new Set(dirs).size, dirs.length, 'no duplicate PATH entries');
});

test('an absolute claudeBin contributes its own directory', async () => {
  const plist = await buildPlist({ ...DEFAULTS, claudeBin: '/opt/custom/bin/claude' });
  assert.match(plist, /<string>[^<]*\/opt\/custom\/bin[^<]*<\/string>/);
});

test('paths with XML-special characters are escaped', async () => {
  const plist = await buildPlist({ ...DEFAULTS, claudeBin: '/tmp/a&b/claude' });
  assert.ok(plist.includes('/tmp/a&amp;b'), 'a raw & would make the plist unparseable');
  assert.ok(!/[^&]&(?!amp;|lt;|gt;)/.test(plist), 'no unescaped ampersands anywhere');
});
