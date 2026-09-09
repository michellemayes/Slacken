# SlackCensor

Rewrites incoming Slack messages in the real macOS desktop app, in place, as
you read them. Two jobs:

- **Soften** messages that are aggressive, hostile, or manufacturing urgency.
- **Condense** messages padded out with assistant-style filler down to one sentence.

Nothing is deleted. Every rewrite carries a badge, and one click brings the
original back.

```
┌────────────────────────────────────────────┐   ┌────────────────────────────────────────────┐
│ Dana Wu  10:04                             │   │ Priya Nair  10:06                          │
│ Deploy is still broken. I've asked for     │   │ We should revisit the retry logic before   │
│ this three times. It needs to be fixed by  │   │ the next release.                          │
│ 3pm today.                                 │   │                                            │
│ ● softened      show original              │   │ ● condensed     show original              │
└────────────────────────────────────────────┘   └────────────────────────────────────────────┘
```

Left, the original was `WHY is the deploy STILL broken?? I asked for this THREE
times. I need it fixed by 3pm today, this is completely unacceptable.` — note
that the 3pm deadline survived. Right, the original was 66 words of circling
back and taking a moment.

## How it works

```
  Slack.app (Electron)                    slackcensor (node)
  ┌──────────────────────┐                ┌────────────────────────┐
  │ renderer             │                │ poll /json/list        │
  │  client/inject.js    │◄── CDP ────────┤ attach + inject        │
  │   · find messages    │    :9222       │                        │
  │   · local triage     │                │ Runtime.addBinding     │
  │   · hold suspects    ├── binding ────►│  ├─ cache lookup       │
  │   · swap in rewrite  │                │  ├─ 120ms batch window │
  │   · reveal toggle    │◄── evaluate ───┤  └─ claude -p ──► 🤖   │
  └──────────────────────┘                └────────────────────────┘
```

1. Slack is launched with `--remote-debugging-port`. Nothing about the app
   bundle is modified — no `app.asar` patching, no broken code signature, and
   nothing to redo after a Slack update.
2. `client/inject.js` is injected into the Slack renderer over CDP. It watches
   the message list, extracts message text, and skips your own messages.
3. Messages are triaged locally first, for free. Tone triage looks for
   shouting, exclamation runs, urgency and blame phrasing. Padding triage
   needs both length and filler markers, so a long message dense with facts is
   left alone. Only what clears triage costs a model call.
4. Anything suspected is hidden immediately behind a `checking…` placeholder,
   so you do not read the hostile version while the model decides. It is
   restored in full if the model disagrees.
5. The page asks the daemon through a CDP binding rather than `fetch`, so
   Slack's content security policy is not involved and no HTTP request leaves
   the page.
6. Messages that arrive together are batched into one
   `claude -p --output-format json` call. Verdicts are cached on disk by
   message text, so re-reading a channel is free.

## Speed and cost

Every number below was measured on this machine with `claude-haiku-4-5`, not
estimated. The last row is the shipped configuration handling a burst of eight
messages.

| | latency | cost per message |
| --- | --- | --- |
| naive `claude -p`, one call per message | 8–11 s | ~$0.0060 |
| thinking disabled | 2.4 s | $0.0031 |
| thinking disabled, batch of 8 | 656 ms | $0.00068 |
| **shipped, real burst of 8** | **912 ms** | **$0.00094** |

What actually mattered, in order:

- **`MAX_THINKING_TOKENS=0` is the whole ballgame.** By default a verdict cost
  ~800 thinking tokens to produce one line of JSON. Turning it off took a call
  from ~10 s to ~2.4 s and cut cost ~3x. It also *improved* schema adherence:
  the thinking runs returned out-of-range severities, the non-thinking runs
  did not.
- **Batching.** One call for eight messages is 4.5x cheaper per message than
  eight calls, and the per-message wait drops accordingly. Requests are held
  for `batchWindowMs` (120 ms) so messages that render together travel together.
- **Not calling the model.** Local triage and the disk cache are the cheapest
  optimisations available, because they cost nothing.
- **`--json-schema`** guarantees parseable JSON back, for a small token cost.

Two things measured and deliberately **not** used:

- **A persistent `--input-format stream-json` session.** Turns were no faster
  than a cold call, and because the conversation accumulates, the sixth turn
  cost 4.7x the first. Process startup was never the bottleneck.
