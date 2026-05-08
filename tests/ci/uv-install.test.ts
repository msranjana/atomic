/**
 * uv install regression test — cross-platform.
 *
 * Verifies `ensureUvInstalled` (in `@bastani/atomic-sdk/lib/spawn`)
 * actually downloads, installs, and discovers `uv` / `uvx` on every
 * supported OS. Without this, a regression in any of:
 *   - the install script invocation (curl|sh on Unix, irm|iex on Windows)
 *   - the `uvInstallPathCandidates` directory list
 *   - the `refreshWindowsUvPath` / `prependUvInstallPaths` mutation
 *   - the `hasUv()` PATH lookup
 * would only surface at first chat-launch on the affected platform —
 * silently in the field, never on PR.
 *
 * The test spawns a child Bun process with env scrubbed so the
 * runner's pre-installed uv (if any) is invisible:
 *   - HOME / USERPROFILE → temp dir (sandboxes `~/.local/bin`)
 *   - UV_INSTALL_DIR → `<tmp>/uv-bin` (deterministic install location)
 *   - XDG_BIN_HOME / XDG_DATA_HOME → unset (otherwise they take precedence
 *     over UV_INSTALL_DIR in `uvInstallPathCandidates` and could redirect
 *     discovery away from our deterministic dir)
 *   - PATH → all entries containing `uv` / `uvx` filtered out
 *
 * The runner script then asserts ensureUvInstalled lands the binaries
 * under UV_INSTALL_DIR, hasUv() flips to true, and `uvx --version`
 * is invokable.
 *
 * Gated on RUN_CI_E2E=1 — the test downloads the uv installer and runs
 * it, which is too slow / network-dependent for the inner-loop suite.
 */

import { test, expect, afterAll, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const isE2EEnabled = process.env.RUN_CI_E2E === "1";

const sandboxes: string[] = [];

afterAll(async () => {
  await Promise.all(
    sandboxes.map((s) => rm(s, { recursive: true, force: true })),
  );
  sandboxes.length = 0;
}, 60_000);

const exeSuffix = (name: string): string =>
  process.platform === "win32" ? `${name}.exe` : name;

/**
 * Drop any PATH entry that contains a `uv` / `uvx` binary. Without this,
 * the subprocess's `hasUv()` would short-circuit on the runner's pre-
 * installed uv and `ensureUvInstalled` would never exercise the
 * installer.
 */
function scrubUvFromPath(currentPath: string): string {
  return currentPath
    .split(delimiter)
    .filter((dir) => {
      if (!dir) return false;
      try {
        if (existsSync(join(dir, exeSuffix("uv")))) return false;
        if (existsSync(join(dir, exeSuffix("uvx")))) return false;
        return true;
      } catch {
        return true;
      }
    })
    .join(delimiter);
}

describe.skipIf(!isE2EEnabled)("uv install (cross-platform)", () => {
  test(
    "ensureUvInstalled lands uv at UV_INSTALL_DIR and is invokable",
    async () => {
      const sandbox = await mkdtemp(join(tmpdir(), "atomic-uv-"));
      sandboxes.push(sandbox);

      const installDir = join(sandbox, "uv-bin");
      const runner = join(import.meta.dir, "_helpers", "uv-install-runner.ts");
      const repoRoot = join(import.meta.dir, "..", "..");

      const childEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        if (k === "XDG_BIN_HOME" || k === "XDG_DATA_HOME") continue;
        childEnv[k] = v;
      }
      childEnv.PATH = scrubUvFromPath(process.env.PATH ?? "");
      childEnv.HOME = sandbox;
      childEnv.USERPROFILE = sandbox;
      childEnv.UV_INSTALL_DIR = installDir;

      const result = spawnSync("bun", [runner], {
        cwd: repoRoot,
        env: childEnv,
        stdio: "pipe",
        encoding: "utf8",
        timeout: 240_000,
      });

      expect(
        result.status,
        `runner subprocess exited ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain("[ok] hasUv=true");
      expect(result.stdout).toContain("[ok] uvx --version");
    },
    300_000,
  );
});

test.skipIf(isE2EEnabled)(
  "uv install [skip when RUN_CI_E2E unset]",
  () => {
    expect(true).toBe(true);
  },
);
