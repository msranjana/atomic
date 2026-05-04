/**
 * Resolved paths to runtime sibling assets (RFC §5.1).
 *
 * Each export holds the path that `with { type: "file" }` resolves to:
 *
 *  - **Compiled binary**: a `/$bunfs/…` virtual-filesystem path.
 *  - **Dev / installed package**: the absolute source path.
 *
 * `with { type: "file" }` is the only correct mechanism for asset resolution
 * under `bun build --compile`. Do NOT use `import.meta.dir` inside this module.
 *
 * The `.script.js` bundles under `runtime-scripts/` are emitted by
 * `emitRuntimeScriptBundles` (RFC §5.3) so a runtime asset import never
 * collides with a module import of the canonical `cc-debounce.ts` /
 * `orchestrator-entry.ts` source (RFC §5.6).
 *
 * ### Bunfs materialization
 *
 * In a compiled binary, `with { type: "file" }` returns a `/$bunfs/…` path
 * that is accessible to Bun APIs but NOT to spawned OS processes — `tmux`
 * cannot read `/$bunfs/.../tmux.conf`, and a re-exec'd `bun` cannot resolve
 * `/$bunfs/.../orchestrator-entry.script.js` from a different binary
 * instance. Mirrors the tarball treatment in
 * `packages/atomic/src/lib/embedded-assets.ts`.
 *
 * To bridge that gap we copy each asset to a stable on-disk cache the
 * first time this module loads in a compiled binary. Subsequent loads see
 * an existing destination and skip the write. In dev / installed-package
 * runtime the import already resolves to a real on-disk path, so the
 * helper is a no-op.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import sdkPackageJson from "../../package.json";
import { isCompiledBinaryRuntime } from "./runtime-env.ts";

import tmuxConfAsset          from "../runtime/tmux.conf"                           with { type: "file" };
// `with { type: "file" }` makes Bun return a path string at runtime, but TypeScript
// resolves the `.js` bundle as a module under `allowJs`. The suppression is
// intentional and load-bearing.
// @ts-expect-error see comment above
import ccDebounceAsset         from "./runtime-scripts/cc-debounce.script.js"        with { type: "file" };
// @ts-expect-error see comment above
import orchestratorEntryAsset  from "./runtime-scripts/orchestrator-entry.script.js" with { type: "file" };

const SDK_VERSION = sdkPackageJson.version;

/**
 * Cache root for materialized runtime assets.
 *
 * Lives under `~/.atomic/runtime/<sdk-version>/` rather than the platform
 * cache dir (`~/.cache`, `~/Library/Caches`, `%LOCALAPPDATA%\…\Cache`):
 *
 *  - `~/.cache` and friends are routinely wiped by users / cleanup tools.
 *    A wipe between atomic runs would force a re-extract on next launch
 *    — recoverable, but a needless cost.
 *  - All other atomic state already lives under `~/.atomic` (sessions/,
 *    tmp/, bin/, .synced-version), so keeping runtime assets there gives
 *    operators a single directory to inspect when debugging.
 *
 * Versioning the path lets two atomic versions share the same machine
 * without their assets stomping each other; a stale version directory
 * is a few KB and harmless.
 */
export function runtimeAssetsCacheDir(home: string = homedir()): string {
  return join(home, ".atomic", "runtime", SDK_VERSION);
}

/**
 * Copy a `/$bunfs/…` asset to a real on-disk path so spawned OS
 * subprocesses can read it. Returns `bundledPath` unchanged in dev /
 * installed-package runtime.
 *
 * Async because `/$bunfs/` paths are NOT readable via OS-level syscalls
 * (`copyfile(2)`, `open(2)`, …) — they only work through Bun's
 * `Bun.file()` API, which is async-only. Module-level evaluation uses
 * top-level await to keep the public API a plain `string` constant.
 *
 * Idempotent: when the destination already exists we skip the write.
 * The cache key includes the SDK version so an upgrade transparently
 * invalidates the cache without us having to hash file contents on
 * every startup.
 */
export async function materializeRuntimeAsset(
  bundledPath: string,
  cacheDir: string = runtimeAssetsCacheDir(),
): Promise<string> {
  if (!isCompiledBinaryRuntime(bundledPath)) return bundledPath;

  const dest = join(cacheDir, basename(bundledPath));
  if (existsSync(dest)) return dest;

  mkdirSync(dirname(dest), { recursive: true });
  // `copyFileSync` and friends fail with ENOENT against `/$bunfs/` source
  // paths — Bun's virtual FS is only exposed through `Bun.file()` /
  // `Bun.write()`. Mirrors `packages/atomic/src/lib/embedded-assets.ts`.
  await Bun.write(dest, await Bun.file(bundledPath).bytes());
  return dest;
}

/** Resolved path to the tmux.conf runtime asset. */
export const tmuxConfPath: string = await materializeRuntimeAsset(tmuxConfAsset);

/** Resolved path to the cc-debounce runtime script. */
export const ccDebounceScriptPath: string = await materializeRuntimeAsset(ccDebounceAsset);

/** Resolved path to the orchestrator-entry runtime script. */
export const orchestratorEntryPath: string = await materializeRuntimeAsset(orchestratorEntryAsset);
