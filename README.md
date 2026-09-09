# Slacken

A calmer reading layer for Slack on macOS. Formerly SlackCensor — same
project, renamed to Slacken.

Incoming messages get rewritten in place, in the real desktop app, as you read
them. Two things happen:

- **Condense** — messages padded out with filler collapse to a single sentence.
- **Even out** — messages written at high intensity are re-phrased flat.

Nothing is deleted and nothing is sent anywhere. Every rewrite carries a small
badge, and one click brings the original back. A menu bar item shows what has
been changed and pauses the whole thing.

```
┌────────────────────────────────────────────┐   ┌────────────────────────────────────────────┐
│ Priya Nair  10:06                          │   │ Dana Wu  10:04                             │
│ We should revisit the retry logic before   │   │ Deploy is still broken. I've asked for     │
│ the next release.                          │   │ this three times. It needs to be fixed by  │
│                                            │   │ 3pm today.                                 │
│ ● condensed     show original              │   │ ● softened      show original              │
└────────────────────────────────────────────┘   └────────────────────────────────────────────┘
```

Left, the original was 66 words of circling back and taking a moment. Right,
the original said the same thing in capitals — note that the 3pm deadline
survived. Taking the edge off must never take the facts with it.

## How it works

```
  Slack.app (Electron)                    slacken (node)
  ┌──────────────────────┐                ┌────────────────────────┐
  │ renderer             │                │ poll /json/list        │
  │  client/inject.js    │◄── CDP ────────┤ attach + inject        │
  │   · find messages    │    :9222       │                        │
  │   · local triage     │                │ Runtime.addBinding     │
  │   · hold suspects    ├── binding ────►│  ├─ cache lookup       │
  │   · swap in rewrite  │                │  ├─ 120ms batch window │
  │   · reveal toggle    │◄── evaluate ───┤  └─ claude -p ──► 🤖   │
  └──────────────────────┘                └───────────┬────────────┘
                                                      │ :8787
  ┌──────────────────────┐                ┌───────────┴────────────┐
  │ menu bar             │◄── GET  /menubar ── the menu, rendered  │
  │  SlackenMenuBar      │─── POST /pause ──► pause / resume       │
  └──────────────────────┘                └────────────────────────┘
```

1. Slack is launched with `--remote-debugging-port`. Nothing about the app
   bundle is modified — no `app.asar` patching, no broken code signature, and
   nothing to redo after a Slack update.
2. `client/inject.js` is injected into the Slack renderer over CDP. It watches
   the message list, extracts message text, and skips your own messages.
3. Messages are triaged locally first, for free. Padding triage needs both
   length and filler markers, so a long message dense with facts is left alone.
   Intensity triage looks for capitals, exclamation runs and urgency phrasing.
   Only what clears triage costs a model call.
4. Anything suspected is hidden the moment triage suspects it, before the
   frame is painted, so the original never gets on screen while the model
   decides. The panel holds the message's height while it waits, so nothing
   on the page jumps, and it stays wordless for the first 140ms — a cached
   verdict beats that and swaps straight in, so a fast answer never flashes a
   `checking…` placeholder on the way past. It is restored in full if the
   model finds nothing worth changing.
5. The hold is a CSS rule rooted at the list item rather than an attribute on
   the message body, because Slack re-renders message bodies constantly and
   anything written onto one dies with it. A body React has just re-created
   arrives already hidden by the cascade, with no JavaScript in the way and so
   no window to see through. Repairs — a panel Slack removed, a recycled list
   item showing the wrong message — run synchronously inside the
   MutationObserver callback, which the browser calls before it paints; the
   panel is reconciled in place rather than torn down and rebuilt.
6. The page asks the daemon through a CDP binding rather than `fetch`, so
   Slack's content security policy is not involved and no HTTP request leaves
   the page.
7. Messages that arrive together are batched into one
   `claude -p --output-format json` call. Verdicts are cached on disk by
   message text, so re-reading a channel is free, and kept in the renderer as
   well so a reload repaints its rewrites without a round trip.

## Install

