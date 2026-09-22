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

### Resolution must happen inside the routing Effect

`Effect.runPromise` starts a fresh runtime with no instance context, so a pool
lookup performed that way fails with `InstanceRef not provided`. Pool entries are
resolved inside the routing Effect and handed to the pure builder.

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
| Current `freecode-main` | 1033 pass, 3 skip, **5 fail** |

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

## Not started

Laya fine-tuning on the routing data FreeCode now produces (v0.4), and a wider
routing benchmark — 100-200 cases weighted toward the boundaries the rules get
wrong, rather than uniformly sampling cases both rule and model find easy.



