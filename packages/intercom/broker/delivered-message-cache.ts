const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

/** Bounded successful-delivery cache used to make broker retries idempotent. */
export class DeliveredMessageCache {
  private readonly delivered = new Map<string, number>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  has(messageId: string, now = Date.now()): boolean {
    this.prune(now);
    const deliveredAt = this.delivered.get(messageId);
    return deliveredAt !== undefined && now - deliveredAt <= this.ttlMs;
  }

  record(messageId: string, now = Date.now()): void {
    this.prune(now);
    this.delivered.delete(messageId);
    this.delivered.set(messageId, now);
    while (this.delivered.size > this.maxEntries) {
      const oldest = this.delivered.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delivered.delete(oldest);
    }
  }

  private prune(now: number): void {
    for (const [messageId, deliveredAt] of this.delivered) {
      if (now - deliveredAt <= this.ttlMs) break;
      this.delivered.delete(messageId);
    }
  }
}
