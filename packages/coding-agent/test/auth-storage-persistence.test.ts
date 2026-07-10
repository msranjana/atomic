import { describe, expect, test } from "vitest";
import { AuthStorage, type AuthStorageBackend } from "../src/core/auth-storage.ts";

class ControllableAuthBackend implements AuthStorageBackend {
	value: string | undefined;
	writeError: Error | undefined;

	constructor(value?: string) {
		this.value = value;
	}

	read(): string | undefined {
		return this.value;
	}

	withLock<T>(fn: Parameters<AuthStorageBackend["withLock"]>[0]): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			if (this.writeError) throw this.writeError;
			this.value = next;
		}
		return result as T;
	}

	async withLockAsync<T>(fn: Parameters<AuthStorageBackend["withLockAsync"]>[0]): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			if (this.writeError) throw this.writeError;
			this.value = next;
		}
		return result as T;
	}
}

describe("AuthStorage persistence failures", () => {
	test("surfaces malformed storage and preserves in-memory credentials", () => {
		const backend = new ControllableAuthBackend(
			JSON.stringify({ anthropic: { type: "api_key", key: "existing" } }),
		);
		const storage = AuthStorage.fromStorage(backend);
		backend.value = "{invalid-json";
		storage.reload();

		expect(() => storage.set("openai", { type: "api_key", key: "new" })).toThrow();
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "existing" });
		expect(storage.get("openai")).toBeUndefined();
		expect(backend.value).toBe("{invalid-json");
	});

	test("surfaces write failures without mutating in-memory credentials", () => {
		const backend = new ControllableAuthBackend(
			JSON.stringify({ anthropic: { type: "api_key", key: "existing" } }),
		);
		const storage = AuthStorage.fromStorage(backend);
		backend.writeError = new Error("disk full");

		expect(() => storage.set("anthropic", { type: "api_key", key: "replacement" })).toThrow("disk full");
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "existing" });
		expect(() => storage.remove("anthropic")).toThrow("disk full");
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "existing" });
		expect(JSON.parse(backend.value ?? "{}")).toEqual({ anthropic: { type: "api_key", key: "existing" } });
	});

	test("recovers after the credential snapshot is repaired", () => {
		const backend = new ControllableAuthBackend("{invalid-json");
		const storage = AuthStorage.fromStorage(backend);
		expect(storage.getLoadError()).toBeInstanceOf(Error);

		backend.value = JSON.stringify({ anthropic: { type: "api_key", key: "existing" } });
		storage.set("openai", { type: "api_key", key: "new" });

		expect(storage.getLoadError()).toBeNull();
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "existing" });
		expect(storage.get("openai")).toEqual({ type: "api_key", key: "new" });
	});
});
