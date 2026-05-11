import { readFileSync, statSync } from "node:fs";

/**
 * Minimum byte size we trust as a real research document. The mandated YAML
 * frontmatter alone is ~300 bytes; a document with any actual findings clears
 * this comfortably. Conservative on purpose — this only catches empty stubs or
 * a short error string the agent wrote on itself, not legitimately terse reports.
 */
const MIN_RESEARCH_DOC_BYTES = 500;

/**
 * Verify the aggregator actually produced a usable research document at
 * `finalPath`, rather than reporting success without writing the artifact (or
 * writing an empty / truncated stub). Checks: the file exists, clears a
 * conservative size floor, and opens with YAML frontmatter (`---`) as
 * `buildAggregatorPrompt()`'s OUTPUT_FORMAT requires. Returns `false` instead
 * of throwing on any filesystem error so callers can treat "not verifiable"
 * the same as "missing".
 */
export function aggregatorOutputComplete(finalPath: string): boolean {
  try {
    if (statSync(finalPath).size < MIN_RESEARCH_DOC_BYTES) return false;
    return readFileSync(finalPath, "utf8").trimStart().startsWith("---");
  } catch {
    return false;
  }
}
