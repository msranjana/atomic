import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    getInstallPaths,
    pathContains,
    wellKnownMuxInstallDirs,
    rcSnippetAlreadyPresent,
    appendPathRcSnippet,
    ensureCompletionsSourcedFromRc,
    cleanupOldArtifacts,
    stripRcSnippet,
    PATH_RC_MARKER,
    RC_MARKER,
} from "./install.ts";

// ─── pathContains ──────────────────────────────────────────────────────────

describe("pathContains", () => {
    test("returns false for empty PATH", () => {
        expect(pathContains("", "/usr/bin", ":")).toBe(false);
    });

    test("matches existing entry exactly (Unix)", () => {
        expect(pathContains("/usr/bin:/bin", "/usr/bin", ":")).toBe(true);
        expect(pathContains("/usr/bin:/bin", "/sbin", ":")).toBe(false);
    });

    test("ignores empty segments from trailing/leading separator", () => {
        expect(pathContains("/usr/bin::/bin", "/usr/bin", ":")).toBe(true);
        expect(pathContains(":/usr/bin:", "/usr/bin", ":")).toBe(true);
    });

    test("Unix matching is case-sensitive", () => {
        // Force Unix branch by checking with `:` separator on a non-Windows host
        if (process.platform === "win32") return;
        expect(pathContains("/usr/bin", "/USR/BIN", ":")).toBe(false);
    });
});

// ─── getInstallPaths ───────────────────────────────────────────────────────

describe("getInstallPaths", () => {
    test("returns platform-appropriate install paths", () => {
        const paths = getInstallPaths();
        expect(paths.binDir).toBeTruthy();
        expect(paths.binPath).toContain(paths.binDir);
        expect(paths.completionsDir).toContain(".atomic");
        if (process.platform === "win32") {
            expect(paths.binPath).toEndWith("atomic.exe");
            expect(paths.binDir.toLowerCase()).toContain("local");
        } else {
            expect(paths.binPath).toEndWith("/atomic");
            expect(paths.binDir).toContain(".local/bin");
        }
    });
});

// ─── wellKnownMuxInstallDirs ───────────────────────────────────────────────

describe("wellKnownMuxInstallDirs", () => {
    test("returns Windows-specific dirs on Windows", () => {
        if (process.platform !== "win32") return;
        const dirs = wellKnownMuxInstallDirs();
        expect(dirs.some((d) => d.toLowerCase().includes("scoop"))).toBe(true);
        expect(dirs.some((d) => d.toLowerCase().includes("winget"))).toBe(true);
    });

    test("returns Unix dirs on Linux/macOS", () => {
        if (process.platform === "win32") return;
        const dirs = wellKnownMuxInstallDirs();
        expect(dirs).toContain("/usr/bin");
        expect(dirs).toContain("/usr/local/bin");
        expect(dirs).toContain("/opt/homebrew/bin");
    });

    test("returns no falsy entries", () => {
        const dirs = wellKnownMuxInstallDirs();
        expect(dirs.every((d) => typeof d === "string" && d.length > 0)).toBe(true);
    });
});

// ─── rc-file snippet idempotency ───────────────────────────────────────────

describe("rcSnippetAlreadyPresent", () => {
    let tmp: string;
    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), "atomic-install-test-"));
    });
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    test("returns false when rc file does not exist", () => {
        expect(rcSnippetAlreadyPresent(join(tmp, "missing"), "/some/dir")).toBe(false);
    });

    test("returns false when marker is missing", () => {
        const rc = join(tmp, ".bashrc");
        writeFileSync(rc, "export FOO=1\n");
        expect(rcSnippetAlreadyPresent(rc, "/some/dir")).toBe(false);
    });

    test("returns true only when both marker and dir are present", () => {
        const rc = join(tmp, ".bashrc");
        writeFileSync(rc, '# Atomic CLI PATH\nexport PATH="/some/dir:$PATH"\n');
        expect(rcSnippetAlreadyPresent(rc, "/some/dir")).toBe(true);
        expect(rcSnippetAlreadyPresent(rc, "/other/dir")).toBe(false);
    });
});

