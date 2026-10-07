/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { isLiveTaskState } from '../../../../services/voltRuntime/common/orchestration/agentTasks.js';
import type { IOrchState } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { isUsageLimitText } from '../../../../services/voltRuntime/common/acpNotices.js';
import { combineDayAndTime, MINUTES_PER_DAY } from '../ui/dateTime/voltDateTime.js';
import dayjs from '../ui/vendor/dayjs.js';
import {
	AgentHomeEnvironmentFilter,
	AgentHomeGrouping,
	AgentHomePrFilter,
	AgentHomeSessionStatus,
	AgentHomeUpdatedBucket,
	anyHomeFilterActive,
	environmentLabel,
	folderSourceTag,
	IAgentHomeViewState,
	isFlatGrouping,
	sessionEnvironmentTag,
	sessionFolders,
	sessionPassesHomeFilters,
	sessionPrimaryStatus,
	sessionStamp,
	sortSessionsForHome,
	STATUS_BUCKET_ORDER,
	statusBucketLabel,
	UPDATED_BUCKET_ORDER,
	updatedBucketId,
	updatedBucketLabel,
} from './agentHomeFilter.js';
import { dominantRepoOwner, IAgentRepoInfo, repoDisplayName } from './agentRepoInfo.js';
import { isScratchSession, scratchProjectLabel } from './agentHomeWorkspace.js';

export interface IAgentHomeFolder {
	readonly uri: URI;
	readonly name: string;
	readonly current: boolean;
	readonly workspace: boolean;
	/** Workspace identity of a `.code-workspace` entry; sessions created in it carry the same id. */
	readonly workspaceId?: string;
}

/** A project row in Repository or Workspace grouping. It holds agent tabs, never other projects. */
export interface IAgentHomeProject {
	readonly key: string;
	readonly label: string;
	readonly kind: 'repository' | 'workspace';
	/** Two or more folders (or repositories) in one agent tab. */
	readonly multi: boolean;
	/** Folder a click or a new chat opens. Absent when the row spans several folders or none was recorded. */
	readonly folder?: IAgentHomeFolder;
	readonly current: boolean;
}

export type AgentHomeSectionKey = 'repositories' | 'workspaces' | 'agents';
export type AgentHomeGroupId = 'working' | 'settled' | 'snooze';
export type AgentHomeActionId = 'search' | 'automations' | 'customize';

export type AgentHomeElement =
	| { readonly type: 'newChat' }
	| { readonly type: 'action'; readonly id: AgentHomeActionId }
	| { readonly type: 'section'; readonly key: AgentHomeSectionKey; readonly add?: boolean; readonly filter?: boolean }
	| { readonly type: 'folder'; readonly project: IAgentHomeProject }
	/** `count` is shown on headers that fold busy rows away (Working). */
	| { readonly type: 'bucket'; readonly id: string; readonly label: string; readonly filter?: boolean; readonly add?: boolean; readonly count?: number }
	| { readonly type: 'group'; readonly id: AgentHomeGroupId; readonly count?: number }
	/**
	 * `nested` sessions sit under their project; the others list the project by its initials.
	 * `sideDepth` is set on a side chat, listed right under the chat it was opened in.
	 */
	| { readonly type: 'session'; readonly session: IAgentSessionMeta; readonly folderKey: string; readonly nested: boolean; readonly sideDepth?: number; readonly runMember?: IAgentHomeRunMember }
	/** One prompt sent to several models: a row that opens the compare view and folds out into its runs. */
	| { readonly type: 'runGroup'; readonly group: IAgentHomeRunGroup; readonly folderKey: string; readonly nested: boolean }
	| { readonly type: 'more'; readonly groupKey: string; readonly hidden: number; readonly nested: boolean }
	| { readonly type: 'empty'; readonly key: string; readonly filtered: boolean };

/** A run of a group as its row shows it: the model instead of the chat's title. */
export interface IAgentHomeRunMember {
	readonly sessionId: string;
	readonly label: string;
	readonly family: string;
	readonly branch: string;
	readonly statusLabel: string;
	readonly badge?: IAgentHomeStatusBadge;
	readonly winner?: boolean;
	readonly discarded?: boolean;
}

export interface IAgentHomeRunGroup {
	readonly id: string;
	/** Stands in for the group wherever the list sorts, filters and groups chats: dates, project, status. */
	readonly session: IAgentSessionMeta;
	readonly families: readonly string[];
	/** "3 models · 2 working". */
	readonly summary: string;
	readonly badge?: IAgentHomeStatusBadge;
	readonly members: readonly IAgentHomeRunMember[];
	/** The runs' own history entries, for those that have one yet. */
	readonly metas: ReadonlyMap<string, IAgentSessionMeta>;
}

export interface IAgentHomeNode {
	readonly element: AgentHomeElement;
	readonly children?: readonly IAgentHomeNode[];
	readonly collapsed?: boolean;
}

export interface IAgentHomeTreeOptions {
	readonly now?: number;
	/** Repository facts by folder path, as sessions store it (see {@link folderPath}). */
	readonly repos?: ReadonlyMap<string, IAgentRepoInfo>;
	/** Rows shown per group, by group key; groups start at {@link AGENT_HOME_GROUP_LIMIT}. */
	readonly limits?: ReadonlyMap<string, number>;
	/** What each session's linked pull requests add up to, for the PR filter. Absent: "No PR". */
	readonly prTags?: ReadonlyMap<string, AgentHomePrFilter>;
	/** Run groups: each replaces its runs' rows with one row that folds out into them. */
	readonly runGroups?: readonly IAgentHomeRunGroup[];
	/** Fold busy chats into a collapsed Working shelf below the active list (`volt.agent.home.workingSection`). */
	readonly workingShelf?: boolean;
	/** What the orchestrator knows that history does not: a turn starting, or subagents still running. See {@link agentHomeLiveWork}. */
	readonly live?: ReadonlyMap<string, AgentHomeWorkState>;
}

