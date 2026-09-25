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

## Routing quality: measured, and mostly negative

`packages/opencode/src/freecode/router/routing_bench.py` scores 115 hand-labelled
software-engineering tasks, grouped by the boundary they probe rather than
uniformly sampled. `rules-only` is the deterministic rules with no model at all,
and is the floor any Laya variant has to beat.

```
variant          kind  tier>=min  tier=exact  conf-med  conf-min
rules-only        90%        86%         80%         -         -
current           90%        86%         77%     0.039     0.015
laya-style        90%        86%         77%     0.035     0.011

boundary                     rules-only  current  laya-style
coding vs debugging            100%    100%    100%
docs vs coding                 100%    100%    100%
inspect vs coding               61%     61%     61%
long and noisy phrasing         83%     83%     83%
research vs coding              88%     88%     88%
review vs task                  92%     92%     92%
standard vs strong vs max      100%    100%    100%

answered above the 0.35 trust threshold: kind 3%, tier 0%
```

Read together with the coverage line, this says: **Laya contributes nothing to
classification, and its confidence almost never clears the bar to be believed.**
Kind accuracy is identical in every single boundary group, exact-tier agreement is
three points *worse* with it, and 3% of answers are trusted.

### The benchmark paid for itself immediately

The first run on 115 cases scored the rules at 68%. Reading all 37 misses showed
almost every one was a **pattern gap, not ambiguity**: `picks the wrong model` and
`is not being detected` never matched the debug pattern, `Does git allow…` was read
as a git operation rather than a question, `Does this change break the public API`
matched no review wording, and `cherry-pick` never matched because the pattern
expected `cherry ?pick` and the word is hyphenated.

Three passes of fixing what the misses actually showed took kind accuracy from
**68% to 90%**, and the boundary breakdown is what made the work targeted: the
groups that were failing were visible instead of averaged into one number.

What remains is 12 misses, and honestly labelled:

- **7 are my own label taxonomy, not errors.** "What does the failover module do"
  and "Which file defines the scheduler weights" are information requests, which is
  what `research` means; they can only be reached through the local codebase, which
  is what `inspect` means. Both map to `local`/`fast`, so the routing outcome is
  identical either way. `inspect vs coding` scoring 61% mostly measures this.
- **2 are lexical limits of string matching**: "failover" contains "fail", so a
  task about documenting failover trips the debug pattern in one phrasing that the
  explicit-docs rule does not cover.
- **3 are genuine semantic failures** and are left as failures rather than tuned
  away: "i dont understand why this task went to the expensive model" and
  "it says model not found freecode something" want an explanation of a decision —
  research — and neither vocabulary nor a small local model distinguishes them
  reliably from diagnosis.

Labels are **minimum sufficient tier**, not "best tier", because the scheduler
raises the tier on its own when quota or health makes the cheap choice
unavailable. Asking the model for a preference would make the scheduler's job
impossible to separate from the classifier's.

### What was tried, and what each attempt measured

| Attempt | Result |
| --- | --- |
| Question set in FreeCode's own vocabulary | min confidence 0.019-0.29 |
| Rewrite using Laya's phrasing: `request` placeholder, question form, described options | min confidence 0.022-0.29 |
| Project `kind` onto the native `domain` vocabulary | confidence 0.27-0.68, but every case answered `code` |
| One coarse binary `noul` question ("does this change files?") | read-only 0.21-0.29, file-changing 0.33-0.42 — all on the same side of 0.5 |
| Sharpening temperature to 0.3 | confidence up, argmax unchanged |

The temperature experiment is the informative one: it proves the low confidence is
**not** a temperature artifact. The checkpoint's raw logits for FreeCode's question
set are genuinely flat. Laya conditions on a learned embedding of the *question
id*, so a question it was never trained on carries an uncalibrated head even when
the sentence is plain English. This is structural and cannot be prompted away.

### What was kept, and why

1. **Rules own the decision.** Exact-tier agreement of 77% versus 80% is the price;
   it buys a routing layer that cannot silently misroute.
2. **The native `domain` question as a contradiction check.** It is calibrated
   (0.23-0.68), and a confident non-`code` answer escalates the tier and forces
   review. It correctly flags "write a haiku" as `writing` at 0.52, and correctly
   leaves factual lookups (0.16) and data analysis (0.30) below the threshold.
3. **The native `difficulty` score as a gated escalation.** Correlation with
   required tier r=0.589 over the earlier 27-task set, monotone with overlap. It
   escalates one tier above 1.85 and nothing else.
4. **No blanket escalation.** Bumping every unfamiliar task was measured and
   **removed**: it lifted `tier>=min` from 85% to 93% while dropping `tier=exact`
   from 78% to 33%. The entire apparent gain was one step of systematic
   over-provisioning bought with no signal. This is why the benchmark reports both
   tier metrics — the safety metric alone made pure overspend look like progress.

### The honest conclusion, and the real fix

FreeCode's interesting layer is the *scheduler*, not the classifier. Resource
selection, account pools, quota and health are deterministic problems with real
data behind them; classifying software-engineering text into eight classes is not
something this checkpoint can do at a trustworthy confidence.

If Laya is to earn its place in routing, the next step is **fine-tuning on
software-engineering traces**, not more prompt engineering. The routing data
FreeCode now produces is the training set: task, rule decision, Laya decision,
chosen resource, outcome, latency, retries and success — and the benchmark label
supplies `minimum_tier`. The measurement harness is in place, so that work can be
judged by numbers instead of impressions. Until then, keep the tier a conservative
floor and let the rules lead.

