export * as FreeCode from "./freecode"

/**
 * Single source of truth for FreeCode's user-visible product identity.
 *
 * Every rebranding seam reads from here instead of hardcoding strings, so the
 * fork's surface stays auditable as one small diff against upstream.
 */
export const Product = {
  /** Executable name shown in help, usage, and shell completion. */
  binary: "freecode",
  /** Human-readable product name used in banners and prompts. */
  name: "FreeCode",
  /** Directory name for the global config root: `~/.config/freecode`. */
  globalConfigDir: "freecode",
  /** Project-local config directory name. */
  projectConfigDir: ".freecode",
} as const

/**
 * Config entry names searched inside a config directory, earliest first.
 *
 * `.opencode` directories answer only to their own name; `.freecode` (and the
 * global root) read all three, so a project can migrate file by file. `config`
 * stays last because upstream also accepts it as a bare legacy filename.
 */
export const configFileNames = ["freecode", "opencode", "config"] as const

/**
 * Project config directory names recognized while walking up from the working
 * directory. `.opencode` remains supported for backward compatibility.
 */
export const projectConfigDirs = [Product.projectConfigDir, ".opencode"] as const
