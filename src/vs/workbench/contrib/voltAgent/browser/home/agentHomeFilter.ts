/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import type { IAgentHomeFolder } from './agentHomeModel.js';

export type AgentHomeGrouping = 'repository' | 'workspace' | 'updated' | 'status' | 'environment';
export type AgentHomeChatOrder = 'updated' | 'status';
export type AgentHomeGroupOrder = 'updated' | 'manual';
export type AgentHomeShowField = 'updated' | 'environment' | 'pr' | 'workspace' | 'branch' | 'machine';
export type AgentHomeStatusFilter = 'needsAttention' | 'unread' | 'working' | 'draft' | 'done';
export type AgentHomePrFilter = 'draft' | 'open' | 'merged' | 'closed' | 'none';
export type AgentHomeEnvironmentFilter = 'cloud' | 'local';
export type AgentHomeSourceFilter = 'folder' | 'workspaceFile';
export type AgentHomeArchivedFilter = 'hide' | 'show';

export interface IAgentHomeViewState {
	readonly grouping: AgentHomeGrouping;
	readonly chatOrder: AgentHomeChatOrder;
	readonly groupOrder: AgentHomeGroupOrder;
	readonly show: ReadonlySet<AgentHomeShowField>;
	readonly status: ReadonlySet<AgentHomeStatusFilter>;
	readonly pr: ReadonlySet<AgentHomePrFilter>;
	readonly environment: ReadonlySet<AgentHomeEnvironmentFilter>;
	readonly source: ReadonlySet<AgentHomeSourceFilter>;
	readonly archived: AgentHomeArchivedFilter;
}

export interface IAgentHomeViewStateJson {
	readonly grouping: AgentHomeGrouping;
	readonly chatOrder: AgentHomeChatOrder;
	readonly groupOrder: AgentHomeGroupOrder;
	readonly show: readonly AgentHomeShowField[];
	readonly status: readonly AgentHomeStatusFilter[];
	readonly pr: readonly AgentHomePrFilter[];
	readonly environment: readonly AgentHomeEnvironmentFilter[];
	readonly source: readonly AgentHomeSourceFilter[];
	readonly archived: AgentHomeArchivedFilter;
}

export const AGENT_HOME_VIEW_STORAGE_KEY = 'volt.agent.home.view';

export const DEFAULT_AGENT_HOME_SHOW: readonly AgentHomeShowField[] = ['updated', 'environment', 'pr'];
export const DEFAULT_AGENT_HOME_STATUS: readonly AgentHomeStatusFilter[] = ['needsAttention', 'working', 'draft', 'done'];
export const DEFAULT_AGENT_HOME_PR: readonly AgentHomePrFilter[] = ['draft', 'open', 'merged', 'closed', 'none'];
export const DEFAULT_AGENT_HOME_ENVIRONMENT: readonly AgentHomeEnvironmentFilter[] = ['cloud', 'local'];
export const DEFAULT_AGENT_HOME_SOURCE: readonly AgentHomeSourceFilter[] = ['folder', 'workspaceFile'];

export function defaultAgentHomeViewState(): IAgentHomeViewState {
	return {
		grouping: 'workspace',
		chatOrder: 'updated',
		groupOrder: 'manual',
		show: new Set(DEFAULT_AGENT_HOME_SHOW),
		status: new Set(DEFAULT_AGENT_HOME_STATUS),
		pr: new Set(DEFAULT_AGENT_HOME_PR),
		environment: new Set(DEFAULT_AGENT_HOME_ENVIRONMENT),
		source: new Set(DEFAULT_AGENT_HOME_SOURCE),
		archived: 'hide',
	};
}

export function serializeAgentHomeViewState(state: IAgentHomeViewState): IAgentHomeViewStateJson {
	return {
		grouping: state.grouping,
		chatOrder: state.chatOrder,
		groupOrder: state.groupOrder,
		show: [...state.show],
		status: [...state.status],
		pr: [...state.pr],
		environment: [...state.environment],
		source: [...state.source],
		archived: state.archived,
	};
}

