/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltProjectRecord, IVoltSessionContextService, sessionBelongsToProject, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { workspaceForProject } from '../../../../services/voltRuntime/browser/sessionContextService.js';
import { IAgentProjectBinding, IAgentWorkspaceService } from './agentWorkspace.js';

/**
 * Where a session's project comes from.
 * A saved folder always wins. A new foreground chat uses the selected project.
 * An existing chat with no folder is not attached to whichever project is visible.
 */
export type SessionProjectMatch =
	| { readonly kind: 'folder'; readonly folder: string; readonly label: string }
	| { readonly kind: 'active' }
	| { readonly kind: 'none' };

/**
 * How a new agent chat picks its project. Kept in one place with send/chip gating.
 * - `folder`: bind that repo/workspace (folder-row +).
 * - `active`: use the last-used / selected project when one exists (New Chat).
 * - `none`: open with no project; Send and Enter stay off until one is chosen.
 */
export type AgentChatStart =
	| { readonly kind: 'folder'; readonly root: URI; readonly name: string }
	| { readonly kind: 'active' }
	| { readonly kind: 'none' };

/** True when this session already has a project binding or a saved workspace folder. */
export function agentSessionHasProject(
	sessionContext: IVoltSessionContextService,
	sessionId: string,
	session?: { readonly workspaceFolder?: string } | undefined,
): boolean {
	if (sessionContext.bindingFor(sessionId)) {
		return true;
	}
	return !!session?.workspaceFolder;
}

/** New chats without a project cannot send until one is selected. */
export function agentComposerCanSend(
	sessionContext: IVoltSessionContextService,
	sessionId: string,
	session?: { readonly workspaceFolder?: string } | undefined,
): boolean {
	return agentSessionHasProject(sessionContext, sessionId, session);
}

/** A hydration result applies only while its selection is still the latest one. */
export function isCurrentActivation(generation: number, current: number): boolean {
	return generation === current;
}

export function matchSessionProject(
	session: { readonly workspaceFolder?: string; readonly workspaceLabel: string } | undefined,
	foreground: boolean,
): SessionProjectMatch {
	if (session?.workspaceFolder) {
		return { kind: 'folder', folder: session.workspaceFolder, label: session.workspaceLabel };
	}
	if (!session && foreground) {
		return { kind: 'active' };
	}
	return { kind: 'none' };
}

export function projectForFolder(projects: readonly IVoltProjectRecord[], folder: string, label: string): IVoltProjectRecord | undefined {
	return projects.find(project => sessionBelongsToProject({ workspaceFolder: folder, workspaceLabel: label }, project));
}

export function bindingFromProject(project: IVoltProjectRecord): IAgentProjectBinding {
	return {
		projectId: project.id,
		root: project.root.toString(),
		authority: project.authority,
	};
}

export function attachSessionToProject(
	sessionContext: IVoltSessionContextService,
	workspace: IAgentWorkspaceService,
	history: IAgentHistoryService,
	sessionId: string,
	project: IVoltProjectRecord,
): void {
	const existing = sessionContext.bindingFor(sessionId);
	const bound = existing ?? sessionContext.bindSession(sessionId, project.id);
	const target = bound ? sessionContext.getProject(bound.projectId) ?? project : project;
	if (!existing) {
		history.pinSessionWorkspace(sessionId, workspaceForProject(target));
	}
	workspace.bindProject(sessionId, bindingFromProject(target));
}

/**
 * A chat that has not sent anything runs where its composer says. A chat restored from
 * before the window switched projects would otherwise run in the old folder.
 */
export function adoptProjectForUnstartedSession(
	sessionContext: IVoltSessionContextService,
	workspace: IAgentWorkspaceService,
	history: IAgentHistoryService,
	sessionId: string,
	project: IVoltProjectRecord,
): void {
	if (sessionContext.bindingFor(sessionId)?.projectId === project.id) {
		return;
	}
	if (!sessionContext.rebindUnstartedSession(sessionId, project.id)) {
		return;
	}
	history.pinSessionWorkspace(sessionId, workspaceForProject(project));
	workspace.bindProject(sessionId, bindingFromProject(project));
}

export function resolveSessionProject(
	sessionContext: IVoltSessionContextService,
	session: { readonly workspaceFolder?: string; readonly workspaceLabel: string } | undefined,
	foreground: boolean,
): IVoltProjectRecord | undefined {
	const match = matchSessionProject(session, foreground);
	switch (match.kind) {
		case 'folder': {
			const existing = projectForFolder(sessionContext.projects, match.folder, match.label);
			if (existing) {
				return existing;
			}
			try {
				return sessionContext.registerProject(uriFromStoredRoot(match.folder), match.label);
			} catch {
				return undefined;
			}
		}
		case 'active':
			return sessionContext.activeProject;
		case 'none':
			return undefined;
		default: {
			const unknown: never = match;
			return unknown;
		}
	}
}