macOS, Node 20+, and `claude` on your `PATH` and signed in (`claude -p "hi"`
should work). The menu bar item is compiled on first run and needs `swiftc`
from the Xcode Command Line Tools (`xcode-select --install`); without it
everything else works and the daemon says so once.

```sh
git clone https://github.com/michellemayes/Slacken.git
cd Slacken
./install.sh
```

That checks your setup, installs dependencies, and puts `slacken` on your PATH.
Then:

```sh
slacken doctor    # confirm everything is wired up
slacken start     # quit Slack, relaunch it with the debug port, and begin
```

To have it running whenever you are logged in:

```sh
./install.sh --agent     # or: slacken agent install
```

That writes a LaunchAgent at `~/Library/LaunchAgents/com.slacken.agent.plist`
which starts Slacken at login and restarts it if it ever exits. Because launchd
does not hand an agent a useful `PATH`, the plist bakes in the directory
`claude` actually lives in, resolved at install time.

```sh
slacken agent status     # installed? running? what pid?
slacken agent logs       # recent output
slacken agent uninstall  # stop running at login
./install.sh --uninstall # remove the command and the agent
```

Uninstalling leaves `~/.slacken` (config and cache) alone; delete it by hand if
you want it gone.

## Use

Leave `slacken start` running. It attaches to each Slack window as it appears,
including after you switch workspaces or the app relaunches. On exit it prints
what the session cost.

| Command | What it does |
| --- | --- |
| `start [--force] [--no-launch] [--always] [--verbose]` | Launch Slack with the debug port, attach, and begin |
| `launch [--force]` | Just relaunch Slack with the debug port open |
| `attach [--verbose]` | Attach to a Slack that is already launched with the port |
| `test "<message>"` | Rewrite one string and print the verdict — no Slack needed |
| `doctor` | Check Slack, `claude`, the debug port, and visible Slack windows |
| `config` | Print the config file path and contents |
| `status` | What the running daemon has done so far |
| `pause` / `resume` | Stop and restart rewriting, without stopping the daemon |
| `agent install\|uninstall\|status\|logs` | Manage the login agent |

`--force` lets it quit a running Slack so it can be relaunched with the port.
`Cmd+Shift+U` inside Slack toggles every original on the screen at once.

## The menu bar item

While the daemon runs there is an item in the menu bar. It is the answer to the
two questions this tool raises the moment you leave it running: *is it on right
now*, and *how much of what I just read was not what was written*.

```
                                       ┌──────────────────────────────────┐
                                       │  Watching 1 Slack window         │
   ▐ 🗨  ▌ ◄────────────────────────    ├──────────────────────────────────┤
                                       │  Pause                           │
                                       ├──────────────────────────────────┤
                                       │  8 messages rewritten of 50 read │
                                       │  5 softened · 3 condensed        │
                                       │  4 model calls · 38 from cache   │
                                       │  $0.0104 today                   │
                                       ├──────────────────────────────────┤
                                       │  claude-haiku-4-5 · triage …     │
                                       │  Running for 1 hour              │
                                       ├──────────────────────────────────┤
                                       │  Open config…                    │
                                       │  Open log…                       │
                                       ├──────────────────────────────────┤
                                       │  Hide menu bar item              │
                                       └──────────────────────────────────┘
```

The icon dims whenever nothing is being changed — paused, or attached to no
Slack window — so the state is readable without opening anything.

**Pause** is the important one. It does not merely stop new rewrites: every
message already swapped out on screen flips back to what its sender actually
wrote, held messages are released, and nothing is sent to the model until you
resume. `slacken pause` and `slacken resume` do exactly the same thing from a
terminal, and `slacken status` prints the same lines the menu shows.

A pause is written to `~/.slacken/state.json` and survives a restart. It has
to: the login agent brings the daemon back whenever it exits, and a pause that
quietly undid itself would leave you reading a rewritten feed you believed you
had turned off. The menu bar item is what stops that becoming a pause you
forgot about.

