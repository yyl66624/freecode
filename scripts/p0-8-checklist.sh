#!/usr/bin/env bash
# FreeCode P0-8 clean-Mac acceptance checklist (11 steps).
#
# This is the human-executable P0-8 script: the 11-step command sequence with a
# pass/fail verdict per step, plus the machine-judgeable segments that also
# collapse into `scripts/acceptance.sh`. The human runs the interactive steps
# (TUI startup, task dispatch, exit, session resume, fallback) by hand and
# records each step's output into the result table at
# `docs/p0-8-result-template.md`.
#
# Usage (on the clean machine, in a freshly cloned repo):
#   bash scripts/p0-8-checklist.sh              # run the machine segments, print the table skeleton
#   bash scripts/p0-8-checklist.sh --steps       # just print the 11-step command list for manual execution
#
# Exit code is the number of failed machine-judgeable checks (mirrors
# acceptance.sh semantics) so it can be consumed by a CI or a human.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--steps" ]]; then
  cat <<'EOF'
# P0-8 11-step checklist (human execution on a clean Mac)
#
# For each step: run the command, observe the output, mark PASS/FAIL in the
# result table, and paste the last <=10 lines of output as evidence.
#
# §0 Environment info + stale-binary gate (P0-5)
#   sw_vers; uname -m; git --version; bun --version 2>/dev/null || echo "bun not installed"
#   cd <repo> && git log -1 --format='%H'
#   cd <repo>/packages/opencode && bun run package
#   bash <repo>/scripts/version.sh check
#   PASS = version.sh check prints all "ok" lines AND the binary's embedded
#   build SHA equals the source HEAD you just read.
#   FAIL = any FAIL line => the whole checklist is void, stop and rebuild.
#
# §1 Install
#   <repo>/scripts/install.sh        # or --from-release for an RC
#   freecode --version
#   freecode doctor
#   PASS = 0.4.0 printed; doctor ends with "FreeCode is usable."
#   FAIL = command not found, or a "x" in the Core group of doctor output.
#
# §2 Startup (non-interactive smoke)
#   freecode --help | head -5
#   freecode config validate
#   PASS = FreeCode title printed; "configuration is valid".
#
# §3 setup a domestic provider
#   freecode setup --provider deepseek --base-url https://api.deepseek.com/v1 \
#       --api-key '<KEY>' --model deepseek-chat --yes
#   freecode provider test deepseek
#   ls -l ~/.freecode/secrets.env     # must be -rw-------
#   grep -r '<a KEY fragment>' ~/.config/freecode/   # must find nothing
#   PASS = setup saved; provider test reachable; secrets.env 600; no key leak.
#   FAIL (product) = key leaked into the config. FAIL (env) = 401 => swap key.
#
# §4 Launch the TUI
#   cd <your git project> && freecode
#   PASS = TUI boots, stays up, accepts input.
#
# §5 Head agent dispatches a subagent
#   > add a module docstring to geom.py        (typed inside the TUI)
#   freecode tasks
#   PASS = task completes; tasks lists it with a changed-file count.
#   FAIL = task SUSPENDED with no pool-wide outage (check `freecode routes status`).
#
# §6 Auto model choice is explainable
#   freecode routes why
#   freecode routes
#   PASS = "routes why" shows the picked candidate + six-dimension scores
#   (capability/quota/health/latency/reliability/cost) + rejected candidates
#   and their reasons, consistent with the score lines in "routes".
#   FAIL = "No routing decision recorded" (task never routed) or missing terms.
#
# §7 worktree isolation
#   head -1 <project>/geom.py                            # main checkout: no docstring
#   find <project>/.freecode/worktrees -name geom.py      # change lives here
#   PASS = main checkout unchanged; change only in the worktree.
#   FAIL (WRONG_CWD, blocking) = main checkout was written. Rerun §5 with
#   FREECODE_TRACE=1 and run:
#     bash <repo>/scripts/isolation-verdict.sh <trace.jsonl> any
#   The verdict label (OK/WRONG_CWD/NO_WRITE/ERROR) is the attribution evidence.
#
# §8 diff / merge
#   freecode tasks diff <id>
#   freecode tasks merge <id>
#   grep docstring <project>/geom.py
#   ls <project>/.freecode/worktrees/    # should be empty now
#   git -C <project> log --oneline -2     # --no-ff merge commit visible
#   PASS = diff shows the patch; merge prints "Merged"; change now in the main
#   checkout; worktree cleaned up; the isolated work is one unit in history.
#
# §9 Exit the TUI
#   (Ctrl-C / Ctrl-D / /exit inside the TUI)
#   PASS = clean exit (exit 0), no hang, no uncaught exception.
#
# §10 Restart + session resume
#   freecode                                # same project dir
#   freecode run --continue "Reply with exactly: resumed"
#   PASS = TUI restores the previous conversation; --continue prints "resumed"
#   on the SAME session id (not a new one).
#
# §11 Provider-fault fallback (recommended)
#   # add a second account + a broken one, put broken first in every pool tier:
#   freecode setup --provider deepseek-backup --base-url https://api.deepseek.com/v1 \
#       --api-key '<OTHER KEY>' --model deepseek-chat --yes
#   freecode setup --provider broken --base-url https://api.deepseek.com/v1 \
#       --api-key 'sk-invalid-key' --model deepseek-chat --yes
#   edit ~/.config/freecode/freecode.jsonc: pool tiers start with broken/deepseek-chat
#   freecode run "add a comment line to geom.py" --print-logs --log-level INFO
#   freecode routes status
#   PASS = the task succeeds on the healthy account; "routes status" shows the
#   broken account excluded (circuit open) with the reason; failover <= 3 retries.
#   FAIL = task SUSPENDED, or retries burn the full budget on the broken one.
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# Machine-judgeable segments. These are the same checks acceptance.sh runs,
# reissued here as the P0-8 subset so a single entry point exists for the
# human on the clean machine. We delegate to acceptance.sh itself: it already
# isolates XDG/FREECODE_HOME/TMPDIR under a temp prefix and covers §0 (the
# build-SHA gate), §1 (install), §3 (setup + key-file 600 + no leak), §5/§7/§8
# (run + isolation + verdict + merge) and §10 (resume). §4/§9/§10-TUI and §11
# are interactive and are NOT covered here — the human does those by hand.
# ---------------------------------------------------------------------------

printf '%s\n' "P0-8 machine segments (delegating to scripts/acceptance.sh)"
if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
  bash "$HERE/acceptance.sh"
  exit=$?
else
  printf '%s\n' "DEEPSEEK_API_KEY is not set: running in --skip-network mode"
  printf '%s\n' "(real-provider segments §3/§5/§6/§11 will be SKIP; the human"
  printf '%s\n' " still performs those steps by hand against a live key)"
  bash "$HERE/acceptance.sh" --skip-network
  exit=$?
fi

printf '\n'
printf '%s\n' "Machine segments done. Interactive steps (§4 launch, §5 dispatch,"
printf '%s\n' "§9 exit, §10 TUI resume, §11 fallback) remain for the human —"
printf '%s\n' "run 'bash $0 --steps' for the exact commands, and record each"
printf '%s\n' "result into docs/p0-8-result-template.md."
printf '%s\n' "Mark every row of that table with 'non-clean host' when this"
printf '%s\n' "ran on a development box rather than a pristine machine (P0-8-R)."
exit "$exit"
