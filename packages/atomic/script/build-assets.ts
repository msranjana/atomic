import { mkdir, rm, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, basename, extname } from "node:path";
import { $ } from "bun";
import { findRepoRoot } from "../src/lib/workspace-paths.ts";

interface ArchiveSpec {
  outPath: string;
  leafDir: string;
  excludes?: readonly string[];
}

/**
 * Hard cap on per-entry path length inside the embedded tarballs.
 *
 * Windows MAX_PATH is 260 chars. The cache extraction prefix
 * (`%LOCALAPPDATA%\atomic\Cache\<version>\<leaf>\`) is ~85 chars on a
 * long-username install. 150 chars per entry leaves ~25 chars of
 * headroom against the Windows limit and ~60 chars of growth runway
 * over the current longest entry (~89 chars in `.opencode.tar` /
 * `skills.tar`). If a contributor vendors a deeper transitive or
 * adds a deeply-nested skill, the build fails loudly here instead
 * of shipping a binary that explodes at extraction time on Windows.
 */
export const MAX_TARRED_PATH_CHARS = 150;

/** Returns the longest entry that exceeds the limit, or null if none. */
export function findOverlongTarEntry(entries: readonly string[]): string | null {
  let worst = "";
  for (const e of entries) {
    if (e.length > worst.length) worst = e;
  }
  return worst.length > MAX_TARRED_PATH_CHARS ? worst : null;
}

export async function bundleEmbeddedAssets(rootDir: string): Promise<void> {
  // Ensure .agents/ dir exists at workspace root (for skills.tar)
  await mkdir(join(rootDir, ".agents"), { recursive: true });

  const archives: ArchiveSpec[] = [
    { outPath: join(rootDir, ".claude.tar"),           leafDir: join(rootDir, ".claude") },
    { outPath: join(rootDir, ".opencode.tar"),         leafDir: join(rootDir, ".opencode") },
    { outPath: join(rootDir, ".github.tar"),           leafDir: join(rootDir, ".github"),
      excludes: ["workflows", "dependabot.yml"] },
    { outPath: join(rootDir, ".agents", "skills.tar"), leafDir: join(rootDir, ".agents", "skills") },
  ];

  for (const { outPath, leafDir, excludes } of archives) {
    const excludeArgs = (excludes ?? []).map((ex) => `--exclude=${ex}`);
    const r = spawnSync(
      "tar",
      ["-cf", outPath, ...excludeArgs, "-C", leafDir, "."],
      { stdio: "inherit" },
    );
    if (r.status !== 0) {
      throw new Error(
        `bundleEmbeddedAssets: tar failed for ${outPath} (exit ${r.status})`,
      );
    }

    const list = spawnSync("tar", ["-tf", outPath], { encoding: "utf8" });
    if (list.status !== 0) {
      throw new Error(`bundleEmbeddedAssets: tar -tf failed for ${outPath} (exit ${list.status})`);
    }
    const entries = (list.stdout as string).split("\n").filter(Boolean);
    const overlong = findOverlongTarEntry(entries);
    if (overlong) {
      throw new Error(
        `bundleEmbeddedAssets: ${basename(outPath)} contains a ${overlong.length}-char path ` +
        `(limit ${MAX_TARRED_PATH_CHARS}): ${overlong}\n` +
        `Windows MAX_PATH is 260; the cache prefix on long-username installs is ~85 chars, ` +
        `so per-entry paths must stay under ${MAX_TARRED_PATH_CHARS} to leave safe headroom.`,
      );
    }

    console.log(`bundled: ${outPath}`);
  }
}

interface RuntimeScriptSpec {
  /** Absolute path to the canonical TS source. */
  src: string;
  /** Output filename (extension MUST be .js — bundle is ESM JS). */
  outName: string;
}

export async function emitRuntimeScriptBundles(rootDir: string): Promise<void> {
  const destDir = join(rootDir, "packages/atomic-sdk/src/lib/runtime-scripts");
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });

  const scripts: RuntimeScriptSpec[] = [
    {
      src: join(rootDir, "packages/atomic-sdk/src/runtime/cc-debounce.ts"),
      outName: "cc-debounce.script.js",
    },
    {
      src: join(rootDir, "packages/atomic-sdk/src/runtime/orchestrator-entry.ts"),
      outName: "orchestrator-entry.script.js",
    },
  ];

  // Pre-create empty placeholders so any `with { type: "file" }` asset import
  // that recursively references one of these output paths during bundling
  // (e.g. orchestrator-entry.ts -> executor.ts -> runtime-assets.ts ->
  //  ./runtime-scripts/orchestrator-entry.script.js) resolves at bundle time.
  // Each `bun build` invocation below overwrites the placeholder with the real
  // bundle.
  for (const { outName } of scripts) {
    await Bun.write(join(destDir, outName), "");
  }

  for (const { src, outName } of scripts) {
    // Use a per-script temp directory so that asset side-files emitted by
    // `bun build` (e.g. .wasm / .conf from transitive `{ type: "file" }`
    // imports) do not collide with other scripts and the main JS output can be
    // reliably renamed to the canonical `outName`.
    const tmpDir = join(destDir, `.tmp-${outName}`);
    await mkdir(tmpDir, { recursive: true });
    try {
      await $`bun build ${src} --target bun --format esm --outdir ${tmpDir} --external 'node:*' --external 'bun:*'`;
      // bun build --outdir names the entry-point JS after the source file stem,
      // e.g. orchestrator-entry.ts -> orchestrator-entry.js.  Move it to the
      // canonical `outName` (e.g. orchestrator-entry.script.js) in destDir.
      const stem = basename(src, extname(src)); // e.g. "orchestrator-entry"
      await rename(join(tmpDir, `${stem}.js`), join(destDir, outName));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
    console.log(`bundled runtime script: ${outName}`);
  }
}

if (import.meta.main) {
  const rootDir = findRepoRoot(import.meta.dir);
  await Promise.all([
    bundleEmbeddedAssets(rootDir),
    emitRuntimeScriptBundles(rootDir),
  ]);
}
