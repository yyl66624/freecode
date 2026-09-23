import { Effect, Option } from "effect"
import * as prompts from "@clack/prompts"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"
import { Config } from "@/config/config"
import { ConfigParse } from "@/config/parse"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Setup } from "@/freecode/setup"
import { ProviderTest } from "@/freecode/provider-test"
import { TIERS, type Tier } from "@/freecode/resolver"

/**
 * `freecode account` — the day-two path for the four-layer model
 * (docs/architecture/02-four-layer-model.md §2.4): credentials belong to an
 * *account*, and an account is what the scheduler's quota/health/reliability
 * numbers actually track.
 *
 * Upstream's `freecode providers login` handles the vendor-authenticated
 * single-credential case. This command is for the FreeCode-specific shape
 * ADR-005 fixes: a named account whose key lives in `~/.freecode/secrets.env`
 * (mode 600, referenced as `{file:...}`), whose pool membership is editable
 * without touching the key, and whose health is observable per account rather
 * than per provider.
 */

export type AccountId = string

/**
 * `Prompt.text` / `Prompt.password` / `Prompt.select` return
 * `Effect<Option<Value>, never, never>`. This helper unwraps the Option and
 * dies on cancel (Esc), matching how `providers.ts` uses `promptValue`.
 */
const promptOr = <Value>(value: Effect.Effect<Option.Option<Value>>): Effect.Effect<Value> =>
  Effect.gen(function* () {
    const option = yield* value
    if (Option.isNone(option)) return yield* Effect.die(new UI.CancelledError())
    return option.value
  })

/** Pool entries for one provider id across all tiers, or [] when it is absent. */
function poolEntries(cfg: ConfigV1.Info, id: string): string[] {
  const pool = cfg.freecode?.pool ?? {}
  return TIERS.flatMap((tier) => pool[tier]?.filter((entry) => entry.startsWith(id + "/")) ?? [])
}

/** Every provider id that appears anywhere in the pool. */
function poolIds(cfg: ConfigV1.Info): string[] {
  const pool = cfg.freecode?.pool ?? {}
  const ids = new Set<string>()
  for (const entries of Object.values(pool)) for (const entry of entries ?? []) ids.add(entry.slice(0, entry.indexOf("/")))
  return [...ids].sort()
}

export const AccountCommand = effectCmd({
  command: "account <action>",
  describe: "manage FreeCode accounts (credentials, pool membership)",
  instance: false,
  builder: (yargs) =>
    yargs
      .command(AccountAddCommand)
      .command(AccountListCommand)
      .command(AccountDisableCommand)
      .command(AccountEnableCommand)
      .demandCommand(),
  handler: Effect.succeed(undefined) as never,
})

/**
 * `freecode account add` — add a second (or more) account for a provider.
 *
 * An account is expressed as its own provider id (`deepseek-backup`,
 * `deepseek-main`) because upstream resolves credentials per provider id
 * (DEVELOPMENT.md, "Account pools need no upstream change"). What this
 * command writes:
 *   - `provider.<id>` in the global config: the endpoint + a `{file:...}`
 *     reference to the key,
 *   - the key itself into `~/.freecode/secrets.env` (mode 600),
 *   - `freecode.pool` entries for the declared tier and every tier above it.
 *
 * The provider's credential is never inlined into the config file; that is
 * ADR-005's invariant and it is testable (the account add test asserts the
 * config references a file, not a literal key).
 */
