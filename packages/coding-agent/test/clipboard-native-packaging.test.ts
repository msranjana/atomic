import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CLIPBOARD_NATIVE_TARGETS,
	copyClipboardNativeBindings,
} from "../scripts/copy-clipboard-native-bindings.ts";

const tempDirs: string[] = [];

function writePackage(root: string, packageName: string, version: string, bindingName?: string): void {
	const packageDir = join(root, ...packageName.split("/"));
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: packageName, version }));
	if (bindingName) {
		writeFileSync(join(packageDir, bindingName), `binding:${packageName}`);
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("standalone clipboard native packaging", () => {
	it("copies every target's 0.3.9-compatible binding beside the generic wrapper", () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-clipboard-packaging-"));
		tempDirs.push(root);
		const sourceNodeModules = join(root, "source");
		const destinationNodeModules = join(root, "destination");
		writePackage(sourceNodeModules, "@mariozechner/clipboard", "0.3.9");
		writePackage(destinationNodeModules, "@mariozechner/clipboard", "0.3.9");

		for (const target of Object.values(CLIPBOARD_NATIVE_TARGETS)) {
			writePackage(sourceNodeModules, target.packageName, "0.3.9", target.bindingName);
		}

		copyClipboardNativeBindings({
			sourceNodeModules,
			destinationNodeModules,
			platforms: Object.keys(CLIPBOARD_NATIVE_TARGETS),
		});

		for (const target of Object.values(CLIPBOARD_NATIVE_TARGETS)) {
			const copied = join(
				destinationNodeModules,
				"@mariozechner",
				"clipboard",
				target.bindingName,
			);
			expect(readFileSync(copied, "utf-8")).toBe(`binding:${target.packageName}`);
		}
	});

	it("rejects a native package version that differs from the generic wrapper", () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-clipboard-version-"));
		tempDirs.push(root);
		const sourceNodeModules = join(root, "source");
		const destinationNodeModules = join(root, "destination");
		const [platform, target] = Object.entries(CLIPBOARD_NATIVE_TARGETS)[0]!;
		writePackage(sourceNodeModules, "@mariozechner/clipboard", "0.3.9");
		writePackage(destinationNodeModules, "@mariozechner/clipboard", "0.3.9");
		writePackage(sourceNodeModules, target.packageName, "0.3.2", target.bindingName);

		expect(() =>
			copyClipboardNativeBindings({ sourceNodeModules, destinationNodeModules, platforms: [platform] }),
		).toThrow(/version mismatch.*0\.3\.9.*0\.3\.2/i);
	});

	it("keeps release copies strict while skip mode copies available bindings and tolerates missing optional packages", () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-clipboard-skip-"));
		tempDirs.push(root);
		const sourceNodeModules = join(root, "source");
		const destinationNodeModules = join(root, "destination");
		const entries = Object.entries(CLIPBOARD_NATIVE_TARGETS);
		const [availablePlatform, availableTarget] = entries[0]!;
		const [missingPlatform] = entries[1]!;
		writePackage(sourceNodeModules, "@mariozechner/clipboard", "0.3.9");
		writePackage(destinationNodeModules, "@mariozechner/clipboard", "0.3.9");
		writePackage(sourceNodeModules, availableTarget.packageName, "0.3.9", availableTarget.bindingName);

		expect(() =>
			copyClipboardNativeBindings({
				sourceNodeModules,
				destinationNodeModules,
				platforms: [availablePlatform, missingPlatform],
			}),
		).toThrow(/metadata not found/i);

		copyClipboardNativeBindings({
			sourceNodeModules,
			destinationNodeModules,
			platforms: [availablePlatform, missingPlatform],
			allowMissing: true,
		});
		expect(
			readFileSync(
				join(destinationNodeModules, "@mariozechner", "clipboard", availableTarget.bindingName),
				"utf-8",
			),
		).toBe(`binding:${availableTarget.packageName}`);
	});
});
