import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import path from "path"
import os from "os"
import { Setup } from "@/freecode/setup"

const TMP = mkdtempSync(path.join(os.tmpdir(), "freecode-setup-"))

function home(name: string) {
  const directory = path.join(TMP, name)
  return directory
}

describe("setup templates", () => {
  test("every template can produce a valid draft", () => {
    // A template that cannot be validated is a menu entry that dead-ends.
    for (const template of Setup.TEMPLATES) {
      const draft: Setup.Draft = {
        id: template.label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        npm: template.npm,
        name: template.label,
        baseURL: template.baseURL,
        models: template.models.length ? template.models : ["placeholder"],
        tier: "standard",
      }
      expect(Setup.validate(draft)).toEqual([])
    }
  })

  test("the OpenAI-compatible entry is first, because it covers the most providers", () => {
    expect(Setup.TEMPLATES[0]!.label).toBe("OpenAI Compatible")
    expect(Setup.TEMPLATES[0]!.note).toContain("DeepSeek")
  })

  test("a local provider does not require a key", () => {
    const local = Setup.TEMPLATES.find((template) => template.label.includes("Ollama"))
    expect(local?.needsKey).toBe(false)
  })
})

describe("setup validation", () => {
  const base: Setup.Draft = {
    id: "deepseek-main",
    npm: "@ai-sdk/openai-compatible",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    models: ["deepseek-v4-pro"],
    tier: "standard",
  }

  test("accepts a well-formed draft", () => {
    expect(Setup.validate(base)).toEqual([])
  })

  test("rejects a provider id that is not a usable identifier", () => {
    expect(Setup.validate({ ...base, id: "has space" })).toHaveLength(1)
    expect(Setup.validate({ ...base, id: "11start-ok" })).toEqual([])
    expect(Setup.validate({ ...base, id: "-leading" })).toHaveLength(1)
  })

  test("rejects a model id containing a slash", () => {
    // The pool entry is built as `<provider>/<model>`, so a slash would produce an
    // id that cannot be resolved back.
    const problems = Setup.validate({ ...base, models: ["org/model"] })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("must not contain '/'")
  })

  test("rejects a base URL without a scheme", () => {
    expect(Setup.validate({ ...base, baseURL: "api.deepseek.com" })).toHaveLength(1)
    expect(Setup.validate({ ...base, baseURL: "http://127.0.0.1:11434/v1" })).toEqual([])
  })

  test("requires at least one model, because a pool entry cannot be built without one", () => {
    expect(Setup.validate({ ...base, models: [] })).toHaveLength(1)
  })

  test("reports every problem at once rather than the first", () => {
    const problems = Setup.validate({ ...base, id: "bad id", baseURL: "nope", models: [] })
    expect(problems.length).toBeGreaterThanOrEqual(3)
  })
})

describe("the configuration setup writes", () => {
  const draft: Setup.Draft = {
    id: "deepseek-main",
    npm: "@ai-sdk/openai-compatible",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "{file:/tmp/secrets.env}",
    models: ["deepseek-v4-pro", "deepseek-flash"],
    tier: "standard",
  }

  test("fills every tier at and above the declared one", () => {
    const config = Setup.draftToConfig(draft) as {
      freecode: { pool: Record<string, string[]> }
    }
    // A new user has one provider, so every tier they could route to must resolve.
    expect(config.freecode.pool["standard"]).toEqual([
      "deepseek-main/deepseek-v4-pro",
      "deepseek-main/deepseek-flash",
    ])
    expect(config.freecode.pool["strong"]).toEqual(config.freecode.pool["standard"])
    expect(config.freecode.pool["max"]).toEqual(config.freecode.pool["standard"])
  })

  test("leaves tiers below the declared one empty, because a strong model does not imply a cheap one", () => {
    const config = Setup.draftToConfig({ ...draft, tier: "strong" }) as {
      freecode: { pool: Record<string, string[]> }
    }
    expect(config.freecode.pool["local"]).toEqual([])
    expect(config.freecode.pool["fast"]).toEqual([])
    expect(config.freecode.pool["standard"]).toEqual([])
    expect(config.freecode.pool["strong"]).not.toEqual([])
  })

  test("references the key rather than inlining it", () => {
    const text = JSON.stringify(Setup.draftToConfig(draft))
    expect(text).toContain("{file:/tmp/secrets.env}")
    // The point of the reference is that no secret-shaped value reaches the config.
    expect(text).not.toContain("sk-")
  })

  test("omits options entirely when there is no base URL and no key", () => {
    const config = Setup.draftToConfig({ ...draft, baseURL: undefined, apiKey: undefined }) as {
      provider: Record<string, Record<string, unknown>>
    }
    expect(config.provider["deepseek-main"]!.options).toBeUndefined()
  })
})

describe("secret storage", () => {
  test("writes the key with mode 600 and returns a reference", () => {
    const directory = home("secret-new")
    const reference = Setup.writeSecret("DEEPSEEK_API_KEY", "sk-secret-value", directory)

    const file = Setup.secretsPath(directory)
    expect(reference).toBe(`{file:${file}}`)
    expect(readFileSync(file, "utf8")).toContain("export DEEPSEEK_API_KEY=sk-secret-value")
    // Others must not be able to read it: the whole point of a separate file.
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("tightens permissions on an existing file that was too permissive", () => {
    const directory = home("secret-existing")
    const file = Setup.secretsPath(directory)
    Setup.writeSecret("FIRST_KEY", "one", directory)
    writeFileSync(file, readFileSync(file, "utf8"))
    require("fs").chmodSync(file, 0o644)

    Setup.writeSecret("SECOND_KEY", "two", directory)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("appends a second provider's key instead of discarding the first", () => {
    const directory = home("secret-append")
    Setup.writeSecret("FIRST_KEY", "one", directory)
    Setup.writeSecret("SECOND_KEY", "two", directory)

    const text = readFileSync(Setup.secretsPath(directory), "utf8")
    expect(text).toContain("FIRST_KEY=one")
    expect(text).toContain("SECOND_KEY=two")
  })

  test("replaces a key that is set again rather than duplicating it", () => {
    const directory = home("secret-replace")
    Setup.writeSecret("SAME_KEY", "old", directory)
    Setup.writeSecret("SAME_KEY", "new", directory)

    const text = readFileSync(Setup.secretsPath(directory), "utf8")
    expect(text).toContain("SAME_KEY=new")
    expect(text).not.toContain("SAME_KEY=old")
    expect(text.match(/SAME_KEY=/g)).toHaveLength(1)
  })
})
