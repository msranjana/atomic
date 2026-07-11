import type { IntercomEventBus } from "../../shared/types.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../shared/types.ts";

export interface CompletionNotificationEnvelope extends Record<string, unknown> {
	notificationId: string;
	acknowledge: (delivered: boolean) => void;
}

export function deliverLocalCompletionNotification(
	events: IntercomEventBus,
	payload: Record<string, unknown>,
	notificationId: string,
	_timeoutMs = 500,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (delivered: boolean) => {
			if (settled) return;
			settled = true;
			resolve(delivered);
		};
		try {
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				...payload,
				notificationId,
				acknowledge: finish,
			} satisfies CompletionNotificationEnvelope);
			// The established event contract treats successful synchronous emission as
			// delivery. Production listeners can synchronously reject via acknowledge(false).
			finish(true);
		} catch {
			finish(false);
		}
	});
}
