#!/usr/bin/env bash
# FreeCode installer.
#
# Sets up everything FreeCode needs and nothing it merely likes. Laya is an
# optional accelerator: if the Python runtime for it cannot be prepared, the
# install still succeeds and FreeCode routes on rules, because a coding agent
# that refuses to start over a missing optional model is not a usable agent.
#
#   ./install.sh                      # install into ~/.local
#   FREECODE_PREFIX=/tmp/fc ./install.sh
#   FREECODE_SKIP_LAYA=1 ./install.sh # binary only, no Python at all
#
# What it does:
#   1. verifies a Bun-built binary is present (built by `bun run package`)
#   2. installs it to <prefix>/bin/freecode
#   3. installs the Laya bridge scripts to <data>/freecode/bridge
#   4. optionally builds a virtualenv for the bridge and warms the checkpoint
#
# It never writes outside <prefix> and <data>.

set -euo pipefail

PREFIX="${FREECODE_PREFIX:-$HOME/.local}"
# FreeCode's runtime resolves its state through `$XDG_DATA_HOME/freecode`, and for
# a default prefix that is exactly `~/.local/share/freecode`. Deriving the data
# directory from the prefix keeps the installer and the binary agreeing on where
# things are, instead of each having its own idea.
XDG_DATA_BASE="${XDG_DATA_HOME:-$PREFIX/share}"
DATA="$XDG_DATA_BASE/freecode"
CONFIG="${XDG_CONFIG_HOME:-$PREFIX/config}/freecode"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The binary is built by `bun run package` from the opencode package directory,
# and the bridge scripts live beside the source they are built from.
BINARY="${FREECODE_BINARY:-$HERE/packages/opencode/dist/freecode/bin/freecode}"
BRIDGE_SOURCE="$HERE/packages/opencode/src/freecode/router"
# `DATA` is the FreeCode data directory, already including the product name, so
# `resources.json`, `last-route.json` and the bridge all sit directly inside it.
BRIDGE_TARGET="$DATA/bridge"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ -x "$BINARY" ]] || fail "no binary at $BINARY — build it first with: bun run package"

say "FreeCode installer"
say "  binary  $PREFIX/bin/freecode"
say "  data    $DATA"
say "  config  $CONFIG"
say ""
if [[ -z "${XDG_DATA_HOME:-}" && "$PREFIX" != "$HOME/.local" ]]; then
  # A non-default prefix means the binary will not find its own state unless the
  # XDG variables point at it, so say so rather than leaving a silent mismatch.
  say "note: with a non-default prefix, export XDG_DATA_HOME=$XDG_DATA_BASE"
  say "      export XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$PREFIX/config}"
  say ""
fi

# --- binary -------------------------------------------------------------------

mkdir -p "$PREFIX/bin"
install -m 755 "$BINARY" "$PREFIX/bin/freecode"
say "installed $PREFIX/bin/freecode"

# --- bridge scripts -----------------------------------------------------------

# Copied rather than bundled into the binary so the Python side stays editable and
# so a missing copy degrades to rules instead of breaking the executable.
mkdir -p "$BRIDGE_TARGET"
for file in main.py questions.py route.py cache.py sdk.py benchmark.py routing_bench.py requirements.txt __init__.py; do
  [[ -f "$BRIDGE_SOURCE/$file" ]] || continue
  install -m 644 "$BRIDGE_SOURCE/$file" "$BRIDGE_TARGET/$file"
done
say "installed Laya bridge to $BRIDGE_TARGET"

# --- config -------------------------------------------------------------------

mkdir -p "$CONFIG"
if [[ ! -f "$CONFIG/freecode.jsonc" ]]; then
  cat > "$CONFIG/freecode.jsonc" <<'CONFIG_EOF'
{
  "$schema": "https://opencode.ai/config.json",
  // FreeCode routing configuration.
  //
  // `pool` maps a capability tier to the models that satisfy it, in preference
  // order. The router decides which tier a task needs; the pool decides which of
  // the models you actually have is used for it. Tiers with no entries fall back
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
  // Add your providers here. Each named account is its own provider id, which is
  // how FreeCode expresses an account pool: upstream resolves credentials per
  // provider id, so `deepseek-main` and `deepseek-backup` are two accounts of one
  // vendor, and the scheduler groups them by that shared prefix.
  "provider": {}
}
CONFIG_EOF
  say "wrote a starter config to $CONFIG/freecode.jsonc"
else
  say "kept the existing config at $CONFIG/freecode.jsonc"
fi

# --- optional Laya runtime ----------------------------------------------------

if [[ "${FREECODE_SKIP_LAYA:-0}" == "1" ]]; then
  say "skipped the Laya runtime (FREECODE_SKIP_LAYA=1); FreeCode will route on rules"
  say ""
  say "Done. Run: $PREFIX/bin/freecode"
  exit 0
fi

VENV="$DATA/freecode/venv"
PYTHON=""
for candidate in python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then PYTHON="$candidate"; break; fi
done

if [[ -z "$PYTHON" ]]; then
  say "no Python 3.10+ found; FreeCode will route on rules"
  say ""
  say "Done. Run: $PREFIX/bin/freecode"
  exit 0
fi

say "preparing the Laya runtime with $PYTHON (this downloads PyTorch, several minutes)"
if "$PYTHON" -m venv "$VENV" >/dev/null 2>&1 &&
   "$VENV/bin/python" -m pip install --quiet --upgrade pip >/dev/null 2>&1 &&
   "$VENV/bin/python" -m pip install --quiet -r "$BRIDGE_TARGET/requirements.txt" >/dev/null 2>&1; then
  say "installed the Laya runtime at $VENV"
else
  # A failed optional component must not fail the install.
  say "could not prepare the Laya runtime; installing without it"
  say "FreeCode will route on rules. Retry later with:"
  say "  $PYTHON -m venv $VENV && $VENV/bin/python -m pip install -r $BRIDGE_TARGET/requirements.txt"
fi

say ""
say "Done."
say "  FreeCode CLI      $PREFIX/bin/freecode"
say "  routing status    $PREFIX/bin/freecode routes status"
say "  why this model    $PREFIX/bin/freecode routes why"
say ""
if [[ ":$PATH:" != *":$PREFIX/bin:"* ]]; then
  say "Add $PREFIX/bin to your PATH to run 'freecode' directly."
fi
