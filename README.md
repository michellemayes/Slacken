# Slacken

A calmer reading layer for Slack on macOS. Formerly SlackCensor — same
project, renamed to Slacken.

Incoming messages get rewritten in place, in the real desktop app, as you read
them. Two things happen:

- **Condense** — messages padded out with filler collapse to a single sentence.
- **Even out** — messages written at high intensity are re-phrased flat.

Nothing is deleted and nothing is sent anywhere. Every rewrite carries a small
badge, and one click brings the original back. A menu bar item shows what has
been changed, adjusts every setting worth adjusting, and pauses the whole
thing. A button in Slack's own channel header takes the channel you are reading
out of its way.

![A Slack channel with two messages rewritten by Slacken, each carrying a badge
reading "softened" or "condensed" and a "show original" link](docs/images/channel-rewritten.png)

Dana's message was written in capitals; Priya's was 66 words of circling back
and taking a moment. Note what came through anyway: the 3pm deadline, the fact
that it had been asked three times, the actual suggestion about retry logic.
Taking the edge off must never take the facts with it.

Note also what is *not* touched. Sam's message was already plain, so it never
reached the model. Alex's is long but dense with facts, and length alone is
never a reason to condense. The last message is mine — Slacken never rewrites
what you wrote yourself, however you wrote it.

Clicking a badge puts the original back, underneath the rewrite it replaced:

![The same channel with one badge clicked, showing Dana's original message in
capitals and the badge now reading "hide original"](docs/images/channel-revealed.png)

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

## Running it without a terminal

`slacken start` runs in the foreground and dies with the window you typed it
into, which is the wrong shape for something you want on all day. Install the
login agent instead and there is no terminal in it at all:

```sh
./install.sh --agent     # or, once installed: slacken agent install
```

That writes a LaunchAgent at `~/Library/LaunchAgents/com.slacken.agent.plist`
which starts Slacken at login and restarts it if it ever crashes. Because
launchd does not hand an agent a useful `PATH`, the plist bakes in the
directory `claude` actually lives in, resolved at install time. The job is
marked `Interactive` rather than `Background`: it holds messages hidden while
the model decides, so a throttled one is a delay you sit and watch.

From then on the menu bar item is the interface — what has been changed, the
pause, and the settings. Everything else is there when you want it:

```sh
slacken status           # the same lines the menu shows
slacken pause / resume   # from anywhere, terminal or menu
slacken stop             # stop the daemon, however it was started
slacken agent restart    # start it again without logging out
slacken agent status     # installed? running? what pid?
slacken agent logs       # recent output
slacken agent uninstall  # stop running at login
./install.sh --uninstall # remove the command and the agent
```

A deliberate `slacken stop` stays stopped — launchd is asked to restart a
crash, not a decision — so it comes back at your next login, or when you say
so. Only one daemon runs at a time: `slacken start` finds one already
answering, says so and leaves it alone, rather than injecting into the same
Slack twice, and `slacken agent install` stops the copy you had running by
hand before handing the job to launchd.

Uninstalling leaves `~/.slacken` (config and cache) alone; delete it by hand if
you want it gone.

## Use

Once it is running — from the agent or from a terminal — it attaches to each
Slack window as it appears, including after you switch workspaces or the app
relaunches. On exit it prints what the session cost.

| Command | What it does |
| --- | --- |
| `start [--force] [--no-launch] [--always] [--verbose]` | Launch Slack with the debug port, attach, and begin |
| `launch [--force]` | Just relaunch Slack with the debug port open |
| `attach [--verbose]` | Attach to a Slack that is already launched with the port |
| `test "<message>"` | Rewrite one string and print the verdict — no Slack needed |
| `doctor` | Check Slack, `claude`, the debug port, and visible Slack windows |
| `config` | Print the config file path and contents |
| `set [<name> <value>]` | List the settings you can change, or change one |
| `status` | What the running daemon has done so far |
| `pause` / `resume` | Stop and restart rewriting, without stopping the daemon |
| `stop` | Stop the daemon itself, whether you started it or launchd did |
| `agent install\|uninstall\|restart\|status\|logs` | Manage the login agent |

`--force` lets it quit a running Slack so it can be relaunched with the port.
`Cmd+Shift+U` inside Slack toggles every original on the screen at once.

`--always` and `--verbose` apply to that run only. `slacken set` is the lasting
version, and is the terminal view of the settings menu below: it asks the
running daemon to make the change, so it lands on what is on screen right now,
and the daemon writes it to the config file. With nothing running it edits the
file directly.

