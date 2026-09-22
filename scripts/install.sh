#!/usr/bin/env bash
# FreeCode installer.
#
# Two ways in, so a developer and a new user take the same code path:
#
#   ./scripts/install.sh                     install the local build
#   ./scripts/install.sh --from-release      install a published release archive
#
# Laya is an optional accelerator: if its Python runtime cannot be prepared the
# install still succeeds and FreeCode routes on rules, because a coding agent that
# refuses to start over a missing optional model is not a usable agent.
#
# Environment:
#   FREECODE_INSTALL_DIR   where the binary goes (highest priority)
#   FREECODE_HOME          FreeCode's own directory, default ~/.freecode
#   XDG_BIN_DIR            used when FREECODE_INSTALL_DIR is unset
#   XDG_DATA_HOME          default ~/.local/share
#   XDG_CONFIG_HOME        default ~/.config
#   FREECODE_SKIP_LAYA=1   install without any Python runtime
#   FREECODE_VERSION       release to install with --from-release

set -euo pipefail

FROM_RELEASE=0
for arg in "$@"; do
  case "$arg" in
    --from-release) FROM_RELEASE=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FREECODE_HOME="${FREECODE_HOME:-$HOME/.freecode}"
XDG_DATA_BASE="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA="$XDG_DATA_BASE/freecode"
CONFIG="$XDG_CONFIG_BASE/freecode"

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- install location ---------------------------------------------------------
#
# Highest priority first, so an explicit choice always wins and a user with an
# existing setup keeps using it. Candidates are checked for writability rather
# than existence: a directory on PATH that cannot be written to is worse than no
# directory at all, because the install appears to succeed and does nothing.

choose_install_dir() {
  local candidates=(
    "${FREECODE_INSTALL_DIR:-}"
    "${XDG_BIN_DIR:-}"
    "$HOME/bin"
    "$FREECODE_HOME/bin"
  )
  for directory in "${candidates[@]}"; do
    [[ -n "$directory" ]] || continue
    if [[ -d "$directory" && -w "$directory" ]]; then
      printf '%s' "$directory"
      return 0
    fi
    if [[ ! -e "$directory" ]] && mkdir -p "$directory" 2>/dev/null; then
      printf '%s' "$directory"
      return 0
    fi
  done
  return 1
}

INSTALL_DIR="$(choose_install_dir)" || fail "no writable install directory among \$FREECODE_INSTALL_DIR, \$XDG_BIN_DIR, ~/bin, $FREECODE_HOME/bin"

say "FreeCode installer"
say "  binary  $INSTALL_DIR/freecode"
say "  home    $FREECODE_HOME"
say "  data    $DATA"
say "  config  $CONFIG"
say ""

# --- staging ------------------------------------------------------------------
#
# A release archive and a local build are unpacked to the same shape, so the rest
# of this script does not care which one it got.

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/freecode-install.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

BINARY=""
BRIDGE_SOURCE=""

if [[ "$FROM_RELEASE" == "1" ]]; then
  VERSION="${FREECODE_VERSION:-latest}"
  PLATFORM="darwin-arm64"
  REPO="${FREECODE_REPO:-freecode-dev/freecode}"

  if [[ "$VERSION" == "latest" ]]; then
    BASE="https://github.com/$REPO/releases/latest/download"
  else
    BASE="https://github.com/$REPO/releases/download/v$VERSION"
  fi
  URL="$BASE/freecode-$PLATFORM.tar.gz"
  SUM_URL="$BASE/SHA256SUMS"

  say "downloading $URL"
  # `FREECODE_RELEASE_BASE` exists so this branch is testable without publishing a
  # release: CI serves the archive locally and the same download, checksum and
  # unpack path runs against it.
  if [[ -n "${FREECODE_RELEASE_BASE:-}" ]]; then
    BASE="$FREECODE_RELEASE_BASE"
    URL="$BASE/freecode-$PLATFORM.tar.gz"
    SUM_URL="$BASE/SHA256SUMS"
  fi
  curl -fsSL "$URL" -o "$STAGE/freecode.tar.gz" || fail "download failed"

  # A checksum that cannot be fetched is reported rather than skipped silently: an
  # unverified download is a different trust position, and the user should know
  # which one they are in.
  if curl -fsSL "$SUM_URL" -o "$STAGE/SHA256SUMS" 2>/dev/null; then
    EXPECTED="$(grep "freecode-$PLATFORM.tar.gz" "$STAGE/SHA256SUMS" | awk '{print $1}' | head -1)"
    if [[ -n "$EXPECTED" ]]; then
      ACTUAL="$(shasum -a 256 "$STAGE/freecode.tar.gz" | awk '{print $1}')"
      [[ "$EXPECTED" == "$ACTUAL" ]] || fail "checksum mismatch: expected $EXPECTED, got $ACTUAL"
      say "checksum verified"
    else
      warn "SHA256SUMS does not mention freecode-$PLATFORM.tar.gz"
    fi
  else
    warn "could not fetch SHA256SUMS; the download was not verified"
  fi

  tar -xzf "$STAGE/freecode.tar.gz" -C "$STAGE" || fail "could not unpack the archive"
  BINARY="$(find "$STAGE" -type f -name freecode -perm -u+x | head -1)"
  BRIDGE_SOURCE="$(find "$STAGE" -type d -name bridge | head -1)"
  [[ -n "$BINARY" ]] || fail "the archive does not contain a freecode binary"
