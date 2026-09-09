# SlackCensor

Softens incoming Slack messages that are aggressive, hostile, or manufacturing
urgency — in the real macOS Slack desktop app, in place, as you read them.

A flagged message is replaced with a neutral rewrite plus a small badge. The
original is never deleted; one click brings it back.

```
┌────────────────────────────────────────────┐
│ Dana Wu  10:04                             │
│ The deploy is still broken. I've asked      │
│ about this before. I need it fixed by 3pm  │
│ today.                                     │
│ ● aggressive · blaming   show original     │
└────────────────────────────────────────────┘
```

The original was `WHY is the deploy STILL broken?? I asked for this THREE times.
I need it fixed by 3pm today, this is completely unacceptable.` — note that the
3pm deadline survived. Removing hostility must not remove information.

## How it works

```
  Slack.app (Electron)                    slackcensor (node)
  ┌──────────────────────┐                ┌────────────────────────┐
  │ renderer             │                │ poll /json/list        │
  │  client/inject.js    │◄── CDP ────────┤ attach + inject        │
  │   · find messages    │    :9222       │                        │
  │   · local triage     │                │ Runtime.addBinding     │
  │   · swap in rewrite  ├── binding ────►│  ├─ cache lookup       │
  │   · reveal toggle    │◄── evaluate ───┤  └─ claude -p ──► 🤖   │
  └──────────────────────┘                └────────────────────────┘
```

1. Slack is launched with `--remote-debugging-port`. Nothing about the app
   bundle is modified — no `app.asar` patching, no broken code signature, and
   nothing to redo after a Slack update.
2. `client/inject.js` is injected into the Slack renderer over CDP. It watches
   the message list, extracts message text, and skips your own messages.
3. Messages are triaged locally first (all-caps, exclamation runs, "ASAP",
   blame phrasing). Only ones that look heated cost a model call. Set
   `triageMode: "always"` if you want every message judged by the model.
4. The page asks the daemon for a verdict through a CDP binding rather than
   `fetch`, so Slack's content security policy is not involved and no HTTP
   request leaves the page.
5. The daemon shells out to `claude -p --output-format json` and returns
   `{flagged, tone, severity, rewrite, note}`. Verdicts are cached on disk by
   message text, so re-reading a channel is free.

## Requirements

- macOS, Slack desktop app in `/Applications` or `~/Applications`
- Node 20+
- `claude` on your `PATH` and already logged in (`claude -p "hi"` should work)

## Install

```sh
git clone https://github.com/michellemayes/SlackCensor.git
cd SlackCensor
npm install
node bin/slackcensor.js doctor
```

Optionally `npm link` to get a `slackcensor` command anywhere.

## Use

```sh
# Quit Slack first, then:
node bin/slackcensor.js start

# Or let it quit Slack for you:
node bin/slackcensor.js start --force
```

Leave it running. It attaches to each Slack window as it appears, including
after you switch workspaces or the app relaunches.

| Command | What it does |
| --- | --- |
| `start [--force] [--no-launch] [--always] [--verbose]` | Launch Slack with the debug port, attach, moderate |
| `launch [--force]` | Just relaunch Slack with the debug port open |
| `attach [--verbose]` | Attach to a Slack that is already launched with the port |
| `test "<message>"` | Moderate one string and print the verdict — no Slack needed |
| `doctor` | Check Slack, `claude`, the debug port, and visible Slack windows |
| `config` | Print the config file path and contents |

`Cmd+Shift+U` in Slack toggles every original on the screen at once.

## Configuration

`~/.slackcensor/config.json`, created on first run.

| Key | Default | Notes |
| --- | --- | --- |
| `model` | `claude-haiku-4-5-20251001` | Small and fast; messages arrive quicker than you read them |
| `triageMode` | `heuristic` | `always` sends every message to the model |
| `triageThreshold` | `2` | Local score a message needs before it is worth a model call |
| `minSeverity` | `2` | Model severity (0–3) required before anything is replaced |
| `selfNames` | `[]` | Fallback if your display name is not detected from the Slack UI |
| `ignoreSenders` | `[]` | Never rewrite these people |
| `ignoreChannels` | `[]` | Never rewrite in these channels |
| `maxChars` | `4000` | Longer messages are left alone |
| `maxConcurrency` | `2` | Concurrent `claude -p` processes |
| `cdpPort` | `9222` | Slack's debug port |
| `httpPort` | `8787` | Loopback control API (`/health`, `/moderate`, `/reinject`) |
| `targetUrlPattern` | `^https://([a-z0-9-]+\.)*slack\.com/` | Widen for a custom workspace domain |
| `claudeBin` / `claudeArgs` | `claude` / `[]` | If `claude` lives somewhere unusual, or you want extra flags |

## Things worth knowing before you run this

**Softening incoming messages can hide real urgency.** That is the whole point
and also the whole risk. Three things are deliberately built in against it: the
prompt is told that deadlines, numbers and the ask itself are information and
must survive intact; a verdict with no rewrite or below `minSeverity` changes
nothing; and the original is always one click away. If a channel is one where
you cannot afford any filtering, put it in `ignoreChannels`.

**Message text is sent to Claude.** Every message that clears local triage goes
to the model through `claude -p`, under your own Claude account and its data
policies. Verdicts are cached in plain text at `~/.slackcensor/cache.json`. If
you work in channels where that is not acceptable, use `ignoreChannels` or do
not run this there.

**The debug port is powerful.** While Slack runs with `--remote-debugging-port`,
any process on your Mac that can reach `127.0.0.1:9222` can drive your logged-in
Slack session. Chromium binds it to loopback only, but this is still a real
widening of what a local process can do. Close it by quitting and reopening
Slack normally.

**Nothing is sent to your coworkers.** This only changes what is drawn in your
own client. It never edits, deletes, or replies to anything, and the sender has
no idea it exists. It also does not touch messages you write.

**Slack's DOM is not a public API.** Slack can rename a class and break message
detection. When that happens, the selectors are all in one place at the top of
`client/inject.js`, and `POST /reinject` reloads the script without restarting
the daemon.

## Tests

```sh
npm test
```

`test/unit.mjs` covers parsing whatever `claude -p` returns and the gating that
decides when a verdict is allowed to change the screen.

`test/e2e.mjs` launches a real Chromium against a fake Slack DOM
(`test/fixture.html`) and drives the actual attach-and-inject code with a stub
moderator, asserting that a heated message is replaced, a grouped follow-up
inherits its sender, a neutral message never reaches the model, your own
messages are skipped, the reveal toggle works both ways, and a re-render that
destroys the panel is repaired from cache rather than by asking again. It skips
itself if no Chromium is present; point `SLACKCENSOR_TEST_CHROME` at one to run
it.

## Layout

```
bin/slackcensor.js   CLI entry point
src/cli.js           commands, logging, arg parsing
src/launch.js        find, quit, and relaunch Slack.app with the debug port
src/cdp.js           minimal Chrome DevTools Protocol client
src/attach.js        attach to Slack windows, inject, serve binding calls
src/moderate.js      run claude -p, parse and gate the verdict
src/prompt.js        the moderation prompt
src/cache.js         disk-backed verdict cache
src/server.js        loopback control API
src/config.js        defaults and ~/.slackcensor/config.json
client/inject.js     the page script: find, triage, replace, reveal
```
