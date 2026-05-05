/**
 * Integration test: `_orchestrator-entry` against the real compiled binary.
 *
 * Regression guard for the dev-vs-binary divergence where Bun's
 * `bun build --compile` collapses every bundled module's
 * `import.meta.path` to the binary's bunfs entry path
 * (`/$bunfs/root/<binary>`), so the `definition.source` captured at
 * workflow-module-eval time pointed at the binary itself. Before the
 * fix, dynamic-importing that path re-loaded `cli.ts` (no default
 * export) and the orchestrator pane died with
 * `"does not export a valid WorkflowDefinition"` while the launcher
 * shell exited 0 — invisible to the chat-style smoke tests.
 *
 * The fix routes binary-mode invocations through the builtin registry
 * by `name + agent`, falling back to dynamic-import for dev /
 * installed-package mode. This test exec's the real binary with the
 * post-fix launcher contract and asserts:
 *   1. The bug signature ("does not export a valid WorkflowDefinition")
 *      does not appear.
 *   2. The action gets past workflow resolution (it complains about
 *      missing ATOMIC_WF_* env, which is the next failure mode in
 *      `runOrchestrator`).
 *   3. An unknown workflow name surfaces a clean registry-miss error,
 *      not the old import-failure error.
 */
import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const builtBinary = locateBuiltBinary();

describe.skipIf(!builtBinary)("compiled binary _orchestrator-entry", () => {
  test("registry-resolves a builtin workflow when source is a bunfs path", () => {
    const bin = builtBinary!;
    // `cli-build-host-default.test.ts` deletes and rebuilds DIST_DIR in
    // parallel; if it ran between locateBuiltBinary() and now, skip
    // rather than fail on a transient ENOENT.
    if (!existsSync(bin)) return;
    // Post-fix arg order: <name> <agent> <inputsB64> <source>.
    // The bunfs source signals "compiled binary" and triggers the
    // registry-lookup branch in the cli action.
    const result = Bun.spawnSync({
      cmd: [bin, "_orchestrator-entry", "ralph", "claude", "", "/$bunfs/root/atomic"],
      stdout: "pipe",
      stderr: "pipe",
      env: stripWorkflowEnv(process.env),
    });

    const out = result.stdout.toString() + result.stderr.toString();

    // Bug signature: pre-fix, the dynamic import re-loaded cli.ts and
    // threw InvalidWorkflowError. The new path never imports the
    // source, so this string must not appear.
    expect(out).not.toContain("does not export a valid WorkflowDefinition");

    // Positive signal: we got past workflow resolution into
    // runOrchestrator → validateOrchestratorEnv. The next failure mode
    // is the missing ATOMIC_WF_* env we deliberately stripped.
    expect(out).toContain("ATOMIC_WF_ID");
  });

  test("unknown workflow name surfaces a clean registry-miss error", () => {
    const bin = builtBinary!;
    if (!existsSync(bin)) return;
    const result = Bun.spawnSync({
      cmd: [bin, "_orchestrator-entry", "no-such-workflow", "claude", "", "/$bunfs/root/atomic"],
      stdout: "pipe",
      stderr: "pipe",
      env: stripWorkflowEnv(process.env),
    });

    const out = result.stdout.toString() + result.stderr.toString();
    expect(out).toContain("no-such-workflow");
    expect(out).toContain("builtin registry");
    expect(result.exitCode).not.toBe(0);
  });
});

function stripWorkflowEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (
      typeof v === "string" &&
      k !== "ATOMIC_WF_ID" &&
      k !== "ATOMIC_WF_TMUX" &&
      k !== "ATOMIC_WF_AGENT" &&
      k !== "ATOMIC_WF_CWD"
    ) {
      out[k] = v;
    }
  }
  return out;
}

function locateBuiltBinary(): string | null {
  const ext = process.platform === "win32" ? ".exe" : "";
  let dir = import.meta.dir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "packages"))) {
      const distRoot = join(dir, "packages", "atomic", "dist");
      const targets = [
        "linux-x64",
        "linux-arm64",
        "darwin-x64",
        "darwin-arm64",
        "windows-x64",
      ];
      for (const target of targets) {
        const candidate = join(distRoot, target, "bin", `atomic${ext}`);
        if (existsSync(candidate)) return candidate;
      }
      return null;
    }
    dir = dirname(dir);
  }
  return null;
}
