/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VoltClient } from './client';
import { compactNumber, money } from './format';
import type { Collections } from './selectors';
import { catalogItem, providerFamily } from './selectors';
import type { AccessMode, ComposerMode, IPromptAttachment, IPromptMention, IRuntimeState } from './types';

/**
 * Run groups ("Compare models"): one prompt sent to 2-4 models at once, each in its own git
 * worktree, branch (`volt/<task>-<model>`) and chat. The agent server owns them (the `runGroups`
 * collection and the `runGroups.*` methods), so a comparison started on the desktop shows here and
 * the other way round. Types mirror src/vs/workbench/services/voltRuntime/common/runGroups/runGroups.ts;
 * labels mirror the desktop's agentRunGroupLabels.ts.
 */

export const RUN_GROUP_MIN_MODELS = 2;
export const RUN_GROUP_MAX_MODELS = 4;

//#region Types

export interface IRunGroupModel {
	readonly ref: string;
	readonly label: string;
	readonly family: string;
	readonly options?: Readonly<Record<string, string | boolean>>;
}

export type RunSetupStepState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface IRunSetupStep {
	readonly command: string;
	readonly state: RunSetupStepState;
	readonly startedAt?: number;
	readonly endedAt?: number;
	readonly exitCode?: number | null;
	readonly tail?: string;
}

export type RunSetupState = 'pending' | 'worktree' | 'running' | 'done' | 'failed' | 'cancelled';

export interface IRunSetup {
	readonly state: RunSetupState;
	readonly steps: readonly IRunSetupStep[];
	readonly source?: string;
	readonly error?: string;
	readonly startedAt?: number;
	readonly endedAt?: number;
}

export interface IRunUsage {
	readonly tokens: number;
	readonly input: number;
	readonly output: number;
	readonly cache: number;
	readonly costUsd?: number;
}

export interface IRunStats {
	readonly files: number;
	readonly additions: number;
	readonly deletions: number;
	readonly snapshot?: string;
	readonly lastMessage?: string;
	readonly at: number;
}

export interface IRunGroupRun {
	/** The run's chat id. */
	readonly id: string;
	readonly model: IRunGroupModel;
	readonly branch: string;
	readonly worktreePath?: string;
	readonly setup: IRunSetup;
	readonly usage: IRunUsage;
	readonly stats?: IRunStats;
	readonly workMs: number;
	readonly activeSince?: number;
	readonly firstStartedAt?: number;
	readonly lastEndedAt?: number;
	readonly discarded?: boolean;
	readonly worktreeRemoved?: boolean;
}

export type RunWinnerAction = 'merge' | 'checkout' | 'pr';

export interface IRunGroupWinner {
	readonly runId: string;
	readonly action: RunWinnerAction;
	readonly at: number;
	readonly commit?: string;
}

export type RunStatus = 'setup' | 'setupFailed' | 'waiting' | 'working' | 'needsInput' | 'stopping' | 'paused' | 'failed' | 'interrupted' | 'stopped' | 'done';
export type RunGroupStatus = 'needsInput' | 'running' | 'failed' | 'done' | 'stopped';

export interface IRunGroupRollup {
	readonly status: RunGroupStatus;
	readonly live: number;
	readonly done: number;
	readonly failed: number;
	readonly total: number;
}

export interface IRunGroup {
	readonly id: string;
	readonly title: string;
	readonly prompt: { readonly text: string; readonly display?: unknown; readonly mode?: string };
	readonly createdAt: number;
	readonly repoRoot: string;
	readonly projectId?: string;
	readonly base: { readonly ref?: string; readonly commit: string };
	readonly runs: readonly IRunGroupRun[];
	readonly winner?: IRunGroupWinner;
	readonly followUp: 'selected' | 'all';
	readonly archived?: boolean;
	/** Each run's status, by run (chat) id, as the server reads it. */
	readonly statuses: Readonly<Record<string, RunStatus>>;
	readonly rollup: IRunGroupRollup;
}

export interface IRunWinnerResult {
	readonly ok: boolean;
	readonly error?: string;
	readonly kept?: readonly string[];
	/** The winner should become a pull request: open the form for this branch (in `worktreePath`). */
	readonly pullRequest?: { readonly runId: string; readonly branch: string; readonly base?: string; readonly worktreePath?: string };
}

export interface IRunGroupStart {
	readonly projectId: string;
	readonly text: string;
	/** 2-4 catalog refs. */
	readonly models: readonly string[];
	readonly mode?: ComposerMode;
	readonly accessMode?: AccessMode;
	readonly attachments?: readonly IPromptAttachment[];
	readonly mentions?: readonly IPromptMention[];
	readonly displayText?: string;
	/** Branch to start from; the project's checked out HEAD when absent. */
	readonly baseRef?: string;
}

//#endregion

//#region Selectors

const EMPTY: readonly IRunGroup[] = [];
let lastCol: unknown;
let lastList: readonly IRunGroup[] = EMPTY;
let lastIndex = new Map<string, IRunGroup>();

