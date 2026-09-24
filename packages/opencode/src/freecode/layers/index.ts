// The four-layer module: Agent / Provider / Model / Account, the
// configuration layer of docs/architecture/02.
//
//   types.ts     — data model + schema validation + isolation
//   config.ts    — load, merge, plaintext gate
//   templates.ts — built-in provider/model/account templates
//   store.ts     — ResourceStore registration registry
//   lint.ts      — dependency-direction check (CI rule)
export * as Layers from "./types"
export * as Config from "./config"
export * as Templates from "./templates"
export * as ResourceStore from "./store"
export * as Lint from "./lint"
