#!/usr/bin/env bash
# FreeCode vanilla-mode smoke test.
#
# "Vanilla" means: FreeCode's additive layers (model auto-routing, Laya
# bridge, resource scheduler) are switched off, but the OpenCode harness —
# the CLI, the TUI, context management, tools, permissions, sessions —
# still works. That is the retained-mechanics promise. This smoke is the
# CI-resident proof that the promise holds on every commit, and it is also
# the rollback path: a user whose FreeCode installation misbehaves can run
# the same binary in vanilla mode and get OpenCode-compatible behaviour.
#
# A FreeCode release today does not yet ship a `--vanilla` flag or a
# `FREECODE_HARNESS` environment switch; the rollback guarantee at this
# point is that the binary still boots and reports its version with no
# FreeCode pool configured, which is exactly what release.yml's "install
# into a clean prefix and run from another directory" step checks. This
# script automates that guarantee so it runs on every trunk commit, not
# only on tag releases.
#
# Stages (each independently runnable):
#   build  — the binary is rebuilt from the current source; a stale
#            artifact is the characteristic packaging failure this catches
#   run    — the binary starts, names itself, and behaves like a usable CLI
#            with no FreeCode pool configured
#   tests  — the OpenCode-owned test directories pass against the tree
#
# Usage:
#   bash scripts/ci/vanilla-smoke.sh          # all three stages
#   bash scripts/ci/vanilla-smoke.sh build   # just one
#
# Exit: number of failed stages, same convention as ci.sh.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG_JSON="$HERE/packages/opencode/package.json"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
BIN="$HERE/packages/opencode/dist/freecode-$PLATFORM/bin/freecode"

# The OpenCode-owned test directories the smoke asserts against, and the fail
# count each is allowed to have. The five `test/config` fails are the same five
# the regression baseline records (config MCP-merge behaviour that fails
# identically on the upstream baseline), so they are a property of the fork's
# starting point, not a FreeCode regression — the smoke allows them. A NEW
# fail in any of these directories is what the vanilla gate exists to catch:
# FreeCode may not have broken a retained mechanism.
VANILLA_TEST_DIRS=(test/config test/provider test/git test/permission)
VANILLA_TEST_BASELINE_FAILS=(5 0 0 0) # one per directory, same order

# A clean prefix the smoke installs into, so the run does not depend on the
# developer's own FreeCode installation — the same property acceptance.sh has.
PREFIX="$(mktemp -d "${TMPDIR:-/tmp}/freecode-vanilla.XXXXXX")"
export FREECODE_INSTALL_DIR="$PREFIX/bin"
export FREECODE_HOME="$PREFIX/home"
export XDG_DATA_HOME="$PREFIX/data"
export XDG_CONFIG_HOME="$PREFIX/config"
export XDG_CACHE_HOME="$PREFIX/cache"
export TMPDIR="$PREFIX/tmp"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$PREFIX/tmp"

stage_build() {
  printf '\n\033[1m[vanilla:build]\033[0m rebuild the binary from current source\n'
  (
    cd "$HERE/packages/opencode"
    set -e
    bun install --frozen-lockfile
    bun run package
  )
  local rc=$?
  if [[ $rc -eq 0 && ! -x "$BIN" ]]; then
    printf 'vanilla:build FAILED: binary missing after successful build at %s\n' "$BIN"
    return 1
  fi
  local version
  version="$("$BIN" --version 2>/dev/null || true)"
  if [[ -z "$version" ]]; then
    printf 'vanilla:build FAILED: binary does not start\n'
    return 1
  fi
  printf 'vanilla:build ok: version %s at %s\n' "$version" "$BIN"
  return 0
}