/** Every group, newest first (archived ones too). The same array while the collection is unchanged. */
export function selectRunGroups(cols: Collections): readonly IRunGroup[] {
	const col = cols['runGroups'];
	if (col !== lastCol) {
		lastCol = col;
		lastList = col ? (Object.values(col) as IRunGroup[]).filter(group => !!group?.id).sort((a, b) => b.createdAt - a.createdAt) : EMPTY;
		lastIndex = new Map();
		for (const group of lastList) {
			for (const run of group.runs) {
				lastIndex.set(run.id, group);
			}
		}
	}
	return lastList;
}

export function runGroupById(cols: Collections, groupId: string): IRunGroup | undefined {
	return selectRunGroups(cols).find(group => group.id === groupId);
}

/** The group a chat is one of the runs of. */
export function runGroupOfChat(cols: Collections, chatId: string): IRunGroup | undefined {
	selectRunGroups(cols);
	return lastIndex.get(chatId);
}

export function runStatusOf(group: IRunGroup, runId: string): RunStatus {
	return group.statuses?.[runId] ?? 'waiting';
}

/** The runs still in the comparison (not archived after another one won). */
export function activeRuns(group: IRunGroup): readonly IRunGroupRun[] {
	return group.runs.filter(run => !run.discarded || run.id === group.winner?.runId);
}

/** Still doing something on its own. */
export function isRunLive(status: RunStatus): boolean {
	return status === 'setup' || status === 'waiting' || status === 'working' || status === 'stopping';
}

/** A run can win once it is set up and no longer working or waiting on the user. */
export function canPickRun(group: IRunGroup, run: IRunGroupRun): boolean {
	const status = runStatusOf(group, run.id);
	return !group.winner && !!run.worktreePath && run.setup.state === 'done' && !isRunLive(status) && status !== 'needsInput';
}

export function runWorkMs(run: Pick<IRunGroupRun, 'workMs' | 'activeSince'>, now: number): number {
	return run.workMs + (run.activeSince !== undefined ? Math.max(0, now - run.activeSince) : 0);
}

//#endregion

//#region Labels (the desktop's wording)

/** "42s", "3m 05s", "1h 02m": steady width, so a live clock does not jitter. */
export function formatRunTime(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h) {
		return `${h}h ${String(m).padStart(2, '0')}m`;
	}
	if (m) {
		return `${m}m ${String(s).padStart(2, '0')}s`;
	}
	return `${s}s`;
}

export function formatRunTokens(run: Pick<IRunGroupRun, 'usage'>): string {
	return run.usage.tokens ? compactNumber(run.usage.tokens) : '—';
}

export function formatRunCost(run: Pick<IRunGroupRun, 'usage'>): string {
	return run.usage.costUsd !== undefined ? money(run.usage.costUsd) : '—';
}

/** "Creating worktree", "Setting up 1/2", "Working 1m 05s", "Done", ... */
export function runStatusLabel(status: RunStatus, run: IRunGroupRun, now: number): string {
	switch (status) {
		case 'setup': {
			if (run.setup.state === 'worktree' || run.setup.state === 'pending') {
				return 'Creating worktree';
			}
			const steps = run.setup.steps;
			const done = steps.filter(step => step.state === 'done').length;
			return steps.length ? `Setting up ${Math.min(steps.length, done + 1)}/${steps.length}` : 'Setting up';
		}
		case 'setupFailed':
			return run.setup.state === 'cancelled' ? 'Setup stopped' : 'Setup failed';
		case 'waiting':
			return 'Starting';
		case 'working':
			return `Working ${formatRunTime(runWorkMs(run, now))}`;
		case 'needsInput':
			return 'Needs input';
		case 'stopping':
			return 'Stopping';
		case 'paused':
			return 'Paused';
		case 'failed':
			return 'Failed';
		case 'interrupted':
			return 'Interrupted';
		case 'stopped':
			return 'Stopped';
		case 'done':
			return 'Done';
	}
}

/** The chat list's status tone for a run (the StatusIcon kinds). */
export function runStatusTone(status: RunStatus): 'working' | 'question' | 'failed' | 'stopped' | 'unread' | 'idle' {
	switch (status) {
		case 'setup':
		case 'waiting':
		case 'working':
		case 'stopping':
			return 'working';
		case 'needsInput':
			return 'question';
		case 'failed':
		case 'setupFailed':
			return 'failed';
		case 'interrupted':
		case 'stopped':
		case 'paused':
			return 'stopped';
		case 'done':
			return 'unread';
	}
}

/** "3 models · 2 working", "3 models · Grok 4.7 won". */
export function runGroupSummary(group: IRunGroup): string {
	const models = `${group.runs.length} models`;
	if (group.winner) {
		const winner = group.runs.find(run => run.id === group.winner!.runId);
		return winner ? `${models} · ${winner.model.label} won` : models;
	}
	if (group.rollup?.live) {
		return `${models} · ${group.rollup.live} working`;
	}
	return models;
}

export function winnerActionLabel(action: RunWinnerAction, base: string | undefined): string {
	switch (action) {
		case 'merge':
			return base ? `Merge into ${base}` : 'Merge into the base branch';
		case 'checkout':
			return 'Check out its branch';
		case 'pr':
			return 'Open a pull request';
	}
}

