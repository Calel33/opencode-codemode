// Local-path entry for the OpenCode v2 loader: a configured plugin directory
// resolves via index.ts || index.js at the directory root (verified 2026-10-16
// against opencode 2.0.29). This re-exports the built package entry.
export { default } from "./dist/index.js"