describe("appendPathRcSnippet", () => {
    let tmp: string;
    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), "atomic-install-test-"));
    });
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    test("creates rc file if missing and writes bash-style snippet", () => {
        const rc = join(tmp, ".bashrc");
        appendPathRcSnippet(rc, "bash", "/my/bin");
        const content = readFileSync(rc, "utf8");
        expect(content).toContain("# Atomic CLI PATH");
        expect(content).toContain("/my/bin");
        expect(content).toContain('export PATH="/my/bin:$PATH"');
    });

    test("writes fish-specific snippet for fish shell", () => {
        const rc = join(tmp, "config.fish");
        appendPathRcSnippet(rc, "fish", "/my/bin");
        const content = readFileSync(rc, "utf8");
        expect(content).toContain("fish_add_path");
        expect(content).not.toContain("export PATH");
    });

    test("creates parent directory if missing", () => {
        const rc = join(tmp, "nested", "dir", ".bashrc");
        appendPathRcSnippet(rc, "bash", "/my/bin");
        expect(existsSync(rc)).toBe(true);
    });
});

// ─── completions rc wiring ─────────────────────────────────────────────────

describe("ensureCompletionsSourcedFromRc", () => {
    let tmp: string;
    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), "atomic-install-test-"));
    });
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    test("appends source line when marker absent", () => {
        const rc = join(tmp, ".bashrc");
        const cache = join(tmp, "atomic.bash");
        writeFileSync(rc, "export FOO=1\n");
        ensureCompletionsSourcedFromRc(rc, "bash", cache);
        const content = readFileSync(rc, "utf8");
        expect(content).toContain("# Atomic CLI completions (cached)");
        expect(content).toContain(`source "${cache}"`);
    });

    test("is idempotent — second run does not duplicate", () => {
        const rc = join(tmp, ".bashrc");
        const cache = join(tmp, "atomic.bash");
        ensureCompletionsSourcedFromRc(rc, "bash", cache);
        ensureCompletionsSourcedFromRc(rc, "bash", cache);
        const content = readFileSync(rc, "utf8");
        const matches = content.match(/# Atomic CLI completions \(cached\)/g) ?? [];
        expect(matches.length).toBe(1);
    });

    test("strips legacy eval-based snippet before adding cached form", () => {
        const rc = join(tmp, ".bashrc");
        const cache = join(tmp, "atomic.bash");
        writeFileSync(
            rc,
            '# Atomic CLI completions\neval "$(atomic completions bash)"\nexport FOO=1\n',
        );
        ensureCompletionsSourcedFromRc(rc, "bash", cache);
        const content = readFileSync(rc, "utf8");
        expect(content).not.toContain('eval "$(atomic completions bash)"');
        expect(content).toContain("# Atomic CLI completions (cached)");
        expect(content).toContain("export FOO=1"); // unrelated lines preserved
    });

    test("uses dot-source syntax for powershell", () => {
        const rc = join(tmp, "Profile.ps1");
        const cache = join(tmp, "atomic.ps1");
        ensureCompletionsSourcedFromRc(rc, "powershell", cache);
        const content = readFileSync(rc, "utf8");
        expect(content).toContain(`. "${cache}"`);
        expect(content).toContain("Test-Path");
    });
});

// ─── cleanupOldArtifacts ───────────────────────────────────────────────────

describe("cleanupOldArtifacts", () => {
    let tmp: string;
    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), "atomic-install-test-"));
    });
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    test("returns zero counts when binDir does not exist", () => {
        const result = cleanupOldArtifacts(join(tmp, "missing"));
        expect(result).toEqual({ oldBinariesRemoved: 0, tempFilesRemoved: 0 });
    });

    test("reaps Windows-style atomic.exe.old.<ts> files", () => {
        writeFileSync(join(tmp, "atomic.exe"), "live");
        writeFileSync(join(tmp, "atomic.exe.old.1700000000000"), "stale1");
        writeFileSync(join(tmp, "atomic.exe.old.1700000001000"), "stale2");
        writeFileSync(join(tmp, "atomic.exe.old.notatimestamp"), "should-be-ignored");

        const result = cleanupOldArtifacts(tmp);
        expect(result.oldBinariesRemoved).toBe(2);
        expect(existsSync(join(tmp, "atomic.exe"))).toBe(true);
        expect(existsSync(join(tmp, "atomic.exe.old.1700000000000"))).toBe(false);
        expect(existsSync(join(tmp, "atomic.exe.old.1700000001000"))).toBe(false);
        // Non-numeric suffix doesn't match pattern, so it stays.
        expect(existsSync(join(tmp, "atomic.exe.old.notatimestamp"))).toBe(true);
    });

    test("reaps Unix-style atomic.old.<ts> files", () => {
        writeFileSync(join(tmp, "atomic"), "live");
        writeFileSync(join(tmp, "atomic.old.1700000000000"), "stale");

        const result = cleanupOldArtifacts(tmp);
        expect(result.oldBinariesRemoved).toBe(1);
        expect(existsSync(join(tmp, "atomic"))).toBe(true);
    });

    test("reaps orphan .tmp.<pid>.<ts> files older than 1 hour", () => {
        const tmpFile = join(tmp, "atomic.tmp.12345.1700000000000");
        writeFileSync(tmpFile, "orphan");
        // Stamp mtime well beyond the 1-hour threshold.
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        utimesSync(tmpFile, twoHoursAgo, twoHoursAgo);

        const result = cleanupOldArtifacts(tmp);
        expect(result.tempFilesRemoved).toBe(1);
        expect(existsSync(tmpFile)).toBe(false);
    });

    test("does NOT reap .tmp files younger than 1 hour (concurrent install safety)", () => {
        const fresh = join(tmp, "atomic.exe.tmp.12345.1700000000000");
        writeFileSync(fresh, "in-flight");

        const result = cleanupOldArtifacts(tmp);
        expect(result.tempFilesRemoved).toBe(0);
        expect(existsSync(fresh)).toBe(true);
    });

    test("ignores unrelated files", () => {
        writeFileSync(join(tmp, "atomic"), "live");
        writeFileSync(join(tmp, "README.md"), "x");
        writeFileSync(join(tmp, "config.json"), "x");

        const result = cleanupOldArtifacts(tmp);
        expect(result).toEqual({ oldBinariesRemoved: 0, tempFilesRemoved: 0 });
        expect(existsSync(join(tmp, "README.md"))).toBe(true);
    });
});

