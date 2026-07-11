interface CompletionClaim {
	inFlight?: Promise<boolean>;
	intercomDelivered: boolean;
	localDelivered: boolean;
	completedAt?: number;
}

export interface CompletionClaimResult {
	owner: boolean;
	delivered: boolean;
}

export interface CompletionDeliveryPhases {
	intercom?: () => Promise<boolean>;
	local: () => Promise<boolean>;
}

const STORE_KEY = "__atomicSubagentCompletionClaims";

function claims(): Map<string, CompletionClaim> {
	const globalStore = globalThis as Record<string, unknown>;
	const existing = globalStore[STORE_KEY];
	if (existing instanceof Map) return existing as Map<string, CompletionClaim>;
	const created = new Map<string, CompletionClaim>();
	globalStore[STORE_KEY] = created;
	return created;
}

function prune(store: Map<string, CompletionClaim>, now: number, ttlMs: number): void {
	for (const [key, claim] of store) {
		// Partial claims correspond to durable result files and must retain completed
		// side effects until the remaining phase succeeds.
		if (claim.completedAt !== undefined && now - claim.completedAt > ttlMs) store.delete(key);
	}
}

/** Atomically owns and advances one completion across aliases and watcher replacements. */
export async function deliverClaimedCompletion(
	key: string,
	ttlMs: number,
	phases: CompletionDeliveryPhases,
): Promise<CompletionClaimResult> {
	const store = claims();
	prune(store, Date.now(), ttlMs);
	let claim = store.get(key);
	if (!claim) {
		claim = { intercomDelivered: false, localDelivered: false };
		store.set(key, claim);
	}
	if (claim.completedAt !== undefined) return { owner: false, delivered: true };
	if (claim.inFlight) return { owner: false, delivered: await claim.inFlight };

	const ownedClaim = claim;
	const attempt = (async () => {
		if (!ownedClaim.intercomDelivered) {
			const delivered = phases.intercom ? await phases.intercom() : true;
			if (!delivered) return false;
			ownedClaim.intercomDelivered = true;
		}
		if (!ownedClaim.localDelivered) {
			const delivered = await phases.local();
			if (!delivered) return false;
			ownedClaim.localDelivered = true;
		}
		ownedClaim.completedAt = Date.now();
		return true;
	})();
	ownedClaim.inFlight = attempt;
	try {
		return { owner: true, delivered: await attempt };
	} finally {
		if (ownedClaim.inFlight === attempt) ownedClaim.inFlight = undefined;
	}
}
