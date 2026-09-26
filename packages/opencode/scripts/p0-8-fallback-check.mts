#!/usr/bin/env bun
// §11 machine segment: provider-fault fallback via deterministic MockProvider.
//
// Machine-judgeable counterpart of the interactive §11 step in
// `scripts/p0-8-checklist.sh` (broken / exhausted leading account, the task
// must land on a healthy sibling, the leading one must end up excluded with a
// recorded reason). Uses the seed-driven MockProvider from
// `test/freecode/mock-provider`, so the result is reproducible: no network, no
// wall clock, no Math.random. Feeds the real scheduler core.
//
// Run:
//   cd packages/opencode && bun run scripts/p0-8-fallback-check.mts
//
// Exit 0 = every matrix row held; non-zero = a violation, and the failing
// label is the minimal reproduction to paste into the defect issue.

import { MockProvider, buildCandidate, scenarios, defaultProfile } from "@test/freecode/mock-provider"
import * as SchedulerCore from "@/freecode/core/scheduler-core"
import { NoResourceError, type ResolveRequest, type CapabilityTier } from "@/freecode/core/types"

const NOW = 1_700_000_000_000

type CoreSpec = Parameters<typeof buildCandidate>[1]

const spec = (
  modelID: string,
  accountID: string,
  providerID: string,
): CoreSpec =>
  ({
    model: {
      id: modelID,
      provider: providerID,
      contextWindow: 32_768,
      maxOutput: 8_192,
      capabilities: ["tools"],
      tier: "standard",
    },
    account: {
      id: accountID,
      provider: providerID,
      credential: `env:${providerID.toUpperCase()}_KEY`,
    },
    provider: {
      id: providerID,
      protocol: "openai-chat",
      endpoint: `https://api.${providerID}.example.com/v1`,
      auth: "bearer",
      models: [modelID],
      accounts: [accountID],
    },
  }) as unknown as CoreSpec

const key = (m: string, a: string) => `${m}@${a}`
const req = (): ResolveRequest => ({ capability: "standard", requiredFeatures: [] })

let failures = 0
function check(label: string, ok: boolean, detail: string) {
  if (ok) {
    console.log(`\x1b[32m✓\x1b[0m ${label}`)
  } else {
    failures += 1
    console.error(`\x1b[31m×\x1b[0m ${label}\n  ${detail}`)
  }
}

// --- scenario 1: broken credential first, healthy siblings serve -----------
{
  const broken = spec("deepseek/deepseek-chat", "broken", "deepseek")
  const main = spec("deepseek/deepseek-chat", "deepseek-main", "deepseek")
  const backup = spec("deepseek/deepseek-chat", "deepseek-backup", "deepseek")
  const profiles = {
    ...scenarios.invalidCredential([key("deepseek/deepseek-chat", "broken")]),
    [key("deepseek/deepseek-chat", "deepseek-main")]: defaultProfile,
    [key("deepseek/deepseek-chat", "deepseek-backup")]: defaultProfile,
  }
  const provider = new MockProvider({ seed: 42, profiles })
  const pool = [broken, main, backup].map((s) => buildCandidate(provider, s, 3, NOW))

  const brokenState = pool[0].health.state
  const outcome = SchedulerCore.resolve(pool, req(), { now: NOW, jitterSeed: 0 })

  check(
    "an INVALID credential is excluded even when it leads the tier",
    brokenState === "INVALID",
    `broken health.state=${brokenState} (expected INVALID after credential refusals)`,
  )
  check(
    "the chosen account is a healthy sibling, not the broken one",
    outcome.binding.account.id !== "broken",
    `chosenAccount=${outcome.binding.account.id} (expected deepseek-main or deepseek-backup)`,
  )
}

// --- scenario 2: quota exhaustion -> cross-account switch ------------------
{
  const main = spec("zhipu/glm-4-flash", "zhipu-work", "zhipu")
  const sibling = spec("zhipu/glm-4-flash", "zhipu-hot", "zhipu")
  const provider = new MockProvider({
    seed: 7,
    profiles: scenarios.quotaExhausted(key("zhipu/glm-4-flash", "zhipu-work"), key("zhipu/glm-4-flash", "zhipu-hot"), 0),
  })
  const pool = [main, sibling].map((s) => buildCandidate(provider, s, 1, NOW))

  const outcome = SchedulerCore.resolve(pool, req(), { now: NOW, jitterSeed: 0 })
  check(
    "a quota-exhausted account is excluded; the sibling serves",
    outcome.binding.account.id === "zhipu-hot",
    `chosenAccount=${outcome.binding.account.id} (expected zhipu-hot, the unexhausted sibling)`,
  )
}

// --- scenario 3: all cloud down -> SUSPENDED (NoResourceError) -------------
{
  const healthy = [
    spec("deepseek/deepseek-chat", "deepseek-main", "deepseek"),
    spec("zhipu/glm-4-flash", "zhipu-main", "zhipu"),
  ]
  const provider = new MockProvider({
    seed: 13,
    profiles: scenarios.cloudDown(healthy.map((s) => key((s as { model: { id: string }; account: { id: string } }).model.id, (s as { model: { id: string }; account: { id: string } }).account.id))),
  })
  const pool = healthy.map((s) => buildCandidate(provider, s, 3, NOW))
  // 3 consecutive 5xx -> UNHEALTHY -> out of the pool (same as the test).
  for (const c of pool) expect_unhealthy(c.health.state)
  let threw = false
  try {
    SchedulerCore.resolve(pool, req(), { now: NOW, jitterSeed: 0 })
  } catch (err) {
    threw = err instanceof NoResourceError
  }
  check(
    "a fully-down pool raises NoResourceError (the SUSPENDED path), never a silent fallback",
    threw,
    "resolve() did not throw NoResourceError — a silently-chosen candidate is a P0-8 defect",
  )
}

function expect_unhealthy(state: string) {
  if (state !== "UNHEALTHY") {
    console.error(`\x1b[33m·\x1b[0m note: candidate health=${state} (expected UNHEALTHY after 3x 5xx)`)
  }
}

console.log(`\n§11 fallback matrix (machine segment): ${failures === 0 ? "PASS" : `${failures} FAIL`} — deterministic, seed-fixed, no network`)
process.exit(failures === 0 ? 0 : 1)
