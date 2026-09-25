#!/usr/bin/env bash
# FreeCode isolation verdict runner (P0-2).
#
# Reads a FreeCode trace file (the JSONL a traced run leaves at
# $XDG_DATA_HOME/freecode/trace/<pid>.jsonl) and prints a verdict label plus
# the evidence, for every subagent session in the trace:
#
#   OK         every write the subagent made landed in its own worktree
#   WRONG_CWD  a write landed outside the subagent's worktree (isolation lost)
#   NO_WRITE   the subagent never called a write tool (model behaviour)
#   ERROR      the turn failed, a write errored, or the subagent was not
#              isolated at all
#
# The verdict is computed from the trace record alone, so it is deterministic
# and reproducible on a recorded trace from any machine. A filesystem
# cross-check is added when the recorded paths still exist on this machine:
# for each write target the trace recorded, does the file exist where the
# trace says it does?
#
# Usage:
#   bash scripts/isolation-verdict.sh [--session <id>] <trace.jsonl> [expect]
#
# `expect` is one of: OK WRONG_CWD NO_WRITE ERROR any (default: OK). The exit
# code is 0 when every verdict matches the expectation, 1 otherwise, 2 on a
# runner error.

set -uo pipefail

# Clean up the generated driver file on exit (ROOT is set right after this).
cleanup_driver() {
  rm -f "${ROOT:-}/packages/opencode/verdict-decide.mjs" 2>/dev/null || true
}
trap cleanup_driver EXIT

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRACE_FILE=""
SESSION_ID=""
EXPECT="OK"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session)
      if [[ -z "${2:-}" ]]; then
        echo "usage: $0 [--session <id>] <trace.jsonl> [expect:OK|WRONG_CWD|NO_WRITE|ERROR|AUTH_FAILED|any]" >&2
        exit 2
      fi
      SESSION_ID="$2"; shift 2
      ;;
    OK|WRONG_CWD|NO_WRITE|ERROR|AUTH_FAILED|any)
      EXPECT="$1"; shift
      ;;
    *)
      if [[ -z "$TRACE_FILE" ]]; then TRACE_FILE="$1"; shift
      else echo "unknown argument: $1" >&2; exit 2
      fi
      ;;
  esac
done

if [[ -z "$TRACE_FILE" || ! -f "$TRACE_FILE" ]]; then
  echo "usage: $0 [--session <id>] <trace.jsonl> [expect:OK|WRONG_CWD|NO_WRITE|ERROR|AUTH_FAILED|any]" >&2
  exit 2
fi

# Locate bun: the environment's copy first, then the workspace .runtime that
# ships one. The runner must work on a recorded trace from any machine, so
# the .runtime fallback keeps it self-sufficient inside this tree.
BUN="${BUN_BIN:-$(command -v bun || true)}"
if [[ -z "$BUN" ]]; then
  for candidate in \
      "$ROOT/../../.runtime/bin/bun" \
      "$ROOT/.runtime/bin/bun" \
      "$HOME/.runtime/bin/bun" \
      "/Users/yyl/Desktop/workshop/freecode/.runtime/bin/bun"; do
    if [[ -x "$candidate" ]]; then BUN="$candidate"; break; fi
  done
fi
if [[ -z "$BUN" ]]; then
  echo "bun not found on the PATH or in any .runtime (set BUN_BIN to one)" >&2
  exit 2
fi

# --- the decision driver ------------------------------------------------------
#
# The driver imports the Verdict module from the source tree, so the verdict
# is always computed against the source, not against a possibly stale dist
# build. The driver is written into a scratch directory, not the source tree.
# The decision driver is written into packages/opencode (not a scratch dir)
# so that bun can resolve the `@/` tsconfig paths. It is gitignored.
DECIDE_JS="$ROOT/packages/opencode/verdict-decide.mjs"
cat > "$DECIDE_JS" <<'DECIDE'
import { readFileSync, existsSync } from "node:fs"
import { Verdict } from "@/freecode/verdict"

const [, , traceFile, sessionArg] = process.argv
const lines = readFileSync(traceFile, "utf8").split("\n").filter(Boolean)
const all = lines.map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)

// Only subagent sessions are verdict targets: they are the ones that have a
// session record in the trace (written by isolation.prepare). The parent
// session's own calls have no session record and are not subagents.
const ids = new Set()
for (const event of all) {
  if (event.kind === "session" && event.sessionID) ids.add(event.sessionID)
}
const targets = sessionArg ? [sessionArg] : [...ids]

const verdicts = []
for (const sessionID of targets) {
  const events = all.filter((e) => e.sessionID === sessionID)
  const result = Verdict.decide(events)

  const fsChecks = result.evidence.written.map((target) => ({
    target,
    exists: existsSync(target),
    insideWorktree: Boolean(
      result.evidence.session?.worktree && target.startsWith(result.evidence.session.worktree),
    ),
  }))

  verdicts.push({
    sessionID,
    label: result.label,
    summary: result.summary,
    isolated: result.isolated,
    session: result.evidence.session,
    writeResolves: result.evidence.resolves,
    writeOutcomes: result.evidence.outcomes,
    turn: result.evidence.turn,
    fsChecks,
  })
}

console.log(JSON.stringify({ traceFile, verdicts }, null, 2))
DECIDE

TRACE_FILE_ABS="$(realpath "$TRACE_FILE")"
ERR_TMP="$(mktemp "${TMPDIR:-/tmp}/freecode-verdict.err.XXXXXX")"
OUT="$(cd "$ROOT/packages/opencode" && "$BUN" run ./verdict-decide.mjs "$TRACE_FILE_ABS" "$SESSION_ID" 2>"$ERR_TMP")"
if [[ -z "$OUT" ]]; then
  echo "verdict computation failed:" >&2
  cat "$ERR_TMP" >&2
  exit 2
fi
echo "$OUT"

# --- expectation check --------------------------------------------------------
LABELS="$(echo "$OUT" | /usr/bin/python3 -c '
import json, sys
data = json.load(sys.stdin)
print(" ".join(v["label"] for v in data["verdicts"]))
')"

if [[ -z "$LABELS" ]]; then
  echo "no subagent session found in the trace (expected $EXPECT)" >&2
  exit 2
fi

if [[ "$EXPECT" == "any" ]]; then
  echo "verdict: $LABELS" >&2
  exit 0
fi

FAILED=0
for label in $LABELS; do
  if [[ "$label" != "$EXPECT" ]]; then FAILED=1; fi
done

echo "expectation: $EXPECT | verdict: $LABELS" >&2
exit "$FAILED"