/** Agent tabs shown in a group before a "Show more" row. */
export const AGENT_HOME_GROUP_LIMIT = 10;
/** Initial tabs in the Updated "Last 7 Days" bucket before Show more. */
export const AGENT_HOME_WEEK_LIMIT = 7;
/** Sentinel limit after Show more: reveal every remaining tab in that group. */
export const AGENT_HOME_GROUP_EXPAND_ALL = Number.MAX_SAFE_INTEGER;

export type AgentHomeSessionShelf = 'active' | 'settled' | 'snooze';

/** Parking shelves below the active list (and below Working), in display order. */
export const AGENT_HOME_SHELVES: readonly Exclude<AgentHomeSessionShelf, 'active'>[] = ['settled', 'snooze'];

/**
 * Why a chat is busy without needing the user: its own turn runs (`working`), or it stopped while
 * the subagents it started still run and will wake it with their reports (`delegating`).
 */
export type AgentHomeWorkState = 'working' | 'delegating';

/**
 * Busy chats as the orchestrator sees them. A chat waiting on an approval or answer is not busy, and
 * neither is one whose subagent waits on the user: both need the user, so they stay in the inbox.
 */
export function agentHomeLiveWork(state: Pick<IOrchState, 'threads' | 'tasks'>): Map<string, AgentHomeWorkState> {
	const delegating = new Set<string>();
	const blocked = new Set<string>();
	for (const task of Object.values(state.tasks)) {
		if (task.source !== 'volt' || !isLiveTaskState(task.state)) {
			continue;
		}
		(task.state === 'waiting' ? blocked : delegating).add(task.parentId);
	}
	const live = new Map<string, AgentHomeWorkState>();
	for (const thread of Object.values(state.threads)) {
		if (thread.inputs.length) {
			continue;
		}
		if (thread.active) {
			live.set(thread.id, 'working');
		} else if (delegating.has(thread.id) && !blocked.has(thread.id)) {
			live.set(thread.id, 'delegating');
		}
	}
	return live;
}

/**
 * Whether a chat is busy with work that does not need the user, from its history and the
 * orchestrator's view (`live`). Pending approvals and questions, failures and interruptions need the
 * user; a turn the orchestrator is starting again (a retry, a queued prompt) is work.
 */
export function sessionWorkState(session: IAgentSessionMeta, live?: AgentHomeWorkState): AgentHomeWorkState | undefined {
	if (session.attention) {
		return undefined;
	}
	if (session.status === 'running' || live === 'working') {
		return 'working';
	}
	if (session.status === 'error' || session.status === 'interrupted') {
		return undefined;
	}
	return live;
}

/** Working shelf: busy inbox chats. Pinned chats stay pinned; Settled and Snoozed keep their own shelves. */
export function sessionInWorkingShelf(session: IAgentSessionMeta, live?: AgentHomeWorkState): boolean {
	return !session.pinned && sessionHomeShelf(session) === 'active' && sessionWorkState(session, live) !== undefined;
}

/**
 * The Working shelf lists the chat the user last sent work to first. Runs ending and Volt's own
 * wake-ups (subagent reports, pull request news) do not move a row, so the order holds while agents work.
 */
export function sortWorkingSessions(sessions: readonly IAgentSessionMeta[]): IAgentSessionMeta[] {
	const sent = (session: IAgentSessionMeta) => Math.max(session.createdAt, session.lastUserPromptAt ?? session.lastPromptAt ?? 0);
	return [...sessions].sort((a, b) => sent(b) - sent(a) || a.id.localeCompare(b.id));
}

/** Where a session lives in the agent home list. Snooze wins over settled. */
export function sessionHomeShelf(session: IAgentSessionMeta): AgentHomeSessionShelf {
	if (session.snoozed) {
		return 'snooze';
	}
	if (session.settled) {
		return 'settled';
	}
	return 'active';
}

export function compactSessionAge(updatedAt: number, now: number): string {
	return compactDuration(now - updatedAt);
}

/**
 * Time left on a snooze: whole minutes rounded up, then the nearest hour, day or week, so a
 * fresh 2 hour snooze reads "2h" rather than "1h" a second after it starts.
 */
export function compactCountdown(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}
	const days = Math.round(hours / 24);
	if (days < 7) {
		return `${days}d`;
	}
	return `${Math.round(days / 7)}w`;
}

