import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../version.ts";
import { getEmbeddedAsset, BUNDLES } from "./embedded-assets.ts";

let cacheDir: string;
let originalXdg: string | undefined;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "atomic-embedded-"));
  originalXdg = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheDir;
});

afterEach(async () => {
  if (originalXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdg;
  await rm(cacheDir, { recursive: true, force: true });
});

test("getEmbeddedAsset throws actionable error when bundle path is empty", async () => {
  const original = BUNDLES["claude"] as string;
  BUNDLES["claude"] = "";
  try {
    await expect(getEmbeddedAsset("claude")).rejects.toThrow(
      /embedded-assets: bundle 'claude' missing\. Run 'bun packages\/atomic\/script\/build-assets\.ts'/,
    );
  } finally {
    BUNDLES["claude"] = original;
  }
});

test("tar failure does not write marker", async () => {
  const spy = spyOn(Bun, "spawn");
  spy.mockImplementation((() => {
    const stderr = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("fake tar error"));
        controller.close();
      },
    });
    return { exited: Promise.resolve(2), stderr } as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn);

  await expect(getEmbeddedAsset("claude")).rejects.toThrow(/tar failed for claude/);

  const marker = join(cacheDir, "atomic", VERSION, "claude", ".extracted");
  expect(existsSync(marker)).toBe(false);

  spy.mockRestore();
});

test("VERSION drives cache subdir, not 'dev'", async () => {
  const spy = spyOn(Bun, "spawn");
  spy.mockImplementation((() => ({
    exited: Promise.resolve(0),
    stderr: new ReadableStream({ start(c) { c.close(); } }),
  })) as unknown as typeof Bun.spawn);

  const result = await getEmbeddedAsset("claude");

  expect(result).toBe(join(cacheDir, "atomic", VERSION, "claude"));
  expect(result).not.toContain("/dev/");

  spy.mockRestore();
});
