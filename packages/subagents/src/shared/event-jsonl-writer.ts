import * as fs from "node:fs";
import * as path from "node:path";
import type { DrainableSource, JsonlWriteStream } from "./jsonl-writer.ts";

interface TelemetryState {
	telemetryBytes: number;
	telemetryTruncated: boolean;
}

interface SharedEventWriter extends TelemetryState {
	stream: JsonlWriteStream;
	sources: Set<DrainableSource>;
	refs: number;
	backpressured: boolean;
	closed: boolean;
	failed: boolean;
	filePath: string;
	key: string;
	closingLines: string[];
	settled: Promise<void>;
	resolveSettled: () => void;
}

const writers = new Map<string, SharedEventWriter>();

function keyFor(filePath: string): string {
	return path.resolve(filePath);
}

function existingTelemetryState(filePath: string, seed?: TelemetryState): TelemetryState {
	try {
		const text = fs.readFileSync(filePath, "utf-8");
		return {
			telemetryBytes: Math.max(seed?.telemetryBytes ?? 0, Buffer.byteLength(text, "utf-8")),
			telemetryTruncated: Boolean(seed?.telemetryTruncated) || text.includes('\"type\":\"subagent.child.telemetry_truncated\"'),
		};
	} catch {
		return seed
			? { telemetryBytes: seed.telemetryBytes, telemetryTruncated: seed.telemetryTruncated }
			: { telemetryBytes: 0, telemetryTruncated: false };
	}
}

function resumeSources(writer: SharedEventWriter): void {
	for (const source of writer.sources) source.resume();
	writer.sources.clear();
	writer.backpressured = false;
}

function settleWriter(writer: SharedEventWriter): void {
	if (writers.get(writer.key) === writer) writers.delete(writer.key);
	resumeSources(writer);
	writer.resolveSettled();
}

function failWriter(writer: SharedEventWriter): void {
	if (writer.failed) return;
	writer.failed = true;
	writer.closed = true;
	settleWriter(writer);
}

function write(writer: SharedEventWriter, chunk: string): void {
	if (writer.closed || writer.failed) return;
	try {
		const accepted = writer.stream.write(chunk);
		if (!accepted && !writer.backpressured) {
			writer.backpressured = true;
			for (const source of writer.sources) source.pause();
			writer.stream.once("drain", () => {
				writer.backpressured = false;
				if (!writer.closed && !writer.failed) for (const source of writer.sources) source.resume();
			});
		}
	} catch {
		failWriter(writer);
	}
}

export interface EventWriterLease {
	reserveTelemetry(bytes: number, maxBytes: number): boolean;
	claimTruncationMarker(): boolean;
	writeLine(line: string): void;
	close(): Promise<void>;
}

type StreamFactory = (filePath: string) => JsonlWriteStream;

function createDeferredLease(
	closingWriter: SharedEventWriter,
	filePath: string,
	source: DrainableSource,
	createWriteStream: StreamFactory,
): EventWriterLease {
	const bufferedLines: string[] = [];
	let inner: EventWriterLease | undefined;
	let closePromise: Promise<void> | undefined;
	const activate = async (): Promise<void> => {
		await closingWriter.settled;
		inner = acquireEventWriterInternal(filePath, source, createWriteStream, closingWriter);
		if (!inner) return;
		for (const line of bufferedLines) inner.writeLine(line);
		bufferedLines.length = 0;
	};
	const activated = activate();
	return {
		reserveTelemetry(bytes, maxBytes) {
			if (inner) return inner.reserveTelemetry(bytes, maxBytes);
			if (closingWriter.telemetryTruncated || closingWriter.telemetryBytes + bytes > maxBytes) return false;
			closingWriter.telemetryBytes += bytes;
			return true;
		},
		claimTruncationMarker() {
			if (inner) return inner.claimTruncationMarker();
			if (closingWriter.telemetryTruncated) return false;
			closingWriter.telemetryTruncated = true;
			return true;
		},
		writeLine(line) {
			if (!line.trim()) return;
			if (inner) inner.writeLine(line);
			else bufferedLines.push(line);
		},
		close() {
			closePromise ??= activated.then(() => inner?.close());
			return closePromise;
		},
	};
}

function createWriter(filePath: string, key: string, createWriteStream: StreamFactory, seed?: TelemetryState): SharedEventWriter | undefined {
	let stream: JsonlWriteStream;
	try {
		stream = createWriteStream(filePath);
	} catch {
		return undefined;
	}
	let resolveSettled = () => {};
	const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
	const writer: SharedEventWriter = {
		stream, sources: new Set(), refs: 0, backpressured: false,
		...existingTelemetryState(filePath, seed),
		closed: false, failed: false, filePath, key, closingLines: [], settled, resolveSettled,
	};
	stream.on?.("error", () => failWriter(writer));
	writers.set(key, writer);
	return writer;
}

function acquireEventWriterInternal(
	filePath: string,
	source: DrainableSource,
	createWriteStream: StreamFactory,
	seed?: TelemetryState,
): EventWriterLease | undefined {
	const key = keyFor(filePath);
	let writer = writers.get(key);
	if (writer?.closed) return createDeferredLease(writer, filePath, source, createWriteStream);
	writer ??= createWriter(filePath, key, createWriteStream, seed);
	if (!writer) return undefined;
	writer.refs += 1;
	writer.sources.add(source);
	if (writer.backpressured) source.pause();
	let closePromise: Promise<void> | undefined;
	return {
		reserveTelemetry(bytes, maxBytes) {
			if (writer!.failed || writer!.telemetryTruncated || writer!.telemetryBytes + bytes > maxBytes) return false;
			writer!.telemetryBytes += bytes;
			return true;
		},
		claimTruncationMarker() {
			if (writer!.failed || writer!.telemetryTruncated) return false;
			writer!.telemetryTruncated = true;
			return true;
		},
		writeLine(line) {
			if (line.trim()) write(writer!, `${line}\n`);
		},
		close() {
			if (closePromise) return closePromise;
			writer!.sources.delete(source);
			writer!.refs -= 1;
			if (writer!.refs > 0 || writer!.failed) return closePromise = Promise.resolve();
			writer!.closed = true;
			try {
				writer!.stream.end(() => {
					if (!writer!.failed) {
						for (const line of writer!.closingLines) {
							try { fs.appendFileSync(writer!.filePath, line); } catch { /* telemetry failure is non-fatal */ }
						}
						settleWriter(writer!);
					}
				});
			} catch {
				failWriter(writer!);
			}
			return closePromise = writer!.settled;
		},
	};
}

export function acquireEventWriter(
	filePath: string,
	source: DrainableSource,
	createWriteStream: StreamFactory = (target) => fs.createWriteStream(target, { flags: "a" }),
): EventWriterLease | undefined {
	return acquireEventWriterInternal(filePath, source, createWriteStream);
}

/** Route lifecycle/control appends through an active child writer to avoid mixed handles. */
export function appendToActiveEventWriter(filePath: string, line: string): boolean {
	const writer = writers.get(keyFor(filePath));
	if (!writer) return false;
	if (writer.closed) writer.closingLines.push(`${line}\n`);
	else write(writer, `${line}\n`);
	return true;
}
