import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Decision } from "@/freecode/decision"
import { Resources } from "@/freecode/resources"
import { Scheduler } from "@/freecode/scheduler"
import { Fallback } from "@/freecode/fallback"
import { ResourceState, load, promote } from "@/freecode/state"
import { TIERS, type Tier } from "@/freecode/resolver"

/**
 * `freecode routes` — inspection of the resource pool and the last decision.
 *
 * Exists because the alternative to a readable answer is a user guessing why
 * their strongest model was skipped, or why a task got slower. Both questions
 * have exact answers in FreeCode's own state, and neither should require reading
 * a log file.
 */
export const RoutesCommand = effectCmd({
  command: "routes [action]",
  describe: "inspect FreeCode resources and routing decisions",
  builder: (yargs) =>
    yargs.positional("action", {
      describe: "status (default) shows the pool; why explains the last decision",
      type: "string",
      choices: ["status", "why", "tiers"],
    }),
  handler: Effect.fn("Cli.routes")(function* (args) {
    const action = args.action ?? "status"

    if (action === "why") {
      const record = Decision.read()
      if (!record) return yield* fail("No routing decision has been recorded yet.")
      UI.println(Decision.render(record))
      return
    }

    const config = yield* Config.Service
    const cfg = yield* config.get()
    const pool = cfg.freecode?.pool ?? {}

    if (action === "tiers") {
      if (Object.keys(pool).length === 0) return yield* fail("No `freecode.pool` is configured.")
      for (const tier of TIERS) {
        const entries = pool[tier]
        UI.println(`${tier.padEnd(9)} ${entries?.length ? entries.join(", ") : "(unconfigured)"}`)
      }
      return
    }

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

    const resolve = (providerID: string, modelID: string) => {
      const entry = providers[ProviderV2.ID.make(providerID)]
      return entry?.models[ModelV2.ID.make(modelID)]
    }

    const candidates = Resources.build({ pool, model: resolve, state: promote(load()).resources })
    if (candidates.length === 0) {
      return yield* fail("The resource pool is empty. Configure `freecode.pool` in freecode.jsonc.")
    }

    const snapshot = promote(load())
    UI.println(UI.Style.TEXT_HIGHLIGHT_BOLD + "Resources" + UI.Style.TEXT_NORMAL)
    for (const candidate of [...candidates].sort((a, b) => a.resource.id.localeCompare(b.resource.id))) {
      const resource = candidate.resource
      const state = snapshot.resources[resource.id]
      const reason = ResourceState.exclusionReason(state, Date.now())
      UI.println(`  ${resource.id}`)
      UI.println(
        `    account ${resource.account}   tiers ${resource.tiers.join(" ")}   ` +
          `cost ${resource.cost.toFixed(2)}   health ${state?.health ?? "unseen"}`,
      )
      if (state) {
        const latency = (state.latencyEMA ?? 0) > 0 ? `${Math.round(state.latencyEMA!)}ms` : "-"
        UI.println(
          `    circuit ${state.circuit.state.padEnd(9)} attempts ${state.attempts} ` +
            `ok ${state.successes} provider-failures ${state.providerFailures} latency ${latency}`,
        )
      }
      if (reason) UI.println(`    ${UI.Style.TEXT_WARNING_BOLD}excluded${UI.Style.TEXT_NORMAL} ${reason}`)
    }

    const excluded = Fallback.excluded(pool)
    if (excluded.length) {
      UI.println("")
      UI.println(UI.Style.TEXT_WARNING_BOLD + "Currently excluded" + UI.Style.TEXT_NORMAL)
      for (const line of excluded) UI.println(`  ${line}`)
    }

    // A dry run per tier shows what the scheduler would pick right now, which is
    // the question a user actually has when a task feels slower than usual.
    UI.println("")
    UI.println(UI.Style.TEXT_HIGHLIGHT_BOLD + "Current choice per tier" + UI.Style.TEXT_NORMAL)
    for (const tier of TIERS) {
      const winner = Scheduler.select(candidates, { tier: tier as Tier })
      UI.println(
        `  ${tier.padEnd(9)} ${winner ? Scheduler.explain(winner) : "no eligible resource"}`,
      )
    }
  }),
})
