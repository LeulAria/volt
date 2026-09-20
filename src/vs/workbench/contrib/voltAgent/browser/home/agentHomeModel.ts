/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';

export interface IAgentHomeFolder {
	readonly uri: URI;
	readonly name: string;
	readonly current: boolean;
	readonly workspace: boolean;
}

export type AgentHomeElement =
	| { readonly type: 'newChat' }
	| { readonly type: 'action'; readonly id: string }
	| { readonly type: 'section'; readonly key: 'projects' | 'workspaces'; readonly add?: boolean }
	| { readonly type: 'folder'; readonly folder: IAgentHomeFolder }
	| { readonly type: 'session'; readonly session: IAgentSessionMeta; readonly folderKey: string };

export interface IAgentHomeNode {
	readonly element: AgentHomeElement;
	readonly children?: readonly IAgentHomeNode[];
	readonly collapsed?: boolean;
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

export function shouldShowAgentEditorTabs(openEditors: number): boolean {
	return openEditors > 1;
}

export function sessionsForFolder(folder: IAgentHomeFolder, sessions: readonly IAgentSessionMeta[]): IAgentSessionMeta[] {
	const folderUri = folder.uri.toString();
	const folderPath = folder.uri.fsPath;
	return sessions
		.filter(session => !session.archived && sessionMatchesFolder(session, folderUri, folderPath, folder.name))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function latestSessionForFolder(folder: IAgentHomeFolder, sessions: readonly IAgentSessionMeta[]): IAgentSessionMeta | undefined {
	return sessionsForFolder(folder, sessions)[0];
}

export function homeFolderKey(folder: IAgentHomeFolder): string {
	return folder.uri.toString();
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

export function buildAgentHomeTree(
	projects: readonly IAgentHomeFolder[],
	workspaces: readonly IAgentHomeFolder[],
	sessions: readonly IAgentSessionMeta[],
): IAgentHomeNode[] {
	return [
		{ element: { type: 'newChat' } },
		{ element: { type: 'action', id: 'search' } },
		{ element: { type: 'action', id: 'automations' } },
		{ element: { type: 'action', id: 'customize' } },
		{
			element: { type: 'section', key: 'projects', add: true },
			collapsed: false,
			children: [
				{ element: { type: 'action', id: 'newProject' } },
				...uniqueHomeFolders(projects).map(folder => folderNode(folder, sessions)),
			],
		},
		{
			element: { type: 'section', key: 'workspaces' },
			collapsed: false,
			children: uniqueHomeFolders(workspaces).map(folder => folderNode(folder, sessions)),
		},
	];
}

function folderNode(folder: IAgentHomeFolder, sessions: readonly IAgentSessionMeta[]): IAgentHomeNode {
	const folderKey = homeFolderKey(folder);
	const children = sessionsForFolder(folder, sessions).map(session => ({
		element: { type: 'session' as const, session, folderKey },
	}));
	return {
		element: { type: 'folder', folder },
		collapsed: !folder.current,
		children: children.length ? children : undefined,
	};
}

function sessionMatchesFolder(session: IAgentSessionMeta, folderUri: string, folderPath: string, name: string): boolean {
	if (session.workspaceFolder && (session.workspaceFolder === folderPath || session.workspaceFolder === folderUri)) {
		return true;
	}
	return !session.workspaceFolder && session.workspaceLabel === name;
}
