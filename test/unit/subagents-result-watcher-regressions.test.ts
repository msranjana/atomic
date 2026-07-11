import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createResultWatcher } from "../../packages/subagents/src/runs/background/result-watcher.js";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type SubagentState,
} from "../../packages/subagents/src/shared/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function createState(sessionId = "session"): SubagentState {
	return {
		baseCwd: "", currentSessionId: sessionId, asyncJobs: new Map(), subagentInProgress: false,
		foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(), cleanupTimers: new Map(), lastUiContext: null,
		poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function tempResults(prefix: string): { root: string; resultsDir: string; asyncDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	const asyncDir = path.join(root, "async");
	fs.mkdirSync(resultsDir);
	fs.mkdirSync(asyncDir);
	return { root, resultsDir, asyncDir };
}

test("modern result requires its own nonempty identity to match terminal status", async () => {
	const { resultsDir, asyncDir } = tempResults("atomic-result-identity-");
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "run-b", state: "complete" }));
	const mismatched = path.join(resultsDir, "mismatched.json");
	const unidentified = path.join(resultsDir, "unidentified.json");
	fs.writeFileSync(mismatched, JSON.stringify({ id: "run-a", sessionId: "session", asyncDir }));
	fs.writeFileSync(unidentified, JSON.stringify({ sessionId: "session", asyncDir }));
	let delivered = 0;
	const watcher = createResultWatcher({ events: {
		on: () => () => {},
		emit(event) { if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) delivered += 1; },
	} }, createState(), resultsDir, 60_000, { statusRecheckIntervalMs: 5 });
	watcher.primeExistingResults();
	await Bun.sleep(40);
	assert.equal(delivered, 0);
	assert.equal(fs.existsSync(mismatched), true);
	assert.equal(fs.existsSync(unidentified), true);
	watcher.stopResultWatcher();
});

test("explicit negative local acknowledgement retries while synchronous observation remains compatible", async () => {
	const { resultsDir } = tempResults("atomic-result-local-ack-");
	const resultPath = path.join(resultsDir, "result.json");
	fs.writeFileSync(resultPath, JSON.stringify({ id: "local-ack", sessionId: "session" }));
	let attempts = 0;
	const watcher = createResultWatcher({ events: {
		on: () => () => {},
		emit(event, payload) {
			if (event !== SUBAGENT_ASYNC_COMPLETE_EVENT) return;
			attempts += 1;
			if (attempts === 1) (payload as { acknowledge(delivered: boolean): void }).acknowledge(false);
			// The second observation intentionally does not acknowledge: legacy observers
			// count successful synchronous emission as delivery.
		},
	} }, createState(), resultsDir, 60_000, { deliveryRetryBaseMs: 10 });
	watcher.primeExistingResults();
	await Bun.sleep(100);
	assert.equal(attempts, 2);
	assert.equal(fs.existsSync(resultPath), false);
	watcher.stopResultWatcher();
});

test("queued watcher errors cannot resurrect a stopped watcher", async () => {
	const { resultsDir } = tempResults("atomic-result-stop-");
	let starts = 0;
	let queuedError: ((error: Error) => void) | undefined;
	const safeWatch = ((_dir: string, _listener: (event: string, file: string | Buffer | null) => void, onError: (error: Error) => void) => {
		starts += 1;
		queuedError = onError;
		return { close() {}, unref() {} };
	}) as never;
	const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, createState(), resultsDir, 60_000, { safeWatch });
	watcher.startResultWatcher();
	assert.equal(starts, 1);
	watcher.stopResultWatcher();
	queuedError?.(new Error("queued failure"));
	await Bun.sleep(20);
	assert.equal(starts, 1);
});

test("an error queued by a retired native watcher cannot close its replacement", () => {
	const { resultsDir } = tempResults("atomic-result-watcher-replacement-");
	const errors: Array<(error: Error) => void> = [];
	const handles: Array<{ closed: boolean; close(): void; unref(): void }> = [];
	const safeWatch = ((_dir: string, _listener: (event: string, file: string | Buffer | null) => void, onError: (error: Error) => void) => {
		errors.push(onError);
		const handle = { closed: false, close() { this.closed = true; }, unref() {} };
		handles.push(handle);
		return handle;
	}) as never;
	const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, createState(), resultsDir, 60_000, { safeWatch });
	watcher.startResultWatcher();
	watcher.stopResultWatcher();
	watcher.startResultWatcher();
	assert.equal(handles.length, 2);
	errors[0]?.(new Error("retired watcher failure"));
	assert.equal(handles[1]?.closed, false);
	watcher.stopResultWatcher();
});

test("a retired restart timer cannot replace or disarm the current watcher lifecycle", () => {
	const { resultsDir } = tempResults("atomic-result-restart-owner-");
	const errors: Array<(error: Error) => void> = [];
	const timerCallbacks: Array<() => void> = [];
	let starts = 0;
	const safeWatch = ((_dir: string, _listener: (event: string, file: string | Buffer | null) => void, onError: (error: Error) => void) => {
		starts += 1;
		errors.push(onError);
		return { close() {}, unref() {} };
	}) as never;
	const setTimer = ((callback: () => void) => {
		timerCallbacks.push(callback);
		return { unref() {} };
	}) as never;
	const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, createState(), resultsDir, 60_000, {
		safeWatch,
		timers: { setTimeout: setTimer, clearTimeout: (() => {}) as never, setInterval: setTimer, clearInterval: (() => {}) as never },
	});
	watcher.startResultWatcher();
	errors[0]?.(new Error("first failure"));
	watcher.stopResultWatcher();
	watcher.startResultWatcher();
	errors[1]?.(new Error("replacement failure"));
	assert.equal(starts, 2);
	timerCallbacks[0]?.();
	assert.equal(starts, 2, "a queued timer from the retired lifecycle must be inert");
	watcher.stopResultWatcher();
});

test("prime and rescan activity cannot bypass delivery backoff", async () => {
	const { resultsDir } = tempResults("atomic-result-backoff-gate-");
	fs.writeFileSync(path.join(resultsDir, "result.json"), JSON.stringify({ id: "backoff", sessionId: "session", intercomTarget: "missing" }));
	const listeners = new Map<string, Set<(payload: object) => void>>();
	let attempts = 0;
	const events = {
		on(event: string, listener: (payload: object) => void) {
			const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); return () => set.delete(listener);
		},
		emit(event: string, payload: object) {
			if (event !== SUBAGENT_RESULT_INTERCOM_EVENT) return;
			attempts += 1;
			const requestId = (payload as { requestId: string }).requestId;
			for (const listener of listeners.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) listener({ requestId, delivered: false });
		},
	};
	const watcher = createResultWatcher({ events }, createState(), resultsDir, 60_000, { deliveryRetryBaseMs: 500 });
	watcher.primeExistingResults();
	await Bun.sleep(70);
	assert.equal(attempts, 1);
	for (let i = 0; i < 5; i += 1) watcher.primeExistingResults();
	await Bun.sleep(150);
	assert.equal(attempts, 1, "rescans must not bypass the pending retry");
	await Bun.sleep(400);
	assert.equal(attempts, 2);
	watcher.stopResultWatcher();
});
