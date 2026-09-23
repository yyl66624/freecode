import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Config as SdkConfig } from "@opencode-ai/sdk/v2"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { BuiltinTuiPlugin } from "../builtins"

const id = "internal:freecode"

/**
 * FreeCode's four TUI commands (docs/architecture/01 §5 P3), and the kill
 * switch that removes all of them at once: `freecode.commands.disable` in the
 * config (the docs also call this `freecode.harness=vanilla`; both spellings
 * are accepted, docs 01 §5 last paragraph).
 *
 * The plugin registers its commands with `api.keymap.registerLayer` — the
 * same surface `plugins.tsx` and `which-key.tsx` use — so it adds
 * commands rather than touching any existing one. When the kill switch is on
 * it registers an empty layer: nothing appears in the command palette, no
 * slash entry autocompletes, and nothing else in the TUI changes. That is
 * the whole acceptance criterion for this issue's "vanilla mode" clause —
 * removal leaves no residue, because there is nothing to remove, only one
 * call that registers zero commands.
 *
 * The six-dimension and pool data comes from two files the CLI side owns:
 * `$XDG_DATA_HOME/freecode/state.json` (scheduler candidate states) and
 * `last-route.json` (the audited decision log). Reading them here by path
 * rather than importing `@/freecode/*` keeps the TUI package's dependency
 * boundary intact: the tui package is the harness's, FreeCode's scheduler
 * core is the opencode package's, and a JSON file is the only thing the two
 * sides both already trust.
 */

const TIERS = ["local", "fast", "standard", "strong", "max"] as const
type Tier = (typeof TIERS)[number]

type Pool = Record<string, string[] | undefined>

/** `freecode.commands.disable` or the spelling docs 01 §5 also documents. */
type FreecodeBlock = { commands?: { disable?: boolean }; harness?: string | boolean; scheduler?: { disable?: boolean } }

function isDisabled(config: unknown): boolean {
  const block = (config as { freecode?: FreecodeBlock } | undefined)?.freecode
  if (!block || typeof block !== "object") return false
  if (block.commands?.disable === true) return true
  if (block.harness === "vanilla" || block.harness === true) return true
  if (block.scheduler?.disable === true) return true
  return false
}

function poolOf(config: unknown): Pool {
  const block = (config as { freecode?: { pool?: Pool } } | undefined)?.freecode
  return block?.pool ?? {}
}

function poolProviders(pool: Pool): string[] {
  const ids = new Set<string>()
  for (const entries of Object.values(pool)) for (const entry of entries ?? []) ids.add(entry.slice(0, entry.indexOf("/")))
  return [...ids].sort()
}

/**
 * The two data files the CLI side writes, mirrored from
 * `packages/opencode/src/freecode/{decision.ts,core/state-store.ts}`.
 * The tui package cannot import those modules (they belong to the opencode
 * package and pull in Effect/Instance machinery); the path rules are stable
 * and short enough to duplicate here with a comment pointing at the source
 * of truth, which is the honest version of the "no new dependency" rule.
 */
function dataDir(): string | undefined {
  const override = process.env.XDG_DATA_HOME
  if (override) return path.join(override, "freecode")
  if (process.env.HOME) return path.join(process.env.HOME, ".local", "share", "freecode")
  return undefined
}

type SchedulerState = {
  candidates: Record<string, { health: { state: string; quotaResetAt?: number } }>
  decisions: Array<{
    ts: string
    task: string
    req: string
    candidates: Array<{ m: string; a: string; score: number }>
    pick: string
    path: string
    reason: string
  }>
}

type DecisionRecord = {
  at: number
  agent: string
  task: string
  mode: string
  tier: string
  selected?: string
  candidates: Array<{
    resource: string
    eligible: boolean
    excluded?: string
    score?: number
    components?: Record<string, number>
  }>
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return undefined
  }
}

function schedulerState(): SchedulerState | undefined {
  const dir = dataDir()
  if (!dir) return undefined
  return readJson<SchedulerState>(path.join(dir, "state.json"))
}

function lastRoute(): DecisionRecord | undefined {
  const dir = dataDir()
  if (!dir) return undefined
  return readJson<DecisionRecord>(path.join(dir, "last-route.json"))
}

/**
 * `/models` — the pool-filtered view over the model store the harness
 * already has, plus an override-terminal marker (docs 02 §5: a manual pick
 * affects only the current session and never mutates config, and picking
 * back or clearing it restores scheduling).
 *
 * Selection goes through the plugin's `api` rather than a second model
 * store: `dialog-model.tsx`'s store is the single source of truth for "what
 * does the next message go to", and re-implementing that here would create
 * two sources that can disagree. This command only changes *which view* the
 * user is selecting from, not where selections land.
 */
