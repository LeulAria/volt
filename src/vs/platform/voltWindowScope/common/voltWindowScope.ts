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
	/** Chats started in or moved to the window. Only that window lists them: a chat is in one scope at most. */
	readonly sessions: readonly string[];
	/** Projects the window lists: the ones added, picked or chatted in there. */
	readonly projects: readonly string[];
	/**
	 * Projects the window holds: new when it added them, or moved to it whole. Other windows leave
	 * them out until it closes.
	 */
	readonly createdProjects: readonly string[];
	readonly layoutMode?: VoltWindowLayoutMode;
	/**
	 * No window without a scope is open: this one is the main window too, and also lists every chat
	 * and project no other scope holds. Chats of a scope that closes show here.
	 */
	readonly main?: boolean;
}

/** Every open scope, by id. */
export type IVoltWindowScopes = Readonly<Record<string, IVoltWindowScopeState>>;

export interface IVoltWindowScopeClaim {
	readonly sessions?: readonly string[];
	readonly projects?: readonly string[];
	readonly createdProjects?: readonly string[];
	readonly layoutMode?: VoltWindowLayoutMode;
}

/**
 * A window opened for chats or a project (Open in New Window): what its scope starts with, and the
 * chat it shows (none for a project with no chats yet).
 */
export interface IVoltWindowStart extends IVoltWindowScopeClaim {
	readonly openSession?: string;
}

/** A window kept ready for the next New Window was shown for one chat. */
export interface IVoltWindowOpenedStart {
	readonly scope: string;
	readonly session: string;
}

/** Another window asked to open a chat this window owns: it was brought to the front to show it. */
export interface IVoltWindowRevealedSession {
	readonly windowId: number;
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

	/** A window was brought to the front to show a chat it owns (see `revealSession`). */
	readonly onDidRevealSession: Event<IVoltWindowRevealedSession>;

	/**
	 * A window in `fromScope` (undefined: a window without one) is about to open a chat. When another
	 * open window owns it, that window comes to the front and shows it, and this answers true: the
	 * asking window does not open it too. A chat is never open in two windows.
	 */
	revealSession(sessionId: string, fromScope: string | undefined): Promise<boolean>;
}

export const EMPTY_WINDOW_SCOPE: IVoltWindowScopeState = { sessions: [], projects: [], createdProjects: [] };

/** The scope holding a chat; undefined when it belongs to the main window. */
export function sessionScope(scopes: IVoltWindowScopes, sessionId: string): string | undefined {
	for (const [id, state] of Object.entries(scopes)) {
		if (state.sessions.includes(sessionId)) {
			return id;
		}
	}
	return undefined;
}

/** The scope that is the main window too (see `IVoltWindowScopeState.main`). */
export function mainWindowScope(scopes: IVoltWindowScopes): string | undefined {
	return Object.entries(scopes).find(([, state]) => state.main)?.[0];
}

/**
 * `scopes` with the claim applied. A chat, or a held project, claimed by one scope leaves every
 * other: it moved. Returns the same object when nothing changed.
 */
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
	const movedSessions = new Set(claim.sessions ?? []);
	const movedProjects = new Set(claim.createdProjects ?? []);
	let next: Record<string, IVoltWindowScopeState> | undefined;
	if (movedSessions.size || movedProjects.size) {
		for (const [id, state] of Object.entries(scopes)) {
			if (id === scope) {
				continue;
			}
			const sessions = state.sessions.some(session => movedSessions.has(session)) ? state.sessions.filter(session => !movedSessions.has(session)) : state.sessions;
			const createdProjects = state.createdProjects.some(project => movedProjects.has(project)) ? state.createdProjects.filter(project => !movedProjects.has(project)) : state.createdProjects;
			const projects = state.projects.some(project => movedProjects.has(project)) ? state.projects.filter(project => !movedProjects.has(project)) : state.projects;
			if (sessions !== state.sessions || createdProjects !== state.createdProjects || projects !== state.projects) {
				next ??= { ...scopes };
				next[id] = { ...state, sessions, projects, createdProjects };
			}
		}
	}
	const sessions = union(current.sessions, claim.sessions);
	const projects = union(union(current.projects, claim.projects), claim.createdProjects);
	const createdProjects = union(current.createdProjects, claim.createdProjects);
	const layoutMode = claim.layoutMode ?? current.layoutMode;
	if (sessions !== current.sessions || projects !== current.projects || createdProjects !== current.createdProjects || layoutMode !== current.layoutMode) {
		next ??= { ...scopes };
		next[scope] = { ...current, sessions, projects, createdProjects, ...(layoutMode ? { layoutMode } : {}) };
	}
	return next ?? scopes;
}

/** `scopes` with `main` (or none) marked as the main window. Returns the same object when nothing changed. */
export function withMainWindowScope(scopes: IVoltWindowScopes, main: string | undefined): IVoltWindowScopes {
	let next: Record<string, IVoltWindowScopeState> | undefined;
	for (const [id, state] of Object.entries(scopes)) {
		const isMain = id === main;
		if (!!state.main !== isMain) {
			next ??= { ...scopes };
			const { main: _main, ...rest } = state;
			next[id] = isMain ? { ...rest, main: true } : rest;
		}
	}
	return next ?? scopes;
}

/** `base` plus `extra`, or `base` itself when `extra` adds nothing. */
function union(base: readonly string[], extra: readonly string[] | undefined): readonly string[] {
	const added = extra?.filter((value, index) => !base.includes(value) && extra.indexOf(value) === index);
	return added?.length ? [...base, ...added] : base;
}
