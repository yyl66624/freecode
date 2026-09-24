# P0-1 trace samples

Recorded trace files from real `freecode run` sessions, used as test fixtures
for the `isolation-verdict.sh` runner and `verdict.test.ts`.

| File | Description | Verdict |
|---|---|---|
| `success-worktree-write.jsonl` | Subagent isolated; `edit` tool resolved and wrote to the worktree. | `OK` |
| `phenomenon-a.jsonl` | Subagent isolated; `write` tool called with an absolute path to the **shared checkout's** `geom.py`. The write landed outside the worktree. | `WRONG_CWD` |
| `phenomenon-b.jsonl` | Subagent isolated; no write tool was called at all (model read the file but did not write). | `NO_WRITE` |
| `phenomenon-b-abs-read.jsonl` | Subagent isolated; `read` tool called with an absolute path to the shared checkout. No write tool was called — a variant of phenomenon B where the model's absolute-path read is visible in the trace. | `NO_WRITE` |

## Reproducing

```bash
# Phenomenon A: the subagent's LLM context contains the shared checkout's
# absolute path (from the instruction text or a glob in the parent session).
# It passes that path to the `write` tool. The write lands in the shared
# checkout, not the worktree.

# Run a traced session against a git repo with a geom.py:
FREECODE_PROJECT=/tmp/trace-proj FREECODE_TRACE=1 FREECODE_TRACE_STDOUT=1 \
  .runtime/run-opencode.sh run --print-logs --log-level INFO --auto \
  "Use the task tool with subagent_type=coder to add a module docstring to geom.py."

# The trace file lands at:
#   $XDG_DATA_HOME/freecode/trace/<pid>.jsonl
# Copy it to trace-samples/ and run:
bash scripts/isolation-verdict.sh trace-samples/phenomenon-a.jsonl WRONG_CWD
```
