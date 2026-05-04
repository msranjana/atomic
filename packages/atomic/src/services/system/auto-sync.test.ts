/**
 * Auto-sync runtime-environment detection tests (RFC §5.3.1).
 *
 * `auto-sync.ts` delegates its `isInstalledPackage()` check to the canonical
 * SDK helper. These tests exercise that SDK helper directly (the wrapper in
 * auto-sync.ts is private and not exported) to guarantee the detection
 * logic the CLI relies on handles every required path pattern.
 */

import { test, expect } from "bun:test";
import {
  isInstalledPackage,
  isCompiledBinaryRuntime,
} from "@bastani/atomic-sdk/lib/runtime-env";

test("isInstalledPackage true for /$bunfs/ paths", () => {
  expect(isInstalledPackage("/$bunfs/abcd/cli.ts")).toBe(true);
});

test("isInstalledPackage false for normal source paths", () => {
  expect(
    isInstalledPackage(
      "/Users/me/atomic/packages/atomic/src/services/system"
    )
  ).toBe(false);
});

test("isInstalledPackage true for node_modules paths", () => {
  expect(isInstalledPackage("/foo/node_modules/@bastani/atomic/src")).toBe(
    true
  );
});

test("isCompiledBinaryRuntime true for POSIX bunfs", () => {
  expect(isCompiledBinaryRuntime("/$bunfs/x")).toBe(true);
});

test("isCompiledBinaryRuntime true for Windows bunfs", () => {
  expect(isCompiledBinaryRuntime("\\$bunfs\\x")).toBe(true);
});