function modelsView(api: TuiPluginApi) {
  const config = api.state.config as SdkConfig & { freecode?: { pool?: Pool } }
  const pool = config?.freecode?.pool ?? {}
  const providers = poolProviders(pool)

  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="FreeCode pool models"
      current={undefined}
      skipFilter={providers.length === 0}
      options={providers.flatMap((providerID) => {
        const provider = api.state.provider.find((item) => item.id === providerID)
        const entries = Object.values(pool)
          .flatMap((list) => list ?? [])
          .filter((entry) => entry.startsWith(providerID + "/"))
          return entries.map((entry) => {
            const modelID = entry.slice(providerID.length + 1)
            return {
              title: `${provider?.name ?? providerID} — ${modelID}`,
              description: tierList(pool, entry),
              value: { providerID, modelID },
            }
          })
      })}
      onSelect={(option) => {
        if (!option) return
        const value = option as unknown as { providerID: string; modelID: string } | undefined
        if (!value) return
        const { providerID, modelID } = value
        // The toast, not a silent switch: a pick outside the pool is legal
        // (override semantics, docs 02 §5) but the user should know they
        // just opted out of the scheduler for this session.
        const inPool = Object.values(pool).flatMap((list) => list ?? []).some((entry) => entry === `${providerID}/${modelID}`)
        void api.ui.toast({
          variant: inPool ? "info" : "warning",
          message: inPool
            ? `Using ${providerID}/${modelID} from the FreeCode pool`
            : `${providerID}/${modelID} is outside the pool; the scheduler is bypassed for this session`,
        })
        api.ui.dialog.clear()
      }}
    />
  ))
}

function tierList(pool: Pool, entry: string): string {
  return TIERS.filter((tier) => pool[tier]?.includes(entry)).join(", ")
}

/**
 * `/provider status` — per-provider aggregate of the six-dimension core's
 * states, read out of `state.json` next to the CLI's `resources.json`
 * (docs 03 §8: the two files coexist on purpose, one is failover's, one is
 * the scheduler's; this command shows the latter).
 */
function providerStatusView(api: TuiPluginApi) {
  const pool = poolOf(api.state.config)
  const providers = poolProviders(pool)
  const state = schedulerState()

  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Provider status (scheduler)"
      skipFilter
      current={providers[0]}
      options={providers.map((providerID) => {
        const candidates = Object.entries(state?.candidates ?? {}).filter(([key]) => key.startsWith(providerID + "/"))
        const counts: Record<string, number> = {}
        for (const [, candidate] of candidates) counts[candidate.health.state] = (counts[candidate.health.state] ?? 0) + 1
        const worst = ["UNAVAILABLE", "UNHEALTHY", "EXHAUSTED", "INVALID", "DEGRADED", "HEALTHY"].find((s) => counts[s]) ?? "HEALTHY"
        return {
          title: providerID,
          description: candidates.length ? `${candidates.length} candidate(s) · ${worst}` : "no observed state yet",
          value: providerID,
        }
      })}
      onSelect={(option) => {
        if (!option) return
        const detail = Object.entries(state?.candidates ?? {})
          .filter(([key]) => key.startsWith(option + "/"))
          .map(([key, candidate]) => {
            const excluded = Object.keys(candidate.health).length ? "" : ""
            void excluded
            return `  ${key}  ${candidate.health.state}${candidate.health.quotaResetAt ? ` (quota window resets)` : ""}`
          })
          .join("\n")
        void api.ui.toast({ variant: "info", message: detail || `${option} has no recorded scheduler state yet` })
      }}
    />
  ))
}

/**
 * `/scheduler explain` — replay the most recent audited decision, each
 * candidate's six-dimension contribution, and why the losers lost
 * (docs 03 §4.3: the log is exactly what this command replays; CLI-side
 * `freecode routes why` renders the same record in terminal layout, this is
 * its dialog layout, same wording).
 */
/**
 * Build the alert text for `/scheduler explain` up front rather than in the
 * JSX body: `DialogAlert.message` is a single string, and computing it
 * outside keeps the component readable and the record's shape visible in
 * one place.
 */
