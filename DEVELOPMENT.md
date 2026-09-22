# FreeCode Development Log

Durable findings from building the fork. Commit messages carry per-change detail;
this file carries the measurements and traps that are expensive to rediscover.

## Frozen upstream

| Field | Value |
| --- | --- |
| Upstream | OpenCode (`anomalyco/opencode`) |
| Version | `1.18.32` |
| Base commit | `e027eb570ba2b6d4affa1e4da59af4701d89dac9` (local freeze commit) |
| Tag | `freecode-upstream-base` |
| Branch | `freecode-main` |
| Checkout | `opencode-dev/` |
| License | MIT |

The checkout arrived as a source archive, not a clone, so `git init` plus one
baseline commit was the only way to make every FreeCode change an auditable diff.

## Baseline environment

- `bun` was absent. A local 1.4.2 binary lives at `.runtime/bin/bun`; nothing was
  installed system-wide. The repo pins `bun@1.3.14` via `packageManager` and runs
  fine on 1.4.2.
- The official `opencode` binary at `~/.opencode/bin/opencode` is a **different,
  newer build** (v2.0.11) than this source tree (1.18.32). The source tree is the
  baseline; do not compare behaviour against the installed binary.
- Every writable path must be redirected into the workspace, or opencode writes to
  `~/.local/share/opencode`, `~/.config/opencode`, `~/.opencode`, and
  `~/.local/state/opencode`. Required: `OPENCODE_TEST_HOME`, all four `XDG_*`
  homes, and `TMPDIR`. Use `.runtime/run-opencode.sh`.
- Provider credentials live in `.runtime/secrets.env` (mode `600`, never
  committed) and are referenced from config as `{env:DEEPSEEK_API_KEY}`.
- DeepSeek (`https://api.deepseek.com/v1`) exposes `deepseek-flash` and
  `deepseek-v4-pro`, supports OpenAI-compatible tool calling, and is the first
  real provider in the pool.

## Two upstream bugs found and fixed

1. **Config directories escaped the project.** `ConfigPaths.directories` walked up
   to the filesystem root for a non-git project, because such a project reports
   `worktree === "/"` and that value was used as the walk's stop marker. It then
   picked up unrelated ancestor `.opencode` directories. Fix: treat `"/"` as "no
   boundary" and stop at the project directory.
2. **Startup aborted on an unwritable config directory.**
   `Config.ensureGitignore` guarded only a typed `PermissionDenied` reason, so any
   other failure (a root-owned or read-only directory) propagated through
   `Effect.orDie` and killed the process. Fix: make the write best-effort with
   `Effect.catchCause`, since it only keeps a config directory tidy.

## Laya bridge

- Persistent Python subprocess speaking newline-delimited JSON over
  stdin/stdout. No HTTP, no port, no auth, dies with the parent.
- The checkpoint loads once and stays resident. **Measured: first request ~24.8 s
  (includes the MPS load), every later request ~250–310 ms.**
- The vendored SDK is found by walking up for `laya-main/`, overridable with
  `FREECODE_LAYA_SDK`.
- `huggingface_hub` freezes its cache location at import time, so
  `FREECODE_LAYA_CACHE` must be applied **before** `laya` is imported. That is
  what `router/cache.py` exists for.
- Checkpoint `convaiinnovations/laya`, subfolder `typed-decisions`:
  `max_len: 1024`, `head_max_len: 256`, encoder `answerdotai/ModernBERT-large`,
  bundle ~807 MB. A six-question pass costs ~381 input tokens.

### Laya is out of distribution on FreeCode's question set

Measured on the shipped checkpoint:

| Input | Confidence |
| --- | --- |
| Laya's own trained presets (e.g. `customer_service`) | 0.38 – 0.79 |
| FreeCode's custom routing questions | 0.019 – 0.29 |

The low confidence is an honest signal, not a defect, and it is the single most
important fact about this integration. The consequence is the routing policy:
Laya is **evidence, not a verdict**.

