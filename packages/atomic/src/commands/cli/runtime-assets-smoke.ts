/**
 * Internal smoke command: verifies that runtime sibling assets (tmux.conf,
 * cc-debounce script, orchestrator-entry script) are accessible to spawned
 * OS subprocesses.
 *
 * Why this exists: in a compiled binary, `with { type: "file" }` imports
 * resolve to `/$bunfs/…` paths inside Bun's virtual filesystem. Those
 * paths are readable by Bun APIs but NOT by external processes — so a
 * `tmux -f /$bunfs/.../tmux.conf` invocation fails with "no such file"
 * and `chatCommand` falls back to a plain spawn (no tmux). The
 * `materializeRuntimeAsset` helper in `runtime-assets.ts` copies each
 * asset to `~/.atomic/runtime/<sdk-version>/` on first use to bridge the
 * gap.
 *
 * This command exercises that materialization end-to-end so a CI matrix
 * job (Linux / macOS / Windows) can catch regressions before they ship.
 * Output is human-readable; CI just checks the exit code.
 */

import { existsSync, statSync } from "node:fs";
import {
  ccDebounceScriptPath,
  orchestratorEntryPath,
  tmuxConfPath,
} from "@bastani/atomic-sdk/lib/runtime-assets";
import { isCompiledBinaryRuntime } from "@bastani/atomic-sdk/lib/runtime-env";
import {
  createSession,
  isTmuxInstalled,
  killSession,
} from "@bastani/atomic-sdk/runtime/tmux";

interface CheckResult {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Verify the resolved asset path is on a real on-disk filesystem
 * (not `/$bunfs/`) and points at a non-empty file.
 */
function checkAssetReadable(label: string, path: string): CheckResult {
  if (isCompiledBinaryRuntime(path)) {
    return {
      ok: false,
      detail: `${label}: still under /$bunfs/ — bunfs materialization did not run: ${path}`,
    };
  }
  if (!existsSync(path)) {
    return { ok: false, detail: `${label}: not found on disk: ${path}` };
  }
  const stat = statSync(path);
  if (!stat.isFile() || stat.size === 0) {
    return {
      ok: false,
      detail: `${label}: empty or not a regular file: ${path} (size=${stat.size})`,
    };
  }
  return { ok: true, detail: `${label}: ${stat.size} bytes at ${path}` };
}

/**
 * The end-to-end check: does `tmux` (a regular OS process) successfully
 * load the materialized conf and spin up a session on the atomic socket?
 *
 * `createSession` invokes `tmux -f <conf> -L atomic new-session -d …`.
 * If the conf path is unreadable to tmux, this throws.
 */
function checkTmuxLoadsConf(): CheckResult {
  if (!isTmuxInstalled()) {
    return {
      ok: false,
      detail: "tmux/psmux is not installed — cannot verify conf load",
    };
  }
  const sessionName = `atomic-smoke-${process.pid}`;
  try {
    // `:` is a POSIX no-op shell builtin; on Windows psmux invokes via
    // pwsh where `:` is also a valid no-op (label statement). Either way
    // the session stays alive until we kill it.
    createSession(sessionName, ":");
    killSession(sessionName);
    return { ok: true, detail: `tmux loaded conf and created/destroyed a session on socket "atomic"` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      killSession(sessionName);
    } catch {
      // best-effort cleanup
    }
    return { ok: false, detail: `tmux failed: ${message}` };
  }
}

export async function runtimeAssetsSmokeCommand(): Promise<number> {
  const checks: ReadonlyArray<readonly [string, CheckResult]> = [
    ["tmux.conf", checkAssetReadable("tmux.conf", tmuxConfPath)],
    ["cc-debounce.script.js", checkAssetReadable("cc-debounce.script.js", ccDebounceScriptPath)],
    ["orchestrator-entry.script.js", checkAssetReadable("orchestrator-entry.script.js", orchestratorEntryPath)],
    ["tmux load conf", checkTmuxLoadsConf()],
  ];

  let allOk = true;
  for (const [name, result] of checks) {
    const symbol = result.ok ? "PASS" : "FAIL";
    console.log(`${symbol} ${name}: ${result.detail}`);
    if (!result.ok) allOk = false;
  }

  return allOk ? 0 : 1;
}
