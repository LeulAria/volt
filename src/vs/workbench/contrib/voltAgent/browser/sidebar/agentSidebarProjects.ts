/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { sessionFolders, sessionPrimaryStatus } from '../home/agentHomeFilter.js';
import { folderPath } from '../home/agentHomeModel.js';
import { IAgentThreadAttentionService } from '../attention/agentThreadAttention.js';

/** A project as the rail and the sidebar decorations see it. */
export interface IAgentSidebarProject {
	readonly root: URI;
	readonly name: string;
	readonly current: boolean;
	/** Chats in it that finished while you were not looking. */
	readonly unread: number;
	/** A chat in it waits for an approval, an answer, or failed. */
	readonly attention: boolean;
	readonly working: boolean;
	/** Its most recently updated chat. */
	readonly latest?: IAgentSessionMeta;
}

/**
 * Projects in the order the user added them, each with its chats' state. A chat belongs to the
 * project holding its first folder; subagent chats are never counted (they are not listed).
 */
export function collectSidebarProjects(
	sessionContext: IVoltSessionContextService,
	history: IAgentHistoryService,
	attention: IAgentThreadAttentionService | undefined,
): IAgentSidebarProject[] {
	const active = sessionContext.activeProject?.root.toString();
	const byPath = new Map<string, IAgentSessionMeta[]>();
	for (const session of history.list()) {
		if (session.subagent) {
			continue;
		}
		const primary = sessionFolders(session)[0];
		if (!primary) {
			continue;
		}
		const list = byPath.get(primary) ?? [];
		list.push(session);
		byPath.set(primary, list);
	}
	const seen = new Set<string>();
	const projects: IAgentSidebarProject[] = [];
	for (const project of sessionContext.projects) {
		const key = project.root.toString();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		const sessions = byPath.get(folderPath(project.root)) ?? [];
		let unread = 0;
		let attentionNeeded = false;
		let working = false;
		let latest: IAgentSessionMeta | undefined;
		for (const session of sessions) {
			if (!session.archived && (session.unread || attention?.isUnread(session.id))) {
				unread++;
			}
			const status = sessionPrimaryStatus(session);
			attentionNeeded ||= !session.archived && status === 'needsAttention';
			working ||= status === 'working';
			if (!session.archived && (!latest || session.updatedAt > latest.updatedAt)) {
				latest = session;
			}
		}
		projects.push({
			root: project.root,
			name: project.displayName || basename(project.root),
			current: key === active,
			unread,
			attention: attentionNeeded,
			working,
			...(latest ? { latest } : {}),
		});
	}
	return projects;
}

/**
 * The project a sidebar project row names. Rows show the repository's name (`owner/name` when the
 * owner is not yours) or the folder's, so the row's label is matched against both.
 */
export function projectForLabel(projects: readonly IAgentSidebarProject[], label: string): IAgentSidebarProject | undefined {
	const text = label.split(' · ')[0].trim().toLowerCase();
	if (!text) {
		return undefined;
	}
	const tail = text.split('/').at(-1) ?? text;
	return projects.find(project => project.name.toLowerCase() === text)
		?? projects.find(project => basename(project.root).toLowerCase() === text)
		?? projects.find(project => basename(project.root).toLowerCase() === tail || project.name.toLowerCase() === tail);
}
