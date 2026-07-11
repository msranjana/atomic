import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createResultWatcher } from "../../packages/subagents/src/runs/background/result-watcher.js";
import { reconcileAsyncRun } from "../../packages/subagents/src/runs/background/stale-run-reconciler.js";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type SubagentState,
} from "../../packages/subagents/src/shared/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function state(sessionId: string): SubagentState {
	return {
		baseCwd: "", currentSessionId: sessionId, asyncJobs: new Map(), subagentInProgress: false,
		foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(), cleanupTimers: new Map(), lastUiContext: null,
		poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function acknowledgeCompletion(payload: object, delivered = true): void {
	(payload as { acknowledge?: (delivered: boolean) => void }).acknowledge?.(delivered);
}

function makeWatcher(resultsDir: string, sessionId: string, options: {
	statusRecheckIntervalMs?: number; intercomTimeoutMs?: number; deliveryRetryBaseMs?: number; localNotificationTimeoutMs?: number;
} = {}) {
	const delivered: object[] = [];
	const events = {
		on: () => () => {},
		emit(event: string, payload: object) {
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) { delivered.push(payload); acknowledgeCompletion(payload); }
		},
	};
	const watcher = createResultWatcher({ events }, state(sessionId), resultsDir, 60_000, options);
	return { watcher, delivered };
}

async function settle(): Promise<void> { await Bun.sleep(80); }

test("modern results wait for terminal status, then deliver exactly once; legacy result-only remains compatible", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-guard-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	const asyncDir = path.join(root, "async");
	fs.mkdirSync(resultsDir, { recursive: true });
	fs.mkdirSync(asyncDir, { recursive: true });
	const resultPath = path.join(resultsDir, "modern.json");
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "modern", state: "running" }));
	fs.writeFileSync(resultPath, JSON.stringify({ id: "modern", sessionId: "session", agent: "worker", success: true, summary: "done", asyncDir }));
	const { watcher, delivered } = makeWatcher(resultsDir, "session");
	watcher.primeExistingResults();
	await settle();
	assert.equal(delivered.length, 0);
	assert.equal(fs.existsSync(resultPath), true, "running modern result must remain pending and unclaimed");

	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "modern", state: "complete" }));
	await Bun.sleep(250);
	assert.equal(delivered.length, 1);
	assert.equal(fs.existsSync(resultPath), false);
	for (const terminalState of ["failed", "paused"]) {
		const terminalAsyncDir = path.join(root, terminalState);
		fs.mkdirSync(terminalAsyncDir);
		fs.writeFileSync(path.join(terminalAsyncDir, "status.json"), JSON.stringify({ runId: terminalState, state: terminalState }));
		fs.writeFileSync(path.join(resultsDir, `${terminalState}.json`), JSON.stringify({ id: terminalState, sessionId: "session", asyncDir: terminalAsyncDir }));
	}
	watcher.primeExistingResults();
	await settle();
	assert.equal(delivered.length, 3, "all terminal modern states deliver");

	const legacyPath = path.join(resultsDir, "legacy.json");
	fs.writeFileSync(legacyPath, JSON.stringify({ id: "legacy", sessionId: "session", agent: "worker", success: true, summary: "legacy" }));
	watcher.primeExistingResults();
	await settle();
	assert.equal(delivered.length, 4);
	assert.equal(fs.existsSync(legacyPath), false);
	watcher.stopResultWatcher();
});

test("missing and malformed modern status remain pending", async () => {
	for (const status of [undefined, "not json", JSON.stringify({ state: "queued" })]) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-invalid-status-"));
		roots.push(root);
		const resultsDir = path.join(root, "results");
		const asyncDir = path.join(root, "async");
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		if (status !== undefined) fs.writeFileSync(path.join(asyncDir, "status.json"), status);
		const resultPath = path.join(resultsDir, "result.json");
		fs.writeFileSync(resultPath, JSON.stringify({ id: "run", sessionId: "session", asyncDir }));
		const { watcher, delivered } = makeWatcher(resultsDir, "session");
		watcher.primeExistingResults();
		await settle();
		assert.equal(delivered.length, 0);
		assert.equal(fs.existsSync(resultPath), true);
		watcher.stopResultWatcher();
	}
});

