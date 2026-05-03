// Ambient declarations for static `with { type: "file" }` imports of runtime assets.
// Bun resolves these to absolute paths (dev) or /$bunfs/... paths (compiled binary).
declare module "*.conf" {
  const path: string;
  export default path;
}

// When a .ts file is imported with { type: "file" }, Bun treats it as a data
// asset and returns the resolved path string — not the module exports.
// These overrides shadow the normal module shape for the specific runtime files.
declare module "../runtime/cc-debounce.ts" {
  const path: string;
  export default path;
}

declare module "../runtime/orchestrator-entry.ts" {
  const path: string;
  export default path;
}
