/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../../base/common/hash.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

/**
 * A registered project. The id is derived from the canonical root so the same
 * folder is never two projects, and it is not the native workbench workspace.
 */
export interface IVoltProjectRecord {
	readonly id: string;
	readonly root: URI;
	readonly displayName: string;
	/** `file` for local folders. Remote authorities stay on the URI. */
	readonly authority: string;
	/**
	 * The folder Volt made for a chat started without a project. Chats run in it like any
	 * project, but it is never listed, selected or offered as one.
	 */
	readonly scratch?: boolean;
}

/** Execution binding for one agent session. The root does not follow the visible chat. */
export interface IVoltSessionBinding {
	readonly sessionId: string;
	readonly projectId: string;
	readonly root: URI;
	readonly authority: string;
}

export const IVoltSessionContextService = createDecorator<IVoltSessionContextService>('voltSessionContextService');

export interface IVoltSessionContextService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeProjects: Event<void>;
	readonly onDidChangeActiveProject: Event<string | undefined>;

	/** Registered projects, without scratch folders. */
	readonly projects: readonly IVoltProjectRecord[];
	readonly activeProject: IVoltProjectRecord | undefined;

	/** Any record, scratch folders included. */
	getProject(id: string): IVoltProjectRecord | undefined;
	/** Register the folder immediately. Does not open a workbench. A known scratch folder stays scratch. */
	registerProject(root: URI, displayName?: string): IVoltProjectRecord;
	/** Records a chat's scratch folder (see {@link IVoltProjectRecord.scratch}) so a session can bind to it. */
	registerScratchProject(root: URI, displayName: string): IVoltProjectRecord;
	/** Forgets a project (a cancelled clone). Chats bound to it keep their saved folder. */
	unregisterProject(id: string): void;
	selectProject(id: string | undefined): void;
	bindingFor(sessionId: string): IVoltSessionBinding | undefined;
	/**
	 * Bind a session that does not already belong to a project.
	 * An existing binding is left as-is so a visible project cannot steal a run.
	 */
	bindSession(sessionId: string, projectId: string): IVoltSessionBinding | undefined;
	/**
	 * Move a chat that has never sent a prompt to the project its composer shows.
	 * Only for unstarted chats: a chat that ran keeps its project for good.
	 */
	rebindUnstartedSession(sessionId: string, projectId: string): IVoltSessionBinding | undefined;
	rootFor(sessionId: string): URI | undefined;
}

export function canonicalProjectRoot(root: URI): URI {
	if (root.scheme !== 'file') {
		return root.with({ query: '', fragment: '' });
	}
	let path = root.path;
	if (path.length > 1 && path.endsWith('/')) {
		path = path.slice(0, -1);
	}
	return root.with({ path, query: '', fragment: '' });
}

export function projectIdForRoot(root: URI): string {
	return `project-${hash(canonicalProjectRoot(root).toString()).toString(36)}`;
}

export function projectAuthority(root: URI): string {
	return root.authority || 'file';
}

export function projectDisplayName(root: URI, displayName?: string): string {
	const name = displayName?.trim();
	return name || basename(canonicalProjectRoot(root)) || root.path;
}

export function uriFromStoredRoot(value: string): URI {
	return value.includes('://') ? URI.parse(value) : URI.file(value);
}

/** A session belongs to a project only through its saved folder, never the folder that happens to be visible. */
export function sessionBelongsToProject(
	session: { readonly workspaceFolder?: string; readonly workspaceLabel: string },
	project: { readonly root: URI; readonly displayName: string },
): boolean {
	const root = canonicalProjectRoot(project.root);
	const folder = session.workspaceFolder;
	if (folder && (folder === root.fsPath || folder === root.toString() || folder === project.root.toString())) {
		return true;
	}
	return !folder && session.workspaceLabel === project.displayName;
}
