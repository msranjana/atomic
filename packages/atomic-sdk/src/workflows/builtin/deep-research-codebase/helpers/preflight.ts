/**
 * Preflight check for the deep-research-codebase workflow.
 *
 * Ensures uv is installed and CodeGraph is initialized/synced before agents spawn.
 * Called from the scout stage prelude in claude/index.ts, copilot/index.ts, opencode/index.ts.
 */

import CodeGraph from "@colbymchenry/codegraph";
import { ensureUvInstalled } from "../../../../lib/spawn";

export type PreflightResult = {
  codegraphHealthy: boolean;
  uvAvailable: boolean;
  initialized: boolean;
  indexed: boolean;
  synced: boolean;
  supportedLanguageRatio: number;
  nodeCount: number;
  fileCount: number;
  reasons: string[];
};

/**
 * Minimum fraction of source files that must map to a CodeGraph-supported language
 * before we attempt to build the index.
 */
const CODEGRAPH_MIN_SUPPORTED_RATIO = 0.20;

/**
 * File extensions whose languages are supported by CodeGraph.
 * Source: https://github.com/colbymchenry/codegraph README + common language list.
 */
const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".rb",
  ".cpp", ".c", ".h", ".hpp",
  ".cs",
  ".php",
  ".swift",
  ".kt",
  ".scala",
]);

/**
 * Binary / lock-file extensions to exclude from the ratio calculation.
 */
const SKIP_EXTENSIONS = new Set([
  ".lock", ".sum",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".pdf", ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
  ".db", ".sqlite", ".sqlite3",
  ".wasm",
  ".bin", ".exe", ".dll", ".so", ".dylib",
  ".map",
]);

/**
 * Walk source files via `git ls-files` and compute the fraction that map to a
 * CodeGraph-supported language.
 *
 * Files with extensions in SKIP_EXTENSIONS are excluded from both the numerator
 * and denominator so binaries / lock files don't dilute the ratio.
 */
async function calculateSupportedLanguageRatio(projectRoot: string): Promise<number> {
  const proc = Bun.spawn({
    cmd: ["git", "ls-files"],
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const files = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let total = 0;
  let supported = 0;

  for (const file of files) {
    const dotIdx = file.lastIndexOf(".");
    if (dotIdx === -1) {
      // No extension — count as unsupported source file
      total++;
      continue;
    }
    const ext = file.slice(dotIdx).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) continue;
    total++;
    if (SUPPORTED_EXTENSIONS.has(ext)) supported++;
  }

  if (total === 0) return 0;
  return supported / total;
}

/**
 * Run the preflight check for the deep-research-codebase workflow.
 *
 * 1. Ensure uv is installed (needed for ast-grep MCP).
 * 2. Compute the supported language ratio; bail early if too low.
 * 3. Init or open CodeGraph, index or sync, capture stats, close.
 *
 * API note: the spec references `cg.status()` but the installed library exposes
 * `cg.getStats()` (synchronous, returns `GraphStats`). We use `getStats()` and
 * preserve the semantics described in the spec.
 */
export async function preflight(projectRoot: string): Promise<PreflightResult> {
  const reasons: string[] = [];
  let uvAvailable = true;

  try {
    await ensureUvInstalled({ quiet: true });
  } catch (e) {
    uvAvailable = false;
    reasons.push(
      `uv unavailable: ${(e as Error).message}; ast-grep MCP tools will be disabled`,
    );
  }

  const ratio = await calculateSupportedLanguageRatio(projectRoot);

  if (ratio < CODEGRAPH_MIN_SUPPORTED_RATIO) {
    reasons.push(
      `Codegraph skipped: only ${(ratio * 100).toFixed(0)}% of source files map to a supported language`,
    );
    return {
      codegraphHealthy: false,
      uvAvailable,
      initialized: false,
      indexed: false,
      synced: false,
      supportedLanguageRatio: ratio,
      nodeCount: 0,
      fileCount: 0,
      reasons,
    };
  }

  try {
    const initialized = CodeGraph.isInitialized(projectRoot);
    const cg = initialized
      ? await CodeGraph.open(projectRoot)
      : await CodeGraph.init(projectRoot);

    let indexed = false;
    let synced = false;

    if (!initialized) {
      await cg.indexAll();
      indexed = true;
    } else {
      await cg.sync();
      synced = true;
    }

    // spec says `cg.status()` — actual library method is `cg.getStats()` (sync)
    const stats = cg.getStats();
    cg.close();

    return {
      codegraphHealthy: true,
      uvAvailable,
      initialized,
      indexed,
      synced,
      supportedLanguageRatio: ratio,
      nodeCount: stats.nodeCount,
      fileCount: stats.fileCount,
      reasons,
    };
  } catch (e) {
    reasons.push(`Codegraph unhealthy: ${(e as Error).message}`);
    return {
      codegraphHealthy: false,
      uvAvailable,
      initialized: false,
      indexed: false,
      synced: false,
      supportedLanguageRatio: ratio,
      nodeCount: 0,
      fileCount: 0,
      reasons,
    };
  }
}
