/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IVoltModelOptions } from '../models/modelOptions.js';
import type { IOrchThreadStatus } from '../orchestration/orchestratorViews.js';

/**
 * Run groups: one prompt sent to several models at once, each in its own git worktree on its own
 * branch from the same base. Every run is an ordinary Volt chat whose turns go through the
 * orchestrator, so queue, steer, approvals, questions and checkpoints stay per run. This file is
 * the pure part: names, rules, roll-ups and plans. The service does the side effects.
 *
 * Modeled on T3 Code's "start new threads with multiple models in separate worktrees" (#12179)
 * and Cursor's parallel agents (per-model tabs, `.cursor/worktrees.json`, Apply).
 */

export const RUN_GROUP_MIN_MODELS = 2;
export const RUN_GROUP_MAX_MODELS = 4;
export const RUN_GROUP_BRANCH_PREFIX = 'volt/';
/** Remembered model set for the next multi-model send (application scope). */
export const RUN_GROUP_MODELS_STORAGE_KEY = 'volt.agent.runGroup.models';

const TASK_SLUG_MAX = 32;
const MODEL_SLUG_MAX = 24;

//#region Types

export interface IRunGroupModel {
	/** Catalog ref (`agent:<profile>:<model>` or `model:<profile>:<model>`). */
	readonly ref: string;
	readonly label: string;
	/** Brand family for the icon (claude, codex, cursor, opencode, deepseek, ...). */
	readonly family: string;
	readonly options?: IVoltModelOptions;
}

export type RunSetupStepState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface IRunSetupStep {
	readonly command: string;
	readonly state: RunSetupStepState;
	readonly startedAt?: number;
	readonly endedAt?: number;
	readonly exitCode?: number | null;
	/** The last lines of output, for the inline progress row. */
	readonly tail?: string;
}

/**
 * - `worktree`: the checkout is being made. `running`: setup commands run.
 * - `done`: the chat is unblocked and its prompt dispatched. `failed`/`cancelled`: the chat stays
 *   blocked with its prompt queued until the user retries.
 */
export type RunSetupState = 'pending' | 'worktree' | 'running' | 'done' | 'failed' | 'cancelled';

export interface IRunSetup {
	readonly state: RunSetupState;
	readonly steps: readonly IRunSetupStep[];
	/** The config file the steps came from (`.volt/worktrees.json`, `.cursor/worktrees.json`). */
	readonly source?: string;
	readonly error?: string;
	readonly startedAt?: number;
	readonly endedAt?: number;
}

/** Tokens and cost a run spent, folded from the runtime's `usage` events. */
export interface IRunUsage {
	readonly tokens: number;
	readonly input: number;
	readonly output: number;
	readonly cache: number;
	/** Reported by the agent (Claude's ACP `usage_update.cost`); absent when it never said. */
	readonly costUsd?: number;
	/** The agent's last cumulative session cost, to turn the next report into a delta. */
	readonly sessionCost?: number;
}

export interface IRunStats {
	readonly files: number;
	readonly additions: number;
	readonly deletions: number;
	/** Snapshot commit of the worktree (pending edits included) the numbers describe. */
	readonly snapshot?: string;
	/** The run's latest reply, trimmed. */
	readonly lastMessage?: string;
	readonly at: number;
}

export interface IRunGroupRun {
	/** The run's chat id (`agent-<uuid>`). */
	readonly id: string;
	readonly model: IRunGroupModel;
	readonly branch: string;
	readonly worktreePath?: string;
	readonly setup: IRunSetup;
	readonly usage: IRunUsage;
	readonly stats?: IRunStats;
	/** Time the agent has spent working, without setup. `activeSince` is set while a turn runs. */
	readonly workMs: number;
	readonly activeSince?: number;
	readonly firstStartedAt?: number;
	readonly lastEndedAt?: number;
	/** Archived after another run won. */
	readonly discarded?: boolean;
	readonly worktreeRemoved?: boolean;
}

export type RunWinnerAction = 'merge' | 'checkout' | 'pr';

export interface IRunGroupWinner {
	readonly runId: string;
	readonly action: RunWinnerAction;
	readonly at: number;
	/** The commit that carried the winner's pending edits, when there were any. */
	readonly commit?: string;
}

