import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, writeDefaultConfig, ConfigStore, CONFIG_PATH } from './config.js';
import { SETTINGS, invalidatesCache } from './settings.js';
import { Moderator } from './moderate.js';
import { Attacher } from './attach.js';
import { createServer } from './server.js';
import { launchSlack, findSlackApp, slackLocations, supportedPlatform, isDebugPortOpen, isSlackRunning, sleep } from './launch.js';
import { listTargets } from './cdp.js';
import { installAgent, uninstallAgent, restartAgent, agentStatus, agentInstalled, agentPath, LOG_PATH } from './agent.js';
import { State } from './state.js';
import { MenuBar, menuModel, count } from './menubar.js';
import { History, formatEntry, HISTORY_PATH } from './history.js';
import { loadToken, readToken } from './auth.js';
import { CHANNEL_KEYS } from './settings.js';
import { VERSION, checkForUpdate } from './version.js';
import { resolveClaudeBin, notFoundMessage, spawnPath } from './claude-bin.js';

const execFileAsync = promisify(execFile);

const TOKEN_HINT = "delete ~/.slacken/token and restart the daemon if it has got out of step";

const USAGE = `slacken - a calmer reading layer for the Slack desktop app

  slacken start [--force] [--no-launch] [--always] [--verbose]
      Launch Slack with debugging enabled, attach, and moderate. Ctrl-C to stop.
      --force      quit an already-running Slack so it can be relaunched
      --no-launch  assume Slack is already listening on the debug port
      --always     send every incoming message to the model, not just flagged ones
      --verbose    log each verdict

  slacken launch [--force]     Relaunch Slack with the debug port open
  slacken attach [--verbose]   Attach to an already-launched Slack
  slacken test "<message>"     Rewrite one string and print the verdict
  slacken doctor [--no-model]  Check the pieces this needs, including one real
                               model call; --no-model skips that one
  slacken config               Print the config file path and contents

  slacken set                  List the settings you can change, and their values
  slacken set <name> <value>   Change one, on the running daemon and on disk

  slacken channel                          What each channel does differently
  slacken channel <#name> <name> <value>   Change one setting in one channel
  slacken channel <#name> reset            Put a channel back to the global settings

  slacken history [--lines N] [--json]     What has been rewritten, most recent last
  slacken token                            Print the control API token
  slacken version [--check]                What this is, and whether it is current

  slacken status               What the running daemon has done so far
  slacken inspect              What Slacken makes of the messages on screen now
  slacken pause                Stop rewriting, and reveal what is on screen
  slacken resume               Start rewriting again
  slacken stop                 Stop the daemon, wherever it was started from

  slacken agent install        Run automatically when you log in, with no terminal
  slacken agent uninstall      Stop running at login
  slacken agent restart        Restart the login agent's daemon now
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
    case 'set': return cmdSet(args);
    case 'channel': return cmdChannel(args);
    case 'history': return cmdHistory(args);
    case 'token': return cmdToken(args);
    case 'version':
    case '--version':
    case '-v':
      return cmdVersion(args);
    case 'status': return cmdStatus(args);
    case 'inspect': return cmdInspect(args);
    case 'pause': return cmdPause(args, true);
    case 'resume': return cmdPause(args, false);
    case 'stop': return cmdStop(args);
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
  const store = storeFrom(args);
  const config = store.values;
  if (await reportAlreadyRunning(config)) return 0;

  if (!args['no-launch']) {
    const result = await launchSlack({ cdpPort: config.cdpPort, force: Boolean(args.force) });
    if (result.started) console.log(`[slacken] launched ${result.app} with --remote-debugging-port=${config.cdpPort}`);
    else console.log(`[slacken] Slack already listening on ${config.cdpPort}`);
  } else if (!(await isDebugPortOpen(config.cdpPort))) {
    console.error(`[slacken] nothing listening on 127.0.0.1:${config.cdpPort}. Run 'slacken launch' first.`);
    return 1;
  }

  return run(store);
}

async function cmdAttach(args) {
  writeDefaultConfig();
  const store = storeFrom(args);
  const config = store.values;
  if (await reportAlreadyRunning(config)) return 0;
  if (!(await isDebugPortOpen(config.cdpPort))) {
    console.error(`[slacken] nothing listening on 127.0.0.1:${config.cdpPort}. Run 'slacken launch' first.`);
    return 1;
  }
  return run(store);
}

// Flags are for this run only, so they are applied to the values the store
// starts from rather than written to the file: `--always` for an afternoon
// should not still be in force next week.
function storeFrom(args) {
  return new ConfigStore({ values: configFrom(args) });
}

async function run(store) {
  const config = store.values;
  const state = new State();
  const moderator = new Moderator(config, state);

  // Found once, up front, and said out loud. A daemon started at login has
  // almost no PATH, so which `claude` this is — or that there is not one — is
  // the first thing you want from the log when nothing is being rewritten.
  const claude = await resolveClaudeBin(config.claudeBin);
  if (claude.path) console.log(`[slacken] claude: ${claude.path}`);
  else console.error(`[slacken] ${notFoundMessage(config.claudeBin, claude.searched)}`);
  // Written by the same handler that logs to the terminal, because they are
  // two views of one thing: what Slacken did, as it did it.
  const history = new History({ config });
  const token = loadToken();
  const attacher = new Attacher({
    config,
    moderator,
    state,
    store,
    onEvent: (event) => {
      logEvent(event, config);
      recordEvent(history, event);
    },
  });

  // POST /stop and Ctrl-C are the same thing, and neither may run twice. The
  // real shutdown is defined at the bottom, once there is something to shut
  // down; a stop that arrives before then — during a first-run Swift compile,
  // say — is remembered rather than answered with a shrug.
  let pendingStop = null;
  let stop = (reason) => { pendingStop = reason || 'a stop request'; };

  let server;
  try {
    server = await createServer({
      config,
      moderator,
      state,
      store,
      getStatus: () => ({ attached: attacher.attachedCount, drifted: attacher.drifted }),
      reinject: () => attacher.reinjectAll(),
      inspect: () => attacher.inspect(),
      onStop: (reason) => stop(reason),
      token,
    });
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`[slacken] something else is already using 127.0.0.1:${config.httpPort}.`);
    console.error("[slacken] if it is another Slacken, 'slacken stop' will stop it; "
      + 'otherwise change httpPort in the config.');
    return 1;
  }

  await attacher.start();

  const menuBar = new MenuBar({ config, token, onEvent: (event) => logEvent(event, config) });
  // The menu bar is how you notice a pause you left running yesterday, so it
  // is worth starting even when nothing else has attached yet.
  if (config.menuBar !== false) await menuBar.start();

  console.log(`[slacken] watching Slack (model ${config.model}, triage ${config.triageMode})`);
  console.log(`[slacken] control API on http://127.0.0.1:${config.httpPort}  ·  Cmd+Shift+U toggles all originals`);
  if (state.paused) console.log('[slacken] currently PAUSED — nothing will be rewritten until you resume');
  if (state.spentToday > 0) {
    console.log(`[slacken] $${state.spentToday.toFixed(4)} spent so far today`
      + `${config.dailyBudgetUsd > 0 ? ` of $${Number(config.dailyBudgetUsd).toFixed(2)}` : ''}`);
  }
  if (config.checkUpdates) {
    // Deliberately after everything else has started: an update check is the
    // one thing here that talks to anything but your own machine, and nothing
    // waits on what it finds.
    checkForUpdate(config).then((update) => {
      if (update?.newer) console.log(`[slacken] ${update.latest} is out (you have ${VERSION}): ${update.url}`);
    }).catch(() => {});
  }
  // Started by hand, so this dies with the terminal it was typed into. Say so
  // once, next to the thing that fixes it.
  if (agentPath() && !agentInstalled()) {
    console.log("[slacken] this stops when you close this window — 'slacken agent install' "
      + 'runs it at login instead');
  }

  state.onChange((paused) => {
    console.log(paused
      ? '[slacken] paused — every message will be shown as written'
      : '[slacken] resumed');
  });

  // A setting can be changed from the menu bar, from the button in Slack or
  // from another terminal. Wherever it came from, the change has to reach the
  // pages being rewritten right now, and the verdicts already decided under
  // the old thresholds have to go.
  store.onChange((changed) => {
    console.log(`[slacken] ${changed.map((key) => `${key} = ${show(config[key])}`).join(', ')}`);
    if (invalidatesCache(changed)) moderator.cache.clear();
    attacher.broadcastConfig().catch((err) => {
      console.warn(`[slacken] could not tell Slack about the change: ${err.message}`);
    });
  });

  await new Promise((resolve) => {
    let stopping = false;
    const shutdown = (reason) => {
      if (stopping) return;
      stopping = true;
      const st = moderator.stats;
      console.log(`\n[slacken] stopping${reason ? ` (${reason})` : ''} — ${st.batched} messages in ${st.calls} calls, `
        + `${st.cacheHits} from cache, ${st.softened} softened, ${st.condensed} condensed, `
        + `$${st.sessionCostUsd.toFixed(4)} this session, $${st.costUsd.toFixed(4)} today`);
      menuBar.stop();
      attacher.stop();
      moderator.cache.flush();
      server.close();
      // A kept-alive control connection would otherwise hold the process open
      // long after everything it was doing has stopped.
      server.closeAllConnections?.();
      resolve();
    };
    stop = shutdown;
    process.on('SIGINT', () => shutdown());
    process.on('SIGTERM', () => shutdown());
    if (pendingStop) shutdown(pendingStop);
  });
  return 0;
}

