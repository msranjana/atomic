/**
 * Deterministic synthesis of per-partition explorer scratch files.
 *
 * Each partition is investigated by four specialist sub-agents dispatched
 * directly via the provider SDK's `agent` parameter:
 *
 *   - codebase-locator           → file index for the partition
 *   - codebase-pattern-finder    → reusable code patterns in the partition
 *   - codebase-analyzer          → how the most relevant impl files work
 *   - codebase-online-researcher → external library docs (when central)
 *
 * Rather than spawn a fifth "synthesizer" LLM stage just to concatenate four
 * markdown sections, we do that synthesis in plain TypeScript here. This keeps
 * the per-partition cost at exactly four LLM calls and avoids burning tokens
 * on a step whose output is fully determined by its inputs.
 *
 * The file we write is the canonical handoff to the aggregator — it MUST keep
 * the heading shape that buildAggregatorPrompt() promises ("Scope / Files in
 * Scope / How It Works / Patterns / External References / Out-of-Partition
 * References"), or the aggregator will look for sections that don't exist.
 *
 * §5.6 Scratch Synthesis Upgrade: when codegraphHealthy is true the "Callers"
 * and "Impact" sections are produced DETERMINISTICALLY by calling
 * cg.getCallers(symbolId) and cg.getImpactRadius(symbolId, depth) from the
 * @colbymchenry/codegraph library API. When unhealthy these sections are
 * omitted (fallback = the aggregator's LLM stage covers them from raw text).
 *
 * NOTE: the codegraph library exposes getCallers(nodeId, maxDepth?) returning
 * Array<{node, edge}> and getImpactRadius(nodeId, maxDepth?) returning
 * Subgraph — names verified against
 * node_modules/@colbymchenry/codegraph/dist/index.d.ts.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CodeGraph } from "@colbymchenry/codegraph";
import type { Node, Edge, Subgraph } from "@colbymchenry/codegraph";
import type { PartitionUnit } from "./scout.ts";

export type ExplorerSections = {
  index: number;
  total: number;
  partition: PartitionUnit[];
  /** Full assistant text from the codebase-locator sub-agent. */
  locatorOutput: string;
  /** Full assistant text from the codebase-pattern-finder sub-agent. */
  patternsOutput: string;
  /** Full assistant text from the codebase-analyzer sub-agent. */
  analyzerOutput: string;
  /** Full assistant text from the codebase-online-researcher sub-agent. */
  onlineOutput: string;
  /**
   * When true the synthesis pipeline calls cg.getCallers / cg.getImpactRadius
   * to produce deterministic "Callers" and "Impact" sections.
   * When false (or absent) those sections are omitted and the aggregator's
   * LLM stage produces equivalent coverage from raw specialist text.
   */
  codegraphHealthy?: boolean;
  /**
   * Absolute path to the project root — required when codegraphHealthy is
   * true so we can open the CodeGraph DB.
   */
  projectRoot?: string;
};

/** Heuristic: detect the "no external research applicable" sentinel. */
function isOnlineSkip(output: string): boolean {
  return /\(\s*no external research applicable\s*\)/i.test(output);
}

// ---------------------------------------------------------------------------
// §5.6 — Deterministic Callers / Impact synthesis via CodeGraph library API
// ---------------------------------------------------------------------------

/**
 * Extract symbol IDs referenced inside specialist output text.
 *
 * Specialists embed codegraph symbol references in the form
 * `[symbol:<id>]` when codegraph MCP tools are available. This helper
 * collects those IDs so we can drive deterministic graph queries without
 * restructuring the rest of the pipeline.
 *
 * Example match: `[symbol:abc123def456]`
 */
export function extractSymbolIds(text: string): string[] {
  const seen = new Set<string>();
  const pattern = /\[symbol:([a-zA-Z0-9_-]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined) seen.add(match[1]);
  }
  return Array.from(seen);
}

/** Render a single caller entry as a markdown table row. */
function callerRow(caller: { node: Node; edge: Edge }): string {
  const { node, edge } = caller;
  const loc = edge.line != null ? `:${edge.line}` : "";
  return `| \`${node.qualifiedName}\` | ${node.kind} | \`${node.filePath}${loc}\` |`;
}

/** Render the deterministic "Callers" subsection for one symbol. */
function renderCallersSubsection(
  symbolId: string,
  callers: Array<{ node: Node; edge: Edge }>,
): string {
  if (callers.length === 0) {
    return [
      `### Callers of \`${symbolId}\``,
      `_(no callers found in graph)_`,
      ``,
    ].join("\n");
  }
  const rows = callers.map(callerRow).join("\n");
  return [
    `### Callers of \`${symbolId}\``,
    `| Caller | Kind | Location |`,
    `|--------|------|----------|`,
    rows,
    ``,
  ].join("\n");
}

/** Render the deterministic "Impact" subsection for one symbol. */
function renderImpactSubsection(symbolId: string, subgraph: Subgraph): string {
  const nodes = Array.from(subgraph.nodes.values());
  if (nodes.length === 0) {
    return [
      `### Impact of \`${symbolId}\``,
      `_(no impacted nodes found in graph)_`,
      ``,
    ].join("\n");
  }
  const rows = nodes
    .map((n) => `| \`${n.qualifiedName}\` | ${n.kind} | \`${n.filePath}\` |`)
    .join("\n");
  return [
    `### Impact of \`${symbolId}\``,
    `| Symbol | Kind | File |`,
    `|--------|------|------|`,
    rows,
    ``,
  ].join("\n");
}