export interface IRunGroupPrompt {
	readonly text: string;
	/** The composer's frozen display (attachments by reference), shared by every run. */
	readonly display?: unknown;
	readonly mode?: string;
}

export interface IRunGroupBase {
	/** The branch the runs start from; absent when the checkout was detached. */
	readonly ref?: string;
	readonly commit: string;
}

export type RunFollowUpTarget = 'selected' | 'all';

export interface IRunGroup {
	readonly id: string;
	readonly title: string;
	readonly prompt: IRunGroupPrompt;
	readonly createdAt: number;
	readonly repoRoot: string;
	readonly projectId?: string;
	readonly base: IRunGroupBase;
	readonly runs: readonly IRunGroupRun[];
	readonly winner?: IRunGroupWinner;
	readonly followUp: RunFollowUpTarget;
	readonly archived?: boolean;
}

//#endregion

//#region Names

/** Lower-case ASCII words joined by `-`, cut at a word boundary when possible. */
export function slugify(text: string, max: number): string {
	const ascii = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
	const words = ascii.split(/[^a-z0-9]+/).filter(Boolean);
	let slug = '';
	for (const word of words) {
		const next = slug ? `${slug}-${word}` : word;
		if (next.length > max) {
			if (!slug) {
				slug = word.slice(0, max);
			}
			break;
		}
		slug = next;
	}
	return slug;
}

const FILLER_WORDS = new Set(['a', 'an', 'the', 'please', 'can', 'could', 'you', 'would', 'i', 'we', 'to', 'of', 'in', 'on', 'for', 'and', 'with', 'this', 'that', 'it', 'me', 'my', 'our', 'is', 'are', 'be']);

/** A short name for the task, from the prompt's first words that say something. */
export function taskSlug(prompt: string): string {
	const firstLine = prompt.split(/\r?\n/).find(line => line.trim()) ?? '';
	const words = slugify(firstLine, 200).split('-').filter(word => word && !FILLER_WORDS.has(word));
	return slugify(words.slice(0, 6).join(' '), TASK_SLUG_MAX) || 'task';
}

/** `Claude Sonnet 4.5 (thinking)` → `claude-sonnet-4-5-thinking`, bounded. */
export function modelSlug(label: string): string {
	return slugify(label, MODEL_SLUG_MAX) || 'model';
}

/** What `git check-ref-format --branch` accepts, for the names this file makes. */
export function isValidRunBranch(name: string): boolean {
	return /^volt\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && !name.endsWith('.lock') && name.length <= 100;
}

/**
 * `volt/<task>-<model>` for each model, unique among themselves and `taken` (existing branches):
 * a clash gets `-2`, `-3`, ... The same model picked twice gets two names.
 */
export function runBranchNames(prompt: string, models: readonly Pick<IRunGroupModel, 'label'>[], taken: ReadonlySet<string> = new Set()): string[] {
	const task = taskSlug(prompt);
	const used = new Set(taken);
	return models.map(model => {
		const base = `${RUN_GROUP_BRANCH_PREFIX}${task}-${modelSlug(model.label)}`;
		let name = base;
		for (let n = 2; used.has(name); n++) {
			name = `${base}-${n}`;
		}
		used.add(name);
		return name;
	});
}