else
  for candidate in \
    "$HERE/packages/opencode/dist/freecode-darwin-arm64/bin/freecode" \
    "$HERE/packages/opencode/dist/freecode/bin/freecode"; do
    [[ -x "$candidate" ]] && BINARY="$candidate" && break
  done
  [[ -n "$BINARY" ]] || fail "no local build found; run 'bun run package' first, or pass --from-release"
  BRIDGE_SOURCE="$HERE/packages/opencode/src/freecode/router"
fi

say "installing from $BINARY"

# --- binary -------------------------------------------------------------------

install -m 755 "$BINARY" "$INSTALL_DIR/freecode"
say "installed $INSTALL_DIR/freecode"

# --- bridge -------------------------------------------------------------------

if [[ -n "$BRIDGE_SOURCE" && -d "$BRIDGE_SOURCE" ]]; then
  mkdir -p "$FREECODE_HOME/bridge"
  for file in main.py questions.py route.py cache.py sdk.py benchmark.py routing_bench.py requirements.txt __init__.py; do
    [[ -f "$BRIDGE_SOURCE/$file" ]] && install -m 644 "$BRIDGE_SOURCE/$file" "$FREECODE_HOME/bridge/$file"
  done
  say "installed the Laya bridge to $FREECODE_HOME/bridge"
fi

mkdir -p "$FREECODE_HOME/logs" "$FREECODE_HOME/runtime"

# --- config -------------------------------------------------------------------

mkdir -p "$CONFIG/agents"
if [[ ! -f "$CONFIG/freecode.jsonc" ]]; then
  cat > "$CONFIG/freecode.jsonc" <<'CONFIG_EOF'
{
  "$schema": "https://opencode.ai/config.json",

  // FreeCode routing configuration.
  //
  // `pool` maps a capability tier to the models that satisfy it, in preference
  // order. The router decides which tier a task needs; the pool decides which of
  // the models you actually have is used for it. A tier with no entries falls back
  // to the session's default model.
  "freecode": {
    "pool": {
      "local": [],
      "fast": [],
      "standard": [],
      "strong": [],
      "max": []
    }
  },

  // Providers. Each named account is its own provider id, which is how FreeCode
  // expresses an account pool: credentials are resolved per provider id, so
  // `deepseek-main` and `deepseek-backup` are two accounts of one vendor and the
  // scheduler groups them by that shared prefix.
  "provider": {},

  // The model used when nothing routes.
  "model": "auto"
}
CONFIG_EOF
  say "wrote a starter config to $CONFIG/freecode.jsonc"
else
  say "kept the existing config at $CONFIG/freecode.jsonc"
fi

if [[ ! -f "$CONFIG/agents/coder.md" ]]; then
  cat > "$CONFIG/agents/coder.md" <<'AGENT_EOF'
---
description: Implements code changes under FreeCode's automatic model routing
mode: subagent
model: auto
tier: standard
permission:
  edit: allow
  bash: ask
---

You are the implementation agent.

Implement the assigned task with minimal changes.
Run focused verification after editing.
Return the changed files, the commands you ran, and any remaining risk.
AGENT_EOF
  say "installed a starter coder agent at $CONFIG/agents/coder.md"
fi

# --- optional Laya runtime ----------------------------------------------------

if [[ "${FREECODE_SKIP_LAYA:-0}" == "1" ]]; then
  say "skipped the Laya runtime; FreeCode will route on rules"
else
  VENV="$FREECODE_HOME/runtime/laya/venv"
  PYTHON=""
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then PYTHON="$candidate"; break; fi
  done

  if [[ -z "$PYTHON" ]]; then
    say "no Python 3.10+ found; FreeCode will route on rules"
  else
    say "preparing the Laya runtime with $PYTHON (downloads PyTorch; several minutes)"
    if "$PYTHON" -m venv "$VENV" >/dev/null 2>&1 &&
       "$VENV/bin/python" -m pip install --quiet --upgrade pip >/dev/null 2>&1 &&
       "$VENV/bin/python" -m pip install --quiet -r "$FREECODE_HOME/bridge/requirements.txt" >/dev/null 2>&1; then
      say "installed the Laya runtime at $VENV"
    else
      say "could not prepare the Laya runtime; continuing without it"
      say "FreeCode will route on rules. Retry later with:"
      say "  $PYTHON -m venv $VENV && $VENV/bin/python -m pip install -r $FREECODE_HOME/bridge/requirements.txt"
    fi
  fi
fi

# --- PATH ---------------------------------------------------------------------
#
# Reported rather than edited into a shell profile: a silent edit to someone's
# .zshrc is generous once and obnoxious forever.

say ""
say "Done."
say "  FreeCode          $INSTALL_DIR/freecode"
say "  version           $("$INSTALL_DIR/freecode" --version 2>/dev/null || echo 'could not run')"
say ""

if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  say "$INSTALL_DIR is not on your PATH."
  say "Add it with:"
  say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc && exec zsh"
fi
