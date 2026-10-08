/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { activityContentState, rankActive, type IAgentChatView } from './agentState.ts';
import { ACTIVE_PHASES, type IAgentActivityAttributes, type IAgentActivityContentState, toSeconds } from './model.ts';

// Decides which Live Activities to start, update and end from the chats' current views. Pure, so
// the app (driving ActivityKit locally) and the agent server (pushing through APNs) make the same
// calls. ActivityKit budgets updates, so step-only changes are rate-limited while phase changes,
// questions and approvals go out at once.

export interface ITrackedActivity {
	readonly activityId: string;
	readonly chatId: string;
	readonly state: IAgentActivityContentState;
	/** When the last start or update went out (ms). */
	readonly sentAt: number;
}

export interface IActivityAlert {
	readonly title: string;
	readonly body: string;
}

export type ActivityAction =
	| { readonly kind: 'start'; readonly chatId: string; readonly attributes: IAgentActivityAttributes; readonly state: IAgentActivityContentState; readonly staleAt: number; readonly relevance: number }
	| { readonly kind: 'update'; readonly activityId: string; readonly chatId: string; readonly state: IAgentActivityContentState; readonly staleAt: number; readonly relevance: number; readonly alert?: IActivityAlert }
	/** `dismissAt`: Unix seconds the ended activity leaves the Lock Screen; 0 = now. */
	| { readonly kind: 'end'; readonly activityId: string; readonly chatId: string; readonly state?: IAgentActivityContentState; readonly dismissAt: number; readonly alert?: IActivityAlert };

export interface IPlanOptions {
	/** Activities at once. iOS allows a handful per app; more than three crowds the Lock Screen. */
	readonly maxActivities: number;
	/** Step, file and count changes go out at most this often per activity. */
	readonly minUpdateIntervalMs: number;
	/** An activity not updated for this long is shown as stale. */
	readonly staleAfterMs: number;
	/** How long a finished turn stays on the Lock Screen. */
	readonly doneLingerMs: number;
	readonly failedLingerMs: number;
	readonly stoppedLingerMs: number;
}

export const DEFAULT_PLAN_OPTIONS: IPlanOptions = {
	maxActivities: 3,
	minUpdateIntervalMs: 2_000,
	staleAfterMs: 10 * 60_000,
	doneLingerMs: 15 * 60_000,
	failedLingerMs: 30 * 60_000,
	stoppedLingerMs: 60_000,
};

export interface IPlan {
	readonly actions: readonly ActivityAction[];
	/** When a deferred update becomes due (ms); plan again then. */
	readonly nextCheckAt?: number;
}

/** Fields whose change is worth an immediate update. */
function urgentChange(prev: IAgentActivityContentState, next: IAgentActivityContentState): boolean {
	return prev.phase !== next.phase
		|| prev.title !== next.title
		|| prev.inputKind !== next.inputKind
		|| prev.inputPrompt !== next.inputPrompt
		|| prev.queued !== next.queued
		|| prev.startedAt !== next.startedAt
		|| prev.model !== next.model;
}

function anyChange(prev: IAgentActivityContentState, next: IAgentActivityContentState): boolean {
	const { updatedAt: _a, ...a } = prev;
	const { updatedAt: _b, ...b } = next;
	return JSON.stringify(a) !== JSON.stringify(b);
}

function relevance(view: IAgentChatView): number {
	return view.phase === 'input' ? 100 : view.phase === 'stopping' ? 75 : 50;
}

function lingerMs(view: IAgentChatView, options: IPlanOptions): number {
	switch (view.phase) {
		case 'failed':
		case 'limited':
			return options.failedLingerMs;
		case 'stopped':
			return options.stoppedLingerMs;
		default:
			return options.doneLingerMs;
	}
}

function endAlert(view: IAgentChatView): IActivityAlert | undefined {
	switch (view.phase) {
		case 'done':
			return { title: view.title, body: view.filesChanged ? `${view.step} · ${view.filesChanged === 1 ? '1 file' : `${view.filesChanged} files`} changed` : view.step };
		case 'failed':
			return { title: `Failed: ${view.title}`, body: view.step };
		case 'limited':
			return { title: `Usage limit: ${view.title}`, body: view.step };
		default:
			return undefined;
	}
}