```sh
slacken set                          # every adjustable setting and its value
slacken set triageMode always
slacken set ignoreChannels "#deploys, #random"
```

## The menu bar item

While the daemon runs there is an item in the menu bar. It is the answer to the
two questions this tool raises the moment you leave it running: *is it on right
now*, and *how much of what I just read was not what was written*.

![The Slacken menu bar item, open, listing what it is watching, a Pause item,
counts of messages rewritten and model calls made, the running cost, a Settings
submenu and an item to open the log](docs/images/menu-bar.png)

The icon dims whenever nothing is being changed — paused, or attached to no
Slack window — so the state is readable without opening anything.

**Pause** is the important one. It does not merely stop new rewrites: every
message already swapped out on screen flips back to what its sender actually
wrote, held messages are released, and nothing is sent to the model until you
resume. `slacken pause` and `slacken resume` do exactly the same thing from a
terminal, and `slacken status` prints the same lines the menu shows.

![The same channel while Slacken is paused: every message shown in full as its
sender wrote it, with no badges](docs/images/channel-original.png)

That is the channel at the top of this page, paused. No badges, no rewrites,
nothing hidden — the messages exactly as their senders wrote them.

A pause is written to `~/.slacken/state.json` and survives a restart. It has
to: the login agent brings the daemon back whenever it exits, and a pause that
quietly undid itself would leave you reading a rewritten feed you believed you
had turned off. The menu bar item is what stops that becoming a pause you
forgot about.

### Settings, without the config file

Everything worth changing while Slacken runs is under **Settings**, and takes
effect on the messages already on your screen.

![The Slacken settings menu, listing what gets rewritten, where it is left
alone, what it costs, and toggles for holding, remembering and
logging](docs/images/menu-settings.png)

Pick a model, cap the day's spend, move the sensitivity, decide what counts as
harsh enough to soften, turn condensing off, or stop ignoring a channel you
ignored last week. A change is applied to the running daemon, written to
`~/.slacken/config.json` so it survives a restart, and pushed into every open
Slack window — the verdicts decided under the old settings are dropped rather
than left on screen answering a question you have stopped asking.

Only settings that can honestly change under a live connection are offered. A
debug port or a URL pattern cannot, so those stay in the file, which
**Everything else…** opens.

### How the item is drawn

The item is a small AppKit program in `menubar/SlackenMenuBar.swift`, compiled
on first run and cached in `~/.slacken/menubar/` by the hash of its source. It
decides nothing: the wording, the counts and the actions are rendered by
`src/menubar.js` and fetched as JSON from `GET /menubar`, which is why the part
that can be wrong is testable on any machine. A settings item is no different:
it arrives carrying the value it would set and the endpoint to post it to, so
the Swift never learns what a setting means or which one is in force — it draws
the checkmark it is told to draw. It holds the daemon's stdin, so it cannot
outlive the daemon even if that daemon is killed outright.

Without `swiftc` there is no item, one line says so at startup, and everything
else runs unchanged. Set `menuBar` to `false` in the config to skip it, or
click **Hide menu bar item** to dismiss it for this run.

## Ignoring a channel, from inside Slack

The menu bar cannot know which channel you are reading. Slack can, so the
button lives there — in the channel header, next to the channel name. It reads
**Ignore in Slacken** until you click it (it is in the first image on this
page), and afterwards:

![A Slack channel header showing the channel name, the member count, and a
small button reading "Ignored by Slacken"](docs/images/channel-ignored.png)

One click and nothing in that channel is rewritten again: the rewrites already
on screen give their originals back, held messages are released, and messages
arriving there stop costing anything at all. Clicking it again puts the channel
back.

Either way the change goes to the daemon, which owns the list: it writes it to
the config file and tells every other Slack window, so the ignore list is one
thing everywhere rather than a per-window opinion, and it is still there
tomorrow. The menu bar lists what is ignored and takes channels back off the
list; this is the end that can see which channel you mean.

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

`~/.slacken/config.json`, created on first run. These are the settings that can
be changed while Slacken is running — from the menu bar, from the button in
Slack, or with `slacken set` — and they take effect on what is already on your
screen.