/** The group's title: the prompt's first line, trimmed. */
export function runGroupTitle(prompt: string, max = 80): string {
	const line = (prompt.split(/\r?\n/).find(text => text.trim()) ?? '').trim().replace(/\s+/g, ' ');
	if (!line) {
		return 'Compare models';
	}
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

//#endregion

//#region Selection

export interface IRunSelectionCheck {
	readonly ok: boolean;
	readonly reason?: string;
}

/** 2..4 distinct models. */
export function validateRunSelection(models: readonly Pick<IRunGroupModel, 'ref'>[]): IRunSelectionCheck {
	const distinct = new Set(models.map(model => model.ref));
	if (distinct.size !== models.length) {
		return { ok: false, reason: 'Pick each model once.' };
	}
	if (models.length < RUN_GROUP_MIN_MODELS) {
		return { ok: false, reason: `Pick at least ${RUN_GROUP_MIN_MODELS} models to compare.` };
	}
	if (models.length > RUN_GROUP_MAX_MODELS) {
		return { ok: false, reason: `Pick at most ${RUN_GROUP_MAX_MODELS} models.` };
	}
	return { ok: true };
}

/** Adds or removes `ref`; refuses to grow past the maximum (returns the same list). */
export function toggleRunModel<T extends Pick<IRunGroupModel, 'ref'>>(models: readonly T[], model: T, max = RUN_GROUP_MAX_MODELS): readonly T[] {
	if (models.some(entry => entry.ref === model.ref)) {
		return models.filter(entry => entry.ref !== model.ref);
	}
	return models.length >= max ? models : [...models, model];
}

/** The remembered set, without models the catalog no longer has. */
export function parseRememberedModels(raw: string | undefined, available: ReadonlySet<string>): string[] {
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		const refs = parsed.filter((ref): ref is string => typeof ref === 'string' && available.has(ref));
		return [...new Set(refs)].slice(0, RUN_GROUP_MAX_MODELS);
	} catch {
		return [];
	}
}

//#endregion

//#region Status

/**
 * One run as the compare view and the sidebar show it.
 * - `setup`: its worktree or setup commands are still running. `setupFailed`: they failed or were stopped.
 * - `waiting`: set up, its prompt not sent yet (a moment between unblock and dispatch).
 * - `stopped`: the user stopped its last turn.
 */
export type RunStatus = 'setup' | 'setupFailed' | 'waiting' | 'working' | 'needsInput' | 'stopping' | 'paused' | 'failed' | 'interrupted' | 'stopped' | 'done';

export interface IRunThreadView {
	readonly status: IOrchThreadStatus;
	readonly turns: number;
	readonly lastOutcome?: 'done' | 'failed' | 'cancelled' | 'interrupted';
}

export function runStatus(run: Pick<IRunGroupRun, 'setup'>, thread: IRunThreadView | undefined): RunStatus {
	switch (run.setup.state) {
		case 'pending':
		case 'worktree':
		case 'running':
			return 'setup';
		case 'failed':
		case 'cancelled':
			return 'setupFailed';
		case 'done':
			break;
	}
	if (!thread) {
		return 'waiting';
	}
	switch (thread.status.kind) {
		case 'working':
		case 'starting':
		case 'delegating':
			return 'working';
		case 'needsInput':
			return 'needsInput';
		case 'stopping':
			return 'stopping';
		case 'queued':
			return 'working';
		case 'blocked':
			return 'setup';
		case 'paused':
			return thread.status.pause === 'stopped' ? 'stopped' : 'paused';
		case 'failed':
			return 'failed';
		case 'interrupted':
			return 'interrupted';
		case 'idle':
			if (!thread.turns) {
				return 'waiting';
			}
			return thread.lastOutcome === 'cancelled' ? 'stopped' : thread.lastOutcome === 'failed' ? 'failed' : 'done';
	}
}

/** Still doing something on its own (a group with such a run is "running"). */
export function isRunLive(status: RunStatus): boolean {
	return status === 'setup' || status === 'waiting' || status === 'working' || status === 'stopping';
}

export type RunGroupStatus = 'needsInput' | 'running' | 'failed' | 'done' | 'stopped';

export interface IRunGroupRollup {
	readonly status: RunGroupStatus;
	readonly live: number;
	readonly done: number;
	readonly failed: number;
	readonly total: number;
}

/** The group row's status: someone waiting on the user first, then anything still running. */
export function runGroupRollup(statuses: readonly RunStatus[]): IRunGroupRollup {
	const live = statuses.filter(isRunLive).length;
	const failed = statuses.filter(status => status === 'failed' || status === 'setupFailed' || status === 'interrupted').length;
	const done = statuses.filter(status => status === 'done').length;
	const stopped = statuses.filter(status => status === 'stopped' || status === 'paused').length;
	const total = statuses.length;
	const status: RunGroupStatus = statuses.includes('needsInput') ? 'needsInput'
		: live ? 'running'
			: failed && !done ? 'failed'
				: stopped && !done ? 'stopped'
					: 'done';
	return { status, live, done, failed, total };
}

//#endregion

//#region Plans

