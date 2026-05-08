import { test, expect, describe } from "bun:test";
import {
  extractFrontmatterLines,
  parseMcpServers,
  parseTools,
  parseFrontmatter,
  serverCoveredByTools,
  lintAgentsDir,
} from "./lint-claude-mcp-allowlist";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── extractFrontmatterLines ───────────────────────────────────────────────────

describe("extractFrontmatterLines", () => {
  test("returns lines between --- delimiters", () => {
    const content = "---\nname: foo\ntools: Bar\n---\n\nbody";
    const lines = extractFrontmatterLines(content);
    expect(lines).toEqual(["name: foo", "tools: Bar"]);
  });

  test("returns null when no leading ---", () => {
    expect(extractFrontmatterLines("name: foo\n---")).toBeNull();
  });

  test("returns null when closing --- missing", () => {
    expect(extractFrontmatterLines("---\nname: foo\n")).toBeNull();
  });
});

// ── parseMcpServers ───────────────────────────────────────────────────────────

describe("parseMcpServers", () => {
  test("extracts single server", () => {
    const lines = [
      "name: agent",
      "mcpServers:",
      "  codegraph:",
      "    type: stdio",
    ];
    expect(parseMcpServers(lines)).toEqual(["codegraph"]);
  });

  test("extracts multiple servers including hyphenated name", () => {
    const lines = [
      "mcpServers:",
      "  codegraph:",
      "    type: stdio",
      "  ast-grep:",
      "    type: stdio",
    ];
    expect(parseMcpServers(lines)).toEqual(["codegraph", "ast-grep"]);
  });

  test("stops at root-level key after mcpServers block", () => {
    const lines = [
      "mcpServers:",
      "  codegraph:",
      "    type: stdio",
      "model: haiku",
    ];
    expect(parseMcpServers(lines)).toEqual(["codegraph"]);
  });

  test("returns empty array when no mcpServers block", () => {
    const lines = ["name: agent", "tools: Bash"];
    expect(parseMcpServers(lines)).toEqual([]);
  });
});

// ── parseTools ────────────────────────────────────────────────────────────────

describe("parseTools", () => {
  test("parses comma-separated tools", () => {
    const lines = ["name: agent", "tools: Grep, Glob, mcp__codegraph__*"];
    expect(parseTools(lines)).toEqual(["Grep", "Glob", "mcp__codegraph__*"]);
  });

  test("returns empty array when no tools line", () => {
    expect(parseTools(["name: agent"])).toEqual([]);
  });

  test("trims whitespace around tokens", () => {
    const lines = ["tools:  Bash ,  Edit "];
    expect(parseTools(lines)).toEqual(["Bash", "Edit"]);
  });
});

// ── parseFrontmatter ──────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  test("returns null when no frontmatter delimiters", () => {
    expect(parseFrontmatter("no frontmatter here")).toBeNull();
  });

  test("returns null when no mcpServers key", () => {
    const content = "---\nname: agent\ntools: Bash\n---\nbody";
    expect(parseFrontmatter(content)).toBeNull();
  });

  test("parses mcpServers and tools together", () => {
    const content = [
      "---",
      "name: agent",
      "tools: Bash, mcp__codegraph__*",
      "mcpServers:",
      "  codegraph:",
      "    type: stdio",
      "---",
      "body",
    ].join("\n");
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result?.mcpServers).toEqual(["codegraph"]);
    expect(result?.tools).toContain("mcp__codegraph__*");
  });
});

// ── serverCoveredByTools ──────────────────────────────────────────────────────

describe("serverCoveredByTools", () => {
  test("matches exact mcp__<server>", () => {
    expect(serverCoveredByTools("codegraph", ["mcp__codegraph"])).toBe(true);
  });

  test("matches wildcard mcp__<server>__*", () => {
    expect(serverCoveredByTools("codegraph", ["mcp__codegraph__*"])).toBe(true);
  });

  test("matches specific sub-tool mcp__<server>__<name>", () => {
    expect(serverCoveredByTools("codegraph", ["mcp__codegraph__search"])).toBe(true);
  });

  test("does not match other server", () => {
    expect(serverCoveredByTools("ast-grep", ["mcp__codegraph__*"])).toBe(false);
  });

  test("handles hyphenated server name", () => {
    expect(serverCoveredByTools("ast-grep", ["mcp__ast-grep__*"])).toBe(true);
  });

  test("returns false when tools list empty", () => {
    expect(serverCoveredByTools("codegraph", [])).toBe(false);
  });

  test("does not match prefix-only overlap", () => {
    // mcp__code should NOT match mcp__codegraph
    expect(serverCoveredByTools("code", ["mcp__codegraph__*"])).toBe(false);
  });
});

// ── lintAgentsDir (integration) ───────────────────────────────────────────────

describe("lintAgentsDir", () => {
  function makeTmpDir(): string {
    const dir = join(tmpdir(), `lint-mcp-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeAgent(dir: string, name: string, content: string) {
    writeFileSync(join(dir, name), content, "utf8");
  }

  test("returns empty errors when all agents pass", () => {
    const dir = makeTmpDir();
    try {
      writeAgent(dir, "agent.md", [
        "---",
        "name: agent",
        "tools: Bash, mcp__codegraph__*, mcp__ast-grep__*",
        "mcpServers:",
        "  codegraph:",
        "    type: stdio",
        "  ast-grep:",
        "    type: stdio",
        "---",
        "body",
      ].join("\n"));

      const errors = lintAgentsDir(dir);
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns error when server missing from tools", () => {
    const dir = makeTmpDir();
    try {
      writeAgent(dir, "bad-agent.md", [
        "---",
        "name: bad",
        "tools: Bash, mcp__codegraph__*",
        "mcpServers:",
        "  codegraph:",
        "    type: stdio",
        "  ast-grep:",
        "    type: stdio",
        "---",
        "body",
      ].join("\n"));

      const errors = lintAgentsDir(dir);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("ast-grep");
      expect(errors[0]).toContain("bad-agent.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips files without mcpServers", () => {
    const dir = makeTmpDir();
    try {
      writeAgent(dir, "no-mcp.md", [
        "---",
        "name: agent",
        "tools: Bash",
        "---",
        "body",
      ].join("\n"));

      const errors = lintAgentsDir(dir);
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips non-.md files", () => {
    const dir = makeTmpDir();
    try {
      writeAgent(dir, "readme.txt", "mcpServers:\n  bad:\n");
      const errors = lintAgentsDir(dir);
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("errors for multiple missing servers", () => {
    const dir = makeTmpDir();
    try {
      writeAgent(dir, "two-missing.md", [
        "---",
        "name: agent",
        "tools: Bash",
        "mcpServers:",
        "  codegraph:",
        "    type: stdio",
        "  ast-grep:",
        "    type: stdio",
        "---",
      ].join("\n"));

      const errors = lintAgentsDir(dir);
      expect(errors).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