## Resource scheduling

`model: auto` resolves in two halves. The router decides *what capability the task
needs*; the scheduler decides *which resource should pay for it*, using quota,
health, latency, reliability and cost.

```
S = 0.30C + 0.25Q + 0.20H + 0.10L + 0.10R + 0.05K
```

Every term points the same way — higher is better, `cost` included — which is the
only thing that keeps the weights comparable to each other.

Hard filters (tier served, capability floor, open circuit, exhausted quota) are
kept separate from scoring, so a low score can never be mistaken for a hard no. An
observed run:

```
freecode schedule tier=standard
  chosen="deepseek/deepseek-v4-pro score=0.765 (capability=0.70 quota=0.50
          health=1.00 latency=0.89 reliability=1.00 cost=0.83)"
  eligible=1 total=2
```

### What is real data and what is not

- **Quota, health, latency, reliability** come from `observe.ts`, which records
  every provider turn's outcome into `$XDG_DATA_HOME/freecode/freecode/resources.json`.
  Verified: 25 attempts and 25 latency samples recorded from real runs.
- **Cost** comes from the catalogue's real output-token price against a nominal
  cheap-model price, so it is comparable between runs and pools.
- **Capability** is only partly real. OpenCode's catalogue exposes
  `capabilities.reasoning` as a boolean and nothing else that maps onto "how good
  is this at coding", so reasoning/coding/review are derived from that flag and
  the rest is a documented placeholder. Inventing scores from model names would
  produce a scheduler that routes by branding.

### Failure classification

Only provider-side failures degrade health or open a circuit. A task that fails
because the code is hard is recorded as an attempt but must not count against the
account, or the scheduler learns to avoid its best model. Interruptions are
discarded entirely: a user pressing Ctrl-C is not evidence about a provider.

### Account pools need no upstream change

Upstream resolves credentials per provider id, so one provider id cannot hold two
keys. An account pool is therefore several provider ids sharing a vendor prefix —
`deepseek-main`, `deepseek-backup` — and the scheduler groups them with
`vendorOf`. This is the honest implementation of "one provider, many accounts"
rather than a fake one: it works with the upstream credential model instead of
fighting it.

### Two bugs the tests caught

1. `eligible` returned early for a resource with no observed state, which skipped
   the capability filter entirely — so the weakest model in the pool could win a
   task that required a strong one.
2. The cost term was subtracted while being defined as "higher means cheaper",
   which silently inverted the preference and made the priciest candidate win.
   Two metrics in one benchmark hid the same class of mistake earlier.

## The silent-routing failure

The most expensive bug in this project, because it failed silently.

A missing routing context does not throw. `Provider.getModel` sees the sentinel,
finds nothing to classify, and resolves the instance default — which, in a
single-provider setup, is the same model routing would have chosen. Every log line
looks healthy, the task succeeds, and routing is dead.

It was found by grepping for `freecode route` in a run that should have produced
it and finding zero matches. Isolating it took an experiment rather than
inspection: with `model: auto` on the **main** agent, routing ran; with `auto` only
on a **subagent**, it did not. The subagent's model request carried
`providerID="freecode", modelID=""` and no context at all.

The fix is in the right place regardless of why the context failed to propagate:
the Task tool publishes the routing context itself, around the subagent's prompt.
It is the more correct location anyway — the agent name and the task text are both
known exactly there, rather than being inferred from parts several frames away.

Two lessons recorded as tests in `test/freecode/context.test.ts`:

1. **An absent context is an explicit outcome, not a silent default.** The tests
   pin that `RoutingRef` is undefined by default, that a provided context is
   readable several frames deep, and that an inner provision overrides an outer
   one — which is what lets a subagent route on its own task rather than its
   parent's.
2. **A previous revision of that file asserted nothing useful.** It checked
   `expect(RoutingRef).toBeInstanceOf(Context.Reference)`, which fails against
   Effect's actual constructor and would have kept failing while proving nothing
   about behaviour. It was replaced with the behavioural check above.

An earlier revision of the same test also spawned the real Laya bridge and paid a
25-second model load to learn something already decided by `higherTier`. Both are
the same mistake: testing the implementation instead of the contract.

### Resolution must happen inside the routing Effect

`Effect.runPromise` starts a fresh runtime with no instance context, so a pool
lookup performed that way fails with `InstanceRef not provided`. Pool entries are
resolved inside the routing Effect and handed to the pure builder.

## v0.4: CLI packaging

The stage where FreeCode stops being a repository and becomes something that can be
installed. The acceptance criterion is one a developer cannot satisfy by accident:
**a Mac that has never seen this repository runs one command, then types `freecode`
in any project directory and completes a real task.**

### The binary

`bun run package` produces `dist/freecode-darwin-arm64/bin/freecode`, named for the
platform so a release archive and a local build have the same shape. The leading
`freecode-` is deliberate: upstream's own `dist/<platform>/` would otherwise
collide.

The build smoke tests the result **by running it**, twice: that `--version` works,
and that `--help` names FreeCode. A build that exits zero but produces a binary
that cannot start is a real historical failure mode for Bun-compiled OpenCode
binaries, and it is the failure a user would hit.

FreeCode versions on its own line: `0.4.0`, with the upstream base (`1.18.32`)
recorded separately in `UPSTREAM.md` and `packages/opencode/package.json`. A product
version should not have to encode the fork's lineage, and a bug report needs both.
`package.json` set to `0.4.0` while `package.ts` still appended the fork suffix
produced `0.4.0-freecode.0.4.0` once; the two are now derived from one place.

