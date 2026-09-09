/*
 * The login agent: a LaunchAgent on macOS, a systemd user unit on Linux.
 *
 * Both are generated on any platform, and only installing one is
 * platform-specific — so what they say can be checked anywhere, which is the
 * point of building them as text rather than as a shell command.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildPlist, buildUnit, agentPath, LABEL, UNIT_PATH, PLIST_PATH } from '../src/agent.js';
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

test('the agent is not asked to run throttled', async () => {
  const plist = await buildPlist({ ...DEFAULTS });
  // launchd throttles Background jobs. This one holds messages hidden while
  // the model decides, so being throttled is something you sit and watch.
  assert.ok(!plist.includes('<string>Background</string>'), 'a throttled job would be a visibly slow one');
  assert.match(plist, /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
});

test('the agent comes back on its own after a crash, but not after a clean stop', async () => {
  const plist = await buildPlist({ ...DEFAULTS });
  // KeepAlive with SuccessfulExit false is what makes `slacken stop` stick:
  // launchd restarts a crash and leaves a deliberate exit alone.
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
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


/* ------------------------------------------------------------- systemd */

test('the unit runs the real entry point, at login', async () => {
  const unit = await buildUnit({ ...DEFAULTS });
  assert.match(unit, /^\[Unit\]/);
  assert.ok(unit.includes(path.join('bin', 'slacken.js')));
  assert.ok(unit.includes(process.execPath), 'the node that installed it is the node that runs it');
  assert.match(unit, /WantedBy=default\.target/, 'default.target is what "at login" means to systemd');
});

test('the unit carries a PATH, since a login session does not provide a useful one', async () => {
  const unit = await buildUnit({ ...DEFAULTS });
  const line = unit.match(/^Environment=PATH=(.+)$/m);
  assert.ok(line, 'without a PATH, claude is not found and nothing is ever rewritten');

  const dirs = line[1].split(':');
  assert.ok(dirs.includes(path.dirname(process.execPath)));
  assert.equal(new Set(dirs).size, dirs.length, 'no duplicate PATH entries');
});

test('the unit comes back after a crash, and stays stopped after a stop', async () => {
  const unit = await buildUnit({ ...DEFAULTS });
  // The systemd spelling of the plist's KeepAlive/SuccessfulExit=false: a
  // deliberate `slacken stop` is a decision, and restarting it would be
  // arguing with the person who made it.
  assert.match(unit, /^Restart=on-failure$/m);
  assert.ok(!/^Restart=always$/m.test(unit));
});

test('an absolute claudeBin contributes its own directory', async () => {
  const unit = await buildUnit({ ...DEFAULTS, claudeBin: '/opt/custom/bin/claude' });
  assert.match(unit, /^Environment=PATH=.*\/opt\/custom\/bin/m);
});

test('both halves log to the same place, so `slacken agent logs` needs no platform', async () => {
  const unit = await buildUnit({ ...DEFAULTS });
  const plist = await buildPlist({ ...DEFAULTS });
  const unitLog = unit.match(/^StandardOutput=append:(.+)$/m)[1];
  assert.ok(plist.includes(`<string>${unitLog}</string>`));
});

test('the agent lives where the platform keeps such things, or nowhere', () => {
  const expected = { darwin: PLIST_PATH, linux: UNIT_PATH }[process.platform] ?? null;
  assert.equal(agentPath(), expected,
    'a platform with no login agent has to say so rather than pretend to have one');
});
