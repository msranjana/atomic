import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateReleaseAssets } from "./release-assets.ts";
import type { BuildTarget } from "./targets.ts";

const TARGETS: readonly BuildTarget[] = [
    { name: "linux-x64", bunTarget: "bun-linux-x64", os: "linux", cpu: "x64" },
    { name: "windows-x64", bunTarget: "bun-windows-x64", os: "win32", cpu: "x64", ext: ".exe" },
];

let tmp: string;
let distRoot: string;
let assetsRoot: string;

function plantBinary(target: string, ext: string, content: string): string {
    const dir = join(distRoot, target, "bin");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `atomic${ext}`);
    writeFileSync(file, content);
    return file;
}

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-release-assets-"));
    distRoot = join(tmp, "dist");
    assetsRoot = join(tmp, "release-assets");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("generateReleaseAssets", () => {
    test("copies binaries with platform-suffixed names and emits manifest", () => {
        plantBinary("linux-x64", "", "linux-bytes");
        plantBinary("windows-x64", ".exe", "windows-bytes");

        const result = generateReleaseAssets({
            version: "1.2.3",
            distRoot,
            assetsRoot,
            targets: TARGETS,
            log: () => {},
        });

        expect(result.assets).toEqual(["atomic-linux-x64", "atomic-windows-x64.exe"]);
        expect(existsSync(join(assetsRoot, "atomic-linux-x64"))).toBe(true);
        expect(existsSync(join(assetsRoot, "atomic-windows-x64.exe"))).toBe(true);

        const manifest = JSON.parse(readFileSync(join(assetsRoot, "manifest.json"), "utf8"));
        expect(manifest.version).toBe("1.2.3");
        expect(Object.keys(manifest.platforms).sort()).toEqual(["linux-x64", "windows-x64"]);
    });

    test("manifest checksums match SHA-256 of copied files", () => {
        plantBinary("linux-x64", "", "linux-bytes");

        const result = generateReleaseAssets({
            version: "0.1.0",
            distRoot,
            assetsRoot,
            targets: TARGETS.filter((t) => t.name === "linux-x64"),
            log: () => {},
        });

        const expected = new Bun.CryptoHasher("sha256").update("linux-bytes").digest("hex");
        expect(result.manifest.platforms["linux-x64"].checksum).toBe(expected);
    });

    test("throws when a target's binary is missing", () => {
        plantBinary("linux-x64", "", "only-linux");
        expect(() =>
            generateReleaseAssets({
                version: "0.1.0",
                distRoot,
                assetsRoot,
                targets: TARGETS,
                log: () => {},
            }),
        ).toThrow(/windows-x64/);
    });

    test("creates assetsRoot if missing", () => {
        plantBinary("linux-x64", "", "x");
        expect(existsSync(assetsRoot)).toBe(false);
        generateReleaseAssets({
            version: "0.1.0",
            distRoot,
            assetsRoot,
            targets: TARGETS.filter((t) => t.name === "linux-x64"),
            log: () => {},
        });
        expect(existsSync(assetsRoot)).toBe(true);
    });
});