export function reviveAgentHomeViewState(raw: unknown): IAgentHomeViewState {
	const defaults = defaultAgentHomeViewState();
	if (!raw || typeof raw !== 'object') {
		return defaults;
	}
	const value = raw as Partial<IAgentHomeViewStateJson>;
	return {
		grouping: isGrouping(value.grouping) ? value.grouping : defaults.grouping,
		chatOrder: isChatOrder(value.chatOrder) ? value.chatOrder : defaults.chatOrder,
		groupOrder: isGroupOrder(value.groupOrder) ? value.groupOrder : defaults.groupOrder,
		show: reviveSet(value.show, isShowField, defaults.show),
		status: reviveSet(value.status, isStatusFilter, defaults.status),
		pr: reviveSet(value.pr, isPrFilter, defaults.pr),
		environment: reviveSet(value.environment, isEnvironmentFilter, defaults.environment),
		source: reviveSet(value.source, isSourceFilter, defaults.source),
		archived: value.archived === 'show' || value.archived === 'hide' ? value.archived : defaults.archived,
	};
}

export function groupingLabel(grouping: AgentHomeGrouping): string {
	switch (grouping) {
		case 'repository': return 'Repository';
		case 'workspace': return 'Workspace';
		case 'updated': return 'Updated';
		case 'status': return 'Status';
		case 'environment': return 'Environment';
		default: {
			const unexpected: never = grouping;
			return unexpected;
		}
	}
}

export function isStatusFilterActive(state: IAgentHomeViewState): boolean {
	return !sameSet(state.status, DEFAULT_AGENT_HOME_STATUS);
}

export function isPrFilterActive(state: IAgentHomeViewState): boolean {
	return !sameSet(state.pr, DEFAULT_AGENT_HOME_PR);
}

export function isEnvironmentFilterActive(state: IAgentHomeViewState): boolean {
	return !sameSet(state.environment, DEFAULT_AGENT_HOME_ENVIRONMENT);
}

export function isSourceFilterActive(state: IAgentHomeViewState): boolean {
	return !sameSet(state.source, DEFAULT_AGENT_HOME_SOURCE);
}

export function isArchivedFilterActive(state: IAgentHomeViewState): boolean {
	return state.archived !== 'hide';
}

export function anyHomeFilterActive(state: IAgentHomeViewState): boolean {
	return isStatusFilterActive(state)
		|| isPrFilterActive(state)
		|| isEnvironmentFilterActive(state)
		|| isSourceFilterActive(state)
		|| isArchivedFilterActive(state);
}

export type AgentHomeSessionStatus = Exclude<AgentHomeStatusFilter, 'unread'>;

/** Groupings that list agent tabs directly under fixed headers instead of under their project. */
export function isFlatGrouping(grouping: AgentHomeGrouping): boolean {
	return grouping === 'updated' || grouping === 'status' || grouping === 'environment';
}

/**
 * Where a session stands, from the harness's point of view. A pending
 * approval or question outranks a live run; a failed or interrupted run needs
 * the user too. A stopped run is finished: the user chose to end it.
 */
export function sessionPrimaryStatus(session: IAgentSessionMeta): AgentHomeSessionStatus {
	if (session.attention) {
		return 'needsAttention';
	}
	switch (session.status) {
		case 'running':
			return 'working';
		case 'error':
		case 'interrupted':
			return 'needsAttention';
		case 'done':
		case 'cancelled':
			return 'done';
		case 'idle':
			return session.turnCount === 0 || session.hasDraft ? 'draft' : 'done';
		default: {
			const unexpected: never = session.status;
			return unexpected;
		}
	}
}

