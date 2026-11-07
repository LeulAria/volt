/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { AutomationSchedule } from '../../../../services/voltRuntime/common/automations/automations.js';
import type { IAgentPageCrumb } from '../customize/agentMarketplaceView.js';

/** A new automation's starting point: a template, a prompt from a chat's composer, or a time picked on the calendar. */
export interface IAutomationSeed {
	readonly templateId?: string;
	readonly threadId?: string;
	readonly instructions?: string;
	readonly mode?: string;
	readonly modelRef?: string;
	/** Clicked calendar slot: the schedule the new automation starts with. */
	readonly schedule?: AutomationSchedule;
	/** The workflow its runs execute (picked or just made in the builder). */
	readonly workflowId?: string;
}

/** A new workflow's starting point in the builder. */
export interface IWorkflowSeed {
	/** YAML to start from (a pasted workflow, a template). Not saved until Save. */
	readonly yaml?: string;
	/** An official or community template id (with `templateSource`). */
	readonly templateId?: string;
	readonly templateSource?: string;
	/** "Describe": build from words with an agent. */
	readonly describe?: string;
	/** Made from an automation's Workflow menu: on save, that automation runs it. */
	readonly automationId?: string;
}

/** How the list page shows automations: the table, or a calendar of their runs. */
export type AutomationsView = 'list' | 'day' | 'week' | 'month';

export type AutomationsRoute =
	/** `date`: the day the calendar shows (start of day, local), today when absent. */
	| { readonly page: 'list'; readonly view?: AutomationsView; readonly date?: number }
	/** No `id`: a new automation, unsaved until Save. */
	| { readonly page: 'detail'; readonly id?: string; readonly tab: 'settings' | 'runs'; readonly seed?: IAutomationSeed }
	| { readonly page: 'runs' }
	/** The workflow library: the user's workflows, templates and community sources. */
	| { readonly page: 'workflows'; readonly tab?: 'mine' | 'templates' }
	/** The builder. No `id`: a new workflow, unsaved until Save. `run`: open that run in the executions panel. */
	| { readonly page: 'workflow'; readonly id?: string; readonly seed?: IWorkflowSeed; readonly run?: string };

/** What a page draws into: the bar at the top (actions), the scrolling content, or the full-size stage. */
export interface IAutomationsHost {
	readonly bar: HTMLElement;
	readonly content: HTMLElement;
	/**
	 * A non-scrolling layer filling the editor under the bar, for pages that lay out themselves
	 * (the workflow builder's canvas). Shown instead of `content` while the page uses it.
	 */
	readonly stage: HTMLElement;
	/** The stage's size changed (editor resized, panels toggled outside it). */
	readonly onDidLayout: Event<{ readonly width: number; readonly height: number }>;
	/** The stage's current size. */
	stageSize(): { readonly width: number; readonly height: number };
	/** The trail after Automations in the window's title bar; empty on the list. */
	setCrumbs(crumbs: readonly IAgentPageCrumb[]): void;
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
	/** The page uses `host.stage` instead of the scrolling content. */
	readonly usesStage?: boolean;
}