/*
 * Everything here fails the same way: not once, but every four seconds, or on
 * every message, for as long as the cause lasts.
 *
 * The menu bar counts those failures and sends you to the log to find out what
 * they were. So the log has to actually say — and a line repeated two hundred
 * times says nothing you can read. The first of each distinct message goes out
 * immediately; identical repeats are counted and summarised at most once a
 * minute; and recovery is announced, because when it stopped is half of what
 * you came to the log to find out.
 */
export class RepeatLog {
  constructor({ summariseAfterMs = 60_000, now = () => Date.now() } = {}) {
    this.summariseAfterMs = summariseAfterMs;
    this.now = now;
    this.kinds = new Map();
  }

  // Returns the line to print, or null to stay quiet.
  fail(kind, message) {
    const at = this.now();
    const prev = this.kinds.get(kind);
    // A different message is different news, however often the last one came.
    if (!prev || prev.message !== message) {
      this.kinds.set(kind, { message, count: 1, since: at, said: at });
      return message;
    }
    prev.count += 1;
    if (at - prev.said < this.summariseAfterMs) return null;
    prev.said = at;
    return `still failing after ${prev.count} tries over ${humanMs(at - prev.since)}: ${message}`;
  }

  ok(kind) {
    const prev = this.kinds.get(kind);
    if (!prev) return null;
    this.kinds.delete(kind);
    return `recovered after ${prev.count} failure${prev.count === 1 ? '' : 's'} over ${humanMs(this.now() - prev.since)}`;
  }
}

