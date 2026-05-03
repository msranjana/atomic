import { $ } from "bun";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { findRepoRoot } from "../src/lib/workspace-paths.ts";
import { TARGETS } from "./targets.ts";

const WORKSPACE_ROOT = findRepoRoot(import.meta.dir);
const CLI_PKG_ROOT = join(WORKSPACE_ROOT, "packages", "atomic");

export async function synthesizeWrapper(outDir: string, opts: { version: string }): Promise<void> {
  const { version } = opts;
  await mkdir(join(outDir, "bin"), { recursive: true });
  await copyFile(join(CLI_PKG_ROOT, "bin", "atomic"),             join(outDir, "bin", "atomic"));
  await copyFile(join(CLI_PKG_ROOT, "script", "postinstall.mjs"), join(outDir, "postinstall.mjs"));
  await copyFile(join(WORKSPACE_ROOT, "LICENSE"),                  join(outDir, "LICENSE"));
  await writeFile(join(outDir, "package.json"), JSON.stringify({
    name: "@bastani/atomic",
    version,
    description: "Configuration management CLI for coding agents",
    bin: { atomic: "./bin/atomic" },
    files: ["bin", "postinstall.mjs", "LICENSE"],
    scripts: { postinstall: "node ./postinstall.mjs" },
    optionalDependencies: Object.fromEntries(
      TARGETS.map((t) => [`@bastani/atomic-${t.name}`, version]),
    ),
    engines: { node: ">=20" },
    license: "MIT",
  }, null, 2) + "\n");
}

if (import.meta.main) {
  const version = (await Bun.file(join(WORKSPACE_ROOT, "package.json")).json()).version;
  const tag = process.env.NPM_TAG ?? (version.includes("-") ? "next" : "latest");

  // 1. Synthesize wrapper.
  const wrapperOut = join(CLI_PKG_ROOT, "dist", "wrapper");
  await synthesizeWrapper(wrapperOut, { version });

  // 2. Publish per-platform packages.
  for (const t of TARGETS) {
    await $`cd ${join(CLI_PKG_ROOT, "dist", t.name)} && npm publish --provenance --access public --tag ${tag}`;
  }

  // 3. Publish wrapper.
  await $`cd ${wrapperOut} && npm publish --provenance --access public --tag ${tag}`;
}
