/**
 * Subprocess body for `tests/ci/uv-install.test.ts`.
 *
 * Runs in a controlled env (sandboxed HOME, UV_INSTALL_DIR set, PATH
 * scrubbed of any pre-existing uv) so the parent test can verify that
 * `ensureUvInstalled` exercises the full installer + PATH-discovery
 * code path on every supported platform — not just the early-return.
 *
 * Exits 0 on success; prints assertion failures to stderr and exits
 * non-zero on any failure. The parent test asserts on exit code and
 * the [ok] markers printed to stdout.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ensureUvInstalled,
  hasUv,
} from "../../../packages/atomic-sdk/src/lib/spawn.ts";

const installDir = process.env.UV_INSTALL_DIR;
if (!installDir) {
  console.error("UV_INSTALL_DIR must be set by the parent test");
  process.exit(2);
}

const exeSuffix = (name: string): string =>
  process.platform === "win32" ? `${name}.exe` : name;

if (hasUv()) {
  console.error(
    "hasUv() returned true before install — parent test failed to scrub uv from PATH",
  );
  process.exit(2);
}
console.log("[start] uv not on PATH; running ensureUvInstalled");

await ensureUvInstalled({ quiet: true });

const uvPath = join(installDir, exeSuffix("uv"));
const uvxPath = join(installDir, exeSuffix("uvx"));

if (!existsSync(uvPath)) {
  console.error(`Expected uv at ${uvPath}; not found after install`);
  process.exit(1);
}
if (!existsSync(uvxPath)) {
  console.error(`Expected uvx at ${uvxPath}; not found after install`);
  process.exit(1);
}
console.log(`[ok] binaries present at ${installDir}`);

if (!hasUv()) {
  console.error(
    `hasUv() returned false after install — PATH discovery failed; PATH=${process.env.PATH}`,
  );
  process.exit(1);
}
console.log("[ok] hasUv=true");

const versionResult = spawnSync(uvxPath, ["--version"], {
  stdio: "pipe",
  encoding: "utf8",
});
if (versionResult.status !== 0) {
  console.error(`uvx --version exited ${versionResult.status}`);
  console.error(versionResult.stderr);
  process.exit(1);
}
console.log("[ok] uvx --version:", versionResult.stdout.trim());