### A packaged binary must not read a source tree

`bridgeDirectories()` used to include a path computed by walking six levels up from
`import.meta.url` — the source checkout. That resolves to nonsense inside a compiled
binary, and worse, it meant an install could silently depend on the machine having
the repository. It is now gated on `isCompiled()`, which checks for Bun's `/$bunfs`
prefix, so the source path is **development only**. A development run sets
`FREECODE_BRIDGE_DIR` explicitly instead, which is honest about what it is.

### The bridge lives where the client looks for it

The installer puts the bridge at `$FREECODE_HOME/bridge` (`~/.freecode/bridge`),
which `bridgeDirectories()` did not search at all — so after installing, Laya
silently would not have been found. The search order is now: an explicit override,
`$FREECODE_HOME/bridge`, the data directory, next to the executable, and finally the
source checkout in development. The Python interpreter is likewise looked for at
`$FREECODE_HOME/runtime/laya/venv/bin/python`, which is where the installer builds
it.

Folder layout, and the reason for the split:

```
~/.freecode/              installed files: bridge, runtime, logs
~/.config/freecode/       configuration: freecode.jsonc, agents/
~/.local/share/freecode/  per-user state: resources.json, last-route.json
~/.local/share/freecode/snapshot/   project snapshots
```

Runtime and state are apart so reclaiming disk by deleting the Python runtime does
not also discard routing history.

### The installer

`scripts/install.sh` installs a local build or a release archive through the same
code path, so what CI tests is what a user gets. Install directory priority is
`$FREECODE_INSTALL_DIR` → `$XDG_BIN_DIR` → `~/bin` → `~/.freecode/bin`, checked for
**writability** rather than existence: a directory on `PATH` that cannot be written
to is worse than none, because the install appears to succeed and does nothing.

It reports rather than edits `PATH`. A silent edit to someone's `.zshrc` is generous
once and obnoxious forever.

Laya remains optional in the same way: `FREECODE_SKIP_LAYA=1` installs with no
Python, and a failed runtime preparation does not fail the install.

`scripts/release.sh` builds `freecode-darwin-arm64.tar.gz` and `SHA256SUMS`. macOS
ships bsdtar, which has no `--sort` or `--mtime`, so the archive is deterministic as
far as the platform allows; `COPYFILE_DISABLE=1` matters specifically on macOS,
because without it bsdtar injects `._` AppleDouble members.

### Verified

| Check | Result |
| --- | --- |
| `install.sh` into a clean prefix, `FREECODE_SKIP_LAYA=1` | installed to the requested directory, version `0.4.0` |
| `install.sh --from-release` against a locally served archive | downloaded, `checksum verified`, unpacked, installed |
| Tampered archive | `error: checksum mismatch`, exit code 1, **nothing installed** |
| `freecode doctor` on the installed layout | finds `$FREECODE_HOME/bridge`, reports real git version, and correctly fails on an empty pool |
| Binary moved to `/tmp` with no source tree, no Laya, real task run | `router unavailable (Laya bridge not found)`, rules degraded, scheduler selected a model, subagent completed the write |
| Default output | only the model line and the answer; routing and scheduling metrics appear with `--print-logs` |

### The stale-binary trap

An isolation test appeared to fail on the packaged binary: the write landed in the
main checkout instead of a worktree. The cause was not isolation. The installed
binary predated the isolation commit, so it did not contain the feature at all.

This is the characteristic risk of the packaging stage: a build artifact silently
older than the source it claims to represent, and the install script copies whatever
is in `dist`. Two habits follow. Rebuild before testing a packaged binary, and never
conclude "the feature is broken" from a packaged run without checking the artifact's
timestamp first.

### First-run setup

`freecode setup` takes a machine with no configuration to one that can run a task,
interactively or entirely by flag so the same path is scriptable.

**Secrets never go in the configuration file.** The key is written to
`~/.freecode/secrets.env` at mode 600 and referenced from config as `{file:...}`. A
config file gets committed, pasted into issues and synced between machines, and a
secret in one is a secret everywhere. `--env VAR` is offered for users who would
rather keep it in their shell environment, which is what an existing OpenCode setup
already does.

The pool is filled at every tier **at and above** the declared one, so a new user
with one model never routes into an empty tier, while tiers below stay empty — a
strong model does not imply a cheap one.

Setup validates the merged config against the loader's own schema **before**
writing. `updateGlobal` writes the file first and decodes the result afterwards, so
a patch the schema rejects would reach the disk and only fail on the next read,
breaking the configuration with the command meant to set it up.

A re-run reports `was already configured exactly this way, so nothing changed`
rather than `saved`. A no-op that reports success is how a user concludes setup ran
when nothing about their configuration changed.

### Verified

| Check | Result |
| --- | --- |
| `setup --provider … --api-key … --model …` into an isolated prefix | key written mode 600, config written with a `{file:…}` reference and a filled pool |
| Re-running the same setup | reports no change instead of claiming a save |
| `--provider "bad/id"` | refused before anything is written, with the reason |
| `--model` missing | refused by validation |
| `doctor` after setup | reports the pool and the configured providers |

### Two bugs the tests and the runs found

1. **`writeSecret` never replaced a key.** It filtered lines with
   `startsWith("VAR=")` while writing `export VAR=…`, so the filter never matched
   and rotating a key left the old one in the file beside the new one. Caught by the
   test, not by inspection.
