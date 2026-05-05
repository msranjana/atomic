import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoRoot } from "../../src/lib/workspace-paths.ts";
import { TARGETS, hostTarget } from "../targets.ts";

const SKIP_PUBLISH = process.env.ATOMIC_SKIP_PUBLISH_BUILD_TEST === "1";

const WORKSPACE_ROOT = findRepoRoot(import.meta.dir);

const HOST_TARGET = hostTarget();
const OTHER_TARGETS = TARGETS.map((t) => t.name).filter((n) => n !== HOST_TARGET);

// Use an isolated temp dist dir instead of `packages/atomic/dist`.
// Concurrent test files (orchestrator-entry, attached-footer) hold
// the real `atomic.exe` open while running; rm-then-rebuild against
// that path then loses to Windows file locks with EACCES. The build
// script honours `ATOMIC_BUILD_DIST_DIR` for exactly this reason.
let isolatedDist: string;

beforeAll(async () => {
  isolatedDist = await mkdtemp(join(tmpdir(), "atomic-build-test-"));
});

afterAll(async () => {
  if (isolatedDist) {
    await rm(isolatedDist, { recursive: true, force: true }).catch(() => {});
  }
});

test.skipIf(SKIP_PUBLISH)(
  "no-arg build.ts builds only host target",
  async () => {
    const proc = Bun.spawn(["bun", "packages/atomic/script/build.ts"], {
      cwd: WORKSPACE_ROOT,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, ATOMIC_BUILD_DIST_DIR: isolatedDist },
    });
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    const entries = await readdir(isolatedDist);

    expect(entries).toContain(HOST_TARGET);

    for (const other of OTHER_TARGETS) {
      expect(entries).not.toContain(other);
    }
  },
  60_000,
);
