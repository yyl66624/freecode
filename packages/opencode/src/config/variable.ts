export * as ConfigVariable from "./variable"

import path from "path"
import os from "os"
import { Filesystem } from "@/util/filesystem"
import { InvalidError } from "@opencode-ai/core/v1/config/error"

type ParseSource =
  | {
      type: "path"
      path: string
    }
  | {
      type: "virtual"
      source: string
      dir: string
    }

type SubstituteInput = ParseSource & {
  text: string
  missing?: "error" | "empty"
  env?: Record<string, string>
}

function source(input: ParseSource) {
  return input.type === "path" ? input.path : input.source
}

function dir(input: ParseSource) {
  return input.type === "path" ? path.dirname(input.path) : input.dir
}

/**
 * The env-var name a shared secrets file is expected to hold for the file
 * `variable.ts` is being loaded from. `account-freecode` writes its
 * secrets file next to the project's config (`.freecode/secrets.env`),
 * so the file's basename minus the `.env` extension is the provider id
 * that `envVarFor` derives the conventional variable from. When the file
 * name is the unqualified `secrets.env` (the shared multi-provider
 * shape), there is no provider hint and the expansion must fall back to
 * the single-assignment rule.
 */
function providerVarNameHint(file: string): string | undefined {
  const base = path.basename(file).replace(/\.env$/i, "")
  if (base && base !== "secrets") {
    return base.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_API_KEY"
  }
  return undefined
}

/**
 * Extract the credential value from a `{file:...}` target.
 *
 * Two file shapes: a bare value file (the legacy single-key shape — the
 * whole trimmed content IS the key) and a shared env file with
 * `VAR=VALUE` / `export VAR=VALUE` lines (what `writeSecret` produces).
 * For the env-file shape we must NOT return the multi-line content — that
 * became the Bearer token and 401'd every request (FREE-28). We return
 * the value of the hinted variable, or the sole assignment when there is
 * exactly one, or `undefined` when the file is ambiguous/missing so the
 * caller reports a missing credential instead of shipping raw text.
 */
function extractValueFromEnvFile(fileContent: string, variable: string | undefined): string | undefined {
  const lines = fileContent
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  const isEnvAssignment = (line: string) => /^(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)
  const assignments = lines.filter(isEnvAssignment)
  if (assignments.length === 0) {
    // Not an env file at all: the whole content is the value (legacy).
    return fileContent
  }
  if (variable) {
    const hit = lines
      .map((line) => line.replace(/^export\s+/, ""))
      .find((line) => line.startsWith(`${variable}=`))
    if (hit) return hit.slice(variable.length + 1).trim()
  }
  if (assignments.length === 1) {
    const plain = assignments[0].replace(/^export\s+/, "")
    return plain.slice(plain.indexOf("=") + 1).trim()
  }
  // Several providers' keys in one file and no usable hint: ambiguous.
  return undefined
}

/** Apply {env:VAR} and {file:path} substitutions to config text. */
export async function substitute(input: SubstituteInput) {
  const missing = input.missing ?? "error"
  let text = input.text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
    return (input.env?.[varName] ?? process.env[varName]) || ""
  })

  const fileMatches = Array.from(text.matchAll(/\{file:[^}]+\}/g))
  if (!fileMatches.length) return text

  const configDir = dir(input)
  const configSource = source(input)
  let out = ""
  let cursor = 0

  for (const match of fileMatches) {
    const token = match[0]
    const index = match.index
    out += text.slice(cursor, index)

    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const prefix = text.slice(lineStart, index).trimStart()
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    let filePath = token.replace(/^\{file:/, "").replace(/\}$/, "")
    if (filePath.startsWith("~/")) {
      filePath = path.join(os.homedir(), filePath.slice(2))
    }

    if (filePath.startsWith("~/")) {
      filePath = path.join(os.homedir(), filePath.slice(2))
    }

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
    const fileContent = (
      await Filesystem.readText(resolvedPath).catch((error: NodeJS.ErrnoException) => {
        if (missing === "empty") return ""

        const errMsg = `bad file reference: "${token}"`
        if (error.code === "ENOENT") {
          throw new InvalidError(
            {
              path: configSource,
              message: errMsg + ` ${resolvedPath} does not exist`,
            },
            { cause: error },
          )
        }
        throw new InvalidError({ path: configSource, message: errMsg }, { cause: error })
      })
    ).trim()

    const providerVar = providerVarNameHint(filePath)
    const value = extractValueFromEnvFile(fileContent, providerVar)
    if (value === undefined) {
      // Ambiguous env-file target (several providers' keys, no usable
      // hint): leave the token in place so the layer that knows the
      // provider id (ProviderTest.expandApiKeyPlaceholder, FREE-27 M2)
      // can extract its own variable's value. Never substitute the raw
      // multi-line content — that is the FREE-28 401 root cause.
      out += token
    } else {
      out += JSON.stringify(value).slice(1, -1)
    }
    cursor = index + token.length
  }

  out += text.slice(cursor)
  return out
}