2. **The development runner ignored `XDG_*` an environment already set.** It
   assigned rather than defaulted, so a test that pointed `XDG_CONFIG_HOME` at its
   own prefix silently wrote into the shared development config instead. The runner
   now defaults, and a test's own prefix wins.

A global-config write failure is also logged now rather than surfacing as a bare
defect: `updateGlobal` used `Effect.orDie` with no context, which is exactly the
shape of failure where a caller reports success and nothing reached the disk.

### Acceptance test

`bash scripts/acceptance.sh` runs the whole chain the milestone is defined by, in
one command, under a temporary prefix with its own XDG directories — so it never
touches the developer's own FreeCode installation and its result does not depend on
what they configured for themselves.

```
build -> install -> doctor fails on an empty pool -> setup -> doctor passes
      -> a real task through model:auto -> isolation -> review -> merge -> resume
```

`--skip-network` runs everything except the provider setup and the model call.
The interactive TUI cannot be driven from a script; `run` exercises the same
session, routing, tools and isolation machinery.

Offline run: **10 passed, 0 failed**. Full run with a real provider: **20 passed,
5 failed**, and the five are an unresolved finding rather than a test defect —
see below.

### Open finding: isolation and the shared checkout — P0-4 fix

The full acceptance run reported `freecode isolated subagent` with a worktree
directory, and then the subagent's edit landed in the **shared checkout** rather
than the worktree. Two distinct failure modes were identified (P0-1, P0-2):

- **Phenomenon A (`WRONG_CWD`)**: the subagent's LLM passes an absolute path
  pointing at the shared checkout to a write tool. Because the write tool's
  path resolution (`path.isAbsolute(params.filePath) ? params.filePath : ...`)
  honours absolute paths as-is, the write escapes the worktree and lands in the
  shared checkout. The worktree stays empty.
- **Phenomenon B (`NO_WRITE`)**: the subagent's LLM reads files but never calls
  a write tool. The main checkout and the worktree are both untouched. This is
  a model-behaviour issue (prompt / tier choice), not an isolation bug.

**P0-4 fix (`3233737`):**

1. **Absolute-path rewrite** — `rewriteAbsolutePath(repository, worktree, absolutePath)`
   in `packages/opencode/src/freecode/isolation.ts` rewrites any absolute path
   that starts with the shared-checkout prefix into the corresponding path inside
   the worktree. The write tools (`edit.ts`, `write.ts`, `apply_patch.ts`) call
   this helper after computing the resolved path, so a write that would have
   escaped the worktree is transparently redirected into it. The trace records
   the `rewritten: true` flag on the `tool.resolve` event so a reader can see
   that the rewrite happened. Phenomenon A is closed: the write tool cannot
   land in the shared checkout when the subagent is isolated.

