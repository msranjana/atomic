import { describe, expect, test } from "bun:test";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanDist } from "./clean-dist.ts";

async function pathExists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

function makeTmpDir(): string {
  return join(tmpdir(), `atomic-clean-dist-test-${crypto.randomUUID()}`);
}

describe("cleanDist", () => {
  test("removes provided dir including nested files", async () => {
    const tmp = makeTmpDir();
    const nested = join(tmp, "subdir", "deeply", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(join(tmp, "index.js"), "// bundle");
    await writeFile(join(nested, "chunk.js"), "// chunk");

    expect(await pathExists(tmp)).toBe(true);

    await cleanDist([tmp]);

    expect(await pathExists(tmp)).toBe(false);
    expect(await pathExists(join(nested, "chunk.js"))).toBe(false);
  });

  test("idempotent: calling twice on same dir does not throw", async () => {
    const tmp = makeTmpDir();
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, "file.js"), "// x");

    await cleanDist([tmp]);
    await expect(cleanDist([tmp])).resolves.toBeUndefined();

    expect(await pathExists(tmp)).toBe(false);
  });

  test("accepts multiple dirs at once", async () => {
    const tmp1 = makeTmpDir();
    const tmp2 = makeTmpDir();
    await mkdir(tmp1, { recursive: true });
    await mkdir(tmp2, { recursive: true });
    await writeFile(join(tmp1, "a.js"), "// a");
    await writeFile(join(tmp2, "b.js"), "// b");

    await cleanDist([tmp1, tmp2]);

    expect(await pathExists(tmp1)).toBe(false);
    expect(await pathExists(tmp2)).toBe(false);
  });

  test("does nothing when given empty array", async () => {
    await expect(cleanDist([])).resolves.toBeUndefined();
  });
});