export const AccountAddCommand = effectCmd({
  command: "add [id]",
  describe: "add an account for a provider (writes key to a 600-mode file, referenced from config)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "account id, e.g. deepseek-backup", type: "string" })
      .option("base-url", { describe: "OpenAI-compatible base URL", type: "string" })
      .option("model", { describe: "model id; repeatable", type: "string", array: true })
      .option("api-key", { describe: "the key; written to secrets.env, never to the config", type: "string" })
      .option("env", { describe: "read the key from this environment variable instead of writing one", type: "string" })
      .option("tier", {
        describe: "capability tier the account serves, and every tier above it",
        type: "string",
        choices: [...TIERS],
        default: "standard",
      })
      .option("yes", { describe: "accept every default without prompting", type: "boolean" }),
  handler: Effect.fn("Cli.account.add")(function* (raw: unknown) {
    const args = raw as {
      id?: string
      baseUrl?: string
      model?: string[]
      apiKey?: string
      env?: string
      tier?: string
      yes?: boolean
    }

    const provider = args.id ?? (yield* promptOr(Prompt.text({ message: "Account id (e.g. deepseek-backup)" })))
    const config = yield* Config.Service
    const cfg = yield* config.getGlobal()

    if (cfg.provider?.[provider]) {
      const confirmed = yield* Effect.promise(() =>
        prompts.confirm({ message: `${provider} is already configured; overwrite it?` }),
      )
      if (prompts.isCancel(confirmed) || !confirmed) return yield* fail(`${provider} is already configured; cancel or pick a new id`)
    }

    const template = Setup.TEMPLATES.find(
      (item) =>
        item.label.toLowerCase().replace(/[^a-z0-9]+/g, "-") === provider?.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    )
    const name = args.id ? provider : (yield* promptOr(Prompt.text({ message: "Display name" })) ?? template?.label ?? provider)
    const baseAnswer = yield* promptOr(Prompt.text({ message: "Base URL" }))
    const baseURL = args.baseUrl ?? (args.yes ? template?.baseURL : baseAnswer ?? template?.baseURL ?? "")
    const modelAnswer = yield* promptOr(Prompt.text({ message: "Model ids, comma-separated" }))
    const models: string[] =
      (args.model?.length ?? 0) > 0
        ? (args.model as string[])
        : (modelAnswer ?? (template?.models ?? []).join(",")).split(",").map((value) => value.trim()).filter(Boolean)
    const tier = args.tier ?? "standard"

    let apiKeyRef: string | undefined
    if (args.env) {
      apiKeyRef = `{env:${args.env}}`
    } else if (args.apiKey) {
      apiKeyRef = Setup.writeSecret(envVarFor(provider), args.apiKey)
      Prompt.log.info(`key written to ${Setup.secretsPath()} (mode 600)`)
    } else if (template?.needsKey ?? true) {
      const pasted = yield* promptOr(Prompt.password({ message: "API key (written to secrets.env, never to config)" }))
      if (!pasted) return yield* fail("no key given; cancel or use --api-key / --env")
      apiKeyRef = Setup.writeSecret(envVarFor(provider), pasted)
      Prompt.log.info(`key written to ${Setup.secretsPath()} (mode 600)`)
    }

    const draft: Setup.Draft = {
      id: provider,
      npm: template?.npm ?? "@ai-sdk/openai-compatible",
      name,
      baseURL: baseURL || undefined,
      apiKey: apiKeyRef,
      models,
      tier,
    }
    const problems = Setup.validate(draft)
    if (problems.length) {
      for (const problem of problems) UI.println(`  ! ${problem}`)
      return yield* fail("the account was not written")
    }

    const patch = Setup.draftToConfig(draft)
    const merged = { ...(yield* config.getGlobal()), ...patch } as ConfigV1.Info
    try {
      ConfigParse.schema(ConfigV1.Info, merged, "freecode account add")
    } catch (error) {
      const issues = (error as { issues?: { message: string; path?: unknown[] }[] }).issues
      if (Array.isArray(issues) && issues.length) {
        for (const issue of issues) UI.println(`  ! ${(issue.path ?? []).map(String).join(".") || "(root)"}: ${issue.message}`)
        return yield* fail("the configuration was not written")
      }
      throw error
    }
    yield* config.updateGlobal(merged)
    UI.println(`  ${UI.Style.TEXT_SUCCESS_BOLD}✓${UI.Style.TEXT_NORMAL} account ${provider} added to the pool${tier !== "standard" ? ` at tier ${tier}` : ""}`)
    UI.println("")
    UI.println("Next: `freecode provider test " + provider + "` to confirm the endpoint is reachable.")
  }),
})

/** `freecode account list` — every pool account, its tiers, and its credential source. */
export const AccountListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list accounts in the routing pool with their tier coverage",
  instance: false,
  handler: Effect.fn("Cli.account.list")(function* (_args) {
    const config = yield* Config.Service
    const cfg = yield* config.getGlobal()
    const ids = poolIds(cfg)
    if (!ids.length) {
      UI.println("No accounts in the pool yet. `freecode account add` or `freecode setup` creates one.")
      return
    }
    UI.println(UI.Style.TEXT_HIGHLIGHT_BOLD + "Accounts" + UI.Style.TEXT_NORMAL)
    for (const id of ids) {
      const provider = cfg.provider?.[id] as { name?: string; options?: Record<string, unknown> } | undefined
      const entries = poolEntries(cfg, id)
      const apiKey = typeof provider?.options?.apiKey === "string" ? provider!.options.apiKey : undefined
      let source: string
      if (!apiKey) source = "env " + envVarFor(id)
      else if (apiKey.startsWith("{env:")) source = apiKey
      else if (apiKey.startsWith("{file:")) source = "secrets file"
      else source = "inline (move it to a file — `freecode account add` rewrites it)"
      UI.println(`  ${id}   ${provider?.name ?? ""}   ${entries.length ? entries.join(", ") : "(no pool entry)"}`)
      UI.println(`    ${source}`)
    }
  }),
})