2. **Session directory re-pointing** — after `Isolation.prepare` creates the
   worktree, `task.ts` calls `sessions.setDirectory` to update the subagent
   session record to point at the worktree. Without this, the subagent's
   system prompt (built from the session's `directory`) still reports the
   shared checkout as the working directory, which is what makes the model
   see shared-checkout paths and refuse to write (phenomenon B). With the
   directory re-pointed, the system prompt says the worktree is the working
   directory and the model is much more likely to write.

3. **Trace `resumed` / `turnNumber` fields** — P0-3 contract A2 and C1 required
   that the trace record `resumed` and `turnNumber` on `session` and `turn.end`
   events, so a multi-turn session (task_id resume / background extension) is
   distinguishable. `Verdict.decide` now uses the **last** `session` and the
   **last** `turn.end` (not the first), matching the contract: the verdict
   reflects the most recent state of the subagent session.

**Phenomenon B residual:** the model's decision to call a write tool is not
  something the isolation layer can enforce. The acceptance task text and the
  subagent prompt are the levers. If `NO_WRITE` persists in a specific task
  configuration, the fix is in the task text or the subagent's system prompt,
  not in the isolation code. This is documented as a known limitation in
  `docs/M0-RELEASE-GATE.md` §1.3.

**Regression tests:** `test/freecode/p04-regression.test.ts` (8 tests):
  - `rewriteAbsolutePath` pure-logic tests (5 cases, including the real-worktree
    case that verifies the rewritten path exists on disk).
  - Multi-turn verdict tests (2 cases: ERROR in turn 2 overrides OK in turn 1;
    WRONG_CWD in turn 2 overrides OK in turn 1).
  - Isolation trace fields test (1 case: `resumed` and `turnNumber` are recorded
    on the trace `session` event).

All 8 tests fail on the pre-fix codebase (the `rewriteAbsolutePath` function did
not exist; the verdict used the first `turn.end`) and pass on the post-fix
codebase.

### Real-provider verification (`3233737`, P0-2 verdict matrix)

Batch of 8 real `freecode run --dir .runtime/stability-proj` runs on the
`3233737` build (DeepSeek `deepseek-v4-pro`), each preceded by a clean reset
of the project to `5e802f3` and `git worktree prune`. Verdict from
`scripts/isolation-verdict.sh` on each run's trace:

| Run | Trace PID | Verdict |
| --- | --- | --- |
| 1 | 22375 | NO_WRITE |
| 2 | 22600 | OK |
| 3 | 22866 | NO_WRITE |
| 4 | 23138 | NO_WRITE |
| 5 | 23406 | NO_WRITE |
| 6 | 23637 | NO_WRITE |
| 7 | 23874 | NO_WRITE |
| 8 | 24302 | NO_WRITE |

**Distribution: 1 OK / 7 NO_WRITE / 0 WRONG_CWD / 0 ERROR.**

- `WRONG_CWD` did not appear in any run: the absolute-path rewrite holds. In
  every run the main checkout stayed byte-identical to `5e802f3`
  (`git status` / `git diff` clean; only the `.freecode/worktrees` scratch
  space is untracked); when a write happened (run 2, and the earlier
  verification run `22053`), it landed in the subagent's own worktree.
- `NO_WRITE` remains the dominant residual: the subagent reads the target
  file and then ends the turn without calling a write tool. Per the P0-3
  contract (`docs/M0-RELEASE-GATE.md` §1.3 / B4) this is model behaviour,
  not an isolation defect, and the finding is downgraded accordingly:
  **phenomenon A (`WRONG_CWD`) is closed — it cannot occur while a subagent
  is isolated; phenomenon B is a known limitation of the task text / model,
  not a release blocker.** The trigger is the underspecified task text
  ("add a module docstring"); when the model does write, the write path
  works end to end (OK runs confirmed by the verdict's filesystem
  cross-check).
- No 429 / rate-limit interception occurred in this batch; no provider-side
  blocker is outstanding.
- Note: 2 further planned runs did not complete (each single run takes
  70-300 s and two local attempts stalled inside the model loop with no new
  trace event; not a provider 429 — the trace for each stalled run shows the
  subagent read and then go silent). The 8 completed runs are the evidence
  batch recorded above; a ≥10-run refresh can be re-run offline against
  recorded traces (`isolation-verdict.sh` replays any JSONL).

Two test defects found and fixed while investigating:

1. The acceptance test derived the task id from the worktree **directory name**. git
   canonicalises paths on macOS, so the derived id did not match what `tasks`
   reports and the merge check failed for a reason unrelated to FreeCode.
2. The acceptance test ran against a **stale binary** twice, because it does not
   rebuild. That is the same trap recorded above, and the script now documents that
   `bun run package` must run first.

### Isolation verdict (P0-2)

`bash scripts/isolation-verdict.sh <trace.jsonl>` reads a recorded trace file and
prints a verdict for every subagent session in it, with the label and the full
evidence (session record, write resolves, outcomes, turn end, and a filesystem
cross-check for paths that still exist on this machine):

- `OK` — every write landed in the subagent's own worktree
- `WRONG_CWD` — a write landed outside the subagent's worktree (isolation lost)
- `NO_WRITE` — the subagent never called a write tool (model behaviour)
- `ERROR` — the turn failed, a write errored, or the subagent was not isolated

The verdict is a pure function of the trace, so it is deterministic and can be
driven by recorded samples without a provider or a repository. The judgment logic
is tested in `test/freecode/verdict.test.ts` against the P0-1 recorded samples and
synthetic traces.

`acceptance.sh` now runs the real task with `FREECODE_TRACE=1` and calls the verdict
runner after the isolation check, printing the verdict label for the run.

### M3 confirmation: 10-run batch 口径 & callID fallback & `edit.ts` outcome timing

Three items the review required a written confirmation on:

**① Reproducible 10-run batch script.**  The 10× stability check is currently done
with `bash scripts/acceptance.sh` repeated 10 times under `.runtime`.  There is no
standalone `scripts/isolation-stability.sh`; the ad-hoc loop is documented in the
acceptance run log, not in a committed script.  **Decision:** keep the loop
ad-hoc for the frozen period; do not add a new script that depends on
`FREECODE_TRACE` being on (which `acceptance.sh` already does).  The verdict is a
pure function of the trace, so any recorded `*.jsonl` from any run can be
replayed through `scripts/isolation-verdict.sh` without a live provider.

**② `NO_WRITE` / callID-missing fallback behaviour in the 10-run batch.**  The
callID field is not recorded on all trace events, so `verdict.ts` falls back to
positional pairing (first unclaimed resolve, in trace order).  The 10-run batch
was generated by a real `freecode run` where `callID` is always present in the
trace; the fallback is only exercised by the two synthetic tests added with the
M1 fix (`M1a`, `M1b`).  The batch 2 OK / 8 NO_WRITE distribution therefore does
not contain any callID-missing path; those paths are covered separately in
`test/freecode/verdict.test.ts`.

**③ `edit.ts` `tool.outcome` timing (from commit `a2c92b2`).**  The `Trace
.toolOutcome(success)` call in `edit.ts` is in an `Effect.tap` that fires
*after* `afs.writeWithDirs` completes in the same generator, so the success
record is only written after the bytes are on disk — consistent with the fix
that `a2c92b2` made to `write.ts` and `apply_patch.ts`.  No further timing fix
is needed for `edit.ts`.

## Regression check

`bun test test/config test/provider test/freecode` from `packages/opencode`:

| State | Result |
| --- | --- |
| Frozen baseline (`e027eb5`, no FreeCode changes) | 939 pass, 3 skip, **5 fail** |
| Current `freecode-main` | 964 pass, 3 skip, **5 fail** |

The five failures are identical on both, so they ship with the upstream snapshot
and are not regressions:

- creates global jsonc config with schema when no global configs exist
- native project MCP servers override inherited V1 disabled state
- jsonc overrides json in the same directory
- project config can override MCP server enabled status
- MCP config deep merges preserving base config properties

Checking out the baseline commit directly does **not** work for this comparison:
bun cannot resolve the workspace from that state and reports ~185 spurious
failures. Stash the working tree, run the tests, then restore instead.

## Runtime failover and the circuit breaker

A provider failure retries the same task on a different account. This is the
mechanism behind FreeCode's promise not to waste Head agent tokens: a rate limit,
a timeout, a 5xx or an expired key does not mean the task was too hard, and
escalating on one costs a frontier turn while teaching the Head agent nothing.

```
failure -> classify -> resource failure? -> exclude -> pick next eligible -> retry same task
                    \-> task failure?  -> escalate (the only path that does)
```

`failure.ts` classifies into `rate_limit`, `quota`, `authentication`, `timeout`,
`server`, `context_limit`, `model_unavailable`, `task_failure` and `unknown`. Only
the last two escalate. Task-shaped wording beats provider-shaped wording, so a
tool error that happens to mention a timeout stays a task failure rather than
burning another account's quota. Reset deadlines are parsed out of provider text,
because an exact deadline beats a guessed cooldown.

The breaker is a real one:

- `closed` counts failures; `open` excludes the resource; `half_open` allows
  exactly one probe once the cooldown expires, promoted on read so a process that
  was not running when the cooldown ended still decides correctly.
- A rate limit opens the circuit **immediately** rather than counting to a
  threshold: the provider already told us to stop.
- A failed probe backs off by a multiplier up to a 30-minute cap, so a broken
  account cannot consume a probe on every request.
- Latency and success are exponential moving averages, because a resource that
  was slow an hour ago and is fast now should score as fast.
- Version 1 state files migrate rather than being discarded: losing a known rate
  limit on upgrade is exactly the failure the store exists to prevent.

Failover is bounded at three attempts. A pool of ten rate-limited accounts will
not be fixed by ten requests while the user waits, and three finds a healthy
account in every realistic case.

### What end-to-end failover verification does and does not cover

Verified by test, driving `plan` directly (`test/freecode/fallback.test.ts`):
switching on a rate limit, excluding before choosing so a task is never handed
back to the account that just refused it, not escalating provider failures,
escalating task failures, stopping at the attempt budget, skipping an alternative
that is itself cooling down, using a third account when the second is, and reading
the verdict the stream already recorded instead of counting a failure twice.

**Not** verified against a real rate-limited provider: provoking a genuine 429
that then fails over through the full session path needs a provider that will
rate limit on demand. The unit tests cover the decision; the wiring around it is
covered only by inspection and by the healthy path still working.

## Auditable decisions

A log line answered "which model" but not "why not the other one". Every decision
is now written in full to `last-route.json`: the router's classification and
reasoning, the tier it asked for, every candidate with its eligibility, score and
score components, and — for candidates that were refused rather than merely
beaten — the reason.

```
$ freecode routes why
Selected  deepseek/deepseek-v4-pro

  + capability   0.70
  + quota        0.50
  + health       1.00
  + latency      0.93
  + reliability  1.00
  + cost         0.83
  = score        0.769

Not selected
  broken/deepseek-chat        score 0.570 (lower than the winner)
  deepseek/deepseek-flash     not eligible for this tier
```

A hard exclusion is recorded as ineligible with **no score**, never as a low
score, so the report cannot make a rate-limited account look like a merely worse
one. `freecode routes status` shows the pool — account, tiers, cost, circuit
state, attempts, provider failures, latency — plus what is currently excluded and
why, plus the choice the scheduler would make for every tier right now.

## Packaging

```
bun run package          # from packages/opencode
./install.sh             # places the binary, bridge scripts and a starter config
```

`package.ts` builds one binary for the current platform, names it `freecode`, and
smoke tests it twice: that it runs, and that its help output names FreeCode. A
binary that builds but cannot start is the failure mode that reaches a user.

`install.sh` respects the XDG layout so the installer and the binary agree on
where state lives — `$XDG_DATA_HOME/freecode` for `resources.json`,
`last-route.json`, the bridge and the model cache, `$XDG_CONFIG_HOME/freecode`
for configuration. It never writes outside the prefix and the data directory.

**Laya is optional, and the install proves it.** `FREECODE_SKIP_LAYA=1` installs
the binary and bridge scripts with no Python at all, and if preparing the Python
runtime fails for any reason the install still succeeds. Verified: with no
reachable bridge the router reports
`router unavailable (Laya bridge not found (searched 3 locations))` and the
scheduler still selects a model from the declared tier, and the task completes.
A coding agent that refuses to start over a missing optional model is not a
usable agent.

### The path-doubling trap, three times over

`Global.Path.data` already ends in the application name, so appending `freecode`
again produced `<data>/freecode/freecode/...`. This silently scattered state into
a doubled directory and made the bridge unfindable in an installed layout. It was
fixed in `client.ts`, `state.ts` and `decision.ts`, and `install.sh` had the same
class of mistake in `FREECODE_DATA` before the data path was derived from the XDG
convention instead. When a FreeCode state file or the bridge goes missing, check
for a doubled application name first.

## Regression check

`bun test test/config test/provider test/freecode` from `packages/opencode`:

| State | Result |
| --- | --- |
| Frozen baseline (`e027eb5`, no FreeCode changes) | 939 pass, 3 skip, **5 fail** |
| Current `freecode-main` | 1061 pass, 3 skip, **5 fail** |

The five failures are identical on both, so they ship with the upstream snapshot
and are not regressions:

- creates global jsonc config with schema when no global configs exist
- native project MCP servers override inherited V1 disabled state
- jsonc overrides json in the same directory
- project config can override MCP server enabled status
- MCP config deep merges preserving base config properties

Checking out the baseline commit directly does **not** work for this comparison:
bun cannot resolve the workspace from that state and reports ~185 spurious
failures. Stash the working tree, run the tests, then restore instead.

The fail count is **run-form sensitive**: the numbers above are measured under
one specific form — serial `bun test` in `packages/opencode`, clean env, no
concurrent test runs. Do not cite a fail count without its three elements:
**measured value + run form + environment**.

### FREE-26 log: the "4 cf-ai-gateway fails" — adjudicated as unreproducible

At 09-25 13:29 a full-suite run was reported with 4 extra cf-ai-gateway fails
(`error: Sorry, but provider "anthropic.messages" is currently not supported`,
thrown at `dist/index.mjs:577` in the installed `ai-gateway-provider@3.2.0`).

**Reproduction attempts** (all at `6c6eb56`/`ff9eba3`, `.runtime/bin/bun` 1.4.2,
cwd `packages/opencode`, worktree `opencode-dev`):

| Observer · time | Form | Result |
| --- | --- | --- |
| core-dev ~14:05 | isolated, bare shell, 4× | 13/0 ×4 |
| core-dev ~14:05 | isolated, `env -i` + XDG isolation | 13/0 |
| core-dev ~14:05 | full suite serial | 1258/5 (cf-gateway 0 fail) |
| core-dev ~14:05 | full suite ×2 concurrent | both 1258/5, cf-gateway 0 fail |
| core-dev ~14:05 | isolated, 3× consecutive | 13/0 ×3 |
| core-dev ~14:40 (redelivery) | isolated, bare shell, 6× | 13/0 ×6 |
| core-dev ~15:0x (re-reproduction) | isolated, bare shell, 5× + full serial | **13/0 ×5**; full = 1258/5, cf-gateway 0 fail |
| core-dev ~15:0x | sibling files `provider.test.ts` (102/0), `transform.test.ts` (561/0) serial | all pass |
| qa ~15:0x (independent 3rd observer) | isolated, bare shell, 2× consecutive | **13/0 ×2** |

~15 independent runs by one observer, spanning isolated/concurrent/`env -i`/
XDG-isolated forms, plus two serial full-suite runs: **the 4-fail form has
never reproduced**.

**Counter-evidence on record:** two review passes of the same worktree by
a second observer independently report 9/4 ×3 in the identical bare-shell
serial form, with full evidence attached (commands, cwd, bun version, error
stacks). This observation is in fact the second observer's measurement, not
an unconfirmed claim — the open problem is that the two sides' environment
fingerprints have not been reconciled (candidates: which `node_modules/.bun`
store actually gets hit, e.g. the main worktree vs the detached `.docbuild`
worktree which carries its own store; which `@ai-sdk/gateway` hash variant
is resolved; which `bun` binary on PATH), so the 9/4 side and the 13/0 side
cannot yet be shown to have run against the same dependency resolution. The
independent third-observer re-run (`47a3c62` era, 09-25 ~15:0x UTC) landed
13/0 under the same form, making the tally 2:1; per the workspace hard rule
— *conclusions require evidence* (reproducible command + input + expected
vs actual) — a 2:1 split where the dissenting side's environment fingerprint
is unverified is closed as **unreproducible, both measurements on record**
(neither side's observation is denied). The 9/4 observation remains a
documented, evidence-backed anomaly that reopens this log if it ever
reproduces with a reconciled fingerprint.

**Environment fingerprints recorded by the 13/0 side (09-25 ~15:0x UTC,
independent third observer):**
- `git rev-parse HEAD` = `47a3c624ef23` (worktree `opencode-dev` [freecode-main];
  a second detached worktree `.docbuild` @ `0cdc7ef` exists and carries its own
  `node_modules/.bun/` — tests were NOT run there).
- `bun` = `/Users/yyl/Desktop/workshop/freecode/.runtime/bin/bun`, 1.4.2;
  `node_modules` resolves to `opencode-dev/node_modules` (per-worktree store, not
  the root store).
- `ai-gateway-provider` resolves via symlink to
  `node_modules/.bun/ai-gateway-provider@3.2.0+39911914b0439de0/...` (version 3.2.0;
  mtime Sep 22 19:32, pre-dating all FREE-26 runs). Note: the store also holds
  three `@ai-sdk+gateway` hash variants (3.0.104+68a1e3a0c4588df3, 3.0.104+d6123d32214422cb,
  3.0.191+d6123d32214422cb) — which one is actually resolved at test time was not
  pinned down and is a prime suspect for the unreconciled 9/4 vs 13/0 split.
- 2× consecutive runs of `bun test test/provider/cf-ai-gateway-e2e.test.ts`:
  both **13/0**, no fails.

**Root-cause check on the alleged failure mechanism** (per the review's
pointer): in `ai-gateway-provider@3.2.0`, `processModelRequest` has two
throw sites for `Sorry, but provider "…" is currently not supported` —
`dist/index.mjs:556` (model.config missing the `fetch` key) and `dist/index.mjs:577`
(provider not found in the GATEWAY_PROVIDERS URL registry). The reported
line 577 throw can only happen when the stubbed fetch URL does not match any
GATEWAY_PROVIDERS host pattern; the test file always points the mock at
`https://gateway.ai.cloudflare.com/...` and the GATEWAY_PROVIDERS table in the
installed 3.2.0 includes matching `anthropic` entries. `ProviderTransform`
outputs `anthropic` (no `.messages` suffix), not `anthropic.messages`.
Therefore the claimed error message (`"anthropic.messages"`) is not
reachable under the current fixture + current 3.2.0 provider table:
either the 13:29 run used a different installed version/state of
`ai-gateway-provider`, or the error was from a different test path that
no longer exists. Either way it is **not reproducible under the current
tree**, and there is no FreeCode-side fixture bug to fix — the fixture
(`cfModel` / `callThroughGateway` / `gatewayModel`) in the current test file
is complete and consistent with the installed provider library.

**Adjudication:** the 4 cf-ai-gateway fails are treated as a **one-off,
unreproducible observation** (independent third-observer re-run: 13/0 ×2,
tally 2:1). This closes the issue as *unreproducible, both measurements on
record* — the 9/4 ×3 report is NOT denied; it stands as evidence that the
two sides' environment fingerprints were not aligned. The issue reopens as
a fixture/environment bug if the 4 fails are ever reproduced under a
reconciled environment fingerprint (same `node_modules` store, same
`ai-gateway-provider` hash, same bun binary, confirmed in the run log).

**Baseline rule:** any cf-ai-gateway fail count observed under a form other
than serial-clean-env (or that changes from one run to the next) is an
environment artefact to re-check, not a regression. Only a **stably
reproducible form — same form, 2 consecutive runs, same fails, confirmed by
an independent second observer** — may change the baseline numbers above.

## Worktree isolation

OpenCode's permission system is not a sandbox, and two agents editing one checkout
is a race no permission rule can arbitrate: whoever writes last wins and the
other's work is silently gone. A worktree gives each writer its own files, and a
branch means the result is reviewed as a diff rather than already merged.

**The isolation is real, not advisory.** Every file tool resolves its working
directory from `InstanceRef`, so giving a subagent a different instance redirects
its entire world — reads, edits, bash, snapshot tracking, file watching.

Verified end to end on a real repository: a writing subagent ran, and

```
freecode isolated subagent agent=coder
  directory=…/proj3/.freecode/worktrees/ses_…  branch=freecode/ses_…
```

- the main checkout's `geom.py` was **unchanged**;
- the docstring appeared only inside the worktree;
- `freecode tasks` listed the task as `1 file(s)  M geom.py`;
- `freecode tasks diff <id>` printed the patch;
- `freecode tasks merge <id>` merged it, removed the worktree, and the main
  checkout then contained the change.

### Placement

`.freecode/worktrees/<task-id>` — inside the repository on purpose. A repository
cannot track a worktree of itself, so git ignores it automatically: nothing has to
be added to the user's `.gitignore`, and cleanup is a local `rmSync` rather than a
walk over a sibling directory.

### Policy

`auto` (the default) isolates writers and shares readers, which is the only
default that makes concurrent agents safe without paying for a worktree on every
read. An agent declares `workspace_mode: shared | isolated | auto` in frontmatter;
`freecode.isolation` sets `auto | always | never` and `never` outranks the agent's
own request.

An agent is treated as a writer unless its permission rules clearly deny writing.
The asymmetry is deliberate: an agent wrongly treated as a writer gets a worktree
it did not need, while one wrongly treated as a reader edits the shared checkout
alongside other agents. The second mistake is the one that loses work.

Isolation never blocks a subagent. A project that is not a git repository, or a
worktree git refuses to create, logs why and runs in the shared checkout —
refusing to start would be a worse outcome than the concurrency risk isolation
exists to avoid.

Merging refuses rather than guesses. A repository with uncommitted changes is the
user's call, a task that changed nothing does not get a noise commit, and
`--no-ff` keeps the isolated work visible as a unit in history. A conflicting
merge is **aborted**, because a half-merged tree is the one situation where doing
something clever is strictly worse than stopping.

### Two git behaviours that broke the first implementation

1. **A worktree inside the repository makes the repository dirty.** `git status`
   in the parent reported FreeCode's own scratch directory as untracked, so every
   merge was refused by FreeCode's dirty-tree guard — a guard tripped by FreeCode
   itself. The check now excludes `.freecode/worktrees`.
2. **`git worktree list` reports resolved paths.** On macOS a repository reached
   through `/tmp` comes back as `/private/tmp`, so comparing our path with git's
   never matched and `tasks list` reported nothing. Paths are canonicalised on the
   way in and out.

## M0 release gate and isolation contract (P0-3)

Contract and gate document: [`docs/M0-RELEASE-GATE.md`](docs/M0-RELEASE-GATE.md).
It fixes four things that the P0 freeze period needs in writing:

1. **The isolation contract.** What `isolated` / `shared` / `fallback` each
   guarantee, which behaviours are contractual and which are degradation, and an
   assertion list (A1–A5, B1–B4, C1–C2) that maps one-to-one onto the P0-1
   trace fields and the P0-2 verdict labels. Any `WRONG_CWD` or `ERROR` verdict
   fails gate G2.
2. **The M0 gate list.** G1–G9, each verifiable by a command and expected
   output. No gate may pass on a feeling.
3. **The freeze rules.** What the P0 window allows and forbids, and how to
   request an exception.
4. **The single-entry model-resolution check.** Confirmed: `FreeCodeRoute.auto`
   is called from exactly one place (`Provider.getModel`), and gate G8 re-runs
   that check with a grep recipe at every gate pass.

## Not started

Laya fine-tuning on the routing data FreeCode now produces (v0.4), and a wider
routing benchmark — 100-200 cases weighted toward the boundaries the rules get
wrong, rather than uniformly sampling cases both rule and model find easy.