The item is a small AppKit program in `menubar/SlackenMenuBar.swift`, compiled
on first run and cached in `~/.slacken/menubar/` by the hash of its source. It
decides nothing: the wording, the counts and the actions are rendered by
`src/menubar.js` and fetched as JSON from `GET /menubar`, which is why the part
that can be wrong is testable on any machine. It holds the daemon's stdin, so
it cannot outlive the daemon even if that daemon is killed outright.

Without `swiftc` there is no item, one line says so at startup, and everything
else runs unchanged. Set `menuBar` to `false` in the config to skip it, or
click **Hide menu bar item** to dismiss it for this run.

## Speed and cost

Every number below was measured with `claude-haiku-4-5`, not estimated. The
last row is the shipped configuration handling a burst of eight messages.

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
  the thinking runs returned out-of-range values, the non-thinking runs did not.
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

## Configuration

`~/.slacken/config.json`, created on first run.

| Key | Default | Notes |
| --- | --- | --- |
| `model` | `claude-haiku-4-5-20251001` | Small and fast; messages arrive quicker than you read them |
| `batchSize` / `batchWindowMs` | `8` / `120` | How many messages share a call, and how long to wait to fill one |
| `maxConcurrency` | `2` | Concurrent `claude -p` processes |
| `useJsonSchema` | `true` | Structured output; guarantees parseable verdicts |
| `dailyBudgetUsd` | `0` | Stop calling the model past this much in a day. `0` disables the cap |
| `triageMode` | `heuristic` | `always` sends every message to the model |
| `triageThreshold` | `2` | Local score needed before a call is worth making |
| `minSeverity` | `2` | Model severity (0–3) required before a tone rewrite is applied |
| `condenseEnabled` | `true` | Set `false` to leave long messages alone |
| `condenseMinWords` | `45` | Shorter messages are never condensed |
| `condenseMaxRatio` | `0.7` | A condense that is not at least this much shorter is discarded |
| `holdWhilePending` | `true` | Hide a suspected message while the model decides, rather than after |
| `persistVerdicts` | `true` | Keep rewrites in Slack's `localStorage` too, so a reload repaints instantly. `false` leaves nothing behind |
| `selfNames` | `[]` | Fallback if your display name is not detected from the Slack UI |
| `ignoreSenders` | `[]` | Never rewrite these people |
| `ignoreChannels` | `[]` | Never rewrite in these channels |
| `maxChars` | `4000` | Longer messages are left alone |
| `menuBar` | `true` | Show the menu bar item. Needs `swiftc`; without it, skipped |
| `cdpPort` | `9222` | Slack's debug port |
| `httpPort` | `8787` | Loopback control API (`/status`, `/menubar`, `/pause`, `/moderate`) |
| `targetUrlPattern` | `^https://([a-z0-9-]+\.)*slack\.com/` | Widen for a custom workspace domain |
| `claudeBin` / `claudeArgs` | `claude` / `[]` | If `claude` lives somewhere unusual, or you want extra flags |

## Things worth knowing before you run this

**Rewriting what you read can hide things you needed.** That is the whole point
and also the whole risk, and condensing is the sharper edge of it: evening out
tone keeps the message's shape, condensing throws detail away on purpose. The
guards are: the prompt treats deadlines, numbers, names and the ask itself as
information that must survive any rewrite; condensing only applies to messages
of at least `condenseMinWords`, and only if the result is genuinely shorter;
anything mostly code, a link, or a stack trace is never condensed; a verdict
with no rewrite or below `minSeverity` changes nothing; and the original is
always one click away. For a channel where you cannot afford any filtering, use
`ignoreChannels`.

**Message text is sent to Claude.** Everything that clears local triage goes to
the model through `claude -p`, under your own Claude account and its data
policies. Verdicts are cached in plain text at `~/.slacken/cache.json`. If you
work in channels where that is not acceptable, use `ignoreChannels` or do not
run this there.

**The debug port is powerful.** While Slack runs with `--remote-debugging-port`,
any process on your Mac that can reach `127.0.0.1:9222` can drive your logged-in
Slack session. Chromium binds it to loopback only, but this is still a real
widening of what a local process can do. Close it by quitting and reopening
Slack normally.