- Deterministic rules set the baseline class and tier.
- Laya's class is trusted only when it agrees with the rules.
- Escalation is at most one step, capped at the `strong` tier, and can only raise
  the tier, never lower it.
- `needsReview` has a floor: classes that change code are always reviewed.
- `parallelizable` needs both the model's consent and a read-only class, because
  OpenCode's permission system is not a sandbox.
- Every failure mode (missing interpreter, missing checkpoint, crash, timeout)
  degrades to rules. Routing must never fail a user's task.

Follow-up worth doing: fine-tune or prompt-tune Laya on software-engineering
traces, or restrict routing questions to shapes the checkpoint already handles
well, and re-measure. Until then, treat the tier as a conservative floor.

## The model resolution seam

- `Provider.parseModel("auto")` yields the sentinel `freecode/auto`.
- `Provider.getModel` intercepts the sentinel and calls `FreeCodeRoute.auto`. This
  is the only place a capability decision becomes a concrete model, so no call
  site can bypass routing.
- The Task tool round-trips a subagent's model through session state and arrives
  as `freecode` with an **empty** model id. The sentinel check accepts both shapes.
- A sentinel that reaches the provider with no routing context — a subagent
  resolving in a fiber that outlived its parent turn — resolves to the instance
  default model rather than failing as "model not found: `freecode/`".
- `freecode.pool` maps a tier to a `provider/model` list. An unconfigured tier
  falls back to the session default instead of guessing.

### TypeScript type-cycle trap

Wiring the seam created a cycle: `getModel` → `route.auto` → registry callback →
`lookup` (defined inside `getModel`). TypeScript resolved it to `any`, silently
switching off type checking exactly where routing is wired in, and surfaced as a
misleading `TS2488: Type 'ResolvedModel' must have a Symbol.iterator` at
`yield* routed`.

What actually fixed it:

1. `route.ts` must not import `Provider.Model`. It declares a minimal structural
   `ResolvedModel { id, providerID }`, which removes the signature dependency on
   `Provider.getModel`.
2. `getModel` must keep an **explicit** return-type annotation. Leaving it
   inferred re-creates the cycle.
3. The internal lookup helper must **not** be annotated. Annotating it pinned it
   to a type the provider record does not literally satisfy; its inferred type is
   the correct one.
4. `auto` wraps its body in `Effect.suspend` so its return type does not depend on
   the generator's inference.

If a routed model ever resolves to `any` again, suspect this cycle first.

## Verified acceptance

A `coder` subagent declaring `model: auto` and `tier: standard`, driven from a real
project, logged:

```
freecode route agent=coder mode=auto tier=strong confidence=0.0546 source=laya
  reason="rules=docs/standard laya=docs/fast agree=True confidence=0.055"
```

and then ran on the model `freecode.pool.strong` names and wrote the requested
change to disk. The critical chain is complete:

```
opencode runs → freecode binary → model:auto → TS ↔ Laya JSONL → tier → model
```

## Regression check

`bun test test/config test/provider` from `packages/opencode`:

| State | Result |
| --- | --- |
| Frozen baseline (`e027eb5`, no FreeCode changes) | 939 pass, 3 skip, **5 fail** |
| Current `freecode-main` | 939 pass, 3 skip, **5 fail** |

Identical counts, so the five failures ship with the upstream snapshot and are not
regressions:

- creates global jsonc config with schema when no global configs exist
- native project MCP servers override inherited V1 disabled state
- jsonc overrides json in the same directory
- project config can override MCP server enabled status
- MCP config deep merges preserving base config properties

Checking out the baseline commit directly does **not** work for this comparison:
bun cannot resolve the workspace from that state and reports ~185 spurious
failures. Stash the working tree, run the tests, then restore instead.

## Not started

Resource scheduler with scoring, multi-account provider profiles, quota and health
tracking, circuit breaking, failure classification with automatic fallback,
worktree isolation for concurrent writers, packaging.