/** What picking `run` does, for the confirmation (the desktop's dialog text). */
export function winnerActionDetail(action: RunWinnerAction, group: IRunGroup, run: IRunGroupRun): string {
	const others = group.runs.filter(other => other.id !== run.id && !other.discarded).length;
	const what = action === 'merge'
		? `Its changes are committed on ${run.branch} and merged into ${group.base.ref ?? 'the base branch'}.`
		: action === 'checkout'
			? `Its changes are committed on ${run.branch}, and the project checks that branch out.`
			: `Its changes are committed on ${run.branch}, then the pull request form opens.`;
	return others ? `${what} ${others === 1 ? 'The other run is' : `The other ${others} runs are`} archived.` : what;
}

/** The base the runs started from: `main`, or a short commit. */
export function runGroupBase(group: IRunGroup): string {
	return group.base.ref ?? group.base.commit.slice(0, 7);
}

/** Why `refs` cannot start a comparison; undefined when they can. */
export function runSelectionProblem(refs: readonly string[]): string | undefined {
	if (new Set(refs).size !== refs.length) {
		return 'Pick each model once.';
	}
	if (refs.length < RUN_GROUP_MIN_MODELS) {
		return `Pick at least ${RUN_GROUP_MIN_MODELS} models to compare.`;
	}
	if (refs.length > RUN_GROUP_MAX_MODELS) {
		return `Pick at most ${RUN_GROUP_MAX_MODELS} models.`;
	}
	return undefined;
}

/** Adds or removes `ref`; refuses to grow past the maximum. */
export function toggleRunModel(refs: readonly string[], ref: string): readonly string[] {
	if (refs.includes(ref)) {
		return refs.filter(entry => entry !== ref);
	}
	return refs.length >= RUN_GROUP_MAX_MODELS ? refs : [...refs, ref];
}

/** The model as a run group names it: the picker's label, provider family, chosen options. */
export function runGroupModel(runtime: IRuntimeState, ref: string): IRunGroupModel {
	const item = catalogItem(runtime, ref);
	const options = runtime.modelOptions?.[ref];
	return {
		ref,
		label: item ? [item.label, item.qualifier].filter(Boolean).join(' ') : ref.replace(/^(agent|model):[^:]+:/, ''),
		family: providerFamily(item?.providerId ?? ref.split(':')[1]),
		...(options && Object.keys(options).length ? { options } : {}),
	};
}

//#endregion

//#region Calls (serverRunGroups.ts)

/** Starts the comparison: a chat, branch and worktree per model. Resolves the group once recorded. */
export function startRunGroup(client: VoltClient, request: IRunGroupStart): Promise<IRunGroup> {
	const runtime = (client.getCollections()['runtime'] ?? {}) as IRuntimeState;
	const mentions: unknown[] = (request.attachments ?? []).map(a => ({ label: a.name, kind: 'image', image: { id: a.id, mime: a.mime, ref: a.ref, name: a.name } }));
	mentions.push(...(request.mentions ?? []));
	const shown = request.displayText ?? request.text;
	return client.connection.call<IRunGroup>('runGroups.start', [{
		prompt: { text: request.text, display: mentions.length ? { text: shown, mentions } : { text: shown }, mode: request.mode ?? 'Agent' },
		models: request.models.map(ref => runGroupModel(runtime, ref)),
		projectId: request.projectId,
		...(request.accessMode ? { accessMode: request.accessMode } : {}),
		...(request.baseRef ? { baseRef: request.baseRef } : {}),
	}], { requireOpen: true, timeoutMs: 60_000 });
}

/** Stops every run, or one: live turns are cancelled, setups aborted. */
export function stopRunGroup(client: VoltClient, groupId: string, runId?: string): Promise<void> {
	return client.connection.call<void>('runGroups.stop', [groupId, runId], { requireOpen: true });
}

export function pickRunWinner(client: VoltClient, groupId: string, runId: string, action: RunWinnerAction, removeOthers: boolean): Promise<IRunWinnerResult> {
	return client.connection.call<IRunWinnerResult>('runGroups.pickWinner', [groupId, runId, action, { removeOthers }], { requireOpen: true, timeoutMs: 120_000 });
}

export function retryRunSetup(client: VoltClient, groupId: string, runId: string): Promise<void> {
	return client.connection.call<void>('runGroups.retrySetup', [groupId, runId], { requireOpen: true, timeoutMs: 120_000 });
}

export function refreshRunStats(client: VoltClient, groupId: string): Promise<void> {
	return client.connection.call<void>('runGroups.refreshStats', [groupId], { timeoutMs: 60_000 });
}

export function archiveRunGroup(client: VoltClient, groupId: string): Promise<void> {
	return client.connection.call<void>('runGroups.archive', [groupId], { requireOpen: true });
}

/** Sends a follow-up to one run, or to every run still in the comparison. */
export function followUpRunGroup(client: VoltClient, groupId: string, target: string | 'all', text: string, mode: ComposerMode = 'Agent'): Promise<void> {
	return client.connection.call<void>('runGroups.followUp', [groupId, target, { text, display: { text }, mode }], { requireOpen: true });
}

//#endregion
