import path from "path"
import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { makeGlobalNode } from "./effect/app-node"

// FreeCode rebrands the user-visible application name, so every XDG path below
// resolves under `freecode` instead of `opencode`. Internal package names stay
// `@opencode-ai/*` on purpose — see UPSTREAM.md.
const app = "freecode"

// OpenCode's product directory name, kept here so FreeCode can read an existing
// OpenCode install as a read-only fallback (FREE-30): its global config and its
// `auth.json` credentials live under `opencode` roots, and without this a machine
// that already ran OpenCode would look empty on first start. FreeCode never writes
// under these paths.
const compatApp = "opencode"

const data = path.join(xdgData!, app)
const cache = path.join(xdgCache!, app)
const config = path.join(xdgConfig!, app)
const state = path.join(xdgState!, app)
const tmp = path.join(os.tmpdir(), app)

const opencodeData = path.join(xdgData!, compatApp)
const opencodeConfig = path.join(xdgConfig!, compatApp)

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  data,
  /** OpenCode's data root (`~/.local/share/opencode`). Read-only fallback source. */
  opencodeData,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  /** OpenCode's global config root (`~/.config/opencode`). Read-only fallback source. */
  opencodeConfig,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  /** OpenCode's data root; FreeCode reads it for a read-only credential fallback. */
  readonly opencodeData: string
  readonly cache: string
  readonly config: string
  /** OpenCode's global config root; FreeCode reads it as a read-only fallback. */
  readonly opencodeConfig: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    opencodeData: Path.opencodeData,
    cache: Path.cache,
    config: Flag.OPENCODE_CONFIG_DIR ?? Path.config,
    opencodeConfig: Path.opencodeConfig,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
