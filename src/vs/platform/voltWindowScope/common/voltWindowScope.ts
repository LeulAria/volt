/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * A window opened with New Window while a main window is open gets a scope of its own: its chats,
 * its projects and its Agent/IDE mode stay in it. When it closes the scope ends, and everything it
 * owned shows in the main window. Scopes live in the main process only, so quitting Volt ends them all.
 */
export const IVoltWindowScopesService = createDecorator<IVoltWindowScopesService>('voltWindowScopesService');
export const VOLT_WINDOW_SCOPES_CHANNEL_NAME = 'voltWindowScopes';

/** Keep the next New Window loaded out of sight, so New Window and Open in New Window show at once. */
export const KEEP_NEXT_WINDOW_READY_SETTING = 'volt.window.keepNextWindowReady';

export type VoltWindowLayoutMode = 'agent' | 'ide';

/** What one scoped window owns while it is open. */
export interface IVoltWindowScopeState {
	/** Chats started in the window. Only that window lists them. */
	readonly sessions: readonly string[];
	/** Projects the window lists: the ones added, picked or chatted in there. */
	readonly projects: readonly string[];
	/** Projects that were new when the window added them. Other windows leave them out until it closes. */
	readonly createdProjects: readonly string[];
	readonly layoutMode?: VoltWindowLayoutMode;
}

/** Every open scope, by id. */
export type IVoltWindowScopes = Readonly<Record<string, IVoltWindowScopeState>>;

export interface IVoltWindowScopeClaim {
	readonly sessions?: readonly string[];
	readonly projects?: readonly string[];
	readonly createdProjects?: readonly string[];
	readonly layoutMode?: VoltWindowLayoutMode;
}

/** A window opened for one chat (Open in New Window): what its scope starts with, and the chat it shows. */
export interface IVoltWindowStart extends IVoltWindowScopeClaim {
	readonly openSession: string;
}

/** A window kept ready for the next New Window was shown for one chat. */
export interface IVoltWindowOpenedStart {
	readonly scope: string;
	readonly session: string;
}

export interface IVoltWindowScopesService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeScopes: Event<IVoltWindowScopes>;

	/** A window that was already loaded is to show a chat (after its scope took the chat in). */
	readonly onDidStartWindow: Event<IVoltWindowOpenedStart>;

	getScopes(): Promise<IVoltWindowScopes>;

	/**
	 * Adds to a scope. With no scope (a main window) the named projects become everyone's again:
	 * a project the main window adds itself is no longer held back by the window that created it.
	 */
	claim(scope: string | undefined, claim: IVoltWindowScopeClaim): Promise<void>;

	/** The next window opened with a scope of its own (for a few seconds) starts with `start`. */
	prepareWindow(start: IVoltWindowStart): Promise<void>;

	/** The chat a window was opened to show. Answered once, so a reload does not open it again. */
	takeWindowStart(scope: string): Promise<string | undefined>;

	/** A window that got its chat with `onDidStartWindow` shows it: the window can come to the front. */
	didShowWindowStart(scope: string): Promise<void>;
}

export const EMPTY_WINDOW_SCOPE: IVoltWindowScopeState = { sessions: [], projects: [], createdProjects: [] };

/** `scopes` with the claim applied. Returns the same object when nothing changed. */
export function applyWindowScopeClaim(scopes: IVoltWindowScopes, scope: string | undefined, claim: IVoltWindowScopeClaim): IVoltWindowScopes {
	if (scope === undefined) {
		const released = new Set(claim.projects ?? []);
		if (!released.size) {
			return scopes;
		}
		let next: Record<string, IVoltWindowScopeState> | undefined;
		for (const [id, state] of Object.entries(scopes)) {
			if (state.createdProjects.some(project => released.has(project))) {
				next ??= { ...scopes };
				next[id] = { ...state, createdProjects: state.createdProjects.filter(project => !released.has(project)) };
			}
		}
		return next ?? scopes;
	}
	const current = scopes[scope];
	if (!current) {
		return scopes;
	}
	const sessions = union(current.sessions, claim.sessions);
	const projects = union(union(current.projects, claim.projects), claim.createdProjects);
	const createdProjects = union(current.createdProjects, claim.createdProjects);
	const layoutMode = claim.layoutMode ?? current.layoutMode;
	if (sessions === current.sessions && projects === current.projects && createdProjects === current.createdProjects && layoutMode === current.layoutMode) {
		return scopes;
	}
	return { ...scopes, [scope]: { sessions, projects, createdProjects, ...(layoutMode ? { layoutMode } : {}) } };
}

/** `base` plus `extra`, or `base` itself when `extra` adds nothing. */
function union(base: readonly string[], extra: readonly string[] | undefined): readonly string[] {
	const added = extra?.filter((value, index) => !base.includes(value) && extra.indexOf(value) === index);
	return added?.length ? [...base, ...added] : base;
}
