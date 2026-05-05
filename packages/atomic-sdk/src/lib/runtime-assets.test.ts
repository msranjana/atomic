import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  materializeRuntimeAsset,
  runtimeAssetsCacheDir,
} from "./runtime-assets.ts";

describe("runtimeAssetsCacheDir", () => {
  // Use a platform-appropriate fake home so the assertion's separator
  // matches what `path.join` produces. Hard-coding `/home/test` makes
  // the prefix check fail on Windows (backslash vs forward slash).
  const fakeHome = process.platform === "win32" ? "C:\\Users\\test" : "/home/test";

  test("lives under ~/.atomic/runtime/<sdk-version>", () => {
    const dir = runtimeAssetsCacheDir(fakeHome);
    expect(dir.startsWith(join(fakeHome, ".atomic", "runtime") + (process.platform === "win32" ? "\\" : "/"))).toBe(true);
  });

  test("is stable across calls within a single SDK version", () => {
    expect(runtimeAssetsCacheDir(fakeHome)).toBe(
      runtimeAssetsCacheDir(fakeHome),
    );
  });

  test("does not pick up XDG_CACHE_HOME / LOCALAPPDATA", () => {
    // The cache lives under ~/.atomic, NOT the platform cache dir, so a
    // user nuking ~/.cache or its Windows/macOS equivalents leaves the
    // materialized assets intact.
    const previousXdg = process.env.XDG_CACHE_HOME;
    const previousLocal = process.env.LOCALAPPDATA;
    process.env.XDG_CACHE_HOME = "/should/not/be/used";
    process.env.LOCALAPPDATA = "C:\\Should\\Not\\Be\\Used";
    try {
      const dir = runtimeAssetsCacheDir("/home/test");
      expect(dir).not.toContain("/should/not/be/used");
      expect(dir).not.toContain("Should\\Not\\Be\\Used");
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousXdg;
      if (previousLocal === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousLocal;
    }
  });
});

describe("materializeRuntimeAsset", () => {
  let tmp: string;
  let cacheDir: string;
  let realAsset: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-runtime-assets-"));
    cacheDir = join(tmp, "cache");
    realAsset = join(tmp, "tmux.conf");
    writeFileSync(realAsset, "set -g status off\n");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns a real on-disk path unchanged (dev / installed-package)", async () => {
    expect(await materializeRuntimeAsset(realAsset, cacheDir)).toBe(realAsset);
    expect(existsSync(cacheDir)).toBe(false);
  });

  test("copies a /$bunfs/… asset to the cache directory", async () => {
    // We can't construct a real /$bunfs/ asset in unit tests — those only
    // exist inside compiled binaries. Instead, place a fake file at a
    // path `isCompiledBinaryRuntime` recognizes as bunfs. The Windows
    // `~BUN` variant lets us stage a real on-disk file under a temp dir
    // whose path contains `~BUN` between separators, so `Bun.file()` can
    // still read it during the test.
    const fakeBunfsDir = join(tmp, "~BUN", "root");
    mkdirSync(fakeBunfsDir, { recursive: true });
    const fakeBundled = join(fakeBunfsDir, "tmux.conf");
    writeFileSync(fakeBundled, "set -g status off\n# bundled\n");

    const out = await materializeRuntimeAsset(fakeBundled, cacheDir);

    expect(out).toBe(join(cacheDir, "tmux.conf"));
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf-8")).toBe("set -g status off\n# bundled\n");
  });

  test("is idempotent — does not re-copy when destination already exists", async () => {
    const fakeBunfsDir = join(tmp, "~BUN", "root");
    mkdirSync(fakeBunfsDir, { recursive: true });
    const fakeBundled = join(fakeBunfsDir, "tmux.conf");
    writeFileSync(fakeBundled, "first\n");

    const first = await materializeRuntimeAsset(fakeBundled, cacheDir);
    // Mutate the source to prove the helper does NOT re-copy on the second
    // call. (In a real binary the bundled asset is read-only, but the
    // contract is "first call wins per (cache-dir, basename) tuple".)
    writeFileSync(fakeBundled, "second\n");
    const second = await materializeRuntimeAsset(fakeBundled, cacheDir);

    expect(second).toBe(first);
    expect(readFileSync(second, "utf-8")).toBe("first\n");
  });

  test("returns a path that is NOT under /$bunfs/ for bunfs inputs", async () => {
    // The whole point of the helper: spawned OS subprocesses must be able
    // to read the returned path. If it still points into /$bunfs/, the
    // bug is unfixed.
    const fakeBunfsDir = join(tmp, "~BUN", "root");
    mkdirSync(fakeBunfsDir, { recursive: true });
    const fakeBundled = join(fakeBunfsDir, "tmux.conf");
    writeFileSync(fakeBundled, "x\n");

    const out = await materializeRuntimeAsset(fakeBundled, cacheDir);

    expect(out).not.toMatch(/[\\/]~BUN[\\/]/);
    expect(out).not.toContain("$bunfs");
  });

  test("creates the cache directory on demand", async () => {
    const fakeBundled = join(tmp, "~BUN", "root", basename("conf"));
    mkdirSync(join(tmp, "~BUN", "root"), { recursive: true });
    writeFileSync(fakeBundled, "x\n");
    expect(existsSync(cacheDir)).toBe(false);

    await materializeRuntimeAsset(fakeBundled, cacheDir);

    expect(existsSync(cacheDir)).toBe(true);
  });
});
