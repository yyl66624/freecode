export * as LayaClient from "./client"

import path from "path"
import { existsSync } from "fs"
import { fileURLToPath } from "url"

/**
 * Client for the persistent Laya bridge subprocess.
 *
 * The bridge is a long-lived Python process talking newline-delimited JSON over
 * stdin/stdout. There is deliberately no HTTP layer: no port to allocate or
 * collide on, no service discovery, no auth, and the process dies with its
 * parent. The checkpoint is loaded once at startup and stays resident, so
 * routing a task costs a forward pass rather than a model load.
 *
 * All failures are contained. A missing interpreter, a missing checkpoint, a
 * crashed bridge, or a timeout resolves to `undefined` and the caller falls
 * back to rules. Routing must never be a reason a user's task fails.
 */

export interface RouteDecision {
  kind: "inspect" | "coding" | "debug" | "test" | "research" | "review" | "docs" | "git"
  tier: "local" | "fast" | "standard" | "strong" | "max"
  difficulty: number
  needsReview: boolean
  parallelizable: boolean
  confidence: number
  /** `laya` when the checkpoint answered, `rules` when it degraded. */
  source: "laya" | "rules"
  reason: string
}

/** Everything the classifier is allowed to see about a task. */
export interface RouteState {
  agent: string
  task: string
  tools?: string[]
  files?: number
  prior_failures?: number
  constraints?: string
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface BridgeStatus {
  loaded: boolean
  model?: string
  load_error?: string
}

const REQUEST_TIMEOUT_MS = 120_000
const SHUTDOWN_GRACE_MS = 2_000

let nextId = 0

/**
 * Locates the bridge interpreter.
 *
 * `FREECODE_PYTHON` wins so a packaged install can point at its bundled
 * runtime. The workspace venv is checked next, then `python3` on PATH.
 */
function resolvePython(repoRoot: string | undefined) {
  const override = process.env["FREECODE_PYTHON"]
  if (override) return override
  if (repoRoot) {
    const venv = path.join(repoRoot, ".runtime", "laya-venv", "bin", "python")
    if (existsSync(venv)) return venv
  }
  return "python3"
}

/**
 * Repo root of the checkout this module runs from.
 *
 * The bridge script and the vendored Laya SDK both live in the repository, so a
 * running FreeCode always drives the revision it shipped with.
 */
function resolveRepoRoot() {
  if (process.env["FREECODE_ROOT"]) return process.env["FREECODE_ROOT"]
  // src/freecode/router/client.ts -> repository root is six levels up.
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, "..", "..", "..", "..", "..", "..")
}

export class Bridge {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
  private pending = new Map<string, Pending>()
  private failed: string | undefined

  constructor(private readonly options: { repoRoot?: string } = {}) {}

  /** Why the bridge is unusable, if it is. */
  get failure() {
    return this.failed
  }

  get running() {
    return this.proc !== undefined
  }