/** Maximum graph traversal depth for impact radius queries. */
const IMPACT_DEPTH = 3;

/**
 * Query CodeGraph for callers and impact of every symbol ID found in the
 * specialist outputs. Returns combined markdown for the two deterministic
 * sections, or null if no symbol IDs were found or the graph is unavailable.
 */
async function buildDeterministicGraphSections(
  projectRoot: string,
  symbolIds: string[],
): Promise<string | null> {
  if (symbolIds.length === 0) return null;

  const cg = await CodeGraph.open(projectRoot, { readOnly: true });
  try {
    const callersParts: string[] = [];
    const impactParts: string[] = [];

    for (const id of symbolIds) {
      const callers = cg.getCallers(id);
      callersParts.push(renderCallersSubsection(id, callers));

      const impact = cg.getImpactRadius(id, IMPACT_DEPTH);
      impactParts.push(renderImpactSubsection(id, impact));
    }

    return [
      `## Callers`,
      `<!-- Source: deterministic CodeGraph library API (getCallers) -->`,
      ...callersParts,
      `## Impact`,
      `<!-- Source: deterministic CodeGraph library API (getImpactRadius depth=${IMPACT_DEPTH}) -->`,
      ...impactParts,
    ].join("\n");
  } finally {
    cg.close();
  }
}

// ---------------------------------------------------------------------------

/** Render the base markdown sections deterministically (sync portion). */
function renderBaseMarkdown(sections: ExplorerSections): string {
  const scope = sections.partition
    .map(
      (u) =>
        `\`${u.path}/\` (${u.fileCount} files, ${u.loc.toLocaleString()} LOC)`,
    )
    .join(", ");

  const lines: string[] = [
    `# Partition ${sections.index} of ${sections.total} — Findings`,
    ``,
    `## Scope`,
    scope,
    ``,
    `## Files in Scope`,
    `<!-- Source: codebase-locator sub-agent -->`,
    sections.locatorOutput.trim() || "_(no files located)_",
    ``,
    `## How It Works`,
    `<!-- Source: codebase-analyzer sub-agent -->`,
    sections.analyzerOutput.trim() || "_(no analysis produced)_",
    ``,
    `## Patterns`,
    `<!-- Source: codebase-pattern-finder sub-agent -->`,
    sections.patternsOutput.trim() || "_(no patterns surfaced)_",
    ``,
  ];

  // Only include the External References section when the online researcher
  // actually returned external findings — its skip sentinel would otherwise
  // pollute the aggregator's view of "evidence collected".
  if (
    sections.onlineOutput.trim().length > 0 &&
    !isOnlineSkip(sections.onlineOutput)
  ) {
    lines.push(
      `## External References`,
      `<!-- Source: codebase-online-researcher sub-agent -->`,
      sections.onlineOutput.trim(),
      ``,
    );
  }

  // Out-of-partition references live in the analyzer output already, but we
  // surface a brief pointer for the aggregator's cross-stitching pass.
  lines.push(
    `## Out-of-Partition References`,
    `Look for the **Out-of-Partition References** subsection inside the`,
    `"How It Works" section above — that is where the analyzer flagged files`,
    `outside this partition that other partitions should examine.`,
    ``,
  );

  return lines.join("\n");
}

/**
 * Render the markdown body deterministically.
 *
 * When sections.codegraphHealthy is true AND sections.projectRoot is set,
 * "Callers" and "Impact" sections are appended via deterministic CodeGraph
 * library API calls (§5.6 healthy branch).
 * When false/absent those sections are omitted — the aggregator's LLM stage
 * covers equivalent coverage from raw specialist text (§5.6 unhealthy branch).
 */
export async function renderExplorerMarkdown(
  sections: ExplorerSections,
): Promise<string> {
  let md = renderBaseMarkdown(sections);

  // §5.6 healthy branch — deterministic callers / impact
  if (sections.codegraphHealthy === true && sections.projectRoot != null) {
    const allText = [
      sections.locatorOutput,
      sections.patternsOutput,
      sections.analyzerOutput,
    ].join("\n");
    const symbolIds = extractSymbolIds(allText);
    const graphSections = await buildDeterministicGraphSections(
      sections.projectRoot,
      symbolIds,
    );
    if (graphSections != null) {
      md += graphSections;
    }
  }
  // §5.6 unhealthy branch — no Callers/Impact sections; LLM fallback via
  // aggregator stage covers them from raw specialist text.

  return md;
}

/**
 * Write a partition's deterministic scratch file. Returns the absolute path so
 * the caller can record it in the explorer manifest the aggregator reads.
 */
export async function writeExplorerScratchFile(
  scratchPath: string,
  sections: ExplorerSections,
): Promise<string> {
  const abs = path.resolve(scratchPath);
  const md = await renderExplorerMarkdown(sections);
  await writeFile(abs, md, "utf8");
  return abs;
}