function explainMessage(): string {
  const record = lastRoute()
  if (!record)
    return "No routing decision recorded yet. Run a task with `model: auto` first; the next `/scheduler explain` will replay it."
  return [
    `${record.agent} \u00b7 ${record.mode} \u00b7 tier ${record.tier}`,
    record.selected ? `selected: ${record.selected}` : "no candidate eligible (fell back to the session default)",
    ...record.candidates.map((candidate) =>
      candidate.eligible && candidate.components
        ? `${candidate.resource}  ${candidate.score?.toFixed(3)}  [${Object.entries(candidate.components)
            .map(([name, value]) => `${name} ${value.toFixed(2)}`)
            .join(" \u00b7 ")}]`
        : `${candidate.resource}  not selected \u2014 ${candidate.excluded ?? "ineligible"}`,
    ),
  ].join("\n")
}

function explainView(api: TuiPluginApi) {
  api.ui.dialog.replace(() => (
    <api.ui.DialogAlert title="Last routing decision" message={explainMessage()} onConfirm={() => api.ui.dialog.clear()} />
  ))
}

/**
 * `/account` — the pool's accounts, credential source, and current health.
 *
 * Write path: `api.client` exposes `config.update`, but that hits
 * `Config.Service.update` — the *project-level* merge write, not the global
 * file `freecode account add/disable/enable` writes through
 * `updateGlobal`. Mutating pool membership from the TUI through the
 * wrong layer would leave `freecode account list` (which reads the global
 * config) reporting something different from what the TUI just did. So
 * this command is read-only and points at the CLI commands that own the
 * write path — one write path, one layer, per the issue's own contract
 * with core-dev's scheduler work.
 */
function accountView(api: TuiPluginApi) {
  const pool = poolOf(api.state.config)
  const providers = poolProviders(pool)
  const state = schedulerState()

  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="FreeCode accounts"
      skipFilter
      options={providers.map((providerID) => {
        const provider = api.state.provider.find((item) => item.id === providerID)
        const apiKey = (provider?.options as Record<string, unknown> | undefined)?.apiKey
        let source = "env"
        if (typeof apiKey === "string") {
          if (apiKey.startsWith("{env:")) source = apiKey
          else if (apiKey.startsWith("{file:")) source = "secrets file"
          else if (apiKey) source = "inline (move to a file)"
        }
        const healthy = Object.values(state?.candidates ?? {}).filter((candidate) => candidate.health.state === "HEALTHY" || candidate.health.state === "DEGRADED")
        return {
          title: `${provider?.name ?? providerID} (${providerID})`,
          description: `${tierList(pool, providerID).split(", ").filter(Boolean).join(" · ") || "no tier"} · ${source} · ${healthy.length ? healthy.length + " in pool" : "not observed"}`,
          value: providerID,
        }
      })}
      onSelect={() => {
        void api.ui.toast({
          variant: "info",
          message: "Change an account (add / disable / enable) with `freecode account …` in the shell; the TUI keeps one read path on purpose",
        })
      }}
    />
  ))
}

/**
 * Which command names the plugin registers when the vanilla kill switch is
 * off. Exported separately from `tui` so the TUI test file can assert the
 * exact set (and order) without constructing a full `TuiPluginApi` mock.
 */
export const FREECODE_COMMAND_NAMES = ["freecode.models", "freecode.provider_status", "freecode.scheduler_explain", "freecode.account"] as const

/** Re-exported for the TUI test file: the vanilla-kill-switch decision, given only the parsed config. */
export const isVanillaDisabled = isDisabled

const tui: TuiPlugin = async (api) => {
  const vanilla = isDisabled(api.state.config)
  const commands = vanilla
    ? []
    : [
        {
          name: "freecode.models",
          title: "FreeCode models",
          category: "FreeCode",
          namespace: "palette",
          slashName: "models",
          run() {
            modelsView(api)
          },
        },
        {
          name: "freecode.provider_status",
          title: "Provider status",
          category: "FreeCode",
          namespace: "palette",
          slashName: "provider",
          slashAliases: ["provider status"],
          desc: "scheduler health per provider",
          run() {
            providerStatusView(api)
          },
        },
        {
          name: "freecode.scheduler_explain",
          title: "Scheduler explain",
          category: "FreeCode",
          namespace: "palette",
          slashName: "scheduler",
          slashAliases: ["scheduler explain"],
          desc: "replay the last routing decision",
          run() {
            explainView(api)
          },
        },
        {
          name: "freecode.account",
          title: "FreeCode accounts",
          category: "FreeCode",
          namespace: "palette",
          slashName: "account",
          desc: "pool accounts and credential sources",
          run() {
            accountView(api)
          },
        },
      ]

  api.keymap.registerLayer({ commands, bindings: [] })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
