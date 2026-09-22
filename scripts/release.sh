#!/usr/bin/env bash
# FreeCode release archive builder.
#
# Called by the release workflow and usable by hand. Produces exactly what
# `scripts/install.sh --from-release` expects to unpack:
#
#   freecode-darwin-arm64/
#   ├── bin/freecode
#   ├── bridge/
#   └── UPSTREAM.md
#
#   dist/release/freecode-darwin-arm64.tar.gz
#   dist/release/SHA256SUMS
#
# The bridge is archived alongside the binary rather than left to the installer,
# so a release is a complete, self-describing artifact: what was tested is what is
# downloaded, byte for byte.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM="${FREECODE_PLATFORM:-darwin-arm64}"
OUT="$HERE/dist/release"
STAGE="$OUT/freecode-$PLATFORM"

# `package.ts` names its output `freecode-<platform>`; the leading `freecode-` is
# kept so it cannot collide with upstream's own `dist/<platform>/` for the
# opencode binary.
BINARY="$HERE/packages/opencode/dist/freecode-$PLATFORM/bin/freecode"
BRIDGE="$HERE/packages/opencode/src/freecode/router"

[[ -x "$BINARY" ]] || { printf 'error: no binary at %s; run bun run package first\n' "$BINARY" >&2; exit 1; }

printf 'building release archive for %s\n' "$PLATFORM"
rm -rf "$OUT"
mkdir -p "$STAGE/bin" "$STAGE/bridge"

cp "$BINARY" "$STAGE/bin/freecode"
chmod 755 "$STAGE/bin/freecode"

for file in main.py questions.py route.py cache.py sdk.py benchmark.py routing_bench.py requirements.txt __init__.py; do
  [[ -f "$BRIDGE/$file" ]] && cp "$BRIDGE/$file" "$STAGE/bridge/$file"
done

# Included because a bug report should identify the fork point without the reporter
# having to look anything up.
[[ -f "$HERE/UPSTREAM.md" ]] && cp "$HERE/UPSTREAM.md" "$STAGE/UPSTREAM.md"
[[ -f "$HERE/LICENSE" ]] && cp "$HERE/LICENSE" "$STAGE/LICENSE"

# Deterministic archive as far as the platform allows. macOS ships bsdtar, which
# has no --sort or --mtime, so entries are sorted by copying in order and the
# extended-attribute sidecars are suppressed. `COPYFILE_DISABLE` matters on macOS
# specifically: without it bsdtar injects `._` AppleDouble members and every
# checksum differs between machines.
(
  cd "$OUT"
  COPYFILE_DISABLE=1 tar -czf "freecode-$PLATFORM.tar.gz" "freecode-$PLATFORM"
)

shasum -a 256 "$OUT/freecode-$PLATFORM.tar.gz" | sed "s|$OUT/||" > "$OUT/SHA256SUMS"

SIZE="$(du -h "$OUT/freecode-$PLATFORM.tar.gz" | awk '{print $1}')"
printf 'ok  freecode-%s.tar.gz (%s)\n' "$PLATFORM" "$SIZE"
printf 'ok  SHA256SUMS\n'
cat "$OUT/SHA256SUMS"
