/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import {
	AgentHomeEnvironmentFilter,
	AgentHomeGrouping,
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
export type AgentHomeGroupId = 'settled' | 'snooze';
export type AgentHomeActionId = 'search' | 'automations' | 'customize';

export type AgentHomeElement =
	| { readonly type: 'newChat' }
	| { readonly type: 'action'; readonly id: AgentHomeActionId }
	| { readonly type: 'section'; readonly key: AgentHomeSectionKey; readonly add?: boolean; readonly filter?: boolean }
	| { readonly type: 'folder'; readonly project: IAgentHomeProject }
	| { readonly type: 'bucket'; readonly id: string; readonly label: string; readonly filter?: boolean; readonly add?: boolean }
	| { readonly type: 'group'; readonly id: AgentHomeGroupId }
	/** `nested` sessions sit under their project; the others list the project by its initials. */
	| { readonly type: 'session'; readonly session: IAgentSessionMeta; readonly folderKey: string; readonly nested: boolean }
	| { readonly type: 'more'; readonly groupKey: string; readonly hidden: number; readonly nested: boolean }
	| { readonly type: 'empty'; readonly key: string; readonly filtered: boolean };

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
}

/** Agent tabs shown in a group before a "Show more" row. */
export const AGENT_HOME_GROUP_LIMIT = 10;
/** Initial tabs in the Updated "Last 7 Days" bucket before Show more. */
export const AGENT_HOME_WEEK_LIMIT = 7;
/** Sentinel limit after Show more: reveal every remaining tab in that group. */
export const AGENT_HOME_GROUP_EXPAND_ALL = Number.MAX_SAFE_INTEGER;

export type AgentHomeSessionShelf = 'active' | 'settled' | 'snooze';

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
	const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
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
	sessions: readonly IAgentSessionMeta[],
	view: IAgentHomeViewState,
	options: IAgentHomeTreeOptions = {},
): IAgentHomeNode[] {
	const now = options.now ?? Date.now();
	const unique = uniqueHomeFolders(folders);
	const workspaceFileIds = new Set(unique.flatMap(folder => folder.workspace && folder.workspaceId ? [folder.workspaceId] : []));
	const visible = sessions.filter(session => sessionPassesHomeFilters(session, view, workspaceFileIds));
	const active = visible.filter(session => sessionHomeShelf(session) === 'active');
	const pinned = sortSessionsForHome(active.filter(session => session.pinned), view.chatOrder);
	const unpinned = active.filter(session => !session.pinned);
	const filtered = anyHomeFilterActive(view);

	const body: IAgentHomeNode[] = [];
	const flat = isFlatGrouping(view.grouping);
	if (pinned.length) {
		body.push(bucketNode('pinned', localize('voltAgent.home.pinned', "Pinned"), pinned, options.limits, { add: flat }));
	}
	if (flat) {
		body.push(...flatBucketNodes(view.grouping, sortSessionsForHome(unpinned, view.chatOrder), now, options.limits));
		if (!body.length) {
			body.push({
				element: { type: 'section', key: 'agents', filter: true },
				collapsed: false,
				children: [{ element: { type: 'empty', key: 'agents', filtered } }],
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

	for (const shelf of ['settled', 'snooze'] as const) {
		const shelved = sortSessionsForHome(visible.filter(session => sessionHomeShelf(session) === shelf), view.chatOrder);
		if (shelved.length) {
			tree.push({
				element: { type: 'group', id: shelf },
				collapsed: true,
				children: shelved.map(session => ({ element: { type: 'session' as const, session, folderKey: `group:${shelf}`, nested: false } })),
			});
		}
	}

	return tree;
}

interface IBucketNodeOptions {
	readonly collapsed?: boolean;
	readonly add?: boolean;
	readonly defaultLimit?: number;
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
		element: { type: 'bucket', id, label, add: options.add },
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
	if (view.show.has('updated')) {
		parts.push(compactSessionAge(sessionStamp(session), now));
	}
	return parts;
}

export function agentHomeGroupLabel(id: AgentHomeGroupId): string {
	switch (id) {
		case 'settled':
			return localize('voltAgent.home.settled', "Settled");
		case 'snooze':
			return localize('voltAgent.home.snooze', "Snooze");
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
		case 'more':
		case 'empty':
			return undefined;
		default: {
			const unexpected: never = element;
			return unexpected;
		}
	}
}