test("blank asyncDir is malformed modern metadata, not a legacy result", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-blank-dir-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(resultsDir, { recursive: true });
	const resultPath = path.join(resultsDir, "result.json");
	fs.writeFileSync(resultPath, JSON.stringify({ id: "run", sessionId: "session", asyncDir: "   " }));
	const { watcher, delivered } = makeWatcher(resultsDir, "session", { statusRecheckIntervalMs: 2 });
	watcher.primeExistingResults();
	await Bun.sleep(30);
	assert.equal(delivered.length, 0);
	assert.equal(fs.existsSync(resultPath), true);
	watcher.stopResultWatcher();
});

test("pending modern result remains deliverable after more than the former retry limit", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-late-status-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	const asyncDir = path.join(root, "async");
	fs.mkdirSync(resultsDir, { recursive: true });
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "late", state: "running" }));
	fs.writeFileSync(path.join(resultsDir, "result.json"), JSON.stringify({ id: "late", sessionId: "session", asyncDir }));
	const { watcher, delivered } = makeWatcher(resultsDir, "session", { statusRecheckIntervalMs: 1 });
	watcher.primeExistingResults();
	await Bun.sleep(180);
	assert.equal(delivered.length, 0, "more than 100 rechecks must not strand or deliver a running result");
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "late", state: "complete" }));
	await Bun.sleep(40);
	assert.equal(delivered.length, 1);
	watcher.stopResultWatcher();
});

test("stale repair exposes terminal status at the observable result publication boundary", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-stale-repair-"));
	roots.push(root);
	const asyncDir = path.join(root, "async");
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.mkdirSync(resultsDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId: "stale", sessionId: "session", mode: "single", state: "running", startedAt: 1, lastUpdate: 1, pid: 999999,
		steps: [{ agent: "worker", status: "running" }],
	}));
	let statusAtDelivery: string | undefined;
	const events = {
		on: () => () => {},
		emit(event: string, payload: object) {
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) {
				statusAtDelivery = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state as string;
				acknowledgeCompletion(payload);
			}
		},
	};
	const watcher = createResultWatcher({ events }, state("session"), resultsDir, 60_000);
	watcher.startResultWatcher();
	const repaired = reconcileAsyncRun(asyncDir, { resultsDir, now: () => 100, kill: () => { const error = new Error("dead") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; } });
	assert.equal(repaired.repaired, true);
	await Bun.sleep(200);
	assert.equal(statusAtDelivery, "failed");
	assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state, "failed");
	watcher.stopResultWatcher();
});

test("concurrent result notifications do not unlink or double-deliver an in-flight intercom result", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-inflight-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	const asyncDir = path.join(root, "async");
	fs.mkdirSync(resultsDir, { recursive: true });
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "run", state: "complete" }));
	const resultPath = path.join(resultsDir, "result.json");
	fs.writeFileSync(resultPath, JSON.stringify({ id: "run", sessionId: "session", asyncDir, intercomTarget: "parent", summary: "done" }));
	const listeners = new Map<string, Set<(data: object) => void>>();
	let intercomDeliveries = 0;
	let completions = 0;
	const events = {
		on(event: string, listener: (data: object) => void) {
			const set = listeners.get(event) ?? new Set();
			set.add(listener);
			listeners.set(event, set);
			return () => set.delete(listener);
		},
		emit(event: string, payload: object) {
			if (event === SUBAGENT_RESULT_INTERCOM_EVENT) {
				intercomDeliveries += 1;
				const requestId = (payload as { requestId: string }).requestId;
				setTimeout(() => {
					for (const listener of listeners.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) listener({ requestId, delivered: true });
				}, 150);
			}
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) { completions += 1; acknowledgeCompletion(payload); }
		},
	};
	const watcher = createResultWatcher({ events }, state("session"), resultsDir, 60_000);
	watcher.primeExistingResults();
	await Bun.sleep(70);
	watcher.primeExistingResults();
	await Bun.sleep(70);
	assert.equal(fs.existsSync(resultPath), true, "a duplicate notification must not unlink an in-flight result");
	await Bun.sleep(150);
	assert.equal(intercomDeliveries, 1);
	assert.equal(completions, 1);
	assert.equal(fs.existsSync(resultPath), false);
	watcher.stopResultWatcher();
});

