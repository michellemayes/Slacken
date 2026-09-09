# Slacken

A calmer reading layer for the Slack desktop app, on macOS and Linux. Being
bombarded with AI messages? Condense them and even out the tone of all of your
team's Slack messages with a simple overlay.

Incoming messages get rewritten in place, in the real desktop app, as you read
them. Two things happen:

- **Condense** — messages padded out with filler collapse to a single sentence.
- **Even out** — messages written at high intensity are re-phrased flat.

Nothing is deleted and nothing is sent anywhere. Every rewrite carries a small
badge, and one click brings the original back. Notifications are caught on the
way past too, so the sharp version does not reach you in the corner of the
screen before the calm one reaches you in the channel. A menu bar item shows
what has been changed, adjusts every setting worth adjusting, and pauses the
whole thing. A button in Slack's own channel header takes the channel you are
reading out of its way, settings can differ channel by channel, and everything
it changed is written down where you can read it back.

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
  Slack (Electron)                        slacken (node)
  ┌──────────────────────┐                ┌────────────────────────┐
  │ renderer             │                │ poll /json/list        │
  │  client/inject.js    │◄── CDP ────────┤ attach + inject        │
  │   · find messages    │    :9222       │                        │
  │   · which column     │                │ Runtime.addBinding     │
  │   · local triage     ├── binding ────►│  ├─ cache lookup       │
  │   · hold suspects    │                │  ├─ 120ms batch window │
  │   · swap in rewrite  │◄── evaluate ───┤  └─ claude -p ──► 🤖   │
  │   · reveal toggle    │                │                        │
  │   · notifications    │── reveal ─────►│  history.jsonl         │
  │   · your own draft   │── health ─────►│  drifted?              │
  └──────────────────────┘                └───────────┬────────────┘
                                                      │ :8787 + token
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
   `claude -p --output-format json` call. Verdicts are cached on disk by the
   message text *and the settings it was judged against*, so re-reading a
   channel is free, the same message in two channels with different settings is
   two questions rather than one wrong answer, and a rewrite is kept in the
   renderer as well so a reload repaints without a round trip.
8. Which channel a message is in is read from the column it is in, not from the
   page. A thread open beside a channel is two conversations on one screen, and
   ignoring `#deploys` has to mean the thread in `#deploys` too.
9. `window.Notification` is wrapped in the renderer, so a notification whose
   body looks heated is held rather than raised and then corrected — you would
   have read it by then. If the verdict has not arrived in 2.5 seconds the
   original is raised anyway: a notification that never arrives is a message
   you never knew about.

## Install

Node 20+, and `claude` on your `PATH` and signed in (`claude -p "hi"` should
work). macOS and Linux are installed and run at login the same way; on Windows
`slacken launch`, `attach` and `start` work from a terminal, and there is no
login agent and no menu bar item.

The menu bar item is macOS only: it is compiled on first run and needs `swiftc`
from the Xcode Command Line Tools (`xcode-select --install`). Without it
everything else works, the daemon says so once, and `slacken status` prints the
same lines the menu would have shown.

```sh
git clone https://github.com/michellemayes/Slacken.git
cd Slacken
./install.sh
```

Or, through a tap, on a Mac:

