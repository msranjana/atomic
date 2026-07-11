import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { isSafeFsWatchPathError, watchWithErrorHandler } from "@bastani/atomic";
import { buildCompletionKey, hasSeenWithTtl, recordSeen } from "./completion-dedupe.ts";
import { deliverClaimedCompletion } from "./completion-claims.ts";
import { deliverLocalCompletionNotification } from "./completion-notification.ts";
import { createFileCoalescer } from "../../shared/file-coalescer.ts";
import {
	type IntercomEventBus,
	type NestedRunSummary,
	type SubagentResultIntercomChild,
	type SubagentState,
} from "../../shared/types.ts";
import {
	attachNestedChildrenToResultChildren,
	buildSubagentResultIntercomPayload,
	compactNestedResultChildren,
	deliverSubagentResultIntercomEvent,
	resolveSubagentResultStatus,
} from "../../intercom/result-intercom.ts";
import { projectNestedRegistryForRoot, sanitizeSummary } from "../shared/nested-events.ts";

const WATCHER_RESTART_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 3000;
const DIRECTORY_RESCAN_DELAY_MS = 50;
const STATUS_RECHECK_INTERVAL_MS = 250;
const DELIVERY_RETRY_BASE_MS = 1000;
const DELIVERY_RETRY_MAX_MS = 30_000;

type ResultWatcherFs = Pick<typeof fs, "existsSync" | "readFileSync" | "unlinkSync" | "readdirSync" | "mkdirSync" | "watch"> & {
	realpathSync?: typeof fs.realpathSync;
};

type ResultWatcherTimers = {
	setTimeout: typeof setTimeout;
	clearTimeout: typeof clearTimeout;
	setInterval: typeof setInterval;
	clearInterval: typeof clearInterval;
};

type ResultWatcherSafeWatch = typeof watchWithErrorHandler;

type ResultWatcherDeps = {
	fs?: ResultWatcherFs;
	timers?: ResultWatcherTimers;
	safeWatch?: ResultWatcherSafeWatch;
	statusRecheckIntervalMs?: number;
	deliveryRetryBaseMs?: number;
	deliveryRetryMaxMs?: number;
	intercomTimeoutMs?: number;
	localNotificationTimeoutMs?: number;
};

type ResultFileChild = {
	agent?: string;
	output?: string;
	error?: string;
	success?: boolean;
	sessionFile?: string;
	artifactPaths?: { outputPath?: string };
	intercomTarget?: string;
	children?: unknown;
};

type ResultFileData = {
	id?: string;
	runId?: string;
	agent?: string;
	success?: boolean;
	state?: string;
	mode?: string;
	summary?: string;
	results?: ResultFileChild[];
	nestedChildren?: unknown;
	sessionId?: string;
	cwd?: string;
	sessionFile?: string;
	asyncDir?: string;
	intercomTarget?: string;
};

function sanitizeNestedResultChildren(value: unknown, resultPath: string, label: string): NestedRunSummary[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		console.error(`Ignoring invalid nested children in subagent result file '${resultPath}' at ${label}: expected an array.`);
		return undefined;
	}
	const children = value.map((child) => sanitizeSummary(child)).filter((child): child is NestedRunSummary => Boolean(child));
	if (children.length !== value.length) {
		console.error(`Ignoring ${value.length - children.length} invalid nested child record(s) in subagent result file '${resultPath}' at ${label}.`);
	}
	return children.length ? children : undefined;
}

function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
}

function isNotFoundError(error: unknown): boolean {
	return getErrorCode(error) === "ENOENT";
}

function shouldFallBackToPolling(error: unknown): boolean {
	const code = getErrorCode(error);
	return code === "EMFILE" || code === "ENOSPC" || isSafeFsWatchPathError(error);
}

const TERMINAL_ASYNC_STATES = new Set(["complete", "failed", "paused"]);

