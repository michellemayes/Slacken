#!/usr/bin/env bash
#
# Slacken installer for macOS and Linux.
#
#   ./install.sh              install dependencies and put `slacken` on your PATH
#   ./install.sh --agent      also start it automatically when you log in
#   ./install.sh --uninstall  remove the command and the login agent
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRY="$REPO_DIR/bin/slacken.js"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '  %s✗%s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }

WANT_AGENT=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --agent) WANT_AGENT=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

# Pick a bin directory that is already on PATH and writable, so the install
# needs no sudo and the command works in a new shell without editing dotfiles.
pick_bin_dir() {
  local candidates=("/usr/local/bin" "/opt/homebrew/bin" "$HOME/.local/bin" "$HOME/bin")
  for dir in "${candidates[@]}"; do
    if [ -d "$dir" ] && [ -w "$dir" ] && [[ ":$PATH:" == *":$dir:"* ]]; then
      printf '%s' "$dir"; return 0
    fi
  done
  for dir in "${candidates[@]}"; do
    if [ -d "$dir" ] && [ -w "$dir" ]; then printf '%s' "$dir"; return 0; fi
  done
  mkdir -p "$HOME/.local/bin" && printf '%s' "$HOME/.local/bin"
}

OS="$(uname -s)"

if [ "$UNINSTALL" = "1" ]; then
  printf '\n%sRemoving Slacken%s\n\n' "$BOLD" "$OFF"
  case "$OS" in
    Darwin|Linux) node "$ENTRY" agent uninstall || warn "could not remove the login agent" ;;
  esac
  for dir in "/usr/local/bin" "/opt/homebrew/bin" "$HOME/.local/bin" "$HOME/bin"; do
    if [ -L "$dir/slacken" ]; then rm -f "$dir/slacken" && ok "removed $dir/slacken"; fi
  done
  printf '\n%s~/.slacken (config, cache) was left alone. Delete it by hand if you want it gone.%s\n\n' "$DIM" "$OFF"
  exit 0
fi

printf '\n%sInstalling Slacken%s\n\n' "$BOLD" "$OFF"

case "$OS" in
  Darwin|Linux) ;;
  *) die "Slacken drives the Slack desktop app on macOS and Linux; this is $OS." ;;
esac

command -v node >/dev/null 2>&1 || die "node is not installed. Install Node 20 or newer, then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node $NODE_MAJOR is too old; Slacken needs Node 20 or newer."
ok "node $(node -v)"

if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>/dev/null | head -1)"
else
  warn "claude is not on your PATH. Slacken needs it to rewrite anything."
  warn "Install Claude Code and sign in, then re-run this script."
fi

if [ "$OS" = "Darwin" ]; then
  if command -v swiftc >/dev/null 2>&1; then
    ok "swiftc found (the menu bar item will be built on first run)"
  else
    warn "swiftc is not installed, so there will be no menu bar item."
    warn "Run 'xcode-select --install' if you want one. Everything else works."
  fi
else
  # The menu bar item is AppKit, so there is none here. Everything it shows is
  # in `slacken status`, which is the same model rendered as lines.
  warn "no menu bar item on $OS — 'slacken status' says everything it would"
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "no systemctl, so there is no login agent either; run 'slacken start' yourself"
  fi
fi

printf '\n  installing dependencies…\n'
cd "$REPO_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --silent
else
  npm install --omit=dev --silent
fi
ok "dependencies installed"

# Asked of the same code that will look for it at launch, rather than a second
# list of paths here that could drift from that one. It needs the dependencies
# above, which is why it is not further up.
if node --input-type=module -e "
  import { findSlackApp } from '$REPO_DIR/src/launch.js';
  process.exit(findSlackApp() ? 0 : 1);
" 2>/dev/null; then
  ok "Slack found"
else
  warn "could not find the Slack desktop app in the usual places"
fi

chmod +x "$ENTRY"
BIN_DIR="$(pick_bin_dir)"
ln -sf "$ENTRY" "$BIN_DIR/slacken"
ok "linked $BIN_DIR/slacken"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  warn "$BIN_DIR is not on your PATH. Add this to your shell profile:"
  printf '      export PATH="%s:$PATH"\n' "$BIN_DIR"
fi

if [ "$WANT_AGENT" = "1" ]; then
  printf '\n  installing the login agent…\n'
  node "$ENTRY" agent install
else
  printf '\n%s  Tip: ./install.sh --agent runs Slacken at login, with no terminal to keep open.%s\n' "$DIM" "$OFF"
fi

printf '\n%sDone.%s\n\n' "$BOLD" "$OFF"
printf '  slacken doctor    check everything is wired up\n'
printf '  slacken start     quit Slack, relaunch it, and start reading\n'
printf '  slacken stop      stop it again, from any terminal\n\n'
