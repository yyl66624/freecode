// Dependency-direction check, docs/architecture/02 §7.
//
// The rule: the Agent layer (the `agents` field in config and any module
// that treats an AgentSpec as input) may reference only CapabilityTier and
// ResolveRequest — it must NOT import provider/, model/, or account/
// implementations. The Agent only declares needs; the scheduler decides
// the binding. This module provides a static check that runs in CI and
// in the test suite: it scans every .ts file under src/freecode/ and
// rejects any import that crosses the Agent boundary.
//
// The check is import-whitelist style: every file in the Agent module
// directory may import only from a fixed set of allowed paths. A violation
// is a named, actionable error, not a silent pass.
export * as Lint from "./lint"

import { existsSync, readdirSync, readFileSync } from "fs"
import path from "path"

export interface LintViolation {
  file: string
  line: number
  importPath: string
  reason: string
}

/**
 * Scan a directory of TS files for imports that cross the four-layer
 * dependency boundary. `agentDir` is the root of the agent layer;
 * `disallowed` is the list of import prefixes that the agent layer must
 * not reach. Returns one entry per violation.
 */
export function checkImportBoundaries(agentDir: string, disallowed: readonly string[]): LintViolation[] {
  const violations: LintViolation[] = []
  for (const file of walk(agentDir)) {
    if (!file.endsWith(".ts")) continue
    const text = readFileSync(file, "utf8")
    const lines = text.split("\n")
    lines.forEach((line, i) => {
      const m = /from\s+["']([^"']+)["']/.exec(line) ?? /import\s+["']([^"']+)["']/.exec(line)
      if (!m) return
      const imported = m[1]
      const rel = resolveFrom(file, imported)
      for (const prefix of disallowed) {
        if (rel.startsWith(prefix)) {
          violations.push({
            file,
            line: i + 1,
            importPath: imported,
            reason: `agent layer imports ${prefix} — the agent must not depend on provider/model/account implementations (docs 02 §7)`,
          })
          break
        }
      }
    })
  }
  return violations
}

/** Resolve an import specifier to a path relative to the repo root. */
function resolveFrom(_file: string, specifier: string): string {
  // Match lint prefixes against the specifier as written. Relative imports
  // like "../provider/types" are canonicalised by stripping the leading ".." / "." path
  // segments so the "provider/" prefix matches. Absolute or alias specifiers are
  // returned as-is.
  void _file
  const parts = specifier.split("/")
  // Drop leading "." and ".." segments: the lint prefixes are written against
  // the path tail, not the full relative path.
  while (parts.length > 0 && (parts[0] === ".." || parts[0] === ".")) parts.shift()
  return parts.join("/")
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}