test("failed intercom acknowledgement remains retryable and is delivered once after retry", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-retry-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	const asyncDir = path.join(root, "async");
	fs.mkdirSync(resultsDir, { recursive: true });
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "retry", state: "complete" }));
	const resultPath = path.join(resultsDir, "result.json");
	fs.writeFileSync(resultPath, JSON.stringify({ id: "retry", sessionId: "session", asyncDir, intercomTarget: "parent" }));
	const listeners = new Map<string, Set<(data: object) => void>>();
	let attempts = 0;
	let completions = 0;
	const events = {
		on(event: string, listener: (data: object) => void) {
			const set = listeners.get(event) ?? new Set();
			set.add(listener);
			listeners.set(event, set);
			return () => set.delete(listener);
		},
		emit(event: string, payload: object) {
			if (event === SUBAGENT_RESULT_INTERCOM_EVENT) {
				attempts += 1;
				const requestId = (payload as { requestId: string }).requestId;
				for (const listener of listeners.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) {
					listener({ requestId, delivered: attempts > 1 });
				}
			}
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) { completions += 1; acknowledgeCompletion(payload); }
		},
	};
	const watcher = createResultWatcher({ events }, state("session"), resultsDir, 60_000, {
		statusRecheckIntervalMs: 10,
		deliveryRetryBaseMs: 10,
	});
	watcher.primeExistingResults();
	await Bun.sleep(200);
	assert.equal(attempts, 2, "a negative acknowledgement must retry without another filesystem event");
	assert.equal(completions, 1);
	assert.equal(fs.existsSync(resultPath), false);
	watcher.primeExistingResults();
	await settle();
	assert.equal(attempts, 2);
	watcher.stopResultWatcher();
});



test("definitive delivery failures use exponential backoff instead of status polling cadence", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-backoff-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(resultsDir, { recursive: true });
	fs.writeFileSync(path.join(resultsDir, "result.json"), JSON.stringify({ id: "backoff-run", sessionId: "session", intercomTarget: "missing" }));
	const listeners = new Map<string, Set<(data: object) => void>>();
	let attempts = 0;
	const events = {
		on(event: string, listener: (data: object) => void) { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); return () => set.delete(listener); },
		emit(event: string, payload: object) {
			if (event !== SUBAGENT_RESULT_INTERCOM_EVENT) return;
			attempts += 1;
			const requestId = (payload as { requestId: string }).requestId;
			for (const listener of listeners.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) listener({ requestId, delivered: false });
		},
	};
	const watcher = createResultWatcher({ events }, state("session"), resultsDir, 60_000, { statusRecheckIntervalMs: 1, deliveryRetryBaseMs: 50 });
	watcher.primeExistingResults();
	await Bun.sleep(220);
	assert.equal(attempts, 3, "50ms, 100ms, then a pending 200ms retry");
	watcher.stopResultWatcher();
});
test("alias files and replacement watchers share one claim through an acknowledgement later than the former timeout", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-global-claim-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	const asyncDir = path.join(root, "async");
	fs.mkdirSync(resultsDir, { recursive: true });
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "same-run", state: "complete" }));
	for (const file of ["one.json", "alias.json"]) {
		fs.writeFileSync(path.join(resultsDir, file), JSON.stringify({ id: "same-run", sessionId: "session", asyncDir, intercomTarget: "parent" }));
	}
	const listeners = new Map<string, Set<(data: object) => void>>();
	let sends = 0;
	let forwarded = 0;
	let completions = 0;
	const events = {
		on(event: string, listener: (data: object) => void) {
			const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); return () => set.delete(listener);
		},
		emit(event: string, payload: object) {
			if (event === SUBAGENT_RESULT_INTERCOM_EVENT) {
				sends += 1;
				const requestId = (payload as { requestId: string }).requestId;
				if (forwarded++ === 0) {
					setTimeout(() => { for (const listener of listeners.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) listener({ requestId, delivered: true }); }, 80);
				} else {
					for (const listener of listeners.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) listener({ requestId, delivered: true });
					forwarded -= 1;
				}
			}
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) { completions += 1; acknowledgeCompletion(payload); }
		},
	};
	const first = createResultWatcher({ events }, state("session"), resultsDir, 60_000, { intercomTimeoutMs: 30, deliveryRetryBaseMs: 10 });
	const replacement = createResultWatcher({ events }, state("session"), resultsDir, 60_000, { intercomTimeoutMs: 30, deliveryRetryBaseMs: 10 });
	first.primeExistingResults();
	replacement.primeExistingResults();
	await Bun.sleep(20);
	assert.equal(sends, 1, "aliases and watcher replacement must share the same in-flight delivery");
	first.stopResultWatcher();
	await Bun.sleep(150);
	assert.equal(sends, 2, "the timed-out attempt retries with the same id");
	assert.equal(forwarded, 1, "the broker forwards the stable message id only once");
	assert.equal(completions, 1);
	assert.equal(listeners.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT)?.size ?? 0, 0, "the pending acknowledgement listener must be released after settlement");
	assert.deepEqual(fs.readdirSync(resultsDir), []);
	replacement.stopResultWatcher();
});


