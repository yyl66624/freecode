#!/usr/bin/env bash
# Cross-platform SHA-256. Prints "<hex>  <file>".
# macOS ships `shasum`, Linux ships `sha256sum`; either may be present.
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$@"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$@"
else
  echo "neither shasum nor sha256sum found" >&2
  exit 1
fi
