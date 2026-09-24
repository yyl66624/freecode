#!/usr/bin/env bash
# FreeCode version tooling.
#
# Three concerns in one small script because they are one guarantee:
#
#   1. The product version (packages/opencode/package.json) and the
#      compiled constant (freecode.ts) stay in step. They are the two
#      places a version can drift.
#   2. `freecode --version` reports what the user actually has installed,
#      not what the source tree says. A mismatch is the stale-binary trap
#      from DEVELOPMENT.md, surfaced as a check instead of a surprise.
#   3. A release is a `v<semver>` tag that names its own version, and the
#      binary's version must match the tag being released. That is what
#      makes "the install path a user takes is the artifact CI tested"
#      true rather than merely convenient.
#
# Subcommands:
#   bash scripts/version.sh show          print the source version
#   bash scripts/version.sh bump <part>   propose a semver bump (patch/minor/major)
#   bash scripts/version.sh check         all three guarantees above
#
# `bump` prints the proposed new version; it does not write. FreeCode's
# versions are bumped by hand, deliberately — a CLI that quietly rewrites
# its own package.json has the same trust problem a stale binary does.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_JSON="$HERE/packages/opencode/package.json"
FREECODE_TS="$HERE/packages/opencode/src/freecode/freecode.ts"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
BIN="$HERE/packages/opencode/dist/freecode-$PLATFORM/bin/freecode"

json_version() {
  node -p 'require("./packages/opencode/package.json").version' 2>/dev/null \
    || python3 -c 'import json; print(json.load(open("packages/opencode/package.json"))["version"])'
}

ts_version() {
  # The constant is written as a bare string, so a line-anchored grep is the
  # whole check. A refactor that moves it off that shape is a finding, not a
  # script bug.
  grep -oE 'export const version = "[^"]+"' "$FREECODE_TS" | head -1 | sed 's/.*"\(.*\)"/\1/'
}

show() {
  local src ts
  src="$(cd "$HERE" && json_version)"
  ts="$(ts_version)"
  printf 'source   %s (packages/opencode/package.json)\n' "$src"
  printf 'constant %s (freecode.ts)\n' "$ts"
  if [[ -x "$BIN" ]]; then
    local installed
    installed="$("$BIN" --version)"
    printf 'binary   %s (%s)\n' "$installed" "$BIN"
  else
    printf 'binary   (not built)\n'
  fi
}

bump() {
  local part="${1:-}"
  case "$part" in
    patch|minor|major) ;;
    *) printf 'usage: version.sh bump <patch|minor|major>\n' >&2; exit 2 ;;
  esac
  local current
  current="$(cd "$HERE" && json_version)"
  # Split a.b.c and bump the requested part, zeroing everything below it —
  # the semver contract for what a bump means.
  local major minor patch
  IFS='.' read -r major minor patch <<<"$current"
  case "$part" in
    patch) patch=$((patch + 1)); minor=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    major) major=$((major + 1)); minor=0; patch=0 ;;
  esac
  printf '%s.%s.%s\n' "$major" "$minor" "$patch"
}

check() {
  local rc=0
  local src ts
  src="$(cd "$HERE" && json_version)"
  ts="$(ts_version)"

  if [[ "$src" == "$ts" ]]; then
    printf 'ok  source and constant agree: %s\n' "$src"
  else
    printf 'FAIL source %s != constant %s — they must stay in step\n' "$src" "$ts"
    rc=1
  fi

  # The binary check is meaningful only when a build exists; a CI run that
  # has not built yet should not fail on a missing artifact, so a missing
  # binary is reported, not failed.
  if [[ ! -x "$BIN" ]]; then
    printf 'note  no binary at %s (run the build stage first)\n' "$BIN"
    return 0
  fi

  local installed
  installed="$("$BIN" --version)"
  if [[ "$installed" == *"$src"* ]]; then
    printf 'ok  binary reports %s (contains source %s)\n' "$installed" "$src"
  else
    printf 'FAIL binary reports %s, source says %s — the artifact is stale or the build is off\n' "$installed" "$src"
    rc=1
  fi

  # The tag check is the release-time guarantee: the version being released
  # and the source version are the same. Run it with RELEASE_TAG set, as the
  # release workflow does.
  if [[ -n "${RELEASE_TAG:-}" ]]; then
    local tag="${RELEASE_TAG#v}"
    if [[ "$tag" == "$src" ]]; then
      printf 'ok  release tag %s matches source %s\n' "$RELEASE_TAG" "$src"
    else
      printf 'FAIL release tag %s != source %s — a tag must name the version it ships\n' "$RELEASE_TAG" "$src"
      rc=1
    fi
  fi

  return $rc
}

case "${1:-show}" in
  show) show ;;
  bump) bump "${2:-}" ;;
  check) check ;;
  *) printf 'usage: version.sh <show|bump <patch|minor|major>|check>\n' >&2; exit 2 ;;
esac