function humanMs(ms) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 6) / 10}h`;
}

const SHARED_REPORT = new RepeatLog();

// Exported for the tests: what reaches the log is the thing the menu bar's
// error count sends you to read, so it is worth pinning down.
export function logEvent(event, config, report = SHARED_REPORT) {
  const say = (kind, message) => {
    const line = report.fail(kind, message);
    if (line) console.warn(`[slacken] ${line}`);
  };
  const recovered = (kind, message) => {
    const line = report.ok(kind);
    if (line) console.log(`[slacken] ${message} — ${line}`);
  };

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
    case 'poll-ok':
      recovered('poll', 'Slack is reachable again');
      break;
    case 'attach-error':
    case 'poll-error':
    case 'moderate-error':
    case 'menubar-error':
      say(event.type === 'poll-error' ? 'poll' : event.type, `${event.type}: ${event.message}`);
      break;
    case 'ignore-channel':
      console.log(event.error
        ? `[slacken] could not ignore ${event.channel}: ${event.error}`
        : event.ignored
          ? `[slacken] ignoring ${event.channel} — nothing there will be rewritten`
          : `[slacken] rewriting ${event.channel} again`);
      break;
    case 'reveal':
      console.log(`[slacken] original asked for: ${event.sender || 'someone'} in ${event.channel || '?'}`);
      break;
    case 'verdict': {
      const v = event.verdict;
      // The one failure that used to be completely silent. Every message the
      // model could not judge was counted in the menu bar's "N errors" line
      // and then dropped, so the log the menu sent you to had nothing in it.
      if (v.error) {
        // Keyed on the error alone, not the channel it happened in: one
        // broken claude is one problem, however many channels it spoils.
        say('model', `the model could not judge a message: ${v.error}`);
        break;
      }
      // Only a verdict that actually came back from the model is evidence the
      // model is working. A paused, empty, over-length or cached one never
      // reached it, and announcing recovery on one of those would call a
      // still-broken claude fixed.
      if (!v.reason && !v.cached) recovered('model', 'the model is answering again');
      if (v.flagged) {
        const what = v.hostile && v.verbose ? 'softened + condensed'
          : v.verbose ? 'condensed' : 'softened';
        const where = event.kind === 'notification' ? ' (notification)'
          : event.kind === 'draft' ? ' (your draft)' : '';
        const who = `${event.sender || 'someone'} in ${event.channel || '?'}`;
        console.log(`[slacken] ${what} ${who}${where}${v.tone.length ? ` (${v.tone.join(', ')})` : ''}`);
      } else if (config.verbose) {
        // Paused is the one that matters most here: without it, a Slacken you
        // forgot you paused reads exactly like a Slacken that read every
        // message and found nothing worth changing.
        const why = v.reason || (v.cached ? 'cached' : v.why) || 'nothing to change';
        console.log(`[slacken] left alone (${why}): ${JSON.stringify(event.text.slice(0, 60))}`);
      }
      break;
    }
    default:
      break;
  }
}

// The history is the same events the terminal gets, kept. A draft is not
// recorded: it is a suggestion about something you have not sent, and writing
// down what you nearly said is not this tool's business.
function recordEvent(history, event) {
  if (event.type === 'verdict' && event.kind !== 'draft') {
    history.recordVerdict({
      sender: event.sender,
      channel: event.channel,
      text: event.text,
      verdict: event.verdict,
    });
  }
  if (event.type === 'reveal') {
    history.recordReveal({ sender: event.sender, channel: event.channel, kind: event.kind, note: event.note });
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
      // The agent's copy would find the port taken and be restarted forever,
      // so whatever is running now has to go first.
      if (await runningDaemon(config)) {
        if (!(await stopDaemon(config))) {
          console.error('a Slacken is already running and would not stop; stop it and try again');
          return 1;
        }
        console.log('stopped the copy that was already running');
      }
      const { plist, log } = await installAgent(config);
      console.log(`installed ${plist}`);
      console.log(`Slacken now starts at login, with no terminal. Output goes to ${log}`);
      return 0;
    }
    case 'restart': {
      await restartAgent(config);
      console.log('restarted the login agent, with the claude this shell can see');
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
      console.error(`unknown agent action: ${action} (install, uninstall, restart, status, logs)`);
      return 1;
  }
}

// `status`, `pause` and `resume` are thin clients for the running daemon: the
// pause state lives in one place, and the menu bar item and the terminal are
// two views of it rather than two copies.
async function daemon(config, method, path, body) {
  const url = `http://127.0.0.1:${config.httpPort}${path}`;
  // The daemon writes the token; every other process on this machine cannot
  // read it, and this one can only because it is running as you.
  const token = readToken();
  try {
    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401) {
      throw new Error(`the daemon refused this token; ${TOKEN_HINT}`);
    }
    // A refused setting is an answer, not a failure to reach anyone: it comes
    // back as JSON saying why, and reading it beats falling back to the file.
    if (!res.ok && res.status !== 400) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    const hint = /ECONNREFUSED|fetch failed/i.test(err.message)
      ? `nothing is listening on 127.0.0.1:${config.httpPort}. Is 'slacken start' running?`
      : err.message;
    throw new Error(hint);
  }
}

