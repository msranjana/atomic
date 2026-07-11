import { test } from "bun:test";
import assert from "node:assert/strict";
import registerSubagentNotify from "../../packages/subagents/src/runs/background/notify.js";
import { deliverLocalCompletionNotification } from "../../packages/subagents/src/runs/background/completion-notification.js";

function createHarness() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  let sends = 0;
  const pi = {
    events: {
      on(event: string, handler: (data: unknown) => void) {
        const set = listeners.get(event) ?? new Set(); set.add(handler); listeners.set(event, set); return () => set.delete(handler);
      },
      emit(event: string, payload: unknown) { for (const handler of listeners.get(event) ?? []) handler(payload); },
    },
    sendMessage() {
      sends += 1;
      if (sends === 1) throw new Error("injected notification failure");
    },
  };
  return { pi, sends: () => sends };
}

test("local completion acknowledgement retries failures and dedupes successful request ids", async () => {
  const harness = createHarness();
  const unregister = registerSubagentNotify(harness.pi as never);
  const payload = { id: "notify-run", agent: "worker", success: true, summary: "done" };
  assert.equal(await deliverLocalCompletionNotification(harness.pi.events, payload, "stable-notify", 20), false);
  assert.equal(await deliverLocalCompletionNotification(harness.pi.events, payload, "stable-notify", 20), true);
  assert.equal(await deliverLocalCompletionNotification(harness.pi.events, payload, "stable-notify", 20), true);
  assert.equal(harness.sends(), 2, "the duplicate request is acknowledged without another message");
  unregister();
});
