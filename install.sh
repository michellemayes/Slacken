#!/usr/bin/env bash
#
# Slacken installer for macOS.
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

if [ "$UNINSTALL" = "1" ]; then
  printf '\n%sRemoving Slacken%s\n\n' "$BOLD" "$OFF"
  if [ "$(uname -s)" = "Darwin" ]; then
    node "$ENTRY" agent uninstall || warn "could not remove the login agent"
  fi
  for dir in "/usr/local/bin" "/opt/homebrew/bin" "$HOME/.local/bin" "$HOME/bin"; do
    if [ -L "$dir/slacken" ]; then rm -f "$dir/slacken" && ok "removed $dir/slacken"; fi
  done
  printf '\n%s~/.slacken (config, cache) was left alone. Delete it by hand if you want it gone.%s\n\n' "$DIM" "$OFF"
  exit 0
fi

printf '\n%sInstalling Slacken%s\n\n' "$BOLD" "$OFF"

[ "$(uname -s)" = "Darwin" ] || die "Slacken drives the macOS Slack desktop app; this is $(uname -s)."

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

if [ -d "/Applications/Slack.app" ] || [ -d "$HOME/Applications/Slack.app" ]; then
  ok "Slack.app found"
else
  warn "Slack.app is not in /Applications or ~/Applications"
fi

printf '\n  installing dependencies…\n'
cd "$REPO_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --silent
else
  npm install --omit=dev --silent
fi
ok "dependencies installed"

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
  printf '\n%s  Tip: ./install.sh --agent also starts Slacken when you log in.%s\n' "$DIM" "$OFF"
fi

printf '\n%sDone.%s\n\n' "$BOLD" "$OFF"
printf '  slacken doctor    check everything is wired up\n'
printf '  slacken start     quit Slack, relaunch it, and start reading\n\n'