```sh
brew tap michellemayes/slacken https://github.com/michellemayes/Slacken
brew install slacken
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

On macOS that writes a LaunchAgent at
`~/Library/LaunchAgents/com.slacken.agent.plist`; on Linux a systemd user unit
at `~/.config/systemd/user/slacken.service`. Both start Slacken at login and
restart it if it ever crashes, and both bake in the directory `claude` actually
lives in, resolved at install time, because neither launchd nor a login session
hands a job a useful `PATH`. The macOS job is marked `Interactive` rather than
`Background`: it holds messages hidden while the model decides, so a throttled
one is a delay you sit and watch.

The daemon does the same lookup again every time it starts, and does not rely
on the `PATH` it was handed: it checks that `PATH`, then the places the
installers actually use (`~/.local/bin`, `~/.claude/local`, Homebrew,
`/usr/local/bin`), then `~/.slacken/claude.json`, then your login shell, which
is where a `PATH` set by nvm, asdf or mise lives.

`~/.slacken/claude.json` is how one Slacken tells the next one what it found.
A `claude` that lives somewhere none of the rest reaches — inside another app's
bundle, say — is findable by the terminal you installed from and by nothing
else, which is how `slacken doctor` comes to report a `claude` it can run
happily while the daemon has never once managed to. So every process that
resolves `claude` writes the answer down, and a daemon holding a cached *not
found* re-checks the moment that file changes: running `slacken doctor` is
enough, no restart. `slacken agent restart` also rewrites the plist or unit
before restarting, so the agent comes back with the `claude` your shell can
see baked into its `PATH` — restarting a job with the same broken environment
would be a fix that visibly does nothing.

If it still cannot find it — *Can't find claude* in the menu — `slacken doctor`
prints every place it looked, and setting `claudeBin` to its full path in
`~/.slacken/config.json` settles it.

`slacken doctor` also asks the running daemon what *it* sees, and reports the
two answers separately. Every other line in that report is answered by the
process you just typed the command into; the process doing the work is a
different one, started at login, with a `PATH` of its own and — after an
upgrade — code of its own. A daemon that cannot find `claude`, or that is
still running the build from before you upgraded, is named as such rather than
hidden behind a row of `ok`s that are true of the wrong process.

From then on the menu bar item is the interface — what has been changed, the
pause, and the settings. Everything else is there when you want it:

```sh
slacken status           # the same lines the menu shows
slacken pause / resume   # from anywhere, terminal or menu
slacken restart          # off and on again, however it was started
slacken stop             # stop the daemon, however it was started
slacken agent restart    # start it again without logging out
slacken agent status     # installed? running? what pid?
slacken agent logs       # recent output
slacken agent uninstall  # stop running at login
./install.sh --uninstall # remove the command and the agent
```

A deliberate `slacken stop` stays stopped — launchd and systemd are both asked
to restart a crash, not a decision — so it comes back at your next login, or when you say
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
| `doctor [--no-model]` | Check Slack, `claude`, one real model call, the debug port, visible Slack windows, and what the running daemon can see |
| `config` | Print the config file path and contents |
| `set [<name> <value>]` | List the settings you can change, or change one |
| `channel [<#name> <setting> <value>]` | What each channel does differently, or change one |
| `history [--lines N] [--json]` | What has been rewritten, and what you asked back |
| `token` | Print the control API token |
| `version [--check]` | What this is, and whether there is a newer one |
| `status` | What the running daemon has done so far |
| `inspect` | What Slacken makes of each message on screen, and why |
| `pause` / `resume` | Stop and restart rewriting, without stopping the daemon |
| `restart` | Stop the daemon and start it again, however it was started |
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

### When a message was left as written

`slacken status` says what Slacken did. `slacken inspect` says what it decided
not to do, message by message, reading the Slack window you are looking at
right now:

```
#eng-oncall — 9 message(s) on screen
  Ibrahim Diallo [thread reply]: Circling back on the audit with a quick rundown for visibility. As you
    rewritten
  Alex Kim: Migration 0042 adds a partial index on events.created_at and drops the
    read as written; tone 0 of 2 needed, padding 0 of 1 needed, 56 words
  Priya Nair: Hey team! I wanted to take a moment to circle back on the deployment
    off screen; it gets looked at when you scroll to it
```

The last line of each entry is the answer: a message can go untouched because
triage cleared it, because you wrote it, because the channel is ignored, or
because it never scrolled into view. A message Slacken cannot find a body under
is reported too, rather than passed over in silence — that is what a Slack
layout this does not read yet looks like from the outside, and it is worth
opening an issue over.

## The menu bar item

While the daemon runs there is an item in the menu bar. It is the answer to the
two questions this tool raises the moment you leave it running: *is it on right
now*, and *how much of what I just read was not what was written*.

![The Slacken menu bar item, open, listing what it is watching, a Pause item,
counts of messages rewritten and model calls made, the running cost, a Settings
submenu, items to open the log and the recent changes, and a Restart
item](docs/images/menu-bar.png)

The icon dims whenever nothing is being changed — paused, or attached to no
Slack window — so the state is readable without opening anything, and turns to
a warning if the page script stops finding messages at all.

Three lines only appear when there is something to say. **N originals asked
for back** counts the badges you clicked, which is the one number here about
whether Slacken is getting it right rather than how much it is doing. **N
notifications checked before it arrived** is how you can tell whether the
notification path is working on your build of Slack. And a failed model call is
named rather than counted: *Not signed in to Claude — run: claude login* is
something you can act on, where *3 errors* is not.

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

### Restart, without a terminal

**Restart Slacken**, at the bottom of the menu, stops the daemon and brings it
straight back. It is the one thing you previously had to open a terminal for,
and it is the fix for more than it sounds like: a `claude` that has moved since
you logged in, an upgrade sitting on disk that the running process has never
read, or a daemon that has simply been up for a fortnight.

How it comes back depends on how it was started, and it works that out itself
rather than guessing. Under the login agent, launchd (or systemd) is asked for
a fresh one — which rewrites the plist on the way, so a `claude` that moved is
found again. Started by hand, it hands over to its own replacement, with the
same arguments and the same terminal to print to. Which of the two it is is
settled by pid, not by whether an agent happens to be installed: kickstarting
the agent from a daemon you started in a terminal would put a second one on a
port the first is still holding.

The icon disappears while the daemon is down and comes back with it, because
the item holds the daemon's stdin and is not allowed to outlive it. `slacken
restart` does the same thing from a terminal, and waits to see it actually come
back before saying so.

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

### Settings that differ channel by channel

Sensitivity is not one answer. `#eng-oncall` at 3am is not `#design-crit`, and
"leave it alone entirely" is a blunt way to say "not so eagerly here".

```sh
slacken channel                              # what each channel does differently
slacken channel "#eng-oncall" minSeverity 3  # only soften what is actually hostile
slacken channel "#announcements" condenseEnabled off
slacken channel "#eng-oncall" reset          # back to the global settings
```

`triageMode`, `triageThreshold`, `minSeverity`, `condenseEnabled`,
`condenseMinWords` and `maxChars` can differ per channel. The rest cannot: which
model to use and what it may spend in a day are decisions about Slacken, not
about a conversation, and a channel is the wrong place to keep an answer to
them. A channel that has been given settings of its own appears in the menu bar
under **Per-channel settings**, with the same choices as the global ones and a
way back to them.

Verdicts are cached against the settings that produced them, so moving a
threshold does not throw the cache away — it makes the old verdicts unreachable,
and moving it back finds them again.

## Notifications

The rewriting above happens once you are looking at the channel. A notification
arrives before that, in full, in the corner of the screen — which is where a
calmer reading layer is least able to help and most needed.

Slacken wraps `window.Notification` in the Slack renderer. A body that clears
local triage is held rather than shown: the real notification is not raised
until the verdict lands, and then it is raised with the rewrite. Raising the
original and correcting it a second later would be worse than not trying, since
you would have read it by then. A verdict that has not arrived within 2.5
seconds gives up and raises the original — a notification that never arrives is
a message you never knew about, which is the one outcome worse than a blunt
banner.

This depends on Slack raising its notifications from the renderer, which not
every build does. Nothing breaks if it does not; the count in the menu bar
simply stays at zero, which is how you can tell. Turn it off with
**Rewrite notifications too**, or `slacken set rewriteNotifications off`.

## Your own drafts

Off by default, and the one thing here that comes anywhere near what you write.

With **Look at what I am about to send** on, a draft that reads sharp gets a
small bar above the composer with a flatter wording in it, and two buttons.
Nothing happens to your message until you click **Use this** — and when you do,
the text is typed rather than assigned, so it lands in Slack's own undo stack
and `Cmd-Z` gives you your words back. Nothing is ever sent. Only tone is
offered, never condensing: how long your own message is, is your business.

Drafts are never written to the history file. What you nearly said is not this
tool's business either.

## What it changed

The counts in the menu bar say whether Slacken is doing anything. The question
the tool actually raises is *what did it decide I did not need to read*, and by
the time you think to ask, the message has scrolled away.

```sh
slacken history              # the last 40 changes, most recent last
slacken history --lines 200
slacken history --json       # one JSON object per line, for grep and jq
```

Every rewrite is appended to `~/.slacken/history.jsonl` with both texts, and so
is every time you clicked a badge to get an original back. **Recent changes…**
in the menu bar opens the same file. It is capped at `historyMaxEntries` lines,
long messages are stored shortened, and `historyEnabled` turns it off.

## The control API needs a token

`127.0.0.1` keeps the control API off the network. It does not keep it away
from anything else running on your machine, and behind it is what you have been
reading, what it cost, an endpoint that will spend your Claude account on any
text at all, and a way to stop the daemon.

So the daemon writes a token to `~/.slacken/token`, readable only by you, and
everything that talks to it sends that token: the CLI reads the file, and the
menu bar helper is handed it in its environment rather than on a command line,
where `ps` would show it to everyone. Only `GET /health` is left open — it is
how a second `slacken start` finds the first one — and it says nothing but that
a Slacken is here and whether it is paused.

By hand:

```sh
curl -H "Authorization: Bearer $(slacken token)" http://127.0.0.1:8787/status
```

## When Slack changes underneath it

Slack's DOM is not a public API, and the failure when it moves is silent by
construction: the page stops finding messages, and everything goes on looking
fine.

So the page script reports what it is finding. List items with no message
bodies inside them is the signature of a renamed class — the list is still the
list and the words are not where they were — and that turns the menu bar icon
and its first line into a warning, and makes `slacken doctor` say so. Finding
no list items at all is not evidence of anything: that is also what an empty
channel and a loading window look like.

The selectors are all at the top of `client/inject.js`, and `POST /reinject`
reloads the script without restarting the daemon.

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
number that matters is the first one: a suspected message is held behind
*checking…* for exactly as long as a verdict takes, so this is not a figure in
a log, it is how long you sit looking at a gap where a sentence should be.

| | latency | cost per message |
| --- | --- | --- |
| naive `claude -p`, one call per message | 8–11 s | ~$0.0060 |
| thinking disabled | 2.4 s | $0.0031 |
| thinking disabled, batch of 8 | 656 ms | $0.00068 |

The last four entries in the list below — the schema, the exit, the window and
the working directory — were measured old-against-new: same messages, same
machine, back to back, so the difference is the change and not the afternoon.

| | one message on its own | a burst of 8 | cost per message |
| --- | --- | --- | --- |
| before | 2.8 s | 6.9 s | $0.0027 / $0.00071 |
| **now** | **1.7 s** | **5.9 s** | **$0.0015 / $0.00055** |

What actually mattered, in order:

- **`MAX_THINKING_TOKENS=0` is the whole ballgame.** By default a verdict cost
  ~800 thinking tokens to produce one line of JSON. Turning it off took a call
  from ~10 s to ~2.4 s and cut cost ~3x. It also *improved* schema adherence:
  the thinking runs returned out-of-range values, the non-thinking runs did not.
- **Batching.** One call for eight messages is 4.5x cheaper per message than
  eight calls, and the per-message wait drops accordingly.
- **Not calling the model.** Local triage and the disk cache are the cheapest
  optimisations available, because they cost nothing.
- **Asking for JSON rather than holding it to a schema.** `--json-schema`
  guarantees the shape, and costs a second model turn and ~730 input tokens to
  do it: ~1.2 s on every message, paid to prevent something that almost never
  happens. So the fast call goes first, and output that does not parse is asked
  again *with* the schema — which puts the cost on the failure rather than on
  every message. `useJsonSchema: true` puts it back on every call.
- **Answering on the answer, not on the exit.** `--output-format json` prints
  one envelope and prints it whole, and then the process spends up to half a
  second going away: flushing telemetry, checking for updates, tidying up. The
  verdict is handed over the moment stdout holds one. The same background work
  is turned off outright for the copies Slacken spawns
  (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`,
  `DISABLE_AUTOUPDATER`), which also took ~360 tokens off every call. The
  `claude` you type at is untouched.
- **A shorter batch window when nothing else is in flight.** `batchWindowMs`
  (120 ms) is free when a call is already out — whatever it collects would have
  queued behind that call anyway. With nothing in flight it is 120 ms of a wait
  you sit and watch, so that case uses `batchWindowIdleMs` (25 ms) instead,
  which still catches every message of a burst that rendered in one frame.
- **Not starting in your repository.** Calls run from `~/.slacken` rather than
  from wherever the daemon was started: a large repo is slower to start in, and
  a `CLAUDE.md` sitting in one has no business shaping a verdict about somebody
  else's Slack message.

Three things measured and deliberately **not** used:

- **A persistent `--input-format stream-json` session.** Turns were no faster
  than a cold call, and because the conversation accumulates, the sixth turn
  cost 4.7x the first.
- **Spawning `claude` early so it is warm when the message arrives.** It reads
  stdin to EOF before it does anything else, so a process started three seconds
  ahead answered no sooner. There is ~450 ms of startup in every call and this
  does not remove it.
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
| `channelOverrides` | `{}` | Settings for one channel: `{"#eng": {"minSeverity": 3}}`. `slacken channel` edits this |
| `maxChars` | `4000` | Longer messages are left alone |
| `rewriteNotifications` | `true` | Rewrite a notification body before it is shown, not after you read it |
| `draftCheck` | `false` | Offer a flatter wording for what you are about to send. Never edits or sends anything |
| `historyEnabled` | `true` | Append every rewrite to `~/.slacken/history.jsonl` |
| `verbose` | `false` | Log every verdict |

These are read at startup. Change one in the file and restart the daemon — a
debug port cannot honestly be moved under a live connection, so it is not
offered anywhere that implies it can.

The file is written out in full on first run, which pins every key in it,
including the ones nobody chose — so a default that moves later would reach new
installs and nobody else. When one does move, the next start brings the file
forward once, says on stdout exactly which key it changed and to what, and
stamps the file so it never revisits it. Only a key still holding the previous
version's default is touched: a value you chose is yours, even where it is the
slower one, and setting it back by hand keeps it.

| Key | Default | Notes |
| --- | --- | --- |
| `batchSize` / `batchWindowMs` | `8` / `120` | How many messages share a call, and how long to wait to fill one |
| `batchWindowIdleMs` | `25` | The same wait with no call already out — the message you are sitting watching |
| `maxConcurrency` | `2` | Concurrent `claude -p` processes |
| `useJsonSchema` | `false` | Hold the model to the schema on every call. Costs ~1.2 s a message to prevent what a retry already catches |
| `condenseMaxRatio` | `0.7` | A condense that is not at least this much shorter is discarded |
| `menuBar` | `true` | Show the menu bar item (macOS). Needs `swiftc`; without it, skipped |
| `retries` | `1` | How many times a failed call is tried again. Being signed out is never retried |
| `historyMaxEntries` | `2000` | How much of the record to keep |
| `checkUpdates` | `false` | Ask GitHub once a day whether there is a newer Slacken |
| `cdpPort` | `9222` | Slack's debug port |
| `httpPort` | `8787` | Loopback control API (`/status`, `/menubar`, `/config`, `/ignore`, `/pause`, `/restart`, `/stop`, `/moderate`) |
| `targetUrlPattern` | `^https://([a-z0-9-]+\.)*slack\.com/` | Widen for a custom workspace domain |
| `claudeBin` / `claudeArgs` | `claude` / `[]` | Set `claudeBin` to a full path if `claude` lives somewhere the lookup does not find; `claudeArgs` for extra flags |

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
policies. Verdicts are cached in plain text at `~/.slacken/cache.json`, and
every rewrite is written to `~/.slacken/history.jsonl` with both texts unless
`historyEnabled` is off. If you work in channels where that is not acceptable,
use `ignoreChannels` or do not run this there.

**The daily budget is a property of the day, not of this process.** It is
written to `~/.slacken/state.json` as it is spent, so restarting the daemon —
which the login agent does on every crash and at every login — does not hand
it back.

**The debug port is powerful.** While Slack runs with `--remote-debugging-port`,
any process on your machine that can reach `127.0.0.1:9222` can drive your
logged-in Slack session. Chromium binds it to loopback only, but this is still a
real widening of what a local process can do. Close it by quitting and reopening
Slack normally. Slacken's own control port is narrower than that on purpose: it
needs the token in `~/.slacken/token`, which nothing else on the machine can
read.

**Nothing here talks to anything but your own machine, except one thing you
turn on.** `checkUpdates` asks GitHub once a day whether there is a newer
release. It is off by default and sends nothing but the request.

**You can always turn it off without turning it off.** Pause from the menu bar
and every rewrite on screen reverts to what was written, immediately, with no
model call and no restart. That is the intended move when a conversation
matters enough that you want the words themselves — it is faster and less
final than quitting, and the menu bar item makes it obvious you are paused.

**It is entirely local to you.** This only changes what is drawn in your own
client. It never edits, deletes, or replies to anything, nobody else can tell
it is running, and it does not touch messages you write.

**Slack's DOM is not a public API.** Slack can rename a class and break message
detection. Slacken notices and says so — see *When Slack changes underneath it*
above — the selectors are all in one place at the top of `client/inject.js`, and
`POST /reinject` reloads the script without restarting the daemon.

**Notifications and drafts are the two places Slacken reaches past reading.**
The notification path depends on Slack raising notifications from its renderer,
and says how many it has actually seen so you can tell whether it is doing
anything. The draft check is off unless you turn it on, offers rather than
edits, and never sends.

## Tests

```sh
npm test            # everything
npm run test:fast   # skips the browser test
```

- `test/unit.mjs` — parsing whatever `claude -p` returns, and the gating that
  decides when a verdict is allowed to change the screen.
- `test/batch.mjs` — the batching, caching and budget logic that make this
  cheap, run against a fake `claude` binary that records how many times it was
  actually invoked, and with what. Asserts that four simultaneous messages cost
  one process, that the day's spend survives a restart and the cap with it,
  that a transient failure is tried again and a signed-out one is not, and that
  the same message in two channels with different settings is two questions. On
  speed: that a verdict is handed over when the answer lands rather than when
  the process gets round to leaving, that the fast call goes without the schema
  and is asked again with it when the output does not parse, that output which
  will not parse either way is not retried forever, and that a message arriving
  on its own does not wait out a window meant for filling a batch.
- `test/agent.mjs` — the generated LaunchAgent plist and systemd unit,
  including that both carry a `PATH` that can actually find `claude`, that both
  come back after a crash and stay stopped after a stop, and that both log to
  the same place so `slacken agent logs` needs no platform.
- `test/history.mjs` — the record: that a rewrite is written with both texts and
  a message left alone is not written at all, that turning it off stops the next
  line rather than the next daemon, that a pasted stack trace is stored
  shortened, that the file is capped keeping the newest, and that a line
  half-written by a daemon killed mid-append costs one line rather than the
  file.
- `test/control.mjs` — pausing, settings, and the menu the menu bar item draws.
  Asserts that a pause survives a restart, that a paused Slacken makes no model
  call and caches nothing, that the control endpoints agree with each other,
  that the menu offers exactly one of pause and resume, and that `/restart`
  answers before it acts and says so plainly when it cannot restart itself. On
  bringing an older config file forward: that a key still holding the previous
  default is moved and a value somebody chose is not, that a file is never
  revisited once stamped, and that one which cannot be read is left alone
  rather than guessed at. On the token: that
  every endpoint but `/health` refuses a request without one, that a wrong one
  changes nothing on its way to being refused, and that the file is written once
  and readable by nobody else. On settings: that a
  refused value leaves the old one standing, that a patch with one bad value in
  it is refused whole, that a change reaches disk without rewriting the keys
  around it, that the config object handed out at startup is the one that
  changes, that ignoring a channel twice ignores it once, and that a checkmark
  in the menu can never disagree with the daemon; and on per-channel settings:
  that one setting joins another rather than replacing it, that a setting which
  cannot honestly differ per channel is refused, that clearing one channel is
  not collateral for the next, and that drift is list items with no message
  bodies in them and nothing else. It also covers the
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
  The fixture has a thread open beside the channel, so it also asserts that a
  message in the thread is attributed to the thread's channel rather than the
  column beside it, and that a per-channel setting changes that channel and
  leaves the identical message in the other one alone. And the paths that reach
  past reading: a heated notification is rewritten before it is raised and
  raised exactly once, a calm one is raised immediately and costs nothing, a
  draft is not looked at until you turn the draft check on, a sharp one is then
  offered a flatter wording, and the composer is only changed when you click.
  Clicking a badge is asserted to reach the daemon, and closing it again to say
  nothing. It finds any Chromium on the machine and skips itself if there is
  none; `SLACKEN_TEST_CHROME` overrides the search.

CI runs the suite on macOS and Linux against Node 20 and 22, separately
installs, exercises and uninstalls the installer on both, and builds the menu
bar helper with `swiftc` on macOS — the only way to find out whether AppKit
code still compiles is to compile it.

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
install.sh           installer and uninstaller (macOS, Linux)
bin/slacken.js       CLI entry point
src/cli.js           commands, logging, arg parsing
src/launch.js        find, quit, and relaunch Slack with the debug port
src/agent.js         the login agent: a LaunchAgent or a systemd user unit
src/cdp.js           minimal Chrome DevTools Protocol client
src/attach.js        attach to Slack windows, inject, serve binding calls
src/moderate.js      batch, run claude -p, parse and gate the verdicts
src/claude-bin.js    find claude from a process with no PATH, and note where
src/state.js         paused or not, and today's spend, across restarts
src/history.js       the record of what was changed, and what was asked back
src/auth.js          the control API token
src/version.js       what this is, and whether there is a newer one
src/menubar.js       render the menu, build and supervise the helper
src/prompt.js        the rewriting prompt and response schema
src/cache.js         disk-backed verdict cache
src/server.js        loopback control API
src/config.js        defaults, ~/.slacken/config.json, the live settings store
src/settings.js      what can be changed while it runs, and what a valid value is
client/inject.js     the page script: find, triage, hold, replace, reveal,
                     notifications, the draft check
Formula/slacken.rb   a Homebrew formula, for a tap
menubar/             SlackenMenuBar.swift, the menu bar item itself
docs/demo/           the fake workspace and capture script behind the images
```