export interface IRunStopPlan {
	/** Chats with a live turn: cancel (with their subagents). */
	readonly cancel: readonly string[];
	/** Runs whose worktree or setup is still being made: abort it, the chat stays blocked. */
	readonly abortSetup: readonly string[];
	/** Idle chats about to send a queued prompt: pause their queue. */
	readonly pause: readonly string[];
}

/** Stopping the group stops every run in it, whatever stage it is at. */
export function runStopPlan(group: Pick<IRunGroup, 'runs'>, statusOf: (runId: string) => RunStatus): IRunStopPlan {
	const cancel: string[] = [];
	const abortSetup: string[] = [];
	const pause: string[] = [];
	for (const run of group.runs) {
		if (run.discarded) {
			continue;
		}
		const status = statusOf(run.id);
		switch (status) {
			case 'setup':
				abortSetup.push(run.id);
				break;
			case 'working':
			case 'needsInput':
				cancel.push(run.id);
				break;
			case 'waiting':
				pause.push(run.id);
				break;
			default:
				break;
		}
	}
	return { cancel, abortSetup, pause };
}

export type RunWinnerStep =
	/** Commit the winner's pending edits on its branch (skipped by the service when the tree is clean). */
	| { readonly kind: 'commit'; readonly runId: string; readonly worktreePath: string; readonly message: string }
	| { readonly kind: 'merge'; readonly branch: string; readonly into: string; readonly message: string }
	/** Free the branch from the winner's worktree (detach it there), then check it out in the project. */
	| { readonly kind: 'checkout'; readonly branch: string; readonly detach: string }
	| { readonly kind: 'pr'; readonly runId: string; readonly branch: string; readonly base?: string }
	| { readonly kind: 'archive'; readonly runIds: readonly string[] }
	| { readonly kind: 'removeWorktrees'; readonly runIds: readonly string[] };

export interface IRunWinnerPlan {
	readonly steps: readonly RunWinnerStep[];
	readonly error?: string;
}

/**
 * What picking `runId` does. The winner must be set up and idle; merge needs the base to be a
 * branch. The other runs are archived; their worktrees go only when `removeOthers`.
 */
export function runWinnerPlan(group: IRunGroup, runId: string, action: RunWinnerAction, statusOf: (runId: string) => RunStatus, options: { readonly removeOthers: boolean }): IRunWinnerPlan {
	const run = group.runs.find(candidate => candidate.id === runId);
	if (!run) {
		return { steps: [], error: 'That run is not in this group.' };
	}
	if (group.winner) {
		return { steps: [], error: 'A winner was already picked for this group.' };
	}
	if (!run.worktreePath || run.setup.state !== 'done') {
		return { steps: [], error: 'That run has no worktree to take changes from.' };
	}
	const status = statusOf(run.id);
	if (isRunLive(status) || status === 'needsInput') {
		return { steps: [], error: 'That run is still working. Stop it or wait for it to finish.' };
	}
	if (action === 'merge' && !group.base.ref) {
		return { steps: [], error: 'The runs started from a detached checkout; check the branch out or open a pull request instead.' };
	}
	const steps: RunWinnerStep[] = [{ kind: 'commit', runId: run.id, worktreePath: run.worktreePath, message: `${group.title} (${run.model.label})` }];
	switch (action) {
		case 'merge':
			steps.push({ kind: 'merge', branch: run.branch, into: group.base.ref!, message: `Merge ${run.branch}: ${group.title}` });
			break;
		case 'checkout':
			steps.push({ kind: 'checkout', branch: run.branch, detach: run.worktreePath });
			break;
		case 'pr':
			steps.push({ kind: 'pr', runId: run.id, branch: run.branch, ...(group.base.ref ? { base: group.base.ref } : {}) });
			break;
	}
	const others = group.runs.filter(other => other.id !== run.id && !other.discarded).map(other => other.id);
	if (others.length) {
		steps.push({ kind: 'archive', runIds: others });
		const removable = group.runs.filter(other => others.includes(other.id) && other.worktreePath && !other.worktreeRemoved).map(other => other.id);
		if (options.removeOthers && removable.length) {
			steps.push({ kind: 'removeWorktrees', runIds: removable });
		}
	}
	return { steps };
}

//#endregion

//#region Usage, time and cost

