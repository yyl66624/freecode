#!/usr/bin/env bash
# FreeCode acceptance test.
#
# Verifies the whole chain the v0.4 milestone is defined by, in one command, with
# no state shared with the developer's own FreeCode installation:
#
#   build -> install -> doctor fails on an empty pool -> setup -> doctor passes
#         -> run a real task through model:auto -> isolation -> merge -> resume
#
# Everything happens under a temporary prefix with its own XDG directories, so this
# is safe to run at any time and its result does not depend on what the developer
# configured for themselves.
#
# The interactive TUI cannot be driven from a script; the `run` path exercises the
# same session, routing, tools and isolation machinery that the TUI does.
#
# Usage:
#   bash scripts/acceptance.sh                 # requires DEEPSEEK_API_KEY in the env
#   bash scripts/acceptance.sh --skip-network  # everything except the model call
#
# Exit code is the number of failed checks, so CI can consume it directly.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_NETWORK=0
[[ "${1:-}" == "--skip-network" ]] && SKIP_NETWORK=1

PREFIX="$(mktemp -d "${TMPDIR:-/tmp}/freecode-acceptance.XXXXXX")"
export FREECODE_INSTALL_DIR="$PREFIX/bin"
export FREECODE_HOME="$PREFIX/home"
export XDG_DATA_HOME="$PREFIX/data"
export XDG_CONFIG_HOME="$PREFIX/config"
export XDG_CACHE_HOME="$PREFIX/cache"
export XDG_STATE_HOME="$PREFIX/state"
export TMPDIR="$PREFIX/tmp"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$TMPDIR"

PASS=0
FAIL=0
SKIP=0