/** Every status filter a session answers to: its primary status, an unsent draft, unread. */
export function sessionStatusTags(session: IAgentSessionMeta): readonly AgentHomeStatusFilter[] {
	const primary = sessionPrimaryStatus(session);
	const tags: AgentHomeStatusFilter[] = [primary];
	if (session.hasDraft && primary !== 'draft') {
		tags.push('draft');
	}
	if (session.unread) {
		tags.push('unread');
	}
	return tags;
}

/**
 * VOLT has no PR metadata yet. Every session is treated as "No PR" so the
 * filter still changes the list when that option is unchecked.
 */
export function sessionPrTag(_session: IAgentSessionMeta): AgentHomePrFilter {
	return 'none';
}

/**
 * Every session runs on this machine today. Cloud sessions will report
 * themselves here once they exist.
 */
export function sessionEnvironmentTag(_session: IAgentSessionMeta): AgentHomeEnvironmentFilter {
	return 'local';
}

/** Name of this machine in the Environment grouping and filter. */
export function localEnvironmentLabel(): string {
	if (isMacintosh) {
		return localize('voltAgent.home.thisMac', "This Mac");
	}
	if (isWindows) {
		return localize('voltAgent.home.thisPc', "This PC");
	}
	return localize('voltAgent.home.thisComputer', "This Computer");
}

export function environmentLabel(tag: AgentHomeEnvironmentFilter): string {
	switch (tag) {
		case 'cloud': return localize('voltAgent.home.cloud', "Cloud");
		case 'local': return localEnvironmentLabel();
		default: {
			const unexpected: never = tag;
			return unexpected;
		}
	}
}

/** Every folder the session works in; the first is its primary folder. */
export function sessionFolders(session: IAgentSessionMeta): readonly string[] {
	if (session.workspaceFolders?.length) {
		return session.workspaceFolders;
	}
	return session.workspaceFolder ? [session.workspaceFolder] : [];
}

export function folderSourceTag(folder: IAgentHomeFolder): AgentHomeSourceFilter {
	return folder.workspace ? 'workspaceFile' : 'folder';
}

/** A session from a `.code-workspace` or with several folders came from a workspace, not a folder. */
export function sessionSourceTag(session: IAgentSessionMeta, workspaceFileIds: ReadonlySet<string> = new Set()): AgentHomeSourceFilter {
	return sessionFolders(session).length > 1 || workspaceFileIds.has(session.workspaceId) ? 'workspaceFile' : 'folder';
}

export function sessionPassesHomeFilters(session: IAgentSessionMeta, state: IAgentHomeViewState, workspaceFileIds?: ReadonlySet<string>): boolean {
	if (session.archived && state.archived !== 'show') {
		return false;
	}
	if (!sessionStatusTags(session).some(tag => state.status.has(tag))) {
		return false;
	}
	if (!state.pr.has(sessionPrTag(session))) {
		return false;
	}
	if (!state.environment.has(sessionEnvironmentTag(session))) {
		return false;
	}
	return state.source.has(sessionSourceTag(session, workspaceFileIds));
}

export function sortSessionsForHome(sessions: readonly IAgentSessionMeta[], order: AgentHomeChatOrder): IAgentSessionMeta[] {
	const copy = [...sessions];
	switch (order) {
		case 'updated':
			return copy.sort((a, b) => sessionStamp(b) - sessionStamp(a));
		case 'status':
			return copy.sort((a, b) => statusRank(sessionPrimaryStatus(a)) - statusRank(sessionPrimaryStatus(b)) || sessionStamp(b) - sessionStamp(a));
		default: {
			const unexpected: never = order;
			return unexpected;
		}
	}
}

export function sessionStamp(session: IAgentSessionMeta): number {
	return session.updatedAt || session.createdAt;
}

export const STATUS_BUCKET_ORDER: readonly AgentHomeSessionStatus[] = ['needsAttention', 'working', 'draft', 'done'];

function statusRank(status: AgentHomeSessionStatus): number {
	return STATUS_BUCKET_ORDER.indexOf(status);
}