export const EMPTY_RUN_USAGE: IRunUsage = { tokens: 0, input: 0, output: 0, cache: 0 };

export interface IRunUsageEvent {
	readonly input: number;
	readonly output: number;
	/** Context occupancy (ACP `usage_update`): not spend, only the window's fill. */
	readonly used?: number;
	readonly cache?: number;
	readonly cacheWrite?: number;
	/** The agent's cumulative cost for its session (Claude's ACP `usage_update.cost`). */
	readonly costUsd?: number;
}

/**
 * Folds one usage report. Per-request and per-turn counts add up; an occupancy report changes
 * nothing; a cumulative session cost adds its growth (a smaller one means the agent's session
 * restarted, so all of it is new).
 */
export function accumulateRunUsage(previous: IRunUsage, event: IRunUsageEvent): IRunUsage {
	let next = previous;
	if (event.used === undefined) {
		const cache = (event.cache ?? 0) + (event.cacheWrite ?? 0);
		const spent = event.input + event.output + cache;
		if (spent > 0) {
			next = { ...next, tokens: next.tokens + spent, input: next.input + event.input, output: next.output + event.output, cache: next.cache + cache };
		}
	}
	if (event.costUsd !== undefined && Number.isFinite(event.costUsd) && event.costUsd >= 0) {
		const last = next.sessionCost ?? 0;
		const delta = event.costUsd >= last ? event.costUsd - last : event.costUsd;
		next = { ...next, costUsd: round6((next.costUsd ?? 0) + delta), sessionCost: event.costUsd };
	}
	return next;
}

