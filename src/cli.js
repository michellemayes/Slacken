import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, writeDefaultConfig, CONFIG_PATH } from './config.js';
import { Moderator } from './moderate.js';
import { Attacher } from './attach.js';
import { createServer } from './server.js';
import { launchSlack, findSlackApp, isDebugPortOpen, isSlackRunning } from './launch.js';
import { listTargets } from './cdp.js';

const execFileAsync = promisify(execFile);

const USAGE = `slackcensor - soften urgent or aggressive incoming Slack messages

  slackcensor start [--force] [--no-launch] [--always] [--verbose]
      Launch Slack with debugging enabled, attach, and moderate. Ctrl-C to stop.
      --force      quit an already-running Slack so it can be relaunched
      --no-launch  assume Slack is already listening on the debug port
      --always     send every incoming message to the model, not just heated ones
      --verbose    log each verdict

  slackcensor launch [--force]     Relaunch Slack with the debug port open
  slackcensor attach [--verbose]   Attach to an already-launched Slack
  slackcensor test "<message>"     Moderate one string and print the verdict
  slackcensor doctor               Check the pieces this needs
  slackcensor config               Print the config file path and contents
`;

export async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0] || 'start';

  switch (command) {
    case 'start': return cmdStart(args);
    case 'launch': return cmdLaunch(args);
    case 'attach': return cmdAttach(args);
    case 'test': return cmdTest(args);
    case 'doctor': return cmdDoctor(args);
    case 'config': return cmdConfig(args);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

function configFrom(args) {
  const config = loadConfig();
  if (args.always) config.triageMode = 'always';
  if (args.verbose) config.verbose = true;
  if (args.port) config.cdpPort = Number(args.port);
  return config;
}

async function cmdStart(args) {
  writeDefaultConfig();
  const config = configFrom(args);

  if (!args['no-launch']) {
    const result = await launchSlack({ cdpPort: config.cdpPort, force: Boolean(args.force) });
    if (result.started) console.log(`[slackcensor] launched ${result.app} with --remote-debugging-port=${config.cdpPort}`);
    else console.log(`[slackcensor] Slack already listening on ${config.cdpPort}`);
  } else if (!(await isDebugPortOpen(config.cdpPort))) {
    console.error(`[slackcensor] nothing listening on 127.0.0.1:${config.cdpPort}. Run 'slackcensor launch' first.`);
    return 1;
  }

  return run(config);
}

async function cmdAttach(args) {
  writeDefaultConfig();
  const config = configFrom(args);
  if (!(await isDebugPortOpen(config.cdpPort))) {
    console.error(`[slackcensor] nothing listening on 127.0.0.1:${config.cdpPort}. Run 'slackcensor launch' first.`);
    return 1;
  }
  return run(config);
}

async function run(config) {
  const moderator = new Moderator(config);
  const attacher = new Attacher({
    config,
    moderator,
    onEvent: (event) => logEvent(event, config),
  });

  const server = await createServer({
    config,
    moderator,
    getStatus: () => ({ attached: attacher.attachedCount }),
    reinject: () => attacher.reinjectAll(),
  });

  await attacher.start();
  console.log(`[slackcensor] watching Slack (model ${config.model}, triage ${config.triageMode})`);
  console.log(`[slackcensor] control API on http://127.0.0.1:${config.httpPort}  ·  Cmd+Shift+U toggles all originals`);

  await new Promise((resolve) => {
    const shutdown = () => {
      console.log('\n[slackcensor] stopping');
      attacher.stop();
      moderator.cache.flush();
      server.close();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

function logEvent(event, config) {
  switch (event.type) {
    case 'attached':
      console.log(`[slackcensor] attached to ${event.title || event.target}`);
      break;
    case 'detached':
      console.log('[slackcensor] window closed, waiting for it to come back');
      break;
    case 'attach-error':
    case 'poll-error':
    case 'moderate-error':
      console.warn(`[slackcensor] ${event.type}: ${event.message}`);
      break;
    case 'verdict':
      if (event.verdict.flagged) {
        console.log(`[slackcensor] softened ${event.sender || 'someone'} in ${event.channel || '?'} (${event.verdict.tone.join(', ') || 'tone'}, sev ${event.verdict.severity})`);
      } else if (config.verbose) {
        console.log(`[slackcensor] left alone: ${JSON.stringify(event.text.slice(0, 60))}`);
      }
      break;
    default:
      break;
  }
}

async function cmdLaunch(args) {
  const config = configFrom(args);
  const result = await launchSlack({ cdpPort: config.cdpPort, force: Boolean(args.force) });
  console.log(result.started
    ? `launched ${result.app} with --remote-debugging-port=${config.cdpPort}`
    : `Slack is already listening on 127.0.0.1:${config.cdpPort}`);
  return 0;
}

async function cmdTest(args) {
  const text = args._.slice(1).join(' ');
  if (!text) {
    console.error('usage: slackcensor test "the message text"');
    return 1;
  }
  const config = configFrom(args);
  const moderator = new Moderator(config);
  const verdict = await moderator.moderate({ text, sender: args.sender || 'A teammate', channel: args.channel || 'a channel' });
  moderator.cache.flush();
  console.log(JSON.stringify(verdict, null, 2));
  return 0;
}

async function cmdConfig() {
  writeDefaultConfig();
  console.log(CONFIG_PATH);
  console.log(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return 0;
}

async function cmdDoctor(args) {
  const config = configFrom(args);
  const checks = [];

  checks.push(['macOS', process.platform === 'darwin', process.platform]);
  checks.push(['node >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node]);

  const app = findSlackApp();
  checks.push(['Slack.app found', Boolean(app), app || 'not in /Applications or ~/Applications']);

  let claudeVersion = null;
  try {
    const { stdout } = await execFileAsync(config.claudeBin, ['--version'], { timeout: 10000 });
    claudeVersion = stdout.trim();
  } catch (err) {
    claudeVersion = err.message;
  }
  checks.push([`${config.claudeBin} on PATH`, Boolean(claudeVersion && /\d/.test(claudeVersion)), claudeVersion]);

  const running = await isSlackRunning();
  const portOpen = await isDebugPortOpen(config.cdpPort);
  // Informational: `start` launches Slack itself, so "not running" is fine.
  checks.push(['Slack running', true, running ? 'yes' : 'no (start will launch it)']);
  checks.push([`debug port ${config.cdpPort}`, portOpen, portOpen ? 'listening' : 'closed (run: slackcensor launch)']);

  if (portOpen) {
    try {
      const targets = await listTargets(config.cdpPort);
      const pages = targets.filter((t) => t.type === 'page' && /slack\.com/.test(t.url || ''));
      checks.push(['Slack web targets', pages.length > 0, `${pages.length} found`]);
    } catch (err) {
      checks.push(['Slack web targets', false, err.message]);
    }
  }

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name.padEnd(24)} ${detail ?? ''}`);
  }
  return failed === 0 ? 0 : 1;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) out[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['port', 'sender', 'channel', 'model'].includes(key)) {
        out[key] = argv[i + 1];
        i += 1;
      } else out[key] = true;
    } else {
      out._.push(arg);
    }
  }
  return out;
}
