import { test } from "bun:test";
import assert from "node:assert/strict";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";

test("successful broker message ids dedupe within a bounded TTL cache", () => {
  const cache = new DeliveredMessageCache(100, 2);
  cache.record("one", 0);
  cache.record("two", 1);
  assert.equal(cache.has("one", 2), true);
  cache.record("three", 3);
  assert.equal(cache.has("one", 3), false, "oldest entry is evicted at the size bound");
  assert.equal(cache.has("two", 102), false, "entries expire after the TTL");
  assert.equal(cache.has("three", 102), true);
});
