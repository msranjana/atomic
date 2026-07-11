import { randomUUID } from "crypto";
import type { Attachment } from "../types.js";

export interface SendOptionsLike {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  expectsReply?: boolean;
}

export interface SendResultLike {
  id: string;
  delivered: boolean;
  reason?: string;
}

export interface PendingSendAttempt {
  readonly messageId: string;
  readonly attemptId: string;
  readonly signature: string;
  readonly promise: Promise<SendResultLike>;
}

interface OwnedPendingSend extends PendingSendAttempt {
  resolve(result: SendResultLike): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface PendingSendAcquisition {
  attempt: PendingSendAttempt;
  owner: boolean;
}

function normalizeAttachments(attachments: Attachment[] | undefined): Array<Record<string, string>> | undefined {
  return attachments?.map((attachment) => ({
    type: attachment.type,
    name: attachment.name,
    content: attachment.content,
    ...(attachment.language === undefined ? {} : { language: attachment.language }),
  }));
}

/** Stable identity for deciding whether an explicit message ID represents the same logical send. */
export function buildSendSignature(to: string, options: SendOptionsLike): string {
  return JSON.stringify({
    to,
    text: options.text,
    attachments: normalizeAttachments(options.attachments),
    replyTo: options.replyTo ?? null,
    expectsReply: options.expectsReply ?? null,
  });
}

export class PendingSendRegistry {
  private readonly attempts = new Map<string, OwnedPendingSend>();

  acquire(messageId: string, signature: string, timeoutMs: number): PendingSendAcquisition {
    const existing = this.attempts.get(messageId);
    if (existing) {
      if (existing.signature !== signature) {
        throw new Error(`Intercom message ID '${messageId}' is already pending with a different target or payload`);
      }
      return { attempt: existing, owner: false };
    }

    let resolvePromise!: (result: SendResultLike) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<SendResultLike>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const attempt: OwnedPendingSend = {
      messageId,
      attemptId: randomUUID(),
      signature,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    attempt.timer = setTimeout(() => {
      this.reject(attempt, new Error("Send timeout"));
    }, timeoutMs);
    this.attempts.set(messageId, attempt);
    return { attempt, owner: true };
  }

  resolve(messageId: string, attemptId: string, result: SendResultLike): boolean {
    const attempt = this.attempts.get(messageId);
    if (!attempt || attempt.attemptId !== attemptId) return false;
    this.attempts.delete(messageId);
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.resolve(result);
    return true;
  }

  /** Resolve a response from a pre-attemptId broker only when this exact message is active. */
  resolveLegacy(messageId: string, result: SendResultLike): boolean {
    const attempt = this.attempts.get(messageId);
    if (!attempt) return false;
    return this.resolve(messageId, attempt.attemptId, result);
  }

  reject(attempt: PendingSendAttempt, error: Error): boolean {
    const current = this.attempts.get(attempt.messageId);
    if (current !== attempt) return false;
    this.attempts.delete(attempt.messageId);
    if (current.timer) clearTimeout(current.timer);
    current.reject(error);
    return true;
  }

  rejectAll(error: Error): void {
    for (const attempt of [...this.attempts.values()]) this.reject(attempt, error);
  }
}
