#!/usr/bin/env bash
# Credential / config sample secret scan for FreeCode CI.
#
# FreeCode ships sample configurations that teach users how to wire up a
# provider. A real key in one of those samples is a leak: the sample ends up
# in the repo, in a GitHub release, in an issue body, and on every machine
# that installs FreeCode from it. This check greps the sample and template
# surface for key-shaped strings and fails on any that are not obviously fake.
#
# Deliberately offline and dependency-free: a bounded file list plus a key
# pattern table. Known fake keys (the `broken` provider's test key, the
# redaction-test fixtures) are an allow-list so the check stays
# deterministic without a secret-scanning binary.
#
# Usage:
#   bash scripts/ci/secret-scan.sh
#
# Exit: 0 clean, 1 a real-looking key found, 2 a runner error.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The surface this check owns: sample / template / config / documentation
# paths. Source fixtures that deliberately embed fake keys for redaction
# tests (e.g. packages/http-recorder/test/record-replay.test.ts, which
# .gitleaksignore already lists) are excluded because their whole job is to
# contain a fake key.
TARGETS=(
  ".freecode/freecode.jsonc"
  "docs/"
  "README.md"
  "README.zh.md"
  "CONTRIBUTING.md"
  "SECURITY.md"
  "scripts/install.sh"
  "scripts/release.sh"
)

# Key shapes worth looking for.
PATTERNS=(
  'sk-[A-Za-z0-9]{16,}'            # OpenAI / DeepSeek / generic sk-
  'sk-ant-[A-Za-z0-9_-]{8,}'       # Anthropic
  'sk-or-[A-Za-z0-9]{16,}'         # OpenRouter
  'minimax-[A-Za-z0-9]{16,}'       # MiniMax
  'moonshot-[A-Za-z0-9]{16,}'      # Kimi / Moonshot
  'key-[A-Za-z0-9]{16,}'           # GLM / Zhipu (zhipu)
  'AKIA[A-Z0-9]{16}'              # AWS access key id
)

# Allow-list: strings that are documentation, not keys. The `broken`
# provider key is the canonical example — it is invalid on purpose and is
# the only fake key FreeCode ships. The `{env:...}` and `{file:...}`
# placeholders are not keys; they are indirections into the environment or
# a 600-mode file.
ALLOWED=(
  "sk-invalid-key-for-failover-testing"
  "sk-your-key-here"
  "sk-your-key-here-placeholder"
)

# Gather the file list: expand directories and non-recursive names.
FILES=()
for t in "${TARGETS[@]}"; do
  if [[ "$t" == */ ]]; then
    while IFS= read -r f; do
      [[ -f "$f" ]] && FILES+=("$f")
    done < <(find "$HERE/$t" -type f \( \
      -name '*.md' -o -name '*.jsonc' -o -name '*.json' \
      -o -name '*.sh' -o -name '*.env' -o -name '*.example' \
      -o -name '*.yml' -o -name '*.yaml' \) 2>/dev/null | sort -u)
  else
    [[ -f "$HERE/$t" ]] && FILES+=("$HERE/$t")
  fi
done

if [[ ${#FILES[@]} -eq 0 ]]; then
  printf 'secret-scan: no files matched the target list; that is itself a finding\n'
  exit 2
fi

found_any=0
for p in "${PATTERNS[@]}"; do
  # grep -H forces the filename prefix even for a single-file run; -n for line.
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    # hit is "path:line" (grep output)
    token="$(grep -oE "$p" <<<"${hit#*:}" | head -1 || true)"
    [[ -z "$token" ]] && continue

    allowed=0
    for a in "${ALLOWED[@]}"; do
      [[ "$token" == "$a" ]] && allowed=1 && break
    done
    (( allowed )) && continue

    # Report in a relative-to-HERE form so the output is stable.
    rel="${hit#$HERE/}"
    printf 'SECRET-SCAN %s: suspected key "%s" (pattern %s)\n' "$rel" "$token" "$p"
    found_any=1
  done < <(
    for f in "${FILES[@]}"; do
      grep -HnE "$p" "$f" 2>/dev/null || true
    done
  )
done

if (( found_any )); then
  printf '\nsecret-scan FAILED: remove the key from the sample, or add it to the allow-list above if it is a documented fake\n'
  exit 1
fi

printf 'secret-scan ok: no plaintext keys in sample / template / config files (%s files scanned)\n' "${#FILES[@]}"
exit 0
