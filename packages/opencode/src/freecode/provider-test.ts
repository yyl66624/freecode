export * as ProviderTest from "./provider-test"

import { existsSync, readFileSync } from "fs"
import path from "path"

/**
 * One provider's reachability, without spending a single token.
 *
 * The SUSPENDED checklist (docs/architecture/adr/004-suspension-semantics.md)
 * needs this to be a real command, not a guess: "check the local model"
 * only helps when the answer distinguishes "endpoint is down" from
 * "credential is wrong" from "no credential at all" — each has a
 * different remedy, and only an actual request tells them apart.
 *
 * `GET {baseURL}/models` for OpenAI-compatible endpoints, `GET /api/tags`
 * for Ollama, is the whole probe. No chat completion: that would cost the
 * user tokens for a health check and is not what "is this alive" needs.
 */

export type ProbeResult =
  | { ok: true; status: number; latencyMs: number; detail: string }
  | { ok: false; status?: number; latencyMs?: number; detail: string; hint?: string }

/**
 * Ollama's local protocol does not expose `/models`; `/api/tags` is the
 * cheap equivalent. Anything else is treated as OpenAI-compatible, which
 * is what `freecode setup` writes for every non-Ollama template.
 */
export function probeUrl(id: string, baseURL: string): string {
  if (id === "ollama" || baseURL.includes(":11434")) return "http://127.0.0.1:11434/api/tags"
  return `${baseURL.replace(/\/$/, "")}/models`
}

/** The documented env-var name for a provider id: `DEEPSEEK_MAIN` → `DEEPSEEK_MAIN_API_KEY`. */
export function envVarFor(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_API_KEY"
}

/**
 * Expand a placeholder in `options.apiKey` to its real value.
 *
 * Two placeholder forms are recognised:
 * - `{env:VAR}`       — looked up in `envs` (no process.env fallback).
 * - `{file:/path}`    — read the line `<providerEnvVar>=...` from the file.
 *
 * Returns `undefined` when the placeholder cannot be resolved. The caller
 * decides what to do with a missing credential; this function is pure
 * (no process.env access) so it can be shared by the probe and the
 * provider layer without pulling in `process.env` as an implicit input.
 */
export function expandApiKeyPlaceholder(
  apiKey: string,
  id: string,
  envs: Record<string, string | undefined>,
): string | undefined {
  const envMatch = apiKey.match(/^\{env:([^}]+)\}$/)
  if (envMatch) return envs[envMatch[1]]

  const fileMatch = apiKey.match(/^\{file:([^}]+)\}$/)
  if (fileMatch) {
    const file = fileMatch[1]
    if (!existsSync(file)) return undefined
    const variable = envVarFor(id)
    const line = readFileSync(file, "utf8")
      .split("\n")
      .find((entry) => entry.replace(/^export\s+/, "") === `${variable}=` || entry.startsWith(`${variable}=`))
    if (!line) return undefined
    return line.replace(/^export\s+/, "").slice(variable.length + 1).trim()
  }

  return undefined
}

/**
 * Resolve the credential for this provider, in the order the config loader
 * would try it: an explicit `{env:VAR}` / `{file:path}` / literal key in
 * `options.apiKey`, then the provider's conventional env var.
 */
export function resolveCredential(id: string, options: Record<string, unknown> | undefined): string | undefined {
  const apiKey = options?.apiKey
  if (typeof apiKey === "string" && apiKey) {
    const placeholder = expandApiKeyPlaceholder(apiKey, id, process.env as Record<string, string | undefined>)
    if (placeholder !== undefined) return placeholder
    if (!apiKey.startsWith("{")) return apiKey
  }
  return process.env[envVarFor(id)]
}

/**
 * Probe one provider. Pure-ish: the only impurity is the fetch itself.
 *
 * - 2xx → reachable, report latency.
 * - 401/403 → reachable but the credential was refused: the endpoint works,
 *   the key does not. This distinction is the whole point of the command.
 * - timeout → network or a hung endpoint; report the timeout, not a 500.
 * - anything else → report the status code as-is.
 */
export async function probe(
  id: string,
  options: Record<string, unknown> | undefined,
  timeoutMs = 8000,
): Promise<ProbeResult> {
  const baseURL = typeof options?.baseURL === "string" ? (options.baseURL as string) : undefined
  const isOllama = id === "ollama" || !!baseURL?.includes(":11434")
  if (!baseURL && !isOllama) {
    return {
      ok: false,
      detail: `no base URL configured for ${id}`,
      hint: `run \`freecode setup\` or set provider.${id}.options.baseURL`,
    }
  }
  const url = probeUrl(id, baseURL ?? "http://127.0.0.1:11434/v1")
  const key = isOllama ? undefined : resolveCredential(id, options)
  const headers: Record<string, string> = {}
  if (key) headers["Authorization"] = `Bearer ${key}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = performance.now()
  try {
    const response = await fetch(url, { signal: controller.signal, headers })
    const latencyMs = Math.round(performance.now() - start)
    const status = response.status
    if (status >= 200 && status < 300) {
      return { ok: true, status, latencyMs, detail: `${status} in ${latencyMs}ms — ${url}` }
    }
    if (status === 401 || status === 403) {
      return {
        ok: false,
        status,
        latencyMs,
        detail: `endpoint is reachable but refused the credential (${status})`,
        hint: key
          ? `the credential ${key === process.env[envVarFor(id)] ? envVarFor(id) : "in config"} was rejected — check the key, not the network`
          : "no credential found; add one with `freecode account add`",
      }
    }
    return { ok: false, status, latencyMs, detail: `${status} in ${latencyMs}ms — ${url}` }
  } catch (error) {
    const latencyMs = Math.round(performance.now() - start)
    if (controller.signal.aborted) {
      return {
        ok: false,
        latencyMs,
        detail: `timed out after ${timeoutMs}ms — ${url}`,
        hint: "check network / proxy, or that the endpoint is up (for Ollama: `ollama serve`)",
      }
    }
    return { ok: false, latencyMs, detail: `${(error as Error).message} — ${url}` }
  } finally {
    clearTimeout(timer)
  }
}
