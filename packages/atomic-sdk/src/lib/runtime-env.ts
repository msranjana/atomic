/**
 * Runtime-environment detection helpers (RFC §5.3).
 *
 * Both functions accept a `dir` parameter instead of reading `import.meta.dir`
 * directly so that unit tests can supply arbitrary paths without patching
 * module globals.
 *
 * Two runtime cases are handled:
 *
 *  1. **Compiled binary** (`isCompiledBinaryRuntime`): `bun build --compile`
 *     packs all sources into a virtual filesystem exposed at `/$bunfs/` on
 *     POSIX (inferred `\$bunfs\` on Windows — RFC §9 open question, defensive
 *     cost is zero).
 *
 *  2. **Installed package** (`isInstalledPackage`): covers the standard
 *     `node_modules/` install path *and* the compiled-binary runtime, because
 *     both indicate production deployments where first-run setup should run.
 */

/**
 * True when `dir` lives inside a Bun-compiled binary's virtual filesystem.
 * Compiled Bun executables expose bundled resources under `/$bunfs/`
 * (POSIX) or `\$bunfs\` (Windows, currently inferred — see RFC §9).
 */
export function isCompiledBinaryRuntime(dir: string): boolean {
  return dir.startsWith("/$bunfs/") || dir.startsWith("\\$bunfs\\");
}

/**
 * True when `dir` indicates the CLI is running from an installed package —
 * either a standard `node_modules/` install or a Bun-compiled binary.
 */
export function isInstalledPackage(dir: string): boolean {
  return dir.includes("node_modules") || isCompiledBinaryRuntime(dir);
}