export type AgentHomeUpdatedBucket = 'today' | 'yesterday' | 'week' | 'month' | 'older';

export const UPDATED_BUCKET_ORDER: readonly AgentHomeUpdatedBucket[] = ['today', 'yesterday', 'week', 'month', 'older'];

/** Calendar days in local time, like VS Code's history: Today, Yesterday, Last 7 Days, Last 30 Days, Older. */
export function updatedBucketId(stamp: number, now: number): AgentHomeUpdatedBucket {
	if (!stamp) {
		return 'older';
	}
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	const today = start.getTime();
	const day = 86_400_000;
	if (stamp >= today) {
		return 'today';
	}
	if (stamp >= today - day) {
		return 'yesterday';
	}
	if (stamp >= today - 7 * day) {
		return 'week';
	}
	if (stamp >= today - 30 * day) {
		return 'month';
	}
	return 'older';
}

export function updatedBucketLabel(id: AgentHomeUpdatedBucket): string {
	switch (id) {
		case 'today': return localize('voltAgent.home.today', "Today");
		case 'yesterday': return localize('voltAgent.home.yesterday', "Yesterday");
		case 'week': return localize('voltAgent.home.last7', "Last 7 Days");
		case 'month': return localize('voltAgent.home.last30', "Last 30 Days");
		case 'older': return localize('voltAgent.home.older', "Older");
		default: {
			const unexpected: never = id;
			return unexpected;
		}
	}
}

export function statusBucketLabel(id: AgentHomeStatusFilter): string {
	switch (id) {
		case 'needsAttention': return localize('voltAgent.home.filter.needsAttention', "Needs Attention");
		case 'unread': return localize('voltAgent.home.filter.unread', "Unread");
		case 'working': return localize('voltAgent.home.filter.working', "Working");
		case 'draft': return localize('voltAgent.home.filter.draft', "Draft");
		case 'done': return localize('voltAgent.home.filter.done', "Done");
		default: {
			const unexpected: never = id;
			return unexpected;
		}
	}
}

function sameSet<T>(actual: ReadonlySet<T>, expected: readonly T[]): boolean {
	if (actual.size !== expected.length) {
		return false;
	}
	return expected.every(item => actual.has(item));
}

function reviveSet<T>(raw: readonly T[] | undefined, guard: (value: unknown) => value is T, fallback: ReadonlySet<T>): Set<T> {
	if (!Array.isArray(raw)) {
		return new Set(fallback);
	}
	const next = raw.filter(guard);
	return next.length ? new Set(next) : new Set(fallback);
}

function isGrouping(value: unknown): value is AgentHomeGrouping {
	return value === 'repository' || value === 'workspace' || value === 'updated' || value === 'status' || value === 'environment';
}

function isChatOrder(value: unknown): value is AgentHomeChatOrder {
	return value === 'updated' || value === 'status';
}

function isGroupOrder(value: unknown): value is AgentHomeGroupOrder {
	return value === 'updated' || value === 'manual';
}

function isShowField(value: unknown): value is AgentHomeShowField {
	return value === 'updated' || value === 'environment' || value === 'pr' || value === 'workspace' || value === 'branch' || value === 'machine';
}

function isStatusFilter(value: unknown): value is AgentHomeStatusFilter {
	return value === 'needsAttention' || value === 'unread' || value === 'working' || value === 'draft' || value === 'done';
}

function isPrFilter(value: unknown): value is AgentHomePrFilter {
	return value === 'draft' || value === 'open' || value === 'merged' || value === 'closed' || value === 'none';
}

function isEnvironmentFilter(value: unknown): value is AgentHomeEnvironmentFilter {
	return value === 'cloud' || value === 'local';
}

function isSourceFilter(value: unknown): value is AgentHomeSourceFilter {
	return value === 'folder' || value === 'workspaceFile';
}