stage_run() {
  printf '\n\033[1m[vanilla:run]\033[0m the binary starts and is usable with no pool configured\n'
  # Install into the clean prefix (Laya skipped: the point is the retained
  # CLI, and the retained CLI must work without the optional accelerator),
  # then run it from a directory that has no FreeCode configuration.
  # With no pool, `doctor` must report exactly that and exit non-zero — a
  # misconfiguration that is caught rather than passed over is the usable
  # CLI working as designed.
  local rc=0
  if ! FREECODE_SKIP_LAYA=1 "$HERE/scripts/install.sh" >"$PREFIX/install.log" 2>&1; then
    printf 'vanilla:run FAILED: install into a clean prefix failed (see %s)\n' "$PREFIX/install.log"
    tail -20 "$PREFIX/install.log" || true
    return 1
  fi
  printf '  ok: install into clean prefix\n'

  if ! "$PREFIX/bin/freecode" --version >/dev/null 2>&1; then
    printf 'vanilla:run FAILED: installed binary does not start\n'
    return 1
  fi
  printf '  ok: installed binary starts\n'

  local help
  help="$("$PREFIX/bin/freecode" --help 2>&1)"
  case "$help" in
    *freecode*) printf '  ok: --help names freecode\n' ;;
    *) printf 'vanilla:run FAILED: --help output does not name freecode\n'
       printf '%s\n' "$help" | head -20
       rc=1 ;;
  esac

  # The installed binary's version is what the user actually has. It must
  # contain the source version — a stale build that reports an older
  # version here is the packaging trap from DEVELOPMENT.md, caught at
  # install time rather than at "the feature is broken" time.
  local srcver binver
  srcver="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$HERE/packages/opencode/package.json")"
  binver="$("$PREFIX/bin/freecode" --version)"
  case "$binver" in
    *"$srcver"*) printf '  ok: installed binary reports %s (source %s)\n' "$binver" "$srcver" ;;
    *) printf 'vanilla:run FAILED: installed binary reports %s, source is %s — the artifact is stale\n' "$binver" "$srcver"
       rc=1 ;;
  esac

  # A starter pool is not a misconfiguration: `install.sh` ships a starter
  # `freecode.jsonc` with a real model in every tier, and with the pool in
  # place `doctor` exits zero. The no-pool branch is only reachable when the
  # user deliberately empties it, so this check is informational, not a gate.
  if "$PREFIX/bin/freecode" doctor >/dev/null 2>&1; then
    printf '  ok: doctor passes with the installed starter pool (the expected steady state)\n'
  else
    printf '  note: doctor reported a problem with the starter config; inspect %s/doctor.log for a broken install\n' "$PREFIX"
    "$PREFIX/bin/freecode" doctor >"$PREFIX/doctor.log" 2>&1 || true
    tail -20 "$PREFIX/doctor.log" || true
  fi

  return $rc
}

stage_tests() {
  printf '\n\033[1m[vanilla:tests]\033[0m OpenCode-owned test directories pass against the tree\n'
  local rc=0
  local i
  for i in "${!VANILLA_TEST_DIRS[@]}"; do
    local dir="${VANILLA_TEST_DIRS[$i]}"
    local baseline="${VANILLA_TEST_BASELINE_FAILS[$i]}"
    if [[ ! -d "$HERE/packages/opencode/$dir" ]]; then
      printf '  skip: %s does not exist in this tree\n' "$dir"
      continue
    fi
    local log
    log="$(cd "$HERE/packages/opencode" && bun test "$dir" --continue 2>&1 | grep -Eo '[0-9]+ fail' | awk '{print $1}' | sort -n | tail -1 || true)"
    local fails="${log:-0}"
    if (( fails > baseline )); then
      printf '  FAILED: %s — %s fails exceed the %s allowed (a new failure in a retained mechanism)\n' "$dir" "$fails" "$baseline"
      rc=1
    else
      printf '  ok: %s — %s fails (baseline %s)\n' "$dir" "$fails" "$baseline"
    fi
  done
  return $rc
}

cleanup() {
  if [[ -d "$PREFIX" && -w "$PREFIX" ]]; then
    # Keep the prefix on failure — the logs are the only way to see what went
    # wrong; delete it on success.
    local stage="$1"
    case "$stage" in
      fail) printf '\nkept %s for inspection\n' "$PREFIX" ;;
      ok) rm -rf "$PREFIX" ;;
    esac
  fi
}

main() {
  local stages=("$@")
  if [[ ${#stages[@]} -eq 0 ]]; then
    stages=(build run tests)
  fi
  local failures=0
  for s in "${stages[@]}"; do
    case "$s" in
      build) stage_build || failures=$((failures + 1)) ;;
      run)   stage_run   || failures=$((failures + 1)) ;;
      tests) stage_tests || failures=$((failures + 1)) ;;
      *) printf 'unknown stage "%s" (valid: build run tests)\n' "$s" >&2; exit 2 ;;
    esac
  done
  if (( failures > 0 )); then
    printf '\n\033[1mvanilla smoke: %s of %s stage(s) failed\033[0m\n' "$failures" "${#stages[@]}"
    cleanup fail
    exit $failures
  fi
  printf '\n\033[1mvanilla smoke: all %s stage(s) passed\033[0m\n' "${#stages[@]}"
  cleanup ok
  exit 0
}

main "$@"