export function attributesFor(view: IAgentChatView, server?: string): IAgentActivityAttributes {
	return {
		chatId: view.chatId,
		provider: view.provider,
		...(view.workspace ? { workspace: view.workspace } : {}),
		...(server ? { server } : {}),
	};
}

/**
 * The actions that bring the tracked activities in line with the chats.
 * - A chat that starts working or needs input gets an activity, best-ranked first, up to the cap.
 * - A tracked chat keeps its activity while active (no churn when a newer chat starts).
 * - A chat that finished ends its activity with the final state, which lingers per outcome.
 * - A chat that is gone ends its activity at once.
 */
export function planActivities(
	tracked: readonly ITrackedActivity[],
	views: readonly IAgentChatView[],
	now: number,
	options: IPlanOptions = DEFAULT_PLAN_OPTIONS,
	server?: string,
): IPlan {
	const actions: ActivityAction[] = [];
	let nextCheckAt: number | undefined;
	const byChat = new Map(views.map(view => [view.chatId, view]));
	const ranked = rankActive(views);
	const trackedChats = new Set(tracked.map(activity => activity.chatId));
	const keptActive = tracked.filter(activity => {
		const view = byChat.get(activity.chatId);
		return view && ACTIVE_PHASES.has(view.phase);
	});
	const capacity = Math.max(0, options.maxActivities - keptActive.length);
	const starting = ranked.filter(view => !trackedChats.has(view.chatId)).slice(0, capacity);
	const shown = keptActive.length + starting.length;
	const others = Math.max(0, ranked.length - shown);
	const staleAt = toSeconds(now + options.staleAfterMs);

	const seenChats = new Set<string>();
	for (const activity of tracked) {
		const view = byChat.get(activity.chatId);
		if (seenChats.has(activity.chatId)) {
			// Two activities for one chat (an app restart raced a start): keep the first.
			actions.push({ kind: 'end', activityId: activity.activityId, chatId: activity.chatId, dismissAt: 0 });
			continue;
		}
		seenChats.add(activity.chatId);
		if (!view) {
			actions.push({ kind: 'end', activityId: activity.activityId, chatId: activity.chatId, dismissAt: 0 });
			continue;
		}
		const state = activityContentState(view, others);
		if (!ACTIVE_PHASES.has(view.phase)) {
			const alert = endAlert(view);
			actions.push({
				kind: 'end',
				activityId: activity.activityId,
				chatId: activity.chatId,
				state,
				dismissAt: toSeconds(now + lingerMs(view, options)),
				...(alert ? { alert } : {}),
			});
			continue;
		}
		if (!anyChange(activity.state, state)) {
			continue;
		}
		const urgent = urgentChange(activity.state, state);
		const dueAt = activity.sentAt + options.minUpdateIntervalMs;
		if (!urgent && now < dueAt) {
			nextCheckAt = Math.min(nextCheckAt ?? dueAt, dueAt);
			continue;
		}
		const alert = state.phase === 'input' && activity.state.phase !== 'input'
			? { title: state.inputKind === 'question' ? 'Question from the agent' : 'Approval needed', body: `${state.title}: ${state.inputPrompt ?? 'Open Volt to answer.'}` }
			: undefined;
		actions.push({ kind: 'update', activityId: activity.activityId, chatId: activity.chatId, state, staleAt, relevance: relevance(view), ...(alert ? { alert } : {}) });
	}

	for (const view of starting) {
		actions.push({ kind: 'start', chatId: view.chatId, attributes: attributesFor(view, server), state: activityContentState(view, others), staleAt, relevance: relevance(view) });
	}
	return { actions, ...(nextCheckAt !== undefined ? { nextCheckAt } : {}) };
}

/** Applies the plan's outcome to the tracked list (the caller adds started activities when iOS returns their ids). */
export function applyPlan(tracked: readonly ITrackedActivity[], actions: readonly ActivityAction[], now: number): ITrackedActivity[] {
	const ended = new Set(actions.filter(action => action.kind === 'end').map(action => action.activityId));
	const updates = new Map(actions.flatMap(action => action.kind === 'update' ? [[action.activityId, action.state] as const] : []));
	return tracked
		.filter(activity => !ended.has(activity.activityId))
		.map(activity => updates.has(activity.activityId) ? { ...activity, state: updates.get(activity.activityId)!, sentAt: now } : activity);
}
