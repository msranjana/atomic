/**
 * lint-claude-mcp-allowlist.ts
 *
 * CI lint: every .claude/agents/*.md that declares `mcpServers:` in YAML
 * frontmatter must enumerate each server in `tools:` via the pattern
 * `mcp__<server>__*` or `mcp__<server>`.
 *
 * Usage:
 *   bun run script/lint-claude-mcp-allowlist.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ParsedFrontmatter {
  mcpServers: string[]; // top-level keys under mcpServers:
  tools: string[];      // individual tool tokens
}

/**
 * Parse YAML frontmatter between leading `---` delimiters.
 * Returns raw frontmatter lines (without the `---` delimiters).
 */
export function extractFrontmatterLines(content: string): string[] | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const endIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (endIdx === -1) return null;
  return lines.slice(1, endIdx);
}

/**
 * Parse server names from `mcpServers:` block.
 * Top-level keys under `mcpServers:` are indented by exactly 2 spaces (one
 * level). We collect lines that follow `mcpServers:` with indent=2 and are
 * key: value or key: (block) entries.
 */
export function parseMcpServers(lines: string[]): string[] {
  const servers: string[] = [];
  let inMcpServers = false;

  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    if (line.trim() === "mcpServers:") {
      inMcpServers = true;
      continue;
    }

    if (inMcpServers) {
      // Top-level keys under mcpServers: have indent == 2
      if (indent === 0) {
        // Back to root level — done
        inMcpServers = false;
        continue;
      }
      if (indent === 2) {
        // e.g. "  codegraph:" or "  ast-grep:"
        const match = line.trim().match(/^([^:]+):/);
        if (match) {
          servers.push(match[1].trim());
        }
      }
      // deeper indent = nested config, skip
    }
  }

  return servers;
}

/**
 * Parse tool names from `tools:` line.
 * Format: `tools: Grep, Glob, mcp__foo__*, ...`
 */
export function parseTools(lines: string[]): string[] {
  for (const line of lines) {
    const match = line.match(/^tools:\s*(.+)/);
    if (match) {
      return match[1]
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }
  }
  return [];
}

export function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const fmLines = extractFrontmatterLines(content);
  if (!fmLines) return null;

  const mcpServers = parseMcpServers(fmLines);
  // Only proceed if mcpServers block exists
  if (mcpServers.length === 0) {
    // Check if mcpServers: key exists at all
    const hasMcpServersKey = fmLines.some((l) => l.trim() === "mcpServers:");
    if (!hasMcpServersKey) return null;
  }

  const tools = parseTools(fmLines);
  return { mcpServers, tools };
}

/**
 * Check if `tools` allowlist covers `server`.
 * Match: exact `mcp__<server>` OR `mcp__<server>__*` OR `mcp__<server>__<anything>`
 */
export function serverCoveredByTools(server: string, tools: string[]): boolean {
  return tools.some((tool) => {
    // Exact match: mcp__<server>
    if (tool === `mcp__${server}`) return true;
    // Wildcard: mcp__<server>__*
    if (tool === `mcp__${server}__*`) return true;
    // Specific sub-tool: mcp__<server>__<name>
    if (tool.startsWith(`mcp__${server}__`)) return true;
    return false;
  });
}

/**
 * Lint all agent files in `agentsDir`. Returns array of error strings.
 */
export function lintAgentsDir(agentsDir: string): string[] {
  let files: string[];
  try {
    files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [`error: cannot read agents directory: ${agentsDir}`];
  }

  const errors: string[] = [];

  for (const filename of files) {
    const filePath = join(agentsDir, filename);
    const content = readFileSync(filePath, "utf8");

    const parsed = parseFrontmatter(content);
    if (!parsed) continue; // no mcpServers declared — skip

    const { mcpServers, tools } = parsed;

    for (const server of mcpServers) {
      if (!serverCoveredByTools(server, tools)) {
        errors.push(
          `error: .claude/agents/${filename}: missing tool pattern mcp__${server}__* (or mcp__${server}) for declared mcpServer "${server}"`
        );
      }
    }
  }

  return errors;
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Guard: only run main block when executed directly (not imported by tests)
if (import.meta.path === Bun.main) {
  const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
  const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
  const AGENTS_DIR = join(REPO_ROOT, ".claude", "agents");

  let totalFiles: number;
  try {
    totalFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).length;
  } catch {
    console.error(`error: cannot read agents directory: ${AGENTS_DIR}`);
    process.exit(1);
  }

  const errors = lintAgentsDir(AGENTS_DIR);

  if (errors.length > 0) {
    for (const err of errors) {
      console.error(err);
    }
    process.exit(1);
  }

  console.log(`lint:mcp-allowlist: all .claude/agents/*.md files pass (${totalFiles} checked)`);
  process.exit(0);
}