/**
 * `freecode account disable <id>` — take one account out of every pool tier
 * without deleting its credential: the key stays in `secrets.env`, the
 * `provider.<id>` block stays in the config, only the `freecode.pool`
 * entries are removed. That is the ADR-005 rotation path: "disabled" means
 * the scheduler stops choosing it, not that the credential is destroyed.
 */
export const AccountDisableCommand = effectCmd({
  command: "disable <id>",
  describe: "remove an account from the routing pool (keeps the credential)",
  instance: false,
  handler: Effect.fn("Cli.account.disable")(function* (raw: unknown) {
    const id = (raw as { id: string }).id
    const config = yield* Config.Service
    const cfg = yield* config.getGlobal()
    const entries = poolEntries(cfg, id)
    if (!entries.length) return yield* fail(`${id} has no pool entry; nothing to disable`)
    const patch = removePoolEntries(cfg, id)
    yield* config.updateGlobal(patch as ConfigV1.Info)
    UI.println(`  ${UI.Style.TEXT_SUCCESS_BOLD}✓${UI.Style.TEXT_NORMAL} ${id} removed from ${entries.length} pool entry(ies); credential kept`)
    UI.println("Re-enable with `freecode account enable " + id + "` — the key is still in " + Setup.secretsPath())
  }),
})

/** `freecode account enable <id>` — put a previously disabled account back into the pool. */
export const AccountEnableCommand = effectCmd({
  command: "enable <id>",
  describe: "re-add an account's models to the routing pool",
  instance: false,
  handler: Effect.fn("Cli.account.enable")(function* (raw: unknown) {
    const id = (raw as { id: string }).id
    const config = yield* Config.Service
    const cfg = yield* config.getGlobal()
    const provider = cfg.provider?.[id] as { models?: Record<string, unknown>; options?: Record<string, unknown> } | undefined
    if (!provider) return yield* fail(`${id} is not a configured provider; run \`freecode account add ${id}\` first`)
    const models = Object.keys(provider.models ?? {})
    if (!models.length) return yield* fail(`${id} has no models declared; add some with \`freecode account add\``)
    const tier = "standard"
    const merged = addPoolEntries({ ...cfg, freecode: { ...cfg.freecode, pool: { ...cfg.freecode?.pool } } }, id, models, tier)
    yield* config.updateGlobal(merged as ConfigV1.Info)
    UI.println(`  ${UI.Style.TEXT_SUCCESS_BOLD}✓${UI.Style.TEXT_NORMAL} ${id} re-added to the pool at tier ${tier}`)
  }),
})

function removePoolEntries(cfg: ConfigV1.Info, id: string): ConfigV1.Info {
  const pool: Record<string, string[]> = { ...(cfg.freecode?.pool ?? {}) }
  for (const tier of Object.keys(pool)) {
    const kept = pool[tier]?.filter((entry) => entry !== undefined && !entry.startsWith(id + "/"))
    if (kept !== undefined) pool[tier] = kept
  }
  return { ...cfg, freecode: { ...cfg.freecode, pool } }
}

function addPoolEntries(cfg: ConfigV1.Info, id: string, models: string[], tier: Tier): ConfigV1.Info {
  const pool: Record<string, string[]> = { ...(cfg.freecode?.pool ?? {}) }
  const entries = models.map((model) => `${id}/${model}`)
  const start = Math.max(0, TIERS.indexOf(tier))
  for (const t of TIERS) {
    if (TIERS.indexOf(t) < start) continue
    const existing = new Set(pool[t] ?? [])
    pool[t] = [...existing, ...entries.filter((entry) => !existing.has(entry))]
  }
  return { ...cfg, freecode: { ...cfg.freecode, pool } }
}

function envVarFor(id: string): string {
  return ProviderTest.envVarFor(id)
}
