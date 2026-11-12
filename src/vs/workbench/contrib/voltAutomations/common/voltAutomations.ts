/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Types only: volt-server loads the command ids through the scheduler.
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';

/**
 * The Automations feature's contract: what the rest of Volt may use of it. Its pages (list,
 * calendar, one automation, runs) are a module of the `volt.automations` built-in extension
 * (`browser/voltAutomations.module.ts`), loaded the first time one of these commands runs, a
 * restored tab shows or Volt Settings opens its page, and unloaded when the extension is disabled.
 * The scheduler (`IAutomationService`) is core: it runs on volt-server too.
 */

export const AUTOMATIONS_FEATURE_ID = 'automations';

/** `(automationId?: string, view?: 'settings' | 'runs')`: the Automations page, or one automation. */
export const OPEN_AUTOMATIONS_COMMAND_ID = 'voltAgent.automations.open';

/** `(options?: { threadId?: string; prompt?: string; mode?: string; modelRef?: string; templateId?: string })`: a new, unsaved automation. */
export const NEW_AUTOMATION_COMMAND_ID = 'voltAgent.automations.new';

/** `()`: every automation's runs. */
export const OPEN_AUTOMATION_RUNS_COMMAND_ID = 'voltAgent.automations.runs';

/**
 * `(route: AutomationsRoute)`: the Automations tab on a page (the workflow library, a workflow in
 * the builder); an open tab moves there. For core's workflow commands, so internal.
 */
export const OPEN_AUTOMATIONS_ROUTE_COMMAND_ID = 'voltAgent.automations.openRoute';

export const AUTOMATIONS_EDITOR_ID = 'workbench.editor.voltAutomations';
export const AUTOMATIONS_EDITOR_INPUT_TYPE_ID = 'workbench.input.voltAutomations';

/** Where an Automations tab is past its list, for the window's title bar. */
export interface IAutomationsTrail {
	/** An automation, then its runs. */
	readonly crumbs: readonly { readonly label: string; readonly run?: () => void }[];
	/** Back to the list, from the title bar's Automations while a page is open past it. */
	readonly home: (() => void) | undefined;
}

/** The trail of an Automations tab (undefined for any other editor, or a tab whose module isn't loaded yet). */
export function automationsTrail(editor: { readonly typeId: string } | undefined): IAutomationsTrail | undefined {
	return editor?.typeId === AUTOMATIONS_EDITOR_INPUT_TYPE_ID && 'crumbs' in editor ? editor as { readonly typeId: string } & IAutomationsTrail : undefined;
}

/** The Automations page hosted inside another editor (Volt Settings > Automations). */
export interface IAutomationsEmbeddedPage extends IDisposable {
	setVisible(visible: boolean): void;
	layout(width: number, height: number): void;
}

/** What the loaded module gives core (`IVoltFeatureModuleService.activate('automations')`). */
export interface IVoltAutomationsModule {
	/** The Automations page in `parent`, on its list. Disposed with the module if it unloads first. */
	createEmbeddedPage(parent: HTMLElement, group: IEditorGroup): IAutomationsEmbeddedPage;
}