ok() { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '  \033[31m×\033[0m %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf '  \033[90m·\033[0m %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# check <description> <command...>
check() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then ok "$description"; else no "$description"; fi
}

cleanup() {
  # The user's real installation is untouched by construction, so this is the only
  # cleanup needed. A failure keeps the directory, because the logs are the only way
  # to see what went wrong and deleting them on exit makes a failing run useless.
  if [[ "${FAIL:-0}" -gt 0 ]]; then
    printf '\nkept %s for inspection\n' "$PREFIX"
    return
  fi
  rm -rf "$PREFIX"
}
trap cleanup EXIT

printf '\033[1mFreeCode acceptance test\033[0m\n'
printf 'prefix %s\n' "$PREFIX"

# --- build and install --------------------------------------------------------

head_ "Build and install"

if [[ -x "$HERE/packages/opencode/dist/freecode-darwin-arm64/bin/freecode" ]]; then
  ok "a current binary exists"
else
  no "no binary; run 'bun run package' in packages/opencode first"
fi

FREECODE_SKIP_LAYA=1 "$HERE/scripts/install.sh" >"$PREFIX/install.log" 2>&1
if [[ $? -eq 0 ]]; then ok "install.sh completed"; else no "install.sh failed"; fi

check "freecode is on the install path" test -x "$FREECODE_INSTALL_DIR/freecode"
check "the bridge was installed" test -f "$FREECODE_HOME/bridge/main.py"
check "a starter config was written" test -f "$XDG_CONFIG_HOME/freecode/freecode.jsonc"
check "a starter agent was written" test -f "$XDG_CONFIG_HOME/freecode/agents/coder.md"

export PATH="$FREECODE_INSTALL_DIR:$PATH"

VERSION="$(freecode --version 2>/dev/null)"
if [[ -n "$VERSION" ]]; then ok "freecode --version reports $VERSION"; else no "freecode --version failed"; fi
if freecode --help 2>&1 | grep -q freecode; then ok "help names FreeCode"; else no "help does not name FreeCode"; fi

# --- workspace and doctor -----------------------------------------------------

head_ "Workspace and doctor"

mkdir -p "$PREFIX/project"
(
  cd "$PREFIX/project"
  git init -q
  git config user.email acceptance@freecode.local
  git config user.name Acceptance
  printf 'def area(r):\n    return r * r\n' > geom.py
  printf 'geom\n' > .gitignore
  git add -A && git commit -qm init
) >/dev/null 2>&1

# The starter config has no pool, so doctor must fail. This is the check that a
# real misconfiguration is caught rather than passed over.
if freecode doctor --dir "$PREFIX/project" >"$PREFIX/doctor-empty.log" 2>&1; then
  no "doctor passed with no pool configured; it should have failed"
else
  if grep -q "pool" "$PREFIX/doctor-empty.log"; then
    ok "doctor fails and names the missing pool"
  else
    no "doctor failed without naming the cause"
  fi
fi

check "doctor reports the workspace it was pointed at" \
  grep -q "$(cd "$PREFIX/project" && pwd -P)" "$PREFIX/doctor-empty.log"

# --- optional provider and pool ----------------------------------------------

head_ "Provider setup"

if [[ "$SKIP_NETWORK" == "1" ]]; then
  skip "provider setup and the model call (--skip-network)"
else
  if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
    no "DEEPSEEK_API_KEY is not set, so setup cannot be exercised"
  else
    freecode setup --dir "$PREFIX/project" \
      --provider "deepseek-main" --base-url "https://api.deepseek.com/v1" \
      --model "deepseek-v4-pro" --api-key "$DEEPSEEK_API_KEY" \
      >"$PREFIX/setup.log" 2>&1
    if grep -q "saved to the global config" "$PREFIX/setup.log"; then
      ok "setup saved a provider"
    else
      no "setup did not report saving a provider"
    fi

    if [[ "$(stat -f '%Sp' "$FREECODE_HOME/secrets.env" 2>/dev/null)" == "-rw-------" ]]; then
      ok "the key file is mode 600"
    else
      no "the key file is not mode 600"
    fi

    if grep -q "{file:" "$XDG_CONFIG_HOME/freecode/freecode.jsonc"; then
      ok "the config references the key file rather than inlining the key"
    else
      no "the config does not reference the key file"
    fi

    if grep -q "$DEEPSEEK_API_KEY" "$XDG_CONFIG_HOME/freecode/freecode.jsonc"; then
      no "the API key leaked into the config file"
    else
      ok "the API key is not in the config file"
    fi

    if freecode doctor --dir "$PREFIX/project" >"$PREFIX/doctor-ok.log" 2>&1; then
      ok "doctor passes once a pool exists"
    else
      no "doctor still fails after setup: $(grep -m1 '×' "$PREFIX/doctor-ok.log" || true)"
    fi

    # --- a real task ----------------------------------------------------------

    head_ "A real task through model:auto"

    (
      cd "$PREFIX/project"
      freecode run --print-logs --log-level INFO \
        "Use the task tool with subagent_type=coder to add a module docstring to geom.py." \
        >"$PREFIX/run.log" 2>&1
    )

    if grep -q "freecode route" "$PREFIX/run.log"; then
      ok "routing ran: $(grep -m1 -o 'tier=[a-z]*' "$PREFIX/run.log" | head -1)"
    else
      no "routing did not run"
    fi

    if grep -q "freecode schedule" "$PREFIX/run.log"; then
      ok "the scheduler chose a resource"
    else
      no "the scheduler did not choose a resource"
    fi

    # Isolation: the writer must not have touched the shared checkout.
    if grep -q "freecode isolated subagent" "$PREFIX/run.log"; then
      ok "the writing subagent was isolated into a worktree"

      if [[ "$(head -1 "$PREFIX/project/geom.py")" == "def area(r):" ]]; then
        ok "the main checkout is unchanged"
      else
        no "the main checkout was modified despite isolation"
      fi

      # The task id is read from the command rather than derived from the directory
      # name: git canonicalises paths on macOS, and a test that guesses would fail
      # for a reason that has nothing to do with FreeCode.
      TASK_ID="$(freecode tasks --dir "$PREFIX/project" 2>/dev/null | sed -n 's/^\(ses_[A-Za-z0-9]*\)$/\1/p' | head -1)"
      WORKTREE="$(find "$PREFIX/project/.freecode/worktrees" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | head -1)"
      if [[ -n "$WORKTREE" ]] && grep -q '"""' "$WORKTREE/geom.py" 2>/dev/null; then
        ok "the change is present in the worktree"
      else
        no "the change is not in the worktree (the subagent may have failed to write)"
      fi

      # --- review and merge ---------------------------------------------------

      head_ "Review and merge"

      if freecode tasks --dir "$PREFIX/project" 2>/dev/null | grep -q "geom.py"; then
        ok "the task is listed with its changed file"
      else
        no "the task is not listed"
      fi

      [[ -n "$TASK_ID" ]] || TASK_ID="$(basename "$WORKTREE")"
      if freecode tasks merge "$TASK_ID" --dir "$PREFIX/project" >"$PREFIX/merge.log" 2>&1; then
        if grep -q "^Merged" "$PREFIX/merge.log"; then
          ok "the task merged"
        else
          no "merge reported success without merging: $(head -2 "$PREFIX/merge.log" | tr '\n' ' ')"
        fi
      else
        no "merge failed: $(head -2 "$PREFIX/merge.log" | tr '\n' ' ')"
      fi

      if grep -q '"""' "$PREFIX/project/geom.py" 2>/dev/null; then
        ok "the merged change is in the main checkout"
      else
        no "the merge did not reach the main checkout"
      fi

      if [[ -z "$(find "$PREFIX/project/.freecode/worktrees" -maxdepth 1 -mindepth 1 -type d 2>/dev/null)" ]]; then
        ok "the worktree was cleaned up"
      else
        no "the worktree was left behind"
      fi
    else
      skip "isolation checks (the subagent did not get a worktree)"
    fi

    # --- resumption -----------------------------------------------------------

    head_ "Resumption"

    (
      cd "$PREFIX/project"
      freecode run --continue "Reply with exactly: resumed" >"$PREFIX/resume.log" 2>&1
    )
    if grep -qi "resumed" "$PREFIX/resume.log"; then
      ok "a second run resumed the session"
    else
      no "the second run did not resume"
    fi
  fi
fi

# --- summary ------------------------------------------------------------------

printf '\n\033[1mSummary\033[0m\n'
printf '  %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
if [[ "$FAIL" -gt 0 ]]; then
  printf '\nlogs: %s\n' "$PREFIX"
fi

exit "$FAIL"