function round6(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

/** Folds the run's clock: a turn starting sets `activeSince`, the chat going idle banks the time. */
export function trackRunClock(run: Pick<IRunGroupRun, 'workMs' | 'activeSince' | 'firstStartedAt' | 'lastEndedAt'>, busy: boolean, now: number): Pick<IRunGroupRun, 'workMs' | 'activeSince' | 'firstStartedAt' | 'lastEndedAt'> {
	if (busy && run.activeSince === undefined) {
		return { ...run, activeSince: now, firstStartedAt: run.firstStartedAt ?? now };
	}
	if (!busy && run.activeSince !== undefined) {
		const { activeSince, ...rest } = run;
		return { ...rest, workMs: run.workMs + Math.max(0, now - activeSince), lastEndedAt: now };
	}
	return run;
}

export function runWorkMs(run: Pick<IRunGroupRun, 'workMs' | 'activeSince'>, now: number): number {
	return run.workMs + (run.activeSince !== undefined ? Math.max(0, now - run.activeSince) : 0);
}

export interface IRunCostHistory {
	/** Typical cost of one session per provider family, from the usage history (USD). */
	readonly costPerSession: ReadonlyMap<string, number>;
	/** Live rate-limit windows per provider family. */
	readonly limits: readonly { readonly family: string; readonly label: string; readonly usedPercent: number; readonly resetsAt?: number }[];
}

export interface IRunGroupWarning {
	readonly kind: 'cost' | 'limit' | 'limitReached';
	readonly family?: string;
	readonly message: string;
}

export interface IRunGroupEstimate {
	/** Sum of the typical session cost of each picked model; undefined when none is known. */
	readonly estimateUsd?: number;
	/** Models with no cost history (free, local, or never used). */
	readonly unknown: readonly string[];
	readonly warnings: readonly IRunGroupWarning[];
}

export const RUN_GROUP_COST_WARN_USD = 2;
export const RUN_GROUP_LIMIT_WARN_PERCENT = 80;

/**
 * Warns before a start that will cost a lot or run into usage limits: each model is a full session,
 * and several runs on one provider spend one plan's limits in parallel.
 */
export function estimateRunGroup(models: readonly IRunGroupModel[], history: IRunCostHistory, thresholds: { readonly costUsd: number; readonly limitPercent: number } = { costUsd: RUN_GROUP_COST_WARN_USD, limitPercent: RUN_GROUP_LIMIT_WARN_PERCENT }): IRunGroupEstimate {
	let estimate: number | undefined;
	const unknown: string[] = [];
	for (const model of models) {
		const cost = history.costPerSession.get(model.family);
		if (cost === undefined) {
			unknown.push(model.label);
			continue;
		}
		estimate = (estimate ?? 0) + cost;
	}
	const warnings: IRunGroupWarning[] = [];
	if (estimate !== undefined && estimate >= thresholds.costUsd) {
		warnings.push({ kind: 'cost', message: `These ${models.length} runs typically cost about $${estimate.toFixed(2)} together.` });
	}
	const perFamily = new Map<string, number>();
	for (const model of models) {
		perFamily.set(model.family, (perFamily.get(model.family) ?? 0) + 1);
	}
	for (const window of history.limits) {
		const runs = perFamily.get(window.family);
		if (!runs) {
			continue;
		}
		if (window.usedPercent >= 100) {
			warnings.push({ kind: 'limitReached', family: window.family, message: `${window.label} is used up${window.resetsAt ? ' until it resets' : ''}; its run${runs > 1 ? 's' : ''} may fail.` });
		} else if (window.usedPercent >= thresholds.limitPercent) {
			warnings.push({ kind: 'limit', family: window.family, message: `${window.label} is ${Math.round(window.usedPercent)}% used; ${runs > 1 ? `${runs} runs` : 'this run'} will add to it.` });
		}
	}
	return { ...(estimate !== undefined ? { estimateUsd: estimate } : {}), unknown, warnings };
}

//#endregion

//#region Service

export interface IRunGroupStartRequest {
	readonly prompt: IRunGroupPrompt;
	/** The composer's live display for the first turn (image bytes), when it has one. */
	readonly liveDisplay?: unknown;
	readonly models: readonly IRunGroupModel[];
	/** The project checkout the worktrees branch from. */
	readonly repoRoot: string;
	readonly projectId?: string;
	/** Branch to start from; absent: the checkout's current HEAD. */
	readonly baseRef?: string;
}

export interface IRunWinnerResult {
	readonly ok: boolean;
	readonly error?: string;
	/** Worktrees that were not removed (dirty, or refused). */
	readonly kept?: readonly string[];
}

export interface IRunDiffTarget {
	readonly repoRoot: string;
	readonly from: string;
	readonly to: string;
	readonly label: string;
	/** Folder that "go to file" opens into. */
	readonly folder?: string;
}

export const IAgentRunGroupService = createDecorator<IAgentRunGroupService>('agentRunGroupService');

export interface IAgentRunGroupService {
	readonly _serviceBrand: undefined;
	/** Fires with the id of a group whose runs, setup, stats or status changed. */
	readonly onDidChange: Event<string>;
	readonly whenReady: Promise<void>;

	list(): readonly IRunGroup[];
	get(groupId: string): IRunGroup | undefined;
	/** The group a chat runs in. */
	groupOf(sessionId: string): IRunGroup | undefined;
	runStatus(groupId: string, runId: string): RunStatus;
	rollup(groupId: string): IRunGroupRollup;

	/** Creates the chats and worktrees and starts every run. Resolves once the group is recorded. */
	start(request: IRunGroupStartRequest): Promise<IRunGroup>;
	/** Stops every run: live turns are cancelled, setups aborted. */
	stop(groupId: string): Promise<void>;
	/** Runs a failed or stopped setup again and lets the run start. */
	retrySetup(groupId: string, runId: string): Promise<void>;
	/** Sends a follow-up to one run or all of them, through each chat's queue. */
	followUp(groupId: string, target: string | 'all', prompt: IRunGroupPrompt): Promise<void>;
	setFollowUpTarget(groupId: string, target: RunFollowUpTarget): void;
	/** Re-reads files changed and lines added and removed for every run. */
	refreshStats(groupId: string): Promise<void>;
	pickWinner(groupId: string, runId: string, action: RunWinnerAction, options: { readonly removeOthers: boolean }): Promise<IRunWinnerResult>;
	removeWorktrees(groupId: string, runIds: readonly string[]): Promise<IRunWinnerResult>;
	/** What a diff shows: a run against the base, or two runs against each other. */
	diffTarget(groupId: string, from: string | 'base', to: string): Promise<IRunDiffTarget>;
	estimate(models: readonly IRunGroupModel[]): Promise<IRunGroupEstimate>;
	archive(groupId: string): Promise<void>;
}

//#endregion
