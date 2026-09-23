import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { Config } from "@/config/config"
import { ProviderTest } from "@/freecode/provider-test"

/**
 * `freecode provider test <id>` — one provider's health, no LLM call.
 *
 * This is the probe the SUSPENDED checklist (docs/architecture/adr/004)
 * points at: "is the endpoint alive at all, or is it the credentials?"
 * A 401 and a timeout are different problems with different remedies, so
 * the command reports which one it saw rather than a single pass/fail.
 *
 * No chat completion: the model costs tokens, and a health check does not
 * need to spend any. `GET {baseURL}/models` (or Ollama's `/api/tags`) is
 * enough to classify the endpoint.
 */
export const ProviderTestCommand = effectCmd({
  command: "provider test <id>",
  describe: "check that a provider endpoint is reachable",
  instance: false,
  handler: Effect.fn("Cli.providerTest")(function* (args) {
    const id = (args as { id: string }).id
    const config = yield* Config.Service
    const cfg = yield* config.getGlobal()
    const options = (cfg.provider?.[id] as { options?: Record<string, unknown> } | undefined)?.options

    const result = yield* Effect.promise(() => ProviderTest.probe(id, options))
    if (result.ok) {
      UI.println(`  ${UI.Style.TEXT_SUCCESS_BOLD}✓${UI.Style.TEXT_NORMAL} ${id}: ${result.detail}`)
      return
    }
    UI.println(`  ${UI.Style.TEXT_WARNING_BOLD}×${UI.Style.TEXT_NORMAL} ${id}: ${result.detail}`)
    if ("hint" in result && result.hint) UI.println(`    ${result.hint}`)
    return yield* fail(`${id} is not reachable`)
  }),
})
