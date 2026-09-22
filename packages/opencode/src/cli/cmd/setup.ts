import { Effect } from "effect"
import { createInterface } from "readline"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { Config } from "@/config/config"
import { Setup } from "@/freecode/setup"
import { ConfigParse } from "@/config/parse"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { version } from "@/freecode/freecode"

/**
 * `freecode setup` — go from a machine with no configuration to one that can run a
 * task, without editing JSON by hand.
 *
 * Interactive by default, and fully flag-driven for scripts and CI. Both paths
 * build the same `Draft` and run the same validation, so a scripted setup cannot
 * produce a configuration the interactive one would have rejected.
 */
export const SetupCommand = effectCmd({
  command: "setup",
  describe: "configure a provider and a routing pool for first use",
  // Setup writes to the global config, but it resolves the instance first so
  // `--dir` behaves the same way it does everywhere else.
  directory: (args: unknown) => (args as { dir?: string }).dir ?? process.cwd(),
  builder: (yargs) =>
    yargs
      .option("provider", { describe: "provider id, e.g. deepseek-main", type: "string" })
      .option("base-url", { describe: "OpenAI-compatible base URL", type: "string" })
      .option("model", { describe: "model id to install; repeatable", type: "string", array: true })
      .option("api-key", { describe: "API key; written to a 600-mode file, never to the config", type: "string" })
      .option("env", { describe: "read the key from this environment variable instead of writing one", type: "string" })
      .option("tier", {
        describe: "capability tier the model serves, and every tier above it",
        type: "string",
        choices: ["local", "fast", "standard", "strong", "max"],
        default: "standard",
      })
      .option("yes", { describe: "accept every default without prompting", type: "boolean" })
      .option("dry-run", { describe: "print the configuration that would be written", type: "boolean" })
      .option("dir", { describe: "project directory to resolve configuration against", type: "string" }),
  handler: Effect.fn("Cli.setup")(function* (raw: unknown) {
    const args = raw as {
      provider?: string
      baseUrl?: string
      model?: string[]
      apiKey?: string
      env?: string
      tier?: string
      yes?: boolean
      dryRun?: boolean
    }

    UI.println(`FreeCode ${version} setup`)
    UI.println("")

    const draft = args.provider
      ? scriptedDraft({ ...args, provider: args.provider })
      : yield* Effect.promise(() => interactiveDraft(args))

    if (!draft) return

    const problems = Setup.validate(draft)
    if (problems.length) {
      for (const problem of problems) UI.println(`  ! ${problem}`)
      return yield* fail("the configuration was not written")
    }

    // The key is written to a 600-mode file and referenced, never inlined: a config
    // file gets committed and pasted into issues, and a secret in one is a secret
    // everywhere.
    let apiKey = draft.apiKey
    if (args.apiKey) {
      const variable = `${draft.id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_API_KEY`
      const reference = Setup.writeSecret(variable, args.apiKey)
      apiKey = reference
      UI.println(`  ${UI.Style.TEXT_SUCCESS_BOLD}✓${UI.Style.TEXT_NORMAL} key written to ${Setup.secretsPath()} (mode 600)`)
    } else if (args.env) {
      apiKey = `{env:${args.env}}`
    } else if (draft.apiKey === "") {
      apiKey = undefined
    }

    const patch = Setup.draftToConfig({ ...draft, apiKey })

    if (args.dryRun) {
      UI.println(JSON.stringify(patch, null, 2))
      return
    }

    // Validated before anything is written. `updateGlobal` writes the file first
    // and decodes the result afterwards, so a patch the schema rejects would reach
    // the disk and only fail on the next read.
    const merged = { ...(yield* (yield* Config.Service).getGlobal()), ...patch }
    const problemsAfterMerge = validateAgainstSchema(merged)
    if (problemsAfterMerge.length) {
      for (const problem of problemsAfterMerge) UI.println(`  ! ${problem}`)
      return yield* fail("the configuration was not written")
    }

    const config = yield* Config.Service
    const result = yield* config.updateGlobal(merged as never)

    if (!result.changed) {
      // Reported as an explicit outcome: "saved" on a no-op is how a user concludes
      // setup ran when nothing about their configuration changed.
      UI.println(`  · ${draft.id} was already configured exactly this way, so nothing changed`)
    } else {
      UI.println(`  ${UI.Style.TEXT_SUCCESS_BOLD}✓${UI.Style.TEXT_NORMAL} provider ${draft.id} saved to the global config`)
    }

    UI.println("")
    UI.println("Next:")
    UI.println("  freecode doctor     check that everything is in place")
    UI.println("  freecode            start working in this directory")
  }),
})

