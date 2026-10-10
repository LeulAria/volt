/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../../base/common/lifecycle.js';

/** A new automation's starting point: a template, or a prompt from a chat's composer. */
export interface IAutomationSeed {
	readonly templateId?: string;
	readonly threadId?: string;
	readonly instructions?: string;
	readonly mode?: string;
	readonly modelRef?: string;
}

export type AutomationsRoute =
	| { readonly page: 'list' }
	/** No `id`: a new automation, unsaved until Save. */
	| { readonly page: 'detail'; readonly id?: string; readonly tab: 'settings' | 'runs'; readonly seed?: IAutomationSeed }
	| { readonly page: 'runs' };

/** What a page draws into: the bar at the top (breadcrumb, actions) and the scrolling content. */
export interface IAutomationsHost {
	readonly bar: HTMLElement;
	readonly content: HTMLElement;
	navigate(route: AutomationsRoute): void;
	/** Records where the page is (a new automation that was saved) without redrawing it. */
	setRoute(route: AutomationsRoute): void;
	/** The content's height changed (rows added, a panel opened). */
	relayout(): void;
	scrollToTop(): void;
}

export interface IAutomationsPage extends IDisposable {
	/** Asked before leaving: false keeps the page (unsaved changes the user kept). */
	canLeave?(): Promise<boolean>;
	focus?(): void;
}