- **`--effort low`.** No measurable effect on thinking tokens or latency.

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
after you switch workspaces or the app relaunches. On exit it prints what the
session cost.

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
| `batchSize` / `batchWindowMs` | `8` / `120` | How many messages share a call, and how long to wait to fill one |
| `maxConcurrency` | `2` | Concurrent `claude -p` processes |
| `useJsonSchema` | `true` | Structured output; guarantees parseable verdicts |
| `dailyBudgetUsd` | `0` | Stop calling the model past this much in a day. `0` disables the cap |
| `triageMode` | `heuristic` | `always` sends every message to the model |
| `triageThreshold` | `2` | Local tone score needed before a call is worth making |
| `minSeverity` | `2` | Model severity (0–3) required before hostile phrasing is replaced |
| `condenseEnabled` | `true` | Set `false` to soften tone but never compress |
| `condenseMinWords` | `45` | Shorter messages are never condensed |
| `condenseMaxRatio` | `0.7` | A "condense" that is not at least this much shorter is discarded |
| `holdWhilePending` | `true` | Hide a suspected message while the model decides, rather than after |
| `selfNames` | `[]` | Fallback if your display name is not detected from the Slack UI |
| `ignoreSenders` | `[]` | Never rewrite these people |
| `ignoreChannels` | `[]` | Never rewrite in these channels |
| `maxChars` | `4000` | Longer messages are left alone |
| `cdpPort` | `9222` | Slack's debug port |
| `httpPort` | `8787` | Loopback control API (`/health`, `/moderate`, `/reinject`) |
| `targetUrlPattern` | `^https://([a-z0-9-]+\.)*slack\.com/` | Widen for a custom workspace domain |
| `claudeBin` / `claudeArgs` | `claude` / `[]` | If `claude` lives somewhere unusual, or you want extra flags |

## Things worth knowing before you run this

**Rewriting incoming messages can hide things you needed.** That is the whole
point and also the whole risk, and condensing is the sharper edge of it:
softening keeps the message's shape, condensing throws detail away on purpose.
The guards are: the prompt treats deadlines, numbers, names and the ask itself
as information that must survive any rewrite; condensing only applies to
messages of at least `condenseMinWords`, and only if the result is genuinely
shorter; messages that are mostly code, a link, or a stack trace are never
condensed; a verdict with no rewrite or below `minSeverity` changes nothing;
and the original is always one click away. For a channel where you cannot
afford any filtering, use `ignoreChannels`.

**Message text is sent to Claude.** Everything that clears local triage goes to
the model through `claude -p`, under your own Claude account and its data
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
npm test         # everything
npm run test:fast   # skips the browser test
```

- `test/unit.mjs` — parsing whatever `claude -p` returns, and the gating that
  decides when a verdict is allowed to change the screen.
- `test/batch.mjs` — the batching, caching and budget logic that make this
  cheap, run against a fake `claude` binary that records how many times it was
  actually invoked. Asserts that four simultaneous messages cost one process.
- `test/e2e.mjs` — a real Chromium against a fake Slack DOM
  (`test/fixture.html`), driving the actual attach-and-inject code with a stub
  moderator. Asserts that a heated message is replaced, a padded one is
  condensed, a long fact-dense one is left alone, a message with a code block
  never costs a call, a grouped follow-up inherits its sender, your own
  messages are skipped, a suspected message is hidden while the model decides
  and restored if cleared, the reveal toggle works both ways, and a re-render
  that destroys the panel is repaired from cache rather than by asking again.
  Skips itself if no Chromium is present; point `SLACKCENSOR_TEST_CHROME` at
  one to run it.

## Layout

```
bin/slackcensor.js   CLI entry point
src/cli.js           commands, logging, arg parsing
src/launch.js        find, quit, and relaunch Slack.app with the debug port
src/cdp.js           minimal Chrome DevTools Protocol client
src/attach.js        attach to Slack windows, inject, serve binding calls
src/moderate.js      batch, run claude -p, parse and gate the verdicts
src/prompt.js        the moderation prompt and response schema
src/cache.js         disk-backed verdict cache
src/server.js        loopback control API
src/config.js        defaults and ~/.slackcensor/config.json
client/inject.js     the page script: find, triage, hold, replace, reveal
```
