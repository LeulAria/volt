/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentSessionMeta } from '../../../services/voltRuntime/common/history/agentHistory.js';

const DAY_MS = 86_400_000;

/** What the session meta does not know: the orchestrator's view of the chat. */
export interface IAgentIdleSettleContext {
	/** A turn runs, starts or waits in the queue, or the harness waits on the user. */
	readonly busy: boolean;
	/** Subagents the chat started still run (or wait on the user). */
	readonly liveSubagents: boolean;
}

/**
 * When the user last moved the chat forward: their own prompt (Volt's wake-ups do not count), its
 * creation, a snooze running out, or an unread reply that has not been looked at yet.
 */
export function lastUserActivity(meta: IAgentSessionMeta): number {
	return Math.max(
		meta.createdAt,
		meta.lastUserPromptAt ?? meta.lastPromptAt ?? 0,
		meta.wokeAt ?? 0,
		// A reply nobody read yet is news; it gets its own idle stretch.
		meta.unread ? meta.updatedAt : 0,
	);
}

/**
 * Whether a chat idle for `days` should move to Settled, the way T3 Code settles inactive threads:
 * work in progress, pending questions or approvals and live subagents hold it, and so do drafts, a
 * per-chat opt-out, and a manual un-settle that no prompt has followed yet. Pinning does not hold
 * it (settling drops the pin). `days` of 0 turns the rule off.
 */
export function shouldAutoSettleIdle(meta: IAgentSessionMeta, context: IAgentIdleSettleContext, now: number, days: number): boolean {
	if (!(days > 0) || meta.settled || meta.snoozed || meta.archived || meta.subagent || meta.autoSettle === false) {
		return false;
	}
	if (meta.turnCount === 0 || meta.hasDraft || meta.status === 'running' || meta.attention || context.busy || context.liveSubagents) {
		return false;
	}
	// Taken out of Settled by hand: it stays out until the user writes to it again.
	if (meta.unsettledAt !== undefined && (meta.lastUserPromptAt ?? meta.lastPromptAt ?? 0) <= meta.unsettledAt) {
		return false;
	}
	return now - lastUserActivity(meta) >= days * DAY_MS;
}