**You can always turn it off without turning it off.** Pause from the menu bar
and every rewrite on screen reverts to what was written, immediately, with no
model call and no restart. That is the intended move when a conversation
matters enough that you want the words themselves — it is faster and less
final than quitting, and the menu bar item makes it obvious you are paused.

**It is entirely local to you.** This only changes what is drawn in your own
client. It never edits, deletes, or replies to anything, nobody else can tell
it is running, and it does not touch messages you write.

**Slack's DOM is not a public API.** Slack can rename a class and break message
detection. When that happens, the selectors are all in one place at the top of
`client/inject.js`, and `POST /reinject` reloads the script without restarting
the daemon.

## Tests

```sh
npm test            # everything
npm run test:fast   # skips the browser test
```

- `test/unit.mjs` — parsing whatever `claude -p` returns, and the gating that
  decides when a verdict is allowed to change the screen.
- `test/batch.mjs` — the batching, caching and budget logic that make this
  cheap, run against a fake `claude` binary that records how many times it was
  actually invoked. Asserts that four simultaneous messages cost one process.
- `test/agent.mjs` — the generated LaunchAgent plist, including that it carries
  a `PATH` that can actually find `claude`.
- `test/control.mjs` — pausing, and the menu the menu bar item draws. Asserts
  that a pause survives a restart, that a paused Slacken makes no model call
  and caches nothing, that the control endpoints agree with each other, and
  that the menu offers exactly one of pause and resume. It also covers the
  helper around the helper: the compile is cached by source hash and never
  repeated, a failed compile leaves nothing that looks finished, closing stdin
  is what stops the item outliving the daemon, and a crashing one is retried
  twice and then left alone. The AppKit itself is deliberately too dumb to
  test; everything it says is decided here.
- `test/e2e.mjs` — a real Chromium against a fake Slack DOM
  (`test/fixture.html`), driving the actual attach-and-inject code with a stub
  moderator. Asserts that an intense message is replaced, a padded one is
  condensed, a long fact-dense one is left alone, a message with a code block
  never costs a call, a grouped follow-up inherits its sender, your own
  messages are skipped, a suspected message is hidden while the model decides
  and restored if cleared, the reveal toggle works both ways, a re-render that
  destroys the panel is repaired from cache rather than by asking again, and a
  message body replaced underneath us is unreadable in the same task that
  replaced it — the flash guard, asserted before any observer or timer could
  have run. It also covers the pause: every rewritten message flips back to
  what was written, a message that arrives during a pause is never triaged or
  sent, a verdict that lands after a pause has begun is thrown away rather than
  quietly applied later, and resuming picks up what the pause let through
  without re-asking about anything already decided.
  It finds any Chromium on the machine and skips itself if there is none;
  `SLACKEN_TEST_CHROME` overrides the search.

CI runs the suite on macOS and Linux against Node 20 and 22, separately
installs, exercises and uninstalls the installer on a real macOS runner, and
builds the menu bar helper with `swiftc` there — the only way to find out
whether AppKit code still compiles is to compile it.

## Layout

```
install.sh           macOS installer and uninstaller
bin/slacken.js       CLI entry point
src/cli.js           commands, logging, arg parsing
src/launch.js        find, quit, and relaunch Slack.app with the debug port
src/agent.js         the login agent: plist generation and launchctl
src/cdp.js           minimal Chrome DevTools Protocol client
src/attach.js        attach to Slack windows, inject, serve binding calls
src/moderate.js      batch, run claude -p, parse and gate the verdicts
src/state.js         paused or not, persisted across restarts
src/menubar.js       render the menu, build and supervise the helper
src/prompt.js        the rewriting prompt and response schema
src/cache.js         disk-backed verdict cache
src/server.js        loopback control API
src/config.js        defaults and ~/.slacken/config.json
client/inject.js     the page script: find, triage, hold, replace, reveal
menubar/             SlackenMenuBar.swift, the menu bar item itself
```
