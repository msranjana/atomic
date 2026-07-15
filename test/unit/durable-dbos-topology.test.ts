import { test } from "bun:test";
import assert from "node:assert/strict";
import { decodeToCheckpoint, encodeCheckpoint } from "../../packages/workflows/src/durable/dbos-envelope.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";

test("DBOS stage envelopes round-trip versioned topology metadata", () => {
  const topology = { version: 1, stageId: "source-review", parentIds: ["source-plan"] } as const;
  const checkpoint: DurableStageCheckpoint = {
    kind: "stage",
    workflowId: "wf-stage-topology",
    checkpointId: "stage:review:1",
    name: "review",
    replayKey: "stage:review:1",
    output: "done",
    completedAt: 3000,
    topology,
  };

  const envelope = encodeCheckpoint(checkpoint);
  assert.deepEqual(envelope.topology, topology);
  const decoded = decodeToCheckpoint(checkpoint.workflowId, checkpoint.checkpointId, envelope);
  assert.ok(decoded?.kind === "stage");
  assert.deepEqual(decoded.topology, topology);
});
