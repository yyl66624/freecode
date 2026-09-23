import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { Config } from "@/config/config"
import { ConfigParse } from "@/config/parse"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { TIERS } from "@/freecode/resolver"
/**
 * `freecode config validate` — the schema half of `freecode doctor`.
 *
 * `doctor` answers "is everything working". This command answers the
 * narrower, scriptable question "does my configuration even parse",
 * which is the failure a machine checks in CI before anything else: a
 * config that fails the schema cannot produce a valid pool, so
 * validating it separately makes the error message about the config
 * rather than about a symptom three layers down.
 *
 * Validation runs the loader's own parser (`ConfigParse.schema`), not a
 * hand-written check, so "valid here" means "will load", exactly like
 * `freecode setup` validates a draft before writing it.
 */

export type ValidateResult = { ok: true; checked: string[]; warnings: string[] } | { ok: false; issues: string[] }

/**
 * Validate one parsed config against the loader's own schema, plus the
 * FreeCode-specific pool check: an empty tier is a warning (routing falls
 * back to the session default, so it is survivable), a provider id with
 * no model is not (it is a typo with a very long tail).
 */
export function validate(cfg: unknown, label = "config"): { issues: string[]; warnings: string[] } {
  const issues: string[] = []
  const warnings: string[] = []
  try {
    ConfigParse.schema(ConfigV1.Info, cfg, label)
  } catch (error) {
    const parsed = (error as { issues?: { message: string; path?: unknown[] }[] }).issues
    if (Array.isArray(parsed) && parsed.length) {
      for (const issue of parsed) issues.push(`${(issue.path ?? []).map(String).join(".") || "(root)"}: ${issue.message}`)
    } else {
      issues.push(error instanceof Error ? error.message : String(error))
    }
  }

  const info = cfg as ConfigV1.Info
  if (info && typeof info === "object") {
    const pool = info.freecode?.pool
    if (pool !== undefined) {
      for (const tier of TIERS) {
        const entries = pool[tier]
        if (entries !== undefined && entries.length === 0) {
          warnings.push(`pool tier "${tier}" is declared but empty; tasks routed there fall back to the session default model`)
        }
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            const separator = entry.indexOf("/")
            if (separator === -1 || !entry.slice(separator + 1)) {
              issues.push(`pool entry "${entry}" is not in "provider/model" form`)
            }
          }
        }
      }
      const providers = new Set(Object.keys(info.provider ?? {}))
      for (const entry of Object.values(pool ?? {}).flatMap((items) => items ?? [])) {
        const providerID = entry.slice(0, entry.indexOf("/"))
        if (!providers.has(providerID)) {
          warnings.push(`pool references provider "${providerID}", which has no provider config block; its credential will come from the environment`)
        }
      }
    }
  }
  return { issues, warnings }
}

export const ConfigValidateCommand = effectCmd({
  command: "config validate",
  describe: "check that the FreeCode configuration parses and the pool is coherent",
  instance: false,
  handler: Effect.fn("Cli.config.validate")(function* (_args) {
    const config = yield* Config.Service
    // `getGlobal` is the right layer here: this command is an instance-free
    // check (like `freecode account list`), and the config it validates is
    // the global file that `setup` and `account add` write to, not a
    // per-project merge.
    const cfg = yield* config.getGlobal()
    const result = validate(cfg, "freecode config")
    if (result.issues.length) {
      for (const issue of result.issues) UI.println(`  ${UI.Style.TEXT_DANGER_BOLD}×${UI.Style.TEXT_NORMAL} ${issue}`)
      for (const warning of result.warnings) UI.println(`  ${UI.Style.TEXT_WARNING_BOLD}!${UI.Style.TEXT_NORMAL} ${warning}`)
      return yield* fail(`${result.issues.length} configuration problem(s)`)
    }
    UI.println(`  ${UI.Style.TEXT_SUCCESS_BOLD}✓${UI.Style.TEXT_NORMAL} configuration is valid`)
    for (const warning of result.warnings) UI.println(`  ${UI.Style.TEXT_WARNING_BOLD}!${UI.Style.TEXT_NORMAL} ${warning}`)
    if (!result.warnings.length) UI.println("  pool tiers, provider references and schema all check out")
  }),
})
