import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, writeDefaultConfig, CONFIG_PATH } from './config.js';
import { Moderator } from './moderate.js';
import { Attacher } from './attach.js';
import { createServer } from './server.js';
import { launchSlack, findSlackApp, isDebugPortOpen, isSlackRunning } from './launch.js';
import { listTargets } from './cdp.js';
import { installAgent, uninstallAgent, agentStatus, LOG_PATH } from './agent.js';
import { State } from './state.js';
import { MenuBar, menuModel } from './menubar.js';

const execFileAsync = promisify(execFile);

const USAGE = `slacken - a calmer reading layer for Slack on macOS

  slacken start [--force] [--no-launch] [--always] [--verbose]
      Launch Slack with debugging enabled, attach, and moderate. Ctrl-C to stop.
      --force      quit an already-running Slack so it can be relaunched
      --no-launch  assume Slack is already listening on the debug port
      --always     send every incoming message to the model, not just flagged ones
      --verbose    log each verdict

  slacken launch [--force]     Relaunch Slack with the debug port open
  slacken attach [--verbose]   Attach to an already-launched Slack
  slacken test "<message>"     Rewrite one string and print the verdict
  slacken doctor               Check the pieces this needs
  slacken config               Print the config file path and contents

  slacken status               What the running daemon has done so far
  slacken pause                Stop rewriting, and reveal what is on screen
  slacken resume               Start rewriting again

  slacken agent install        Run automatically when you log in
  slacken agent uninstall      Stop running at login
  slacken agent status         Is the login agent installed and running?
  slacken agent logs           Print the login agent's recent output
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
    case 'status': return cmdStatus(args);
    case 'pause': return cmdPause(args, true);
    case 'resume': return cmdPause(args, false);
    case 'agent': return cmdAgent(args);
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
    if (result.started) console.log(`[slacken] launched ${result.app} with --remote-debugging-port=${config.cdpPort}`);
    else console.log(`[slacken] Slack already listening on ${config.cdpPort}`);
  } else if (!(await isDebugPortOpen(config.cdpPort))) {
    console.error(`[slacken] nothing listening on 127.0.0.1:${config.cdpPort}. Run 'slacken launch' first.`);
    return 1;
  }

  return run(config);
}

async function cmdAttach(args) {
  writeDefaultConfig();
  const config = configFrom(args);
  if (!(await isDebugPortOpen(config.cdpPort))) {
    console.error(`[slacken] nothing listening on 127.0.0.1:${config.cdpPort}. Run 'slacken launch' first.`);
    return 1;
  }
  return run(config);
}

async function run(config) {
  const state = new State();
  const moderator = new Moderator(config, state);
  const attacher = new Attacher({
    config,
    moderator,
    state,
    onEvent: (event) => logEvent(event, config),
  });

  const server = await createServer({
    config,
    moderator,
    state,
    getStatus: () => ({ attached: attacher.attachedCount }),
    reinject: () => attacher.reinjectAll(),
  });

  await attacher.start();

  const menuBar = new MenuBar({ config, onEvent: (event) => logEvent(event, config) });
  // The menu bar is how you notice a pause you left running yesterday, so it
  // is worth starting even when nothing else has attached yet.
  if (config.menuBar !== false) await menuBar.start();

  console.log(`[slacken] watching Slack (model ${config.model}, triage ${config.triageMode})`);
  console.log(`[slacken] control API on http://127.0.0.1:${config.httpPort}  ·  Cmd+Shift+U toggles all originals`);
  if (state.paused) console.log('[slacken] currently PAUSED — nothing will be rewritten until you resume');

  state.onChange((paused) => {
    console.log(paused
      ? '[slacken] paused — every message will be shown as written'
      : '[slacken] resumed');
  });

  await new Promise((resolve) => {
    const shutdown = () => {
      const st = moderator.stats;
      console.log(`\n[slacken] stopping — ${st.batched} messages in ${st.calls} calls, `
        + `${st.cacheHits} from cache, ${st.softened} softened, ${st.condensed} condensed, `
        + `$${st.costUsd.toFixed(4)}`);
      menuBar.stop();
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
      console.log(`[slacken] attached to ${event.title || event.target}`);
      break;
    case 'detached':
      console.log('[slacken] window closed, waiting for it to come back');
      break;
    case 'menubar-unavailable':
      console.log(`[slacken] no menu bar item: ${event.message}`);
      break;
    case 'menubar-exited':
      console.log(event.crashed
        ? '[slacken] menu bar item gave up after repeated crashes; everything else is unaffected'
        : '[slacken] menu bar item hidden (set menuBar to false to keep it that way)');
      break;
    case 'attach-error':
    case 'poll-error':
    case 'moderate-error':
    case 'menubar-error':
      console.warn(`[slacken] ${event.type}: ${event.message}`);
      break;
    case 'verdict': {
      const v = event.verdict;
      if (v.flagged) {
        const what = v.hostile && v.verbose ? 'softened + condensed'
          : v.verbose ? 'condensed' : 'softened';
        const who = `${event.sender || 'someone'} in ${event.channel || '?'}`;
        console.log(`[slacken] ${what} ${who}${v.tone.length ? ` (${v.tone.join(', ')})` : ''}`);
      } else if (config.verbose) {
        console.log(`[slacken] left alone: ${JSON.stringify(event.text.slice(0, 60))}`);
      }
      break;
    }
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
    console.error('usage: slacken test "the message text"');
    return 1;
  }
  const config = configFrom(args);
  const moderator = new Moderator(config);
  const verdict = await moderator.moderate({ text, sender: args.sender || 'A teammate', channel: args.channel || 'a channel' });
  moderator.cache.flush();
  console.log(JSON.stringify(verdict, null, 2));
  return 0;
}

async function cmdAgent(args) {
  const config = configFrom(args);
  const action = args._[1] || 'status';

  switch (action) {
    case 'install': {
      const { plist, log } = await installAgent(config);
      console.log(`installed ${plist}`);
      console.log(`Slacken now starts at login. Output goes to ${log}`);
      return 0;
    }
    case 'uninstall': {
      const { removed, plist } = await uninstallAgent();
      console.log(removed ? `removed ${plist}` : 'no login agent was installed');
      return 0;
    }
    case 'status': {
      const status = await agentStatus();
      if (!status.installed) {
        console.log("not installed (run 'slacken agent install')");
        return 1;
      }
      console.log(`installed: ${status.plist}`);
      console.log(`running:   ${status.running ? `yes (pid ${status.pid})` : 'no'}`);
      if (status.lastExit && status.lastExit !== '0') console.log(`last exit: ${status.lastExit}`);
      console.log(`log:       ${status.log}`);
      return status.running ? 0 : 1;
    }
    case 'logs': {
      if (!fs.existsSync(LOG_PATH)) {
        console.log(`no log yet at ${LOG_PATH}`);
        return 1;
      }
      const lines = fs.readFileSync(LOG_PATH, 'utf8').trimEnd().split('\n');
      console.log(lines.slice(-Number(args.lines || 50)).join('\n'));
      return 0;
    }
    default:
      console.error(`unknown agent action: ${action} (install, uninstall, status, logs)`);
      return 1;
  }
}

// `status`, `pause` and `resume` are thin clients for the running daemon: the
// pause state lives in one place, and the menu bar item and the terminal are
// two views of it rather than two copies.
async function daemon(config, method, path) {
  const url = `http://127.0.0.1:${config.httpPort}${path}`;
  try {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    const hint = /ECONNREFUSED|fetch failed/i.test(err.message)
      ? `nothing is listening on 127.0.0.1:${config.httpPort}. Is 'slacken start' running?`
      : err.message;
    throw new Error(hint);
  }
}

async function cmdStatus(args) {
  const config = configFrom(args);
  let status;
  try {
    status = await daemon(config, 'GET', '/status');
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  // Printed from the same model the menu bar draws, so the two can never drift.
  for (const item of menuModel(status).items) {
    if (item.separator) continue;
    if (item.post || item.open || item.quit) continue;
    console.log(item.label);
  }
  return 0;
}

async function cmdPause(args, paused) {
  const config = configFrom(args);
  try {
    const res = await daemon(config, 'POST', paused ? '/pause' : '/resume');
    console.log(res.paused
      ? 'paused — Slacken will leave every message exactly as written'
      : 'resumed — Slacken is rewriting again');
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
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

  if (process.platform === 'darwin' && config.menuBar !== false) {
    let swift = null;
    try {
      const { stdout } = await execFileAsync('swiftc', ['--version'], { timeout: 20000 });
      swift = stdout.trim().split('\n')[0];
    } catch {
      swift = null;
    }
    // Informational: without swiftc there is no menu bar item, but everything
    // else still works, so this is never a failure.
    checks.push(['menu bar item', true, swift || 'no swiftc (run: xcode-select --install)']);
  }

  const running = await isSlackRunning();
  const portOpen = await isDebugPortOpen(config.cdpPort);
  // Informational: `start` launches Slack itself, so "not running" is fine.
  checks.push(['Slack running', true, running ? 'yes' : 'no (start will launch it)']);
  checks.push([`debug port ${config.cdpPort}`, portOpen, portOpen ? 'listening' : 'closed (run: slacken launch)']);

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
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['port', 'sender', 'channel', 'model', 'lines'].includes(key)) {
        out[key] = argv[i + 1];
        i += 1;
      } else out[key] = true;
    } else {
      out._.push(arg);
    }
  }
  return out;
}
