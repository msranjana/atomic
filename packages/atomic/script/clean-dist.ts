#!/usr/bin/env bun
/**
 * Removes the dist directories for both packages/atomic and packages/atomic-sdk.
 *
 * Usage:
 *   bun run script/clean-dist.ts
 */

import { rm, access } from "node:fs/promises";
import { join } from "node:path";
import { findRepoRoot } from "../src/lib/workspace-paths.ts";

const WORKSPACE_ROOT = findRepoRoot(import.meta.dir);

const DEFAULT_DIST_DIRS: readonly string[] = [
  join(WORKSPACE_ROOT, "packages", "atomic", "dist"),
  join(WORKSPACE_ROOT, "packages", "atomic-sdk", "dist"),
];

/**
 * Removes dist directories and verifies they no longer exist.
 *
 * @param targetDirs - Directories to remove. Defaults to workspace dist dirs.
 * @throws {Error} with path-specific message if any dir still exists after removal.
 */
export async function cleanDist(targetDirs: readonly string[] = DEFAULT_DIST_DIRS): Promise<void> {
  for (const dist of targetDirs) {
    await rm(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

    const stillExists = await access(dist).then(
      () => true,
      () => false,
    );

    if (stillExists) {
      throw new Error(`Cleanup failed: "${dist}" still exists after removal`);
    }
  }
}

// Run when executed directly (not imported).
if (import.meta.main) {
  await cleanDist();
  for (const dist of DEFAULT_DIST_DIRS) {
    console.log(`Removed: ${dist}`);
  }
}
