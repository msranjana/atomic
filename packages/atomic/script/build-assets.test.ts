import { test, expect } from "bun:test";
import { findOverlongTarEntry, MAX_TARRED_PATH_CHARS } from "./build-assets.ts";

test("returns null when every entry is within the limit", () => {
  const entries = ["a/b/c.ts", "x".repeat(MAX_TARRED_PATH_CHARS)];
  expect(findOverlongTarEntry(entries)).toBeNull();
});

test("returns the offending entry when one exceeds the limit", () => {
  const tooLong = "x".repeat(MAX_TARRED_PATH_CHARS + 1);
  expect(findOverlongTarEntry(["short.ts", tooLong])).toBe(tooLong);
});

test("returns the longest entry when multiple exceed the limit", () => {
  const a = "a".repeat(MAX_TARRED_PATH_CHARS + 1);
  const b = "b".repeat(MAX_TARRED_PATH_CHARS + 50);
  expect(findOverlongTarEntry([a, b])).toBe(b);
});
