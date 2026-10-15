/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isRetryableFailure, RESCUE_RETRY, retryDelay } from '../jobs/retryPolicy.js';
import { formatClock, formatCountdown } from './limitRecovery.js';
import type { IOrchRescue, IOrchThread } from './orchestrator.js';

/**
 * Keep working until done. A chat's work can stop in four ways before it is finished, and Volt
 * restarts it from each, so nobody has to watch it:
 *
 * - A run fails past the quick retries (`MAX_FAILURE_RETRIES`, seconds apart): the chat is restarted
 *   after 15 s, 30 s, 1 min... at most 30 min apart, forever. A failure no retry fixes by itself
 *   (signed out, a model that is gone) is looked at every 30 min, so the chat goes on once fixed.
 * - Volt restarts (or crashes) mid-run: past what `volt.agent.resumeAfterRestart` continues at once.
 * - The wake-up guard pauses a chat its subagents' reports woke many times in a row (a long graph of
 *   delegated rounds): it goes on after the back-off, so a runaway loop slows down instead of spinning.
 * - A turn ends with its plan unfinished: it continues while each continuation closes items.
 *
 * Pure: the decider and the views compute the same due times from the record.
 */

/** Chats due to restart at the same moment go this far apart, so a restart does not start them all at once. */
export const RESCUE_STAGGER_MS = 5_000;

/** Continuations of one unfinished plan before the chat waits for the user, even while it makes progress. */
export const MAX_PLAN_CONTINUATIONS = 24;

/** When Volt restarts the chat: the back-off after `attempts` restarts, from `at`. */
export function rescueDueAt(rescue: IOrchRescue, key: string): number {
	const delay = isRetryableFailure(rescue.error) ? retryDelay(RESCUE_RETRY, rescue.attempts + 1, { key }) : RESCUE_RETRY.maximumIntervalMs;
	return Math.max(rescue.at + delay, rescue.notBefore ?? 0);
}

/** The chat is idle with nothing else in the way of its restart (a usage-limit park, a move, the user's stop). */
export function rescueWaits(thread: IOrchThread): boolean {
	return !!thread.rescue && !thread.taskId && !thread.active && !thread.moving && !thread.pendingMove && !thread.blocked && !thread.limit && thread.pause !== 'stopped';
}

/**
 * The id of the `attempt`th restart of the chat whose last turn was `lastTurnId`: the failure and
 * rescue suffixes come off first, so a chain of restarts reads `t~s1`, `t~s2`, ... and never
 * repeats an id (the cross-window claim is keyed by it).
 */
export function rescueTurnId(lastTurnId: string, attempt: number): string {
	return `${lastTurnId.replace(/(?:~[fs]\d+)+$/, '')}~s${attempt}`;
}

/** A turn Volt sent to restart a chat (see `rescueTurnId`). */
export function isRescueTurnId(turnId: string): boolean {
	return /~s\d+$/.test(turnId);
}

/** The model-facing text a restarted chat continues with. */
export function rescueResumeText(rescue: IOrchRescue): string {
	const why = rescue.reason === 'interrupted'
		? 'Volt restarted while you were working, so your previous run was cut off part way.'
		: `Your previous run stopped part way${rescue.error ? ` (${rescue.error.replace(/\s+/g, ' ').trim().slice(0, 200)})` : ''}, and Volt restarted you to finish the task.`;
	return `[Volt] ${why} Continue where you left off: check what is already done (files, git status, command output) before redoing anything, then finish the work. Change only what the task needs. If you were in the middle of a delegated task, end with your report as before.`;
}

/** The transcript's line for a restart. */
export function rescueLabel(rescue: IOrchRescue, attempt: number): string {
	const what = rescue.reason === 'interrupted' ? 'Continued after Volt restarted' : rescue.reason === 'wakeups' ? 'Continued' : 'Restarted after an error';
	return attempt > 1 ? `${what} (attempt ${attempt})` : what;
}

const PLAN_SUFFIX = /~c(\d+)(?:~[flmrs]\d+)*$/;

/** Plan continuations so far in a turn's chain (`~cN`, with any retries of it after). */
export function planContinuationCount(turnId: string): number {
	const match = PLAN_SUFFIX.exec(turnId);
	return match ? Number(match[1]) : 0;
}

/** The id of the next plan continuation after `turnId`: `t~c1`, `t~c2`, ... */
export function planTurnId(turnId: string): string {
	return `${turnId.replace(PLAN_SUFFIX, '')}~c${planContinuationCount(turnId) + 1}`;
}

/** The model-facing text that continues a turn whose plan still has open items. */
export function planContinueText(open: readonly string[]): string {
	const items = open.slice(0, 12).map(item => `- ${item.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
	const more = open.length > items.length ? `\n- …and ${open.length - items.length} more` : '';
	return `[Volt] You ended your turn, but your plan still has ${open.length} open item${open.length === 1 ? '' : 's'}:\n${items.join('\n')}${more}\n\nKeep working until they are done: check what is already done first, then finish the rest and mark each item as you complete it. Change only what the task needs. If an item is already done, mark it; if it cannot be done, or needs a decision only the user can make, say why plainly and stop.`;
}

/** The model-facing text that continues a turn that ran out of steps for one run. */
export function stepLimitContinueText(open: readonly string[]): string {
	const items = open.slice(0, 12).map(item => `- ${item.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
	const plan = items.length ? `\n\nOpen plan items:\n${items.join('\n')}${open.length > items.length ? `\n- …and ${open.length - items.length} more` : ''}` : '';
	return `[Volt] Your previous run reached its step limit for one run (a safety stop, not an error) before the task was done.${plan}\n\nContinue where you left off: do not redo what is already done, then finish the work. If you were going in circles, step back and try a different approach. If the task is actually done, or needs a decision only the user can make, say so plainly and stop.`;
}

export interface IRescueChipView {
	readonly label: string;
	/** The countdown ("4m"), while the restart is ahead. */
	readonly detail?: string;
	readonly tooltip: string;
	readonly dueAt: number;
}

/** The chat's chip while Volt waits to restart it: "Stopped by an error · restarting 3:12 PM · 4m". */
export function rescueChipView(rescue: IOrchRescue, key: string, now: number, locale?: string): IRescueChipView {
	const dueAt = rescueDueAt(rescue, key);
	const what = rescue.reason === 'interrupted' ? 'Cut off by a restart' : rescue.reason === 'wakeups' ? 'Paused after many wake-ups' : 'Stopped by an error';
	const label = dueAt > now ? `${what} · restarting ${formatClock(dueAt, now, locale)}` : `${what} · restarting…`;
	const so = rescue.attempts ? ` ${rescue.attempts} restart${rescue.attempts === 1 ? '' : 's'} so far.` : '';
	const tooltip = [
		rescue.error,
		`Volt restarts this chat on its own until its work is done, waiting longer each time (at most 30 minutes).${so} Stop retrying to have it wait for you instead.`,
	].filter(Boolean).join('\n\n');
	return { label, ...(dueAt > now ? { detail: formatCountdown(dueAt - now) } : {}), tooltip, dueAt };
}
