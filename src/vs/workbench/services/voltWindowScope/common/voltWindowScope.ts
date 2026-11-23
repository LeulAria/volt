/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IVoltWindowScopeState, VoltWindowLayoutMode } from '../../../../platform/voltWindowScope/common/voltWindowScope.js';

export const IVoltWindowScopeService = createDecorator<IVoltWindowScopeService>('voltWindowScopeService');

/**
 * What this window lists. A window opened with New Window beside a main window starts empty and
 * lists only the chats and projects started or added in it; the main window leaves those out.
 * When the scoped window closes they show in the main window.
 */
export interface IVoltWindowScopeService {
	readonly _serviceBrand: undefined;

	/** Set in a scoped window (opened with New Window beside a main window). */
	readonly scope: string | undefined;

	/** What this window lists changed: a claim here or in another window, or a scoped window closed. */
	readonly onDidChange: Event<void>;

	/** Scoped windows that just closed, in a main window. What they owned is this window's now. */
	readonly onDidEndScopes: Event<readonly IVoltWindowScopeState[]>;

	/** The Agent/IDE mode this scoped window last used. */
	readonly layoutMode: VoltWindowLayoutMode | undefined;

	/**
	 * A window without a scope, or a scoped one that is the main window too because no window
	 * without a scope is open. It lists every chat and project no scoped window holds.
	 */
	readonly isMain: boolean;

	/** Another window asked to open a chat this window owns; this window was brought to the front for it. */
	readonly onDidRevealSession: Event<string>;

	showsSession(sessionId: string): boolean;
	showsProject(projectId: string): boolean;

	/** Another open window owns the chat: it must not be open here. */
	heldElsewhere(sessionId: string): boolean;

	/**
	 * Before opening a chat this window does not list: when another open window owns it, that window
	 * comes to the front and shows it, and this answers true (do not open it here).
	 */
	revealElsewhere(sessionId: string): Promise<boolean>;

	/** A chat started in this window. */
	claimSession(sessionId: string): void;
	/** A project added, picked or chatted in here. `created`: it was not registered anywhere before. */
	claimProject(projectId: string, created: boolean): void;
	setLayoutMode(mode: VoltWindowLayoutMode): void;
}
