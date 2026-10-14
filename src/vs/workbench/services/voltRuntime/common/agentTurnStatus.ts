/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/** "Worked for 1m 5s": how long a finished turn worked. */
export function formatWorkedDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) {
		return localize('voltAgent.workedSeconds', "Worked for {0}s", Math.max(1, totalSeconds));
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds
		? localize('voltAgent.workedMinutesSeconds', "Worked for {0}m {1}s", minutes, seconds)
		: localize('voltAgent.workedMinutes', "Worked for {0}m", minutes);
}

/** The reply fields the status label reads. */
export interface IAgentTurnStatusSource {
	readonly kind: string;
	readonly durationMs?: number;
	readonly startedAt?: number;
	readonly endedAt?: number;
	readonly cancelled?: boolean;
	readonly activity?: { readonly status?: string };
}

/** The status beside the composer: the live phrase while a turn runs, then how long it worked. */
export function agentTurnStatus(lastAgent: IAgentTurnStatusSource | undefined, streaming: boolean, now = Date.now()): { readonly label: string; readonly working: boolean } {
	if (!lastAgent || lastAgent.kind !== 'agent') {
		return { label: '', working: false };
	}
	const duration = lastAgent.durationMs ?? (lastAgent.startedAt ? (lastAgent.endedAt ?? now) - lastAgent.startedAt : undefined);
	const label = streaming
		? (lastAgent.activity?.status || localize('voltAgent.working', "Working"))
		: lastAgent.cancelled
			? localize('voltAgent.cancelled', "Cancelled")
			: duration !== undefined ? formatWorkedDuration(duration) : '';
	return { label, working: streaming };
}
