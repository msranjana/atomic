import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregatorOutputComplete } from "./aggregator-output.ts";

function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agg-output-"));
  const file = join(dir, "report.md");
  writeFileSync(file, contents);
  return file;
}

const REAL_DOC = [
  "---",
  "date: 2026-05-11 12:00:00 UTC",
  "researcher: deep-research-codebase workflow",
  "git_commit: deadbeef",
  "branch: main",
  "repository: atomic",
  'topic: "What does the thing do?"',
  "tags: [research, codebase, deep-research]",
  "status: complete",
  "last_updated: 2026-05-11",
  "---",
  "",
  "# Research: The Thing",
  "",
  "## Research Question",
  "What does the thing do?",
  "",
  "## Executive Summary",
  "It does the thing, thoroughly, across several partitions of the codebase. ".repeat(
    5,
  ),
  "",
  "## Detailed Findings",
  "### Component A",
  "`src/a.ts:1` — entry point. ".repeat(6),
  "",
  "## Open Questions",
  "None.",
].join("\n");

describe("aggregatorOutputComplete", () => {
  test("returns false when the file does not exist", () => {
    expect(aggregatorOutputComplete(join(tmpdir(), "definitely-missing.md"))).toBe(
      false,
    );
  });

  test("returns false for an empty stub below the size floor", () => {
    expect(aggregatorOutputComplete(tmpFile(""))).toBe(false);
    expect(aggregatorOutputComplete(tmpFile("---\nstatus: complete\n---\n"))).toBe(
      false,
    );
  });

  test("returns false when large enough but not opening with frontmatter", () => {
    const body = `# Research: Example\n\n${"lorem ipsum ".repeat(80)}`;
    expect(aggregatorOutputComplete(tmpFile(body))).toBe(false);
  });

  test("returns true for a real document with frontmatter and body", () => {
    expect(aggregatorOutputComplete(tmpFile(REAL_DOC))).toBe(true);
  });

  test("tolerates leading whitespace before the frontmatter delimiter", () => {
    expect(aggregatorOutputComplete(tmpFile(`\n  ${REAL_DOC}`))).toBe(true);
  });
});
