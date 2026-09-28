/**
 * TUI-side rebrand constants.
 *
 * The TUI package cannot import from `@/freecode/freecode` (which lives in the
 * opencode package, not in `@opencode-ai/*` packages the TUI depends on).
 * These constants mirror `FreeCode.Product` in `packages/opencode/src/freecode/freecode.ts`.
 * If a constant there changes, update it here too — a rebrand is two files.
 *
 * The comment in `freecode.ts` ("Every rebranding seam reads from here instead
 * of hardcoding strings") is the invariant; this module extends it to the TUI
 * boundary where a direct import is not possible.
 */
export const TUI_PRODUCT = {
  /** Executable name; same as `FreeCode.Product.binary`. */
  binary: "freecode",
  /** Human-readable product name; same as `FreeCode.Product.name`. */
  name: "FreeCode",
  /** Terminal window/tab title prefix, 2 chars so it fits alongside session titles. */
  titlePrefix: "FC",
  /** Docs/help link; same as `FreeCode.Product.docsUrl` (`freecode-main`, the
   * repository's default branch — there is no `main` branch to link to). */
  docsUrl: "https://github.com/yyl66624/freecode/blob/freecode-main/docs/README.md",
} as const