  private start() {
    if (this.proc || this.failed) return

    const root = this.options.repoRoot ?? resolveRepoRoot()
    const script = path.join(root, "opencode-dev", "packages", "opencode", "src", "freecode", "router", "main.py")
    const interpreter = resolvePython(root)

    if (!existsSync(script)) {
      this.failed = `bridge script not found at ${script}`
      return
    }

    try {
      const proc = Bun.spawn({
        cmd: [interpreter, script],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          FREECODE_LAYA_CACHE: process.env["FREECODE_LAYA_CACHE"] ?? path.join(root, ".runtime", "hf-cache"),
          FREECODE_LAYA_DEVICE: process.env["FREECODE_LAYA_DEVICE"] ?? "mps",
        },
      })
      this.proc = proc
      void this.readResponses()
      void this.drainStderr()
      void proc.exited.then((code) => this.onExit(code))
    } catch (error) {
      this.failed = error instanceof Error ? error.message : String(error)
    }
  }

  private async readResponses() {
    const stdout = this.proc?.stdout
    if (!stdout) return

    const decoder = new TextDecoder()
    const reader = stdout.getReader()
    let buffer = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf("\n")
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) this.settle(line)
          newline = buffer.indexOf("\n")
        }
      }
    } catch {
      // A closed pipe during shutdown is expected, not an error worth surfacing.
    } finally {
      reader.releaseLock()
    }
  }

  private async drainStderr() {
    const stderr = this.proc?.stderr
    if (!stderr) return
    const decoder = new TextDecoder()
    const reader = stderr.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        // The bridge writes progress and load errors here; keeping the pipe
        // drained prevents the child blocking on a full buffer.
        if (process.env["FREECODE_LAYA_DEBUG"]) process.stderr.write(decoder.decode(value, { stream: true }))
      }
    } catch {
      // Ignored for the same reason as stdout.
    } finally {
      reader.releaseLock()
    }
  }

  private settle(line: string) {
    let parsed: { id?: string; ok?: boolean; decision?: RouteDecision; error?: string }
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (typeof parsed.id !== "string") return
    const entry = this.pending.get(parsed.id)
    if (!entry) return
    this.pending.delete(parsed.id)
    clearTimeout(entry.timer)
    if (parsed.ok === false) {
      entry.reject(new Error(parsed.error ?? "bridge request failed"))
      return
    }
    // The whole envelope is handed back rather than just `decision`, because
    // not every response carries one (`ping`, `warmup`, `shutdown`) and the
    // callers select the field they own.
    entry.resolve(parsed)
  }

  private onExit(code: number | null) {
    this.proc = undefined
    if (this.pending.size > 0) {
      this.failed = `bridge exited with code ${code}`
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error(this.failed))
      }
      this.pending.clear()
    }
  }

  private send(request: Record<string, unknown>): Promise<unknown> {
    this.start()
    const proc = this.proc
    if (!proc || this.failed) {
      return Promise.reject(new Error(this.failed ?? "bridge is not running"))
    }

    const id = `r${++nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bridge request timed out after ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        // One JSON object per line is the entire protocol; a failed write means
        // the bridge is gone, which the exit handler will also observe.
        proc.stdin.write(JSON.stringify({ id, ...request }) + "\n")
        proc.stdin.flush()
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Route a task. Resolves `undefined` instead of throwing on any failure. */
  async route(state: RouteState): Promise<RouteDecision | undefined> {
    try {
      const response = await this.send({ route: state })
      if (!isRecord(response)) return undefined
      return isRouteDecision(response.decision) ? response.decision : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Liveness probe. `loaded: false` is the expected answer before the first
   * route request, or when the checkpoint is missing and the bridge is serving
   * rules.
   */
  async ping(): Promise<BridgeStatus | undefined> {
    try {
      const response = await this.send({ ping: true })
      if (!isRecord(response)) return undefined
      return {
        loaded: response.loaded === true,
        model: typeof response.model === "string" ? response.model : undefined,
        load_error: typeof response.load_error === "string" ? response.load_error : undefined,
      }
    } catch {
      return undefined
    }
  }

  async stop() {
    const proc = this.proc
    if (!proc) return
    try {
      proc.stdin.write(JSON.stringify({ shutdown: true }) + "\n")
      proc.stdin.flush()
    } catch {
      // The process may already be gone.
    }
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS)),
    ])
    if (!exited) proc.kill()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isRouteDecision(value: unknown): value is RouteDecision {
  return isRecord(value) && typeof value.kind === "string" && typeof value.tier === "string"
}

let shared: Bridge | undefined

/**
 * Process-wide bridge.
 *
 * One subprocess serves every agent in the session: the checkpoint is
 * expensive to load and the bridge answers requests sequentially, which is
 * exactly what a routing decision needs.
 */
export function instance() {
  shared ??= new Bridge()
  return shared
}

export async function route(state: RouteState): Promise<RouteDecision | undefined> {
  return instance().route(state)
}