// Is a daemon already answering on this port? Two of them would inject into
// the same Slack twice and fight over the port, and under the login agent the
// loser would be restarted forever.
async function runningDaemon(config) {
  try {
    const res = await fetch(`http://127.0.0.1:${config.httpPort}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function reportAlreadyRunning(config) {
  if (!(await runningDaemon(config))) return false;
  const agent = await agentStatus();
  console.log(agent.running
    ? `[slacken] already running at login (pid ${agent.pid}) — nothing to start`
    : '[slacken] already running — nothing to start');
  console.log("[slacken] 'slacken status' says what it has done, 'slacken stop' stops it");
  return true;
}

// Ask the daemon to go, then wait until it actually has: whatever comes next
// (installing the agent, starting a fresh copy) needs the port back.
async function stopDaemon(config, { timeoutMs = 10000 } = {}) {
  try {
    await daemon(config, 'POST', '/stop');
  } catch (err) {
    // A daemon that drops the connection as it exits has still stopped.
    if (!(await runningDaemon(config))) return true;
    throw err;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await runningDaemon(config))) return true;
    await sleep(200);
  }
  return false;
}

async function cmdStop(args) {
  const config = configFrom(args);
  if (!(await runningDaemon(config))) {
    console.log('nothing is running');
    return 0;
  }
  if (!(await stopDaemon(config))) {
    console.error('it did not stop. Check its log, or kill it by hand.');
    return 1;
  }
  console.log('stopped');
  const agent = await agentStatus();
  if (agent.installed) {
    console.log("it will be back when you next log in — 'slacken agent restart' brings it back now");
  }
  return 0;
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
    if (item.separator || item.submenu) continue;
    if (item.post || item.open || item.quit) continue;
    console.log(item.label);
  }
  return 0;
}

/*
 * Why a message on screen was left as written. `status` reports what Slacken
 * did; this reports what it decided not to do, which is the only way to tell a
 * message it read and cleared from one it never saw at all.
 */
async function cmdInspect(args) {
  const config = configFrom(args);
  let res;
  try {
    res = await daemon(config, 'GET', '/inspect');
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const windows = res.windows || [];
  if (!windows.length) {
    console.log('no Slack window is attached');
    return 1;
  }

  for (const win of windows) {
    if (win.error) {
      console.log(`window ${win.target}: ${win.error}`);
      continue;
    }
    const rows = win.rows || [];
    console.log(`${win.channel || 'unknown channel'} — ${count(rows.length, 'message')} on screen`
      + `${win.paused ? ', paused' : ''}`);
    for (const row of rows) {
      const who = row.sender || 'unknown sender';
      const kind = row.threadReply ? ' [thread reply]' : '';
      console.log(`  ${who}${kind}: ${row.head || '(no text)'}`);
      console.log(`    ${row.why}`);
    }
    if (win.missedCount) {
      console.log(`  ${count(win.missedCount, 'message')} on this page`
        + ` ${win.missedCount === 1 ? 'is' : 'are'} in a layout Slacken does not read:`);
      for (const text of win.missed) console.log(`    ${text}`);
    }
    console.log('');
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

function show(value) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  // The per-channel map is a setting you edit with `slacken channel`, so what
  // belongs in a list of one-line values is how many channels have one.
  if (value && typeof value === 'object') {
    const names = Object.keys(value);
    return names.length ? names.join(', ') : '(same everywhere)';
  }
  return String(value);
}

/*
 * The terminal view of the settings menu.
 *
 * A running daemon is asked to make the change, so it lands on the messages on
 * screen right now and is written to disk once, by the process that owns it.
 * With nothing running there is nobody to ask, so the file is edited directly
 * and picked up at the next start.
 */
async function cmdSet(args) {
  writeDefaultConfig();
  const config = configFrom(args);
  const [, key, ...rest] = args._;

  if (!key) {
    for (const [name, spec] of Object.entries(SETTINGS)) {
      const choices = spec.type === 'channelMap' ? 'slacken channel <#name> <setting> <value>'
        : spec.choices ? spec.choices.map((c) => c.value).join(' | ')
          : spec.type;
      console.log(`${name.padEnd(18)} ${show(config[name]).padEnd(28)} ${choices}`);
    }
    console.log('\nslacken set <name> <value>   (a list takes commas: slacken set ignoreChannels "#eng,#random")');
    return 0;
  }

  const raw = rest.join(' ');
  if (!raw) {
    console.error(`usage: slacken set ${key} <value>`);
    return 1;
  }

  let result;
  try {
    result = await daemon(config, 'POST', '/config', { [key]: raw });
  } catch (err) {
    // Nothing running to tell. Writing the file is the whole change.
    const store = new ConfigStore();
    result = store.update({ [key]: raw });
    if (!result.errors.length) console.log(`(no daemon running; saved to ${CONFIG_PATH})`);
  }

  for (const problem of result.errors || []) console.error(problem.message);
  if (result.errors?.length) return 1;

  // Read back from whoever applied it. The daemon may have been told something
  // different since this process read the file, and its answer is the truth.
  const values = result.config || result.values || config;
  if (!result.changed.length) {
    console.log(`${key} is already ${show(values[key])}`);
    return 0;
  }
  for (const name of result.changed) console.log(`${name} = ${show(values[name])}`);
  return 0;
}

/*
 * What one channel does differently.
 *
 * The menu bar can offer this for a channel that already has settings of its
 * own; getting the first one is a terminal job, because it needs you to name
 * a channel rather than point at one.
 */
async function cmdChannel(args) {
  writeDefaultConfig();
  const config = configFrom(args);
  const [, channel, key, ...rest] = args._;

  if (!channel) {
    const overrides = config.channelOverrides || {};
    const names = Object.keys(overrides);
    if (!names.length) {
      console.log('every channel uses the same settings');
      console.log('\nslacken channel #eng-oncall minSeverity 3');
      console.log(`settings that can differ per channel: ${CHANNEL_KEYS.join(', ')}`);
      return 0;
    }
    for (const name of names) {
      const own = overrides[name];
      console.log(`${name}`);
      for (const [k, v] of Object.entries(own)) console.log(`  ${k.padEnd(18)} ${show(v)}`);
    }
    return 0;
  }

  if (!key) {
    console.error(`usage: slacken channel ${channel} <setting> <value>   (or: ${channel} reset)`);
    console.error(`settings: ${CHANNEL_KEYS.join(', ')}`);
    return 1;
  }

  const clearing = key === 'reset' || key === 'clear';
  const raw = rest.join(' ');
  if (!clearing && !raw) {
    console.error(`usage: slacken channel ${channel} ${key} <value>`);
    return 1;
  }

  const body = clearing ? { channel, clear: true } : { channel, settings: { [key]: raw } };
  let result;
  try {
    result = await daemon(config, 'POST', '/channel', body);
  } catch {
    // Nothing running to tell, so the file is the whole change.
    const store = new ConfigStore();
    result = clearing ? store.clearChannel(channel) : store.setChannel(channel, { [key]: raw });
    if (!result.errors.length) console.log(`(no daemon running; saved to ${CONFIG_PATH})`);
  }

  for (const problem of result.errors || []) console.error(problem.message);
  if (result.errors?.length) return 1;

  if (clearing) {
    console.log(`${channel} uses the global settings again`);
    return 0;
  }
  const overrides = result.channelOverrides || result.values?.channelOverrides || {};
  const own = Object.entries(overrides).find(([name]) => name.trim().toLowerCase().replace(/^#/, '')
    === channel.trim().toLowerCase().replace(/^#/, ''))?.[1] || {};
  console.log(`${channel}: ${Object.entries(own).map(([k, v]) => `${k} = ${show(v)}`).join(', ') || 'nothing of its own'}`);
  return 0;
}

// Read from the file rather than from the daemon: the record is written by
// whoever was running at the time, and reading it does not need one running now.
async function cmdHistory(args) {
  const config = configFrom(args);
  const history = new History({ config });
  const entries = history.read({ limit: Number(args.lines || 40) });

  if (!entries.length) {
    console.log(config.historyEnabled === false
      ? `nothing recorded (historyEnabled is off; ${HISTORY_PATH})`
      : `nothing recorded yet (${HISTORY_PATH})`);
    return 0;
  }
  if (args.json) {
    for (const entry of entries) console.log(JSON.stringify(entry));
    return 0;
  }
  for (const entry of entries) console.log(formatEntry(entry));
  return 0;
}

// For talking to the control API by hand. Printed rather than echoed into a
// shell history by a helpful example: it is the one thing here worth keeping.
async function cmdToken() {
  const token = readToken();
  if (!token) {
    console.error('no token yet; it is written the first time the daemon starts');
    return 1;
  }
  console.log(token);
  return 0;
}

async function cmdVersion(args) {
  const config = configFrom(args);
  console.log(`slacken ${VERSION}`);
  if (!args.check) return 0;
  const update = await checkForUpdate(config, { force: true });
  if (!update) {
    console.log('could not reach GitHub to check for a newer one');
    return 1;
  }
  console.log(update.newer ? `${update.latest} is available: ${update.url}` : 'that is the newest release');
  return 0;
}

/*
 * What the running daemon says about itself, checked against this process.
 *
 * Every check above this one is answered by the process you just typed the
 * command into, and the process doing the work is a different one, started at
 * login, with a PATH of its own and — after an upgrade — code of its own. That
 * is the whole of "doctor says everything is fine and nothing is happening",
 * so the two are compared here rather than each being reported as if it spoke
 * for both.
 */
export function daemonChecks(status, claude, version = VERSION) {
  const checks = [];
  const mine = claude?.path || null;
  const theirs = status.claude?.path || null;

  // An upgrade replaces the files on disk. It does not replace the process,
  // and a fix that is not in the running process has not been applied yet.
  // No version at all means a daemon from before this line existed, which is
  // the same answer: it is not the Slacken you installed.
  if (status.version !== version) {
    checks.push(['daemon is current', false,
      `running ${status.version || 'a build too old to say'}, you have ${version}`
      + ' — the running one is what answers your messages. Restart it: slacken agent restart']);
  }

  if (status.claude) {
    if (theirs) {
      checks.push([`daemon can run ${status.claude.bin}`, true,
        `${theirs}${status.claude.source === 'path' ? '' : ` (${status.claude.source})`}`]);
    } else if (mine) {
      // The case this whole check exists for: claude is installed somewhere
      // only a terminal's PATH knows about, so this process runs it happily
      // and the daemon has never been able to.
      checks.push([`daemon can run ${status.claude.bin}`, false,
        `no — this shell finds it at ${mine}, the daemon does not.`
        + ` It looked in: ${(status.claude.searched || []).join(', ')}.`
        + ' Fix: slacken agent restart, which starts it with this claude on its PATH']);
    } else {
      checks.push([`daemon can run ${status.claude.bin}`, false,
        `no, and neither can this — ${notFoundMessage(status.claude.bin, status.claude.searched)}`]);
    }
  }

  if (status.lastError) {
    const { kind, message } = status.lastError;
    // Not `hint`: that one says "run: slacken doctor", which is fine on a menu
    // and useless here, where it is the thing you already did.
    const fixed = kind === 'missing' && theirs;
    // A daemon too old to say where its claude is has already been told to
    // restart, one line up. Sending it to the config file as well would be
    // two fixes for one problem, and the wrong one first.
    const detail = kind === 'missing' && !status.claude && mine
      ? `${message} — but that is this daemon, not this shell, which runs it at ${mine};`
        + ' restart the daemon and try again'
      : doctorHint(kind, message);
    checks.push(['last model call', Boolean(fixed),
      fixed
        ? `failed (${kind}), but the daemon can see claude now — the next message will use it`
        : detail]);
  }
  return checks;
}

// The same failures errorHint names, said to someone who is already looking at
// a full report and needs the next move rather than where to go for one.
function doctorHint(kind, message) {
  switch (kind) {
    case 'auth': return 'not signed in to Claude — run: claude login';
    case 'missing': return `${message} — set claudeBin in ~/.slacken/config.json`;
    case 'rate-limit': return 'rate limited by the API — nothing to fix, it will catch up';
    case 'overloaded': return 'the API was overloaded — nothing to fix, it will catch up';
    case 'timeout': return `model calls are timing out — raise requestTimeoutMs, or use a smaller model (${message})`;
    default: return String(message || 'model call failed');
  }
}

async function cmdDoctor(args) {
  const config = configFrom(args);
  const checks = [];

  checks.push(['platform', supportedPlatform(), process.platform]);
  checks.push(['node >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node]);

  const app = findSlackApp();
  checks.push(['Slack found', Boolean(app), app || `not in ${slackLocations()}`]);

  // Not just "is it on PATH": the daemon looks in more places than a login
  // shell's PATH, so this has to report on the same lookup the daemon does —
  // and, when it comes up empty, on where that lookup went.
  const claude = await resolveClaudeBin(config.claudeBin, { useCache: false });
  let claudeVersion = null;
  if (claude.path) {
    try {
      const { stdout } = await execFileAsync(claude.path, ['--version'], {
        timeout: 10000,
        env: { ...process.env, PATH: spawnPath(claude.path) },
      });
      claudeVersion = stdout.trim();
    } catch (err) {
      claudeVersion = err.message;
    }
  }
  const claudeOk = Boolean(claudeVersion && /\d/.test(claudeVersion));
  checks.push([
    `${config.claudeBin} runnable`,
    claudeOk,
    claude.path
      ? `${claudeVersion} — ${claude.path}${claude.source === 'path' ? '' : ` (${claude.source})`}`
      : notFoundMessage(config.claudeBin, claude.searched),
  ]);

  // The check the menu bar's "N errors" line sends you here for. Everything
  // else can pass while the one call that matters — the flags this daemon
  // actually invokes claude with, against the model actually configured —
  // fails on every single message.
  if (!args['no-model']) {
    // cacheTtlHours 0 turns the cache off entirely, so this neither answers
    // from a week-old verdict nor leaves one behind.
    const moderator = new Moderator({ ...config, cacheTtlHours: 0 });
    const startedAt = Date.now();
    let detail;
    let ok = false;
    try {
      const verdict = await moderator.moderate({
        text: 'Circling back on this — just wanted to check whether the deploy is still going out at 3pm today.',
        sender: 'slacken doctor',
        channel: 'slacken doctor',
      });
      ok = !verdict.error;
      detail = verdict.error || `answered in ${Math.round((Date.now() - startedAt) / 100) / 10}s`;
    } catch (err) {
      detail = err.message;
    }
    checks.push(['model answers', ok, `${config.model} — ${detail}`]);
  }

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

  if (agentPath()) {
    const agent = await agentStatus();
    // Informational: running it from a terminal is a perfectly good way to run
    // it, so not having the agent installed is never a failure.
    checks.push(['runs at login', true, !agent.installed
      ? 'no (run: slacken agent install)'
      : agent.running ? `yes (pid ${agent.pid})` : 'installed, but not running right now']);
  }

  const slackUp = await isSlackRunning();
  const portOpen = await isDebugPortOpen(config.cdpPort);
  // Informational: `start` launches Slack itself, so "not running" is fine.
  checks.push(['Slack running', true, slackUp ? 'yes' : 'no (start will launch it)']);
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

  // Anything already running knows things this process cannot work out from
  // the outside: whether the model is answering, and whether the page script
  // is still finding messages in a Slack that may have been updated overnight.
  const running = await runningDaemon(config);
  if (running) {
    try {
      const status = await daemon(config, 'GET', '/status');
      checks.push(['daemon', true, `running · ${status.attached} window(s) attached`
        + `${status.paused ? ' · PAUSED' : ''}`]);
      checks.push(['finding messages', !status.drifted,
        status.drifted ? "no — Slack's layout may have changed (see the README)" : 'yes']);
      checks.push(...daemonChecks(status, claude));
    } catch (err) {
      checks.push(['daemon', false, `running, but would not answer: ${err.message}`]);
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