function modernResultHasTerminalStatus(data: ResultFileData, fsApi: ResultWatcherFs): boolean {
	if (!Object.prototype.hasOwnProperty.call(data, "asyncDir")) return true;
	const asyncDir = data.asyncDir?.trim();
	const resultRunId = data.runId?.trim() || data.id?.trim();
	if (!asyncDir || !resultRunId) return false;
	try {
		const status = JSON.parse(fsApi.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as { state?: string; runId?: string };
		return status.runId?.trim() === resultRunId
			&& typeof status.state === "string"
			&& TERMINAL_ASYNC_STATES.has(status.state);
	} catch {
		return false;
	}
}

export function createResultWatcher(
	pi: { events: IntercomEventBus },
	state: SubagentState,
	resultsDir: string,
	completionTtlMs: number,
	deps: ResultWatcherDeps = {},
): {
	startResultWatcher: () => void;
	primeExistingResults: () => void;
	stopResultWatcher: () => void;
} {
	const fsApi = deps.fs ?? fs;
	const timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
	const safeWatch = deps.safeWatch ?? watchWithErrorHandler;
	let directoryRescanTimer: ReturnType<typeof setTimeout> | null = null;
	let statusRecheckTimer: ReturnType<typeof setInterval> | null = null;
	const pendingStatusFiles = new Set<string>();
	const inFlight = new Set<string>();
	const rerunAfterFlight = new Set<string>();
	const deliveryRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const deliveryRetryAttempts = new Map<string, number>();
	let stopped = false;
	let watcherGeneration = 0;
	const isCurrentWatcher = (generation: number): boolean => !stopped && generation === watcherGeneration;

	const clearStatusRecheck = (file: string) => {
		pendingStatusFiles.delete(file);
		if (pendingStatusFiles.size === 0 && statusRecheckTimer) {
			timers.clearInterval(statusRecheckTimer);
			statusRecheckTimer = null;
		}
	};

	const clearDeliveryRetry = (file: string) => {
		const timer = deliveryRetryTimers.get(file);
		if (timer) timers.clearTimeout(timer);
		deliveryRetryTimers.delete(file);
		deliveryRetryAttempts.delete(file);
	};

	const scheduleDeliveryRetry = (file: string) => {
		if (stopped || deliveryRetryTimers.has(file)) return;
		const attempt = (deliveryRetryAttempts.get(file) ?? 0) + 1;
		deliveryRetryAttempts.set(file, attempt);
		const base = deps.deliveryRetryBaseMs ?? DELIVERY_RETRY_BASE_MS;
		const maximum = deps.deliveryRetryMaxMs ?? DELIVERY_RETRY_MAX_MS;
		const delay = Math.min(maximum, base * 2 ** Math.min(attempt - 1, 10));
		const timer = timers.setTimeout(() => {
			deliveryRetryTimers.delete(file);
			if (!stopped && fsApi.existsSync(path.join(resultsDir, file))) state.resultFileCoalescer.schedule(file, 0);
		}, delay);
		timer.unref?.();
		deliveryRetryTimers.set(file, timer);
	};

	const canScheduleFile = (file: string): boolean => !stopped && !deliveryRetryTimers.has(file);
	const scheduleResultFile = (file: string, delay = 0): boolean => canScheduleFile(file)
		&& state.resultFileCoalescer.schedule(file, delay);

	const ownsResult = (data: ResultFileData): boolean => !stopped
		&& (!data.sessionId || data.sessionId === state.currentSessionId)
		&& Boolean(data.sessionId || !data.cwd || (state.baseCwd && data.cwd === state.baseCwd));

	const scheduleStatusRecheck = (file: string) => {
		if (stopped) return;
		pendingStatusFiles.add(file);
		if (statusRecheckTimer) return;
		statusRecheckTimer = timers.setInterval(() => {
			if (stopped) return;
			for (const pendingFile of [...pendingStatusFiles]) {
				if (!fsApi.existsSync(path.join(resultsDir, pendingFile))) {
					clearStatusRecheck(pendingFile);
					continue;
				}
				scheduleResultFile(pendingFile);
			}
		}, deps.statusRecheckIntervalMs ?? STATUS_RECHECK_INTERVAL_MS);
		statusRecheckTimer.unref?.();
	};

	const processResult = async (file: string) => {
		const resultPath = path.join(resultsDir, file);
		if (!fsApi.existsSync(resultPath)) {
			clearStatusRecheck(file);
			clearDeliveryRetry(file);
			return;
		}
		try {
			const data = JSON.parse(fsApi.readFileSync(resultPath, "utf-8")) as ResultFileData;
			if (!ownsResult(data)) {
				clearStatusRecheck(file);
				clearDeliveryRetry(file);
				return;
			}
			// Modern producers publish asyncDir and must expose terminal status before
			// delivery. Result-only files predate that contract and remain compatible.
			if (!modernResultHasTerminalStatus(data, fsApi)) {
				scheduleStatusRecheck(file);
				return;
			}
			clearStatusRecheck(file);

			const runId = data.runId ?? data.id ?? file.replace(/\.json$/i, "");
			const hasExplicitNestedChildren = data.nestedChildren !== undefined;
			let nestedChildren = compactNestedResultChildren(sanitizeNestedResultChildren(data.nestedChildren, resultPath, "nestedChildren"));
			if (!nestedChildren?.length && !hasExplicitNestedChildren) {
				try {
					nestedChildren = compactNestedResultChildren(projectNestedRegistryForRoot(runId)?.children);
				} catch (error) {
					console.error(`Failed to enrich subagent result file '${resultPath}' with nested registry children; will retry later:`, error);
					return;
				}
			}
			const now = Date.now();
			const completionKey = buildCompletionKey(data, `result:${file}`);
			if (hasSeenWithTtl(state.completionSeen, completionKey, now, completionTtlMs)) {
				fsApi.unlinkSync(resultPath);
				return;
			}

			const hasResultChildren = Array.isArray(data.results) && data.results.length > 0;
			const resultChildren = hasResultChildren
				? data.results!
				: [{
					agent: data.agent,
					output: data.summary,
					success: data.success,
				}];
			const normalizedChildren = attachNestedChildrenToResultChildren(runId, resultChildren.map((result = {}, index): SubagentResultIntercomChild => {
				const baseOutput = result.output ?? data.summary;
				const hasRealOutput = typeof baseOutput === "string" && baseOutput.trim().length > 0;
				const output = hasRealOutput ? baseOutput : "(no output)";
				const summary = result.success === false && result.error
					? `${result.error}${hasRealOutput ? `\n\nOutput:\n${baseOutput}` : ""}`
					: output;
				const sessionPath = result.sessionFile ?? (resultChildren.length === 1 ? data.sessionFile : undefined);
				const childNestedChildren = sanitizeNestedResultChildren(result.children, resultPath, `results[${index}].children`);
				return {
					agent: result.agent ?? data.agent ?? `step-${index + 1}`,
					status: resolveSubagentResultStatus({
						success: result.success,
						state: data.state === "paused" || typeof result.success !== "boolean" ? data.state : undefined,
					}),
					summary,
					index,
					artifactPath: result.artifactPaths?.outputPath,
					...(typeof sessionPath === "string" && fsApi.existsSync(sessionPath) ? { sessionPath } : {}),
					...(result.intercomTarget ? { intercomTarget: result.intercomTarget } : {}),
					...(childNestedChildren ? { children: childNestedChildren } : {}),
				};
			}), nestedChildren);

			const intercomTarget = data.intercomTarget?.trim();
			const claimKey = `${path.resolve(resultsDir)}:${completionKey}`;
			const stableHash = createHash("sha256").update(claimKey).digest("hex");
			const completionPayload: Record<string, unknown> = {
				...data,
				runId,
				...(nestedChildren?.length ? { nestedChildren } : {}),
				...(Array.isArray(data.results) ? {
					results: hasResultChildren
						? normalizedChildren.map((child, index) => ({
							...data.results![index],
							agent: child.agent,
							status: child.status,
							summary: child.summary,
							index: child.index,
							artifactPath: child.artifactPath,
							sessionPath: child.sessionPath,
							children: child.children,
						}))
						: [],
				} : {}),
			};
			const claim = await deliverClaimedCompletion(claimKey, completionTtlMs, {
				intercom: intercomTarget ? async () => {
					if (!ownsResult(data)) return false;
					const mode = data.mode === "single" || data.mode === "parallel" || data.mode === "chain"
						? data.mode
						: resultChildren.length > 1 ? "chain" : "single";
					const payload = buildSubagentResultIntercomPayload({
						to: intercomTarget, runId, mode, source: "async", children: normalizedChildren,
						asyncId: data.id, asyncDir: data.asyncDir,
					});
					payload.requestId = `completion-${stableHash}`;
					const delivered = await deliverSubagentResultIntercomEvent(pi.events, payload, deps.intercomTimeoutMs ?? 500);
					return delivered;
				} : undefined,
				local: async () => {
					if (!ownsResult(data)) return false;
					const notified = await deliverLocalCompletionNotification(
						pi.events,
						completionPayload,
						`completion-notify-${stableHash}`,
						deps.localNotificationTimeoutMs ?? 500,
					);
					return notified && ownsResult(data);
				},
			});
			if (!claim.delivered) {
				if (ownsResult(data)) {
					if (!deliveryRetryAttempts.has(file)) console.error(`Subagent async completion delivery was not acknowledged for '${resultPath}'; retrying with backoff.`);
					scheduleDeliveryRetry(file);
				}
				return;
			}
			if (!ownsResult(data)) return;
			clearStatusRecheck(file);
			clearDeliveryRetry(file);
			recordSeen(state.completionSeen, completionKey, Date.now());
			fsApi.unlinkSync(resultPath);
		} catch (error) {
			if (isNotFoundError(error)) return;
			console.error(`Failed to process subagent result file '${resultPath}':`, error);
		}
	};

	const handleResult = async (file: string) => {
		if (!canScheduleFile(file)) return;
		if (inFlight.has(file)) {
			rerunAfterFlight.add(file);
			return;
		}
		inFlight.add(file);
		try {
			await processResult(file);
		} finally {
			inFlight.delete(file);
			if (rerunAfterFlight.delete(file) && fsApi.existsSync(path.join(resultsDir, file))) {
				scheduleResultFile(file);
			}
		}
	};

	state.resultFileCoalescer = createFileCoalescer((file) => {
		void handleResult(file);
	}, 50);

	const primeExistingResults = () => {
		if (stopped) return;
		try {
			fsApi.readdirSync(resultsDir)
				.filter((f) => f.endsWith(".json"))
				.forEach((file) => scheduleResultFile(file));
		} catch (error) {
			if (isNotFoundError(error)) return;
			console.error(`Failed to scan subagent result directory '${resultsDir}':`, error);
		}
	};

	const scheduleDirectoryRescan = () => {
		if (stopped) return;
		if (directoryRescanTimer) timers.clearTimeout(directoryRescanTimer);
		directoryRescanTimer = timers.setTimeout(() => {
			directoryRescanTimer = null;
			if (!stopped) primeExistingResults();
		}, DIRECTORY_RESCAN_DELAY_MS);
		directoryRescanTimer.unref?.();
	};

	const startPollingFallback = (reason: unknown) => {
		if (stopped) return;
		state.watcher?.close();
		state.watcher = null;
		if (state.watcherRestartTimer) return;

		console.error(
			`Subagent result watcher for '${resultsDir}' fell back to polling because native fs.watch is unavailable (${getErrorCode(reason) ?? "unknown error"}).`,
		);
		primeExistingResults();
		state.watcherRestartTimer = timers.setInterval(() => { if (!stopped) primeExistingResults(); }, POLL_INTERVAL_MS);
		state.watcherRestartTimer.unref?.();
	};

	const openResultWatcher = () => {
		if (stopped || state.watcher) return;
		const generation = watcherGeneration;
		try {
			const handleWatcherError = (error: Error) => {
				if (!isCurrentWatcher(generation)) return;
				if (shouldFallBackToPolling(error)) {
					startPollingFallback(error);
					return;
				}
				console.error(`Subagent result watcher failed for '${resultsDir}':`, error);
				state.watcher?.close();
				state.watcher = null;
				scheduleRestart(generation);
			};
			state.watcher = safeWatch(resultsDir, (_event, file) => {
				if (!isCurrentWatcher(generation)) return;
				if (file) {
					const fileName = file.toString();
					if (fileName.endsWith(".json")) scheduleResultFile(fileName, 50);
				}
				scheduleDirectoryRescan();
			}, handleWatcherError, {
				watch: fsApi.watch,
				realpathSyncNative: fsApi.realpathSync?.native,
			});
			state.watcher?.unref?.();
		} catch (error) {
			if (stopped) return;
			if (shouldFallBackToPolling(error)) {
				startPollingFallback(error);
				return;
			}
			console.error(`Failed to start subagent result watcher for '${resultsDir}':`, error);
			state.watcher = null;
			scheduleRestart(generation);
		}
	};

	function scheduleRestart(generation = watcherGeneration): void {
		if (!isCurrentWatcher(generation) || state.watcherRestartTimer) return;
		let timer!: ReturnType<typeof setTimeout>;
		timer = timers.setTimeout(() => {
			if (state.watcherRestartTimer !== timer || !isCurrentWatcher(generation)) return;
			state.watcherRestartTimer = null;
			try {
				fsApi.mkdirSync(resultsDir, { recursive: true });
				openResultWatcher();
			} catch (error) {
				if (stopped) return;
				if (shouldFallBackToPolling(error)) {
					startPollingFallback(error);
					return;
				}
				console.error(`Failed to restart subagent result watcher for '${resultsDir}':`, error);
				scheduleRestart(generation);
			}
		}, WATCHER_RESTART_DELAY_MS);
		state.watcherRestartTimer = timer;
		timer.unref?.();
	}

	const startResultWatcher = () => {
		stopped = false;
		if (state.watcherRestartTimer) {
			timers.clearTimeout(state.watcherRestartTimer);
			timers.clearInterval(state.watcherRestartTimer);
			state.watcherRestartTimer = null;
		}
		openResultWatcher();
	};

	const stopResultWatcher = () => {
		stopped = true;
		watcherGeneration += 1;
		state.watcher?.close();
		state.watcher = null;
		if (state.watcherRestartTimer) {
			timers.clearTimeout(state.watcherRestartTimer);
			timers.clearInterval(state.watcherRestartTimer);
		}
		state.watcherRestartTimer = null;
		if (directoryRescanTimer) timers.clearTimeout(directoryRescanTimer);
		directoryRescanTimer = null;
		for (const file of [...pendingStatusFiles]) clearStatusRecheck(file);
		if (statusRecheckTimer) timers.clearInterval(statusRecheckTimer);
		statusRecheckTimer = null;
		for (const file of [...deliveryRetryTimers.keys()]) clearDeliveryRetry(file);
		state.resultFileCoalescer.clear();
	};

	return { startResultWatcher, primeExistingResults, stopResultWatcher };
}