test("pending status polling stops when result ownership changes", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-owner-change-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	const asyncDir = path.join(root, "async");
	fs.mkdirSync(resultsDir, { recursive: true });
	fs.mkdirSync(asyncDir, { recursive: true });
	const statusPath = path.join(asyncDir, "status.json");
	fs.writeFileSync(statusPath, JSON.stringify({ runId: "owner", state: "running" }));
	fs.writeFileSync(path.join(resultsDir, "result.json"), JSON.stringify({ id: "owner", sessionId: "session-a", asyncDir }));
	let statusReads = 0;
	const countedReadFileSync = ((filePath: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
		if (filePath === statusPath) statusReads += 1;
		return fs.readFileSync(filePath, options);

	}) as typeof fs.readFileSync;
	const fsApi = {
		existsSync: fs.existsSync,
		readFileSync: countedReadFileSync,
		unlinkSync: fs.unlinkSync,
		readdirSync: fs.readdirSync,
		mkdirSync: fs.mkdirSync,
		watch: fs.watch,
		realpathSync: fs.realpathSync,
	};
	const runState = state("session-a");
	const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, runState, resultsDir, 60_000, {
		fs: fsApi,
		statusRecheckIntervalMs: 2,
	});
	watcher.primeExistingResults();
	await Bun.sleep(30);
	runState.currentSessionId = "session-b";
	await Bun.sleep(30);
	const readsAfterOwnershipChange = statusReads;
	await Bun.sleep(30);
	assert.equal(statusReads, readsAfterOwnershipChange, "ownership mismatch must remove the file from status polling");
	watcher.stopResultWatcher();
});

test("stopped watcher does not finalize a delayed acknowledged result", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-stopped-wait-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(resultsDir, { recursive: true });
	const resultPath = path.join(resultsDir, "result.json");
	fs.writeFileSync(resultPath, JSON.stringify({ id: "stopped-after-wait", sessionId: "session", intercomTarget: "parent" }));
	const listeners = new Map<string, Set<(data: object) => void>>();
	let completions = 0;
	const events = {
		on(event: string, listener: (data: object) => void) { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); return () => set.delete(listener); },
		emit(event: string, payload: object) {
			if (event === SUBAGENT_RESULT_INTERCOM_EVENT) {
				const requestId = (payload as { requestId: string }).requestId;
				setTimeout(() => { for (const listener of listeners.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) listener({ requestId, delivered: true }); }, 40);
			}
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) { completions += 1; acknowledgeCompletion(payload); }
		},
	};
	const watcher = createResultWatcher({ events }, state("session"), resultsDir, 60_000);
	watcher.primeExistingResults();
	await Bun.sleep(10);
	watcher.stopResultWatcher();
	await Bun.sleep(80);
	assert.equal(completions, 0);
	assert.equal(fs.existsSync(resultPath), true);
});