| Key | Default | Notes |
| --- | --- | --- |
| `model` | `claude-haiku-4-5-20251001` | Small and fast; messages arrive quicker than you read them |
| `dailyBudgetUsd` | `0` | Stop calling the model past this much in a day. `0` disables the cap |
| `triageMode` | `heuristic` | `always` sends every message to the model |
| `triageThreshold` | `2` | Local score needed before a call is worth making |
| `minSeverity` | `2` | Model severity (0–3) required before a tone rewrite is applied |
| `condenseEnabled` | `true` | Set `false` to leave long messages alone |
| `condenseMinWords` | `45` | Shorter messages are never condensed |
| `holdWhilePending` | `true` | Hide a suspected message while the model decides, rather than after |
| `persistVerdicts` | `true` | Keep rewrites in Slack's `localStorage` too, so a reload repaints instantly. `false` leaves nothing behind |
| `selfNames` | `[]` | Fallback if your display name is not detected from the Slack UI |
| `ignoreSenders` | `[]` | Never rewrite these people |
| `ignoreChannels` | `[]` | Never rewrite in these channels — the button in Slack's channel header edits this |
| `maxChars` | `4000` | Longer messages are left alone |
| `verbose` | `false` | Log every verdict |

These are read at startup. Change one in the file and restart the daemon — a
debug port cannot honestly be moved under a live connection, so it is not
offered anywhere that implies it can.

| Key | Default | Notes |
| --- | --- | --- |
| `batchSize` / `batchWindowMs` | `8` / `120` | How many messages share a call, and how long to wait to fill one |
| `maxConcurrency` | `2` | Concurrent `claude -p` processes |
| `useJsonSchema` | `true` | Structured output; guarantees parseable verdicts |
| `condenseMaxRatio` | `0.7` | A condense that is not at least this much shorter is discarded |
| `menuBar` | `true` | Show the menu bar item. Needs `swiftc`; without it, skipped |
| `cdpPort` | `9222` | Slack's debug port |
| `httpPort` | `8787` | Loopback control API (`/status`, `/menubar`, `/config`, `/ignore`, `/pause`, `/stop`, `/moderate`) |
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
- `test/control.mjs` — pausing, settings, and the menu the menu bar item draws.
  Asserts that a pause survives a restart, that a paused Slacken makes no model
  call and caches nothing, that the control endpoints agree with each other, and
  that the menu offers exactly one of pause and resume. On settings: that a
  refused value leaves the old one standing, that a patch with one bad value in
  it is refused whole, that a change reaches disk without rewriting the keys
  around it, that the config object handed out at startup is the one that
  changes, that ignoring a channel twice ignores it once, and that a checkmark
  in the menu can never disagree with the daemon. It also covers the
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
  have run, and a revealed original survives the row being re-rendered
  underneath it. It also covers the pause: every rewritten message flips back to
  what was written, a message that arrives during a pause is never triaged or
  sent, a verdict that lands after a pause has begun is thrown away rather than
  quietly applied later, and resuming picks up what the pause let through
  without re-asking about anything already decided. It also drives the button
  in the channel header: clicking it puts the channel on the daemon's ignore
  list, gives back every original on screen, and stops new messages there
  costing anything; clicking it again brings the rewrites back; and a setting
  changed on the daemon reaches the page and is acted on without a reload.
  It finds any Chromium on the machine and skips itself if there is none;
  `SLACKEN_TEST_CHROME` overrides the search.

CI runs the suite on macOS and Linux against Node 20 and 22, separately
installs, exercises and uninstalls the installer on a real macOS runner, and
builds the menu bar helper with `swiftc` there — the only way to find out
whether AppKit code still compiles is to compile it.

## The images above

```sh
npm run docs:images
```

They are regenerated rather than taken by hand, and nothing in them is a
drawing of what the code does. `docs/demo/capture.mjs` serves the fake
workspace in `docs/demo/workspace.html`, runs the real attach-and-inject path
against a headless Chromium, and photographs the result — so every badge,
hidden original and reveal toggle was drawn by the page script that ships. The
menu images are rendered from the real `menuModel()` and `settingsMenu()`
output, because that is where the wording, the counts and the checkmarks are
actually decided. The button in the channel header was drawn by the page
script, and the picture of it reading "Ignored by Slacken" was taken after
clicking it — against a real settings store, in the same run.

Two things are staged: the channel, so nobody's real messages end up in a
README, and the verdicts, which come from a stub rather than `claude -p` so
that re-running this produces the same pictures instead of a fresh sample of
the model. Editing the badge, the reveal or the menu and re-running is the
fastest way to see the change.

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
src/config.js        defaults, ~/.slacken/config.json, the live settings store
src/settings.js      what can be changed while it runs, and what a valid value is
client/inject.js     the page script: find, triage, hold, replace, reveal
menubar/             SlackenMenuBar.swift, the menu bar item itself
docs/demo/           the fake workspace and capture script behind the images
```
