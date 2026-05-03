/**
 * Single accessor for runtime-resolved sibling assets (RFC §5.1).
 *
 * Each exported function returns the resolved path to a runtime file embedded
 * via `with { type: "file" }` static imports. Bun resolves these paths
 * correctly in both environments:
 *
 *  - **Compiled binary**: returns a `/$bunfs/…` virtual-filesystem path.
 *  - **Dev / installed package**: returns the absolute source path.
 *
 * This mirrors the `embedded-assets.ts` pattern. Do NOT use `import.meta.dir`
 * inside this module — `with { type: "file" }` is the only correct mechanism
 * for asset resolution under `bun build --compile`.
 */

import tmuxConfAsset from "../runtime/tmux.conf" with { type: "file" };
// @ts-expect-error — `with { type: "file" }` makes Bun treat this as an asset
// path, not a module. TypeScript resolves the real module and errors on the
// missing default export; the suppression is intentional and load-bearing.
import ccDebounceAsset from "../runtime/cc-debounce.ts" with { type: "file" };
// @ts-expect-error — same as above
import orchestratorEntryAsset from "../runtime/orchestrator-entry.ts" with { type: "file" };

/** Resolved path to the tmux.conf runtime asset. */
export function tmuxConfPath(): string {
  return tmuxConfAsset;
}

/** Resolved path to the cc-debounce.ts runtime script. */
export function ccDebounceScriptPath(): string {
  return ccDebounceAsset;
}

/** Resolved path to the orchestrator-entry.ts runtime script. */
export function orchestratorEntryPath(): string {
  return orchestratorEntryAsset;
}