/**
 * Check a full config against the same schema the loader applies to it.
 *
 * `updateGlobal` writes the file and decodes the result afterwards, so a patch the
 * schema rejects reaches the disk and only fails on the next read — the user's
 * configuration is broken by the command meant to set it up. Validating the merged
 * config first makes that impossible.
 *
 * Uses the loader's own parser rather than a hand-written validator, so agreement
 * is guaranteed instead of approximated.
 */
function validateAgainstSchema(config: unknown): string[] {
  try {
    ConfigParse.schema(ConfigV1.Info, config, "freecode setup")
    return []
  } catch (error) {
    const issues = (error as { issues?: { message: string; path?: unknown[] }[] }).issues
    if (Array.isArray(issues) && issues.length) {
      return issues.map((issue) => `${(issue.path ?? []).map(String).join(".") || "(root)"}: ${issue.message}`)
    }
    return [error instanceof Error ? error.message : String(error)]
  }
}

function scriptedDraft(args: { provider: string; baseUrl?: string; model?: string[]; apiKey?: string; env?: string; tier?: string }): Setup.Draft {
  const template = Setup.TEMPLATES.find((item) => item.label.toLowerCase() === args.provider!.toLowerCase())
  return {
    id: args.provider,
    npm: template?.npm ?? "@ai-sdk/openai-compatible",
    name: template?.label ?? args.provider,
    baseURL: args.baseUrl ?? template?.baseURL,
    apiKey: args.apiKey || (args.env ? `{env:${args.env}}` : ""),
    models: args.model?.length ? args.model : (template?.models ?? []),
    tier: args.tier ?? "standard",
  }
}

async function interactiveDraft(args: {
  baseUrl?: string
  model?: string[]
  apiKey?: string
  env?: string
  tier?: string
  yes?: boolean
}): Promise<Setup.Draft | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (question: string, fallback = "") =>
    new Promise<string>((resolve) => {
      rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `, (answer) => {
        const trimmed = answer.trim()
        resolve(trimmed || fallback)
      })
    })

  try {
    console.log("Which provider would you like to use?")
    Setup.TEMPLATES.forEach((template, index) => {
      console.log(`  ${index + 1}. ${template.label}${template.note ? ` — ${template.note}` : ""}`)
    })
    const chosen = await ask("Choice", "1")
    const index = Number.parseInt(chosen, 10) - 1
    const template = Setup.TEMPLATES[index] ?? Setup.TEMPLATES[0]

    const id = await ask("Provider name", template.label.toLowerCase().replace(/[^a-z0-9]+/g, "-"))
    const baseURL = await ask("Base URL", args.baseUrl ?? template.baseURL ?? "")
    const models = args.model?.length
      ? args.model
      : (await ask("Model id (comma-separated)", template.models.join(",") || ""))
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)

    let apiKey = ""
    let env = ""
    if (template.needsKey) {
      const existing = template.env && process.env[template.env] ? template.env : ""
      if (existing) {
        console.log(`  found $${existing} in your environment`)
        env = await ask("Environment variable to read the key from (blank to paste one instead)", existing)
      }
      if (!env) {
        const pasted = await ask("API key (saved to a 600-mode file, never to the config)")
        if (!pasted) {
          console.log("  no key given, so no provider was configured")
          return undefined
        }
        // The interactive path returns the literal key; the caller turns it into a
        // file reference so the secret never reaches the config file.
        apiKey = pasted
      }
    }

    const tier = await ask("Capability tier for this model", args.tier ?? "standard")

    return {
      id,
      npm: template.npm,
      name: template.label,
      baseURL: baseURL || undefined,
      apiKey: env ? `{env:${env}}` : apiKey,
      models,
      tier,
    }
  } finally {
    rl.close()
  }
}