/** "45s", "12m", "3h", "2d", "1w": the age slot of a row. */
export function compactDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) {
		return `${Math.max(1, seconds)}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	if (days < 7) {
		return `${days}d`;
	}
	return `${Math.floor(days / 7)}w`;
}

/**
 * Agent layout has no tab strip: one agent fills the main panel and the left
 * menu switches between them. A non-agent editor (file, browser, changes)
 * gets a single title bar so it can still be told apart and closed.
 */
export function agentPanelTabsMode(nonAgentEditors: number): 'none' | 'single' {
	return nonAgentEditors > 0 ? 'single' : 'none';
}

export function sessionsForFolder(folder: IAgentHomeFolder, sessions: readonly IAgentSessionMeta[]): IAgentSessionMeta[] {
	const folderUri = folder.uri.toString();
	const folderPathValue = folder.uri.fsPath;
	return sessions
		.filter(session => sessionMatchesFolder(session, folderUri, folderPathValue, folder.name))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function latestSessionForFolder(folder: IAgentHomeFolder, sessions: readonly IAgentSessionMeta[]): IAgentSessionMeta | undefined {
	return sessionsForFolder(folder, sessions)[0];
}

/**
 * The folder's newest chat that holds only text never sent. A new chat reopens it rather than
 * starting another empty one; `exceptId` (the chat on screen) never counts, so New still gives a blank chat there.
 */
export function unsentDraftForFolder(folder: IAgentHomeFolder, sessions: readonly IAgentSessionMeta[], exceptId?: string): IAgentSessionMeta | undefined {
	return sessionsForFolder(folder, sessions).find(session => session.turnCount === 0 && session.hasDraft && !session.archived && session.id !== exceptId);
}

/**
 * A new chat open in the window that history does not list yet.
 * Nothing has been sent, and there is no saved unsent text, so the row lives
 * only as long as that editor does.
 */
export interface IAgentOpenDraft {
	readonly id: string;
	/** Newest open chat first when several new chats are open. */
	readonly createdAt: number;
	readonly title?: string;
	readonly workspaceId: string;
	readonly workspaceLabel: string;
	readonly workspaceFolder?: string;
	readonly workspaceFolders?: readonly string[];
	/** Set when the new chat is a side chat in another chat's tools. */
	readonly parentId?: string;
}

/**
 * Adds open new chats to the sidebar list. A session history already lists
 * (saved unsent text, or the chat after its first send) keeps that record,
 * so the draft row becomes the real chat instead of sitting beside it.
 */
export function sessionsWithOpenDrafts(sessions: readonly IAgentSessionMeta[], openDrafts: readonly IAgentOpenDraft[]): IAgentSessionMeta[] {
	if (!openDrafts.length) {
		return sessions as IAgentSessionMeta[];
	}
	const listed = new Set(sessions.map(session => session.id));
	const extras: IAgentSessionMeta[] = [];
	for (const draft of openDrafts) {
		if (!draft.id || listed.has(draft.id)) {
			continue;
		}
		listed.add(draft.id);
		const folders = draft.workspaceFolders?.filter(folder => folder.length > 0);
		extras.push({
			id: draft.id,
			title: draft.title?.trim() ?? '',
			createdAt: draft.createdAt,
			updatedAt: draft.createdAt,
			workspaceId: draft.workspaceId,
			workspaceLabel: draft.workspaceLabel,
			workspaceFolder: draft.workspaceFolder || folders?.[0],
			workspaceFolders: folders && folders.length > 1 ? folders : undefined,
			turnCount: 0,
			preview: '',
			status: 'idle',
			parentId: draft.parentId,
		});
	}
	return extras.length ? [...extras, ...sessions] : sessions as IAgentSessionMeta[];
}

/**
 * A new chat with nothing sent and nothing typed. Leaving it throws the row
 * away. Typed text, a mention, or a queued prompt keeps it as a draft.
 */
export function isBlankNewChat(
	chat: { readonly messages: number; readonly draft: string; readonly mentions: number; readonly queued: number },
	saved: { readonly turnCount: number; readonly hasDraft?: boolean } | undefined,
): boolean {
	if (chat.messages > 0 || chat.mentions > 0 || chat.queued > 0 || chat.draft.trim().length > 0) {
		return false;
	}
	if (saved && (saved.turnCount > 0 || saved.hasDraft)) {
		return false;
	}
	return true;
}

export function homeFolderKey(folder: IAgentHomeFolder): string {
	return folder.uri.toString();
}

/** A folder in the form sessions record it: a file system path, or the URI for remote folders. */
export function folderPath(uri: URI): string {
	return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

/**
 * Recents and the current workspace can name the same folder twice after a
 * park-and-switch. One row per URI keeps the sidebar from stacking copies.
 */
export function uniqueHomeFolders(folders: readonly IAgentHomeFolder[]): IAgentHomeFolder[] {
	const byKey = new Map<string, IAgentHomeFolder>();
	for (const folder of folders) {
		const key = homeFolderKey(folder);
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, folder);
			continue;
		}
		if (folder.current && !existing.current) {
			byKey.set(key, { ...existing, current: true, name: folder.name || existing.name });
		}
	}
	return [...byKey.values()];
}

/** Section title for the project groupings. */
export function agentHomeSectionLabel(key: AgentHomeSectionKey): string {
	switch (key) {
		case 'repositories': return localize('voltAgent.home.repositories', "Repositories");
		case 'workspaces': return localize('voltAgent.home.workspaces', "Workspaces");
		case 'agents': return localize('voltAgent.home.agents', "Agents");
		default: {
			const unexpected: never = key;
			return unexpected;
		}
	}
}

export function buildAgentHomeTree(
	folders: readonly IAgentHomeFolder[],
	allSessions: readonly IAgentSessionMeta[],
	view: IAgentHomeViewState,
	options: IAgentHomeTreeOptions = {},
): IAgentHomeNode[] {
	const runGroups = new Map((options.runGroups ?? []).map(group => [group.id, group]));
	const sessions = runGroups.size ? withRunGroupRows(allSessions, [...runGroups.values()]) : allSessions;
	const built = buildHomeTree(folders, sessions, view, options);
	return runGroups.size ? foldRunGroups(built, runGroups) : built;
}

/** The runs leave the list; their group stands in for them. */
function withRunGroupRows(sessions: readonly IAgentSessionMeta[], groups: readonly IAgentHomeRunGroup[]): IAgentSessionMeta[] {
	const members = new Set(groups.flatMap(group => group.members.map(member => member.sessionId)));
	return [...sessions.filter(session => !members.has(session.id)), ...groups.map(group => group.session)];
}

/** Turns each group's stand-in row into the group row with its runs under it (folded until opened). */
function foldRunGroups(nodes: readonly IAgentHomeNode[], groups: ReadonlyMap<string, IAgentHomeRunGroup>): IAgentHomeNode[] {
	return nodes.map(node => {
		const element = node.element;
		if (element.type === 'session') {
			const group = groups.get(element.session.id);
			if (group) {
				return {
					element: { type: 'runGroup', group, folderKey: element.folderKey, nested: element.nested },
					collapsed: true,
					children: group.members.map(member => ({
						element: { type: 'session' as const, session: group.metas.get(member.sessionId) ?? runMemberMeta(group, member), folderKey: element.folderKey, nested: element.nested, sideDepth: 1, runMember: member },
					})),
				};
			}
		}
		return node.children ? { ...node, children: foldRunGroups(node.children, groups) } : node;
	});
}

/** A run whose chat has no history yet (its worktree is still being made). */
function runMemberMeta(group: IAgentHomeRunGroup, member: IAgentHomeRunMember): IAgentSessionMeta {
	return {
		...group.session,
		id: member.sessionId,
		title: member.label,
		turnCount: 0,
		preview: '',
		summary: undefined,
		model: member.label,
		worktreeBranch: member.branch,
		pinned: false,
	};
}

function buildHomeTree(
	folders: readonly IAgentHomeFolder[],
	sessions: readonly IAgentSessionMeta[],
	view: IAgentHomeViewState,
	options: IAgentHomeTreeOptions,
): IAgentHomeNode[] {
	const now = options.now ?? Date.now();
	const unique = uniqueHomeFolders(folders);
	const workspaceFileIds = new Set(unique.flatMap(folder => folder.workspace && folder.workspaceId ? [folder.workspaceId] : []));
	const { roots: visible, sideChats } = splitSideChats(sessions.filter(session => sessionPassesHomeFilters(session, view, workspaceFileIds, options.prTags)));
	const active = visible.filter(session => sessionHomeShelf(session) === 'active');
	const pinned = sortSessionsForHome(active.filter(session => session.pinned), view.chatOrder);
	// Busy chats fold into Working and come back to the inbox when they finish, fail or need the user.
	const working = options.workingShelf
		? sortWorkingSessions(active.filter(session => sessionInWorkingShelf(session, options.live?.get(session.id))))
		: [];
	const folded = new Set(working);
	const unpinned = active.filter(session => !session.pinned && !folded.has(session));
	const filtered = anyHomeFilterActive(view);

	const body: IAgentHomeNode[] = [];
	const flat = isFlatGrouping(view.grouping);
	if (pinned.length) {
		body.push(bucketNode('pinned', localize('voltAgent.home.pinned', "Pinned"), pinned, options.limits, { add: flat }));
	}
	const shelved = (shelf: Exclude<AgentHomeSessionShelf, 'active'>) => sortSessionsForHome(visible.filter(session => sessionHomeShelf(session) === shelf), view.chatOrder);
	// Status grouping lists Settled and Snooze as status headers after Done; elsewhere they fold at the bottom.
	const shelvesAsBuckets = view.grouping === 'status';
	if (flat) {
		body.push(...flatBucketNodes(view.grouping, sortSessionsForHome(unpinned, view.chatOrder), now, options.limits));
		if (shelvesAsBuckets) {
			if (working.length) {
				body.push(bucketNode('working', statusBucketLabel('working'), working, options.limits, { add: true, collapsed: true, count: working.length }));
			}
			for (const shelf of AGENT_HOME_SHELVES) {
				const members = shelved(shelf);
				if (members.length) {
					body.push(bucketNode(shelf, agentHomeGroupLabel(shelf), members, options.limits, { add: true }));
				}
			}
		}
		if (!body.length) {
			// Every chat busy: the header keeps the filter, without "No agents yet" over the Working shelf.
			body.push({
				element: { type: 'section', key: 'agents', filter: true },
				collapsed: false,
				children: working.length ? [] : [{ element: { type: 'empty', key: 'agents', filtered } }],
			});
		} else {
			// The filter control lives on the first header, whichever bucket that is.
			const first = body[0];
			if (first.element.type === 'bucket') {
				body[0] = { ...first, element: { ...first.element, filter: true } };
			}
		}
	} else {
		const key: AgentHomeSectionKey = view.grouping === 'repository' ? 'repositories' : 'workspaces';
		const projects = projectNodes(unique, unpinned, view, workspaceFileIds, options);
		body.push({
			element: { type: 'section', key, filter: true },
			collapsed: false,
			children: projects.length ? projects : [{ element: { type: 'empty', key, filtered } }],
		});
	}

	/* Top nav (New Chat … Customize) lives outside the tree so it can pin while this body scrolls. */
	const tree: IAgentHomeNode[] = [...body];

	if (!shelvesAsBuckets) {
		if (working.length) {
			tree.push({
				element: { type: 'group', id: 'working', count: working.length },
				collapsed: true,
				children: working.map(session => ({ element: { type: 'session' as const, session, folderKey: 'group:working', nested: false } })),
			});
		}
		for (const shelf of AGENT_HOME_SHELVES) {
			const members = shelved(shelf);
			if (members.length) {
				tree.push({
					element: { type: 'group', id: shelf },
					// Snoozed tabs come back on their own, so the countdown stays in view.
					collapsed: shelf !== 'snooze',
					children: members.map(session => ({ element: { type: 'session' as const, session, folderKey: `group:${shelf}`, nested: false } })),
				});
			}
		}
	}

	return sideChats.size ? withSideChats(tree, sideChats) : tree;
}

/**
 * Side chats whose chat is listed too go under that chat instead of in the list. One whose chat
 * is filtered out, archived or gone stays a row of its own.
 */
export function splitSideChats(sessions: readonly IAgentSessionMeta[]): { roots: IAgentSessionMeta[]; sideChats: Map<string, IAgentSessionMeta[]> } {
	const byId = new Map(sessions.map(session => [session.id, session]));
	const listedUnder = (session: IAgentSessionMeta): boolean => {
		// Parents that point at each other would hide every one of them, so a loop lists them all as rows.
		const seen = new Set<string>([session.id]);
		let parentId = session.parentId;
		while (parentId && byId.has(parentId)) {
			if (seen.has(parentId)) {
				return false;
			}
			seen.add(parentId);
			parentId = byId.get(parentId)?.parentId;
		}
		return seen.size > 1;
	};
	const roots: IAgentSessionMeta[] = [];
	const sideChats = new Map<string, IAgentSessionMeta[]>();
	for (const session of sessions) {
		if (session.parentId && listedUnder(session)) {
			const siblings = sideChats.get(session.parentId) ?? [];
			siblings.push(session);
			sideChats.set(session.parentId, siblings);
		} else {
			roots.push(session);
		}
	}
	return { roots, sideChats };
}

/** Puts each chat's side chats right below its row, oldest first, the way they were opened. */
function withSideChats(nodes: readonly IAgentHomeNode[], sideChats: ReadonlyMap<string, readonly IAgentSessionMeta[]>): IAgentHomeNode[] {
	const result: IAgentHomeNode[] = [];
	const appendSideChats = (parent: Extract<AgentHomeElement, { type: 'session' }>, depth: number) => {
		const children = [...sideChats.get(parent.session.id) ?? []].sort((a, b) => a.createdAt - b.createdAt);
		for (const session of children) {
			const element: Extract<AgentHomeElement, { type: 'session' }> = { type: 'session', session, folderKey: parent.folderKey, nested: parent.nested, sideDepth: depth };
			result.push({ element });
			appendSideChats(element, depth + 1);
		}
	};
	for (const node of nodes) {
		if (node.children) {
			result.push({ ...node, children: withSideChats(node.children, sideChats) });
			continue;
		}
		result.push(node);
		if (node.element.type === 'session') {
			appendSideChats(node.element, 1);
		}
	}
	return result;
}

interface IBucketNodeOptions {
	readonly collapsed?: boolean;
	readonly add?: boolean;
	readonly defaultLimit?: number;
	readonly count?: number;
}

function bucketNode(
	id: string,
	label: string,
	sessions: readonly IAgentSessionMeta[],
	limits: ReadonlyMap<string, number> | undefined,
	options: IBucketNodeOptions = {},
): IAgentHomeNode {
	const groupKey = `bucket:${id}`;
	return {
		element: { type: 'bucket', id, label, add: options.add, ...(options.count !== undefined ? { count: options.count } : {}) },
		collapsed: options.collapsed ?? false,
		children: pagedSessionNodes(groupKey, sessions, false, limits, options.defaultLimit),
	};
}

/** Updated buckets past Last 7 Days start folded; Today / Yesterday / Last 7 Days stay open. */
function updatedBucketCollapsed(id: AgentHomeUpdatedBucket): boolean {
	switch (id) {
		case 'today':
		case 'yesterday':
		case 'week':
			return false;
		case 'month':
		case 'older':
			return true;
		default: {
			const unexpected: never = id;
			return unexpected;
		}
	}
}

function flatBucketNodes(
	grouping: AgentHomeGrouping,
	sessions: readonly IAgentSessionMeta[],
	now: number,
	limits: ReadonlyMap<string, number> | undefined,
): IAgentHomeNode[] {
	switch (grouping) {
		case 'updated':
			return orderedBuckets<AgentHomeUpdatedBucket>(UPDATED_BUCKET_ORDER, sessions, session => updatedBucketId(sessionStamp(session), now))
				.map(([id, members]) => bucketNode(id, updatedBucketLabel(id), members, limits, {
					collapsed: updatedBucketCollapsed(id),
					add: true,
					defaultLimit: id === 'week' ? AGENT_HOME_WEEK_LIMIT : undefined,
				}));
		case 'status':
			return orderedBuckets<AgentHomeSessionStatus>(STATUS_BUCKET_ORDER, sessions, sessionPrimaryStatus)
				.map(([id, members]) => bucketNode(id, statusBucketLabel(id), members, limits, { add: true }));
		case 'environment':
			return orderedBuckets<AgentHomeEnvironmentFilter>(['cloud', 'local'], sessions, sessionEnvironmentTag)
				.map(([id, members]) => bucketNode(id, environmentLabel(id), members, limits, { add: true }));
		case 'repository':
		case 'workspace':
			return [];
		default: {
			const unexpected: never = grouping;
			return unexpected;
		}
	}
}

/** Non-empty buckets in their fixed order; input order is kept inside each. */
function orderedBuckets<T extends string>(order: readonly T[], sessions: readonly IAgentSessionMeta[], bucketOf: (session: IAgentSessionMeta) => T): [T, IAgentSessionMeta[]][] {
	const buckets = new Map<T, IAgentSessionMeta[]>();
	for (const session of sessions) {
		const id = bucketOf(session);
		const members = buckets.get(id) ?? [];
		members.push(session);
		buckets.set(id, members);
	}
	return order.filter(id => buckets.has(id)).map(id => [id, buckets.get(id)!]);
}

function pagedSessionNodes(
	groupKey: string,
	sessions: readonly IAgentSessionMeta[],
	nested: boolean,
	limits: ReadonlyMap<string, number> | undefined,
	defaultLimit: number = AGENT_HOME_GROUP_LIMIT,
): IAgentHomeNode[] {
	const max = limits?.get(groupKey) ?? defaultLimit;
	const shown = sessions.slice(0, max);
	const nodes: IAgentHomeNode[] = shown.map(session => ({ element: { type: 'session' as const, session, folderKey: groupKey, nested } }));
	if (sessions.length > shown.length) {
		nodes.push({ element: { type: 'more', groupKey, hidden: sessions.length - shown.length, nested } });
	}
	return nodes;
}

interface IProjectDraft {
	readonly key: string;
	readonly label: string;
	readonly multi: boolean;
	folder?: IAgentHomeFolder;
	current: boolean;
	/** Position of the project's first registered folder, for Manual order. */
	rank: number;
	readonly sessions: IAgentSessionMeta[];
}

interface IProjectIdentity {
	readonly key: string;
	readonly label: string;
	readonly multi: boolean;
	readonly folder?: IAgentHomeFolder;
}

/**
 * Repository and Workspace rows. A multi-folder agent tab gets one row for
 * its whole set of folders. Repository grouping also merges clones and
 * worktrees of one repository, using the folders' git remotes.
 */
function projectNodes(
	folders: readonly IAgentHomeFolder[],
	sessions: readonly IAgentSessionMeta[],
	view: IAgentHomeViewState,
	workspaceFileIds: ReadonlySet<string>,
	options: IAgentHomeTreeOptions,
): IAgentHomeNode[] {
	const kind = view.grouping === 'repository' ? 'repository' : 'workspace';
	const repos = options.repos ?? new Map<string, IAgentRepoInfo>();
	const selfOwner = dominantRepoOwner(repos.values());
	const identify = (paths: readonly string[], fallback: IAgentHomeFolder | undefined): IProjectIdentity | undefined => {
		if (!paths.length) {
			return fallback ? { key: homeFolderKey(fallback), label: fallback.name, multi: false, folder: fallback } : undefined;
		}
		const parts = paths.map(path => {
			const folder = knownFolder(folders, path) ?? syntheticFolder(path);
			const repo = kind === 'repository' ? repos.get(path) : undefined;
			return {
				key: repo ? `repo:${repo.id}` : homeFolderKey(folder),
				label: repo ? repoDisplayName(repo, selfOwner) : folder.name,
				folder,
			};
		});
		const distinct = [...new Map(parts.map(part => [part.key, part])).values()];
		if (distinct.length === 1) {
			return { key: distinct[0].key, label: distinct[0].label, multi: false, folder: distinct[0].folder };
		}
		return {
			key: `multi:${distinct.map(part => part.key).sort().join('|')}`,
			label: distinct.map(part => part.label).join(', '),
			multi: true,
		};
	};

	const drafts = new Map<string, IProjectDraft>();
	const draftFor = (identity: IProjectIdentity): IProjectDraft => {
		let draft = drafts.get(identity.key);
		if (!draft) {
			draft = { ...identity, current: false, rank: Number.MAX_SAFE_INTEGER, sessions: [] };
			drafts.set(identity.key, draft);
		}
		return draft;
	};

	for (const session of sessions) {
		const workspaceFile = workspaceFileIds.has(session.workspaceId)
			? folders.find(folder => folder.workspace && folder.workspaceId === session.workspaceId)
			: undefined;
		// Chats without a project share one group; each has a scratch folder no one picks as a project.
		if (isScratchSession(session)) {
			draftFor({ key: 'scratch', label: scratchProjectLabel(), multi: false }).sessions.push(session);
			continue;
		}
		const identity = workspaceFile && kind === 'workspace'
			? { key: homeFolderKey(workspaceFile), label: workspaceFile.name, multi: true, folder: workspaceFile }
			: identify(sessionFolders(session), folders.find(folder => !folder.workspace && folder.name === session.workspaceLabel)) ?? {
				key: `label:${session.workspaceLabel}`,
				label: session.workspaceLabel || localize('voltAgent.home.noFolder', "No Folder"),
				multi: false,
			};
		draftFor(identity).sessions.push(session);
	}

	// Registered folders give Manual order, and the open project always has a row.
	folders.forEach((folder, index) => {
		if (!view.source.has(folderSourceTag(folder))) {
			return;
		}
		const identity = folder.workspace
			? { key: homeFolderKey(folder), label: folder.name, multi: true, folder }
			: identify([folderPath(folder.uri)], folder);
		if (!identity) {
			return;
		}
		const existing = drafts.get(identity.key);
		if (!existing && !folder.current) {
			return;
		}
		const draft = existing ?? draftFor(identity);
		draft.rank = Math.min(draft.rank, index);
		draft.current = draft.current || folder.current;
		// New chats land in the open folder, else a registered one rather than a clone only a session named.
		if (!draft.multi && (folder.current || !draft.folder || !folders.includes(draft.folder))) {
			draft.folder = folder;
		}
	});

	const ordered = [...drafts.values()].map(draft => ({ draft, latest: draft.sessions.reduce((max, session) => Math.max(max, sessionStamp(session)), 0) }));
	switch (view.groupOrder) {
		case 'updated':
			ordered.sort((a, b) => b.latest - a.latest || a.draft.rank - b.draft.rank);
			break;
		case 'manual':
			ordered.sort((a, b) => a.draft.rank - b.draft.rank || b.latest - a.latest);
			break;
		default: {
			const unexpected: never = view.groupOrder;
			return unexpected;
		}
	}

	return ordered.map(({ draft }) => {
		const project: IAgentHomeProject = {
			key: draft.key,
			label: draft.label,
			kind,
			multi: draft.multi,
			folder: draft.folder,
			current: draft.current,
		};
		const children = pagedSessionNodes(`folder:${draft.key}`, sortSessionsForHome(draft.sessions, view.chatOrder), true, options.limits);
		return {
			element: { type: 'folder' as const, project },
			collapsed: !project.current,
			children: children.length ? children : undefined,
		};
	});
}

function knownFolder(folders: readonly IAgentHomeFolder[], path: string): IAgentHomeFolder | undefined {
	return folders.find(folder => !folder.workspace && (folderPath(folder.uri) === path || folder.uri.toString() === path));
}

/** A session can name a folder the sidebar does not list (not registered, dropped from recents). */
function syntheticFolder(path: string): IAgentHomeFolder {
	const uri = uriFromStoredRoot(path);
	return { uri, name: basename(uri) || path, current: false, workspace: false };
}

function sessionMatchesFolder(session: IAgentSessionMeta, folderUri: string, folderPathValue: string, name: string): boolean {
	if (session.workspaceFolder && (session.workspaceFolder === folderPathValue || session.workspaceFolder === folderUri)) {
		return true;
	}
	return !session.workspaceFolder && session.workspaceLabel === name;
}

/** What the session row shows after its title, per the Show menu. */
export interface IAgentHomeSessionContext {
	/** Project the session belongs to: repository or folder name. */
	readonly workspace?: string;
	readonly branch?: string;
}

export function sessionMetaParts(session: IAgentSessionMeta, context: IAgentHomeSessionContext, view: IAgentHomeViewState, now: number): string[] {
	const parts: string[] = [];
	if (view.show.has('workspace') && context.workspace) {
		parts.push(context.workspace);
	}
	if (view.show.has('branch') && context.branch) {
		parts.push(context.branch);
	}
	const environment = sessionEnvironmentTag(session);
	if (view.show.has('machine')) {
		parts.push(environmentLabel(environment));
	}
	// Local is the default; only an agent running elsewhere is called out.
	if (view.show.has('environment') && environment !== 'local' && !view.show.has('machine')) {
		parts.push(environmentLabel(environment));
	}
	// PR metadata is not recorded yet, so there is never a PR to show.
	// A snoozed tab counts down to its return instead of up from its last change.
	if (session.snoozed) {
		if (session.snoozedUntil !== undefined) {
			parts.push(compactCountdown(session.snoozedUntil - now));
		}
		return parts;
	}
	// Nothing sent yet: the age slot says Draft, unless the badge already does. The first message drops it for the usual age.
	if (session.turnCount === 0) {
		if (!sessionShowsStatusBadge(session, view)) {
			parts.push(localize('voltAgent.home.draft', "Draft"));
		}
	} else if (view.show.has('updated')) {
		parts.push(compactSessionAge(sessionStamp(session), now));
	}
	return parts;
}

/** Agent tabs take two lines while the Show menu puts anything on the second (branch, PR, model). */
export function isTwoLineView(view: IAgentHomeViewState): boolean {
	return view.show.has('branch') || view.show.has('pr') || view.show.has('model');
}

export interface IAgentHomeSecondLine {
	/** The chat's branch: its worktree's, else the checkout's. */
	readonly branch?: string;
	/** Where it lives when there is no branch to show (a folder outside git). */
	readonly place?: string;
	readonly model?: string;
}

/**
 * The second line of an agent tab: the branch on the left (the PR badge follows it), the model it
 * last ran on at the right. A chat with no branch names its project instead, so the line still
 * says where the chat works.
 */
export function sessionSecondLine(session: IAgentSessionMeta, context: IAgentHomeSessionContext, view: IAgentHomeViewState, modelLabel?: string): IAgentHomeSecondLine {
	const branch = view.show.has('branch') ? (session.worktreeBranch || context.branch) : undefined;
	const model = view.show.has('model') ? (modelLabel || session.model) : undefined;
	return {
		...(branch ? { branch } : {}),
		...(!branch && context.workspace ? { place: context.workspace } : {}),
		...(model ? { model } : {}),
	};
}

export function agentHomeGroupLabel(id: AgentHomeGroupId): string {
	switch (id) {
		case 'working':
			return localize('voltAgent.home.working', "Working");
		case 'settled':
			return localize('voltAgent.home.settled', "Settled");
		case 'snooze':
			return localize('voltAgent.home.snoozed', "Snoozed");
		default: {
			const unexpected: never = id;
			return unexpected;
		}
	}
}

/**
 * What the row's + control starts: a folder/project for repository/workspace
 * rows, or an empty (no-project) chat for flat group headers.
 */
export function agentHomeAddStart(element: AgentHomeElement):
	| { readonly kind: 'folder'; readonly root: URI; readonly name: string }
	| { readonly kind: 'none' }
	| undefined {
	switch (element.type) {
		case 'folder': {
			const folder = element.project.folder;
			if (!folder || folder.workspace) {
				return undefined;
			}
			return { kind: 'folder', root: folder.uri, name: folder.name };
		}
		case 'bucket':
			return element.add ? { kind: 'none' } : undefined;
		case 'newChat':
		case 'action':
		case 'section':
		case 'group':
		case 'session':
		case 'runGroup':
		case 'more':
		case 'empty':
			return undefined;
		default: {
			const unexpected: never = element;
			return unexpected;
		}
	}
}

export type AgentHomeStatusBadgeKind = 'input' | 'working' | 'woke' | 'done' | 'draft' | 'limited' | 'failed' | 'interrupted';

export interface IAgentHomeStatusBadge {
	readonly kind: AgentHomeStatusBadgeKind;
	readonly label: string;
}

/** Active tabs carry a status badge after their age; Settled and Snoozed tabs do not. */
export function sessionShowsStatusBadge(session: IAgentSessionMeta, view: IAgentHomeViewState): boolean {
	return view.show.has('status') && sessionHomeShelf(session) === 'active';
}

/**
 * The badge after an agent tab's age: "Input", "Working 2m", "Waiting", "Woke", "Done", "Draft", "Limited", "Failed".
 * Stopped and idle tabs have none. `live` is the orchestrator's view (see {@link agentHomeLiveWork}).
 */
export function sessionStatusBadge(session: IAgentSessionMeta, now: number, live?: AgentHomeWorkState): IAgentHomeStatusBadge | undefined {
	switch (session.attention) {
		case 'approval':
		case 'question':
			return { kind: 'input', label: localize('voltAgent.home.badge.input', "Input") };
		case undefined: break;
		default: {
			const unexpected: never = session.attention;
			return unexpected;
		}
	}
	if (session.status !== 'running') {
		// History has not caught up with a turn that is starting, or the chat waits on its subagents.
		switch (sessionWorkState(session, live)) {
			case 'working': return { kind: 'working', label: localize('voltAgent.home.badge.working', "Working") };
			case 'delegating': return { kind: 'working', label: localize('voltAgent.home.badge.waiting', "Waiting") };
			case undefined: break;
		}
	}
	// Back from a timed snooze and not opened yet. A run that started since says Working instead.
	if (session.wokeAt !== undefined && session.status !== 'running') {
		return { kind: 'woke', label: localize('voltAgent.home.badge.woke', "Woke") };
	}
	switch (session.status) {
		case 'running':
			return {
				kind: 'working',
				label: session.lastPromptAt
					? localize('voltAgent.home.badge.workingFor', "Working {0}", compactDuration(now - session.lastPromptAt))
					: localize('voltAgent.home.badge.working', "Working"),
			};
		case 'error':
			return isUsageLimitText(session.summary)
				? { kind: 'limited', label: localize('voltAgent.home.badge.limited', "Limited") }
				: { kind: 'failed', label: localize('voltAgent.home.badge.failed', "Failed") };
		case 'interrupted':
			return { kind: 'interrupted', label: localize('voltAgent.home.badge.interrupted', "Interrupted") };
		case 'done':
			return { kind: 'done', label: localize('voltAgent.home.badge.done', "Done") };
		case 'idle':
			return session.turnCount === 0 ? { kind: 'draft', label: localize('voltAgent.home.badge.draft', "Draft") } : undefined;
		case 'cancelled':
			return undefined;
		default: {
			const unexpected: never = session.status;
			return unexpected;
		}
	}
}

export type AgentSnoozePresetId = 'hour' | 'threeHours' | 'evening' | 'tomorrow';

export interface IAgentSnoozePreset {
	readonly id: AgentSnoozePresetId;
	readonly label: string;
	/** When the tab comes back, ms since epoch. */
	readonly until: number;
}

/** Hour this evening starts; "This evening" is offered until an hour before it. */
const SNOOZE_EVENING_HOUR = 18;
const SNOOZE_MORNING_HOUR = 9;

/** The snooze menu's quick picks, in local time. */
export function agentSnoozePresets(now: number): IAgentSnoozePreset[] {
	const hour = 3_600_000;
	const presets: IAgentSnoozePreset[] = [
		{ id: 'hour', label: localize('voltAgent.snooze.hour', "In 1 hour"), until: now + hour },
		{ id: 'threeHours', label: localize('voltAgent.snooze.threeHours', "In 3 hours"), until: now + 3 * hour },
	];
	const evening = new Date(now);
	evening.setHours(SNOOZE_EVENING_HOUR, 0, 0, 0);
	if (evening.getTime() - now >= hour) {
		presets.push({ id: 'evening', label: localize('voltAgent.snooze.evening', "This evening"), until: evening.getTime() });
	}
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	tomorrow.setHours(SNOOZE_MORNING_HOUR, 0, 0, 0);
	presets.push({ id: 'tomorrow', label: localize('voltAgent.snooze.tomorrow', "Tomorrow"), until: tomorrow.getTime() });
	return presets;
}

export type AgentSnoozeUnit = 'minutes' | 'hours' | 'days' | 'weeks';

export const AGENT_SNOOZE_UNITS: readonly AgentSnoozeUnit[] = ['minutes', 'hours', 'days', 'weeks'];

const SNOOZE_UNIT: Record<AgentSnoozeUnit, 'minute' | 'hour' | 'day' | 'week'> = {
	minutes: 'minute',
	hours: 'hour',
	days: 'day',
	weeks: 'week',
};

/**
 * End of a "Snooze for N units" pick; undefined unless N is a whole number from 1 up. Days and weeks
 * are calendar days, so "1 day" at 9:00 comes back at 9:00 across a DST change.
 */
export function agentSnoozeAfter(now: number, amount: number, unit: AgentSnoozeUnit): number | undefined {
	return Number.isInteger(amount) && amount > 0 ? dayjs(now).add(amount, SNOOZE_UNIT[unit]).valueOf() : undefined;
}

/** End of a "Date and time" pick: `minutes` after midnight on `day`, local time. Undefined once that moment has passed. */
export function agentSnoozeAt(now: number, day: number, minutes: number): number | undefined {
	if (!Number.isFinite(day) || !Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) {
		return undefined;
	}
	const at = combineDayAndTime(day, minutes);
	return at > now ? at : undefined;
}