// ─── stripRcSnippet ────────────────────────────────────────────────────────

describe("stripRcSnippet", () => {
    let tmp: string;
    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), "atomic-install-test-"));
    });
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    test("returns false when rc file is missing", () => {
        expect(stripRcSnippet(join(tmp, "missing"), PATH_RC_MARKER)).toBe(false);
    });

    test("returns false when marker is absent", () => {
        const rc = join(tmp, ".bashrc");
        writeFileSync(rc, "export FOO=1\nexport BAR=2\n");
        expect(stripRcSnippet(rc, PATH_RC_MARKER)).toBe(false);
        expect(readFileSync(rc, "utf8")).toBe("export FOO=1\nexport BAR=2\n");
    });

    test("removes bash PATH snippet exactly, preserving surrounding lines", () => {
        const rc = join(tmp, ".bashrc");
        const original = [
            "export FOO=1",
            "",
            PATH_RC_MARKER,
            'case ":$PATH:" in',
            '    *":/home/me/.local/bin:"*) ;;',
            '    *) export PATH="/home/me/.local/bin:$PATH" ;;',
            "esac",
            "",
            "export BAR=2",
            "",
        ].join("\n");
        writeFileSync(rc, original);

        expect(stripRcSnippet(rc, PATH_RC_MARKER)).toBe(true);
        const after = readFileSync(rc, "utf8");
        expect(after).not.toContain(PATH_RC_MARKER);
        expect(after).not.toContain("/home/me/.local/bin");
        expect(after).toContain("export FOO=1");
        expect(after).toContain("export BAR=2");
    });

    test("removes single-line completions snippet", () => {
        const rc = join(tmp, ".bashrc");
        writeFileSync(
            rc,
            ["export FOO=1", RC_MARKER, '[ -f "$HOME/.atomic/completions/atomic.bash" ] && source "$HOME/.atomic/completions/atomic.bash"', "", "export BAR=2"].join("\n"),
        );
        expect(stripRcSnippet(rc, RC_MARKER)).toBe(true);
        const after = readFileSync(rc, "utf8");
        expect(after).not.toContain(RC_MARKER);
        expect(after).not.toContain("atomic.bash");
        expect(after).toContain("export FOO=1");
        expect(after).toContain("export BAR=2");
    });

    test("is idempotent — second call is a no-op", () => {
        const rc = join(tmp, ".bashrc");
        writeFileSync(rc, [PATH_RC_MARKER, 'export PATH="/x:$PATH"', ""].join("\n"));
        expect(stripRcSnippet(rc, PATH_RC_MARKER)).toBe(true);
        expect(stripRcSnippet(rc, PATH_RC_MARKER)).toBe(false);
    });

    test("stops at the next # comment, not consuming unrelated blocks", () => {
        const rc = join(tmp, ".bashrc");
        const original = [
            PATH_RC_MARKER,
            'export PATH="/x:$PATH"',
            "# Some other tool",
            "export OTHER=1",
        ].join("\n");
        writeFileSync(rc, original);

        stripRcSnippet(rc, PATH_RC_MARKER);
        const after = readFileSync(rc, "utf8");
        expect(after).toContain("# Some other tool");
        expect(after).toContain("export OTHER=1");
        expect(after).not.toContain(PATH_RC_MARKER);
    });
});
