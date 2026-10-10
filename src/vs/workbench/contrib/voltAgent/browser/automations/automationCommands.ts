/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** `(automationId?: string, view?: 'settings' | 'runs')`: the Automations page, or one automation. */
export const OPEN_AUTOMATIONS_COMMAND_ID = 'voltAgent.automations.open';

/** `(options?: { threadId?: string; prompt?: string; mode?: string; modelRef?: string; templateId?: string })`: a new, unsaved automation. */
export const NEW_AUTOMATION_COMMAND_ID = 'voltAgent.automations.new';

/** `()`: every automation's runs. */
export const OPEN_AUTOMATION_RUNS_COMMAND_ID = 'voltAgent.automations.runs';

/**
 * Send options an automation run carries in its prompt's `host`: the transcript draws an
 * "Automation · name" divider above the turn. `scheduled` is the key turns stored before
 * Automations replaced scheduled tasks used, so old chats keep their divider.
 */
export interface IAutomationRunHost {
	readonly scheduled: { readonly id: string; readonly title: string; readonly webhook?: boolean; readonly runId?: string };
}

export function automationRunOf(host: unknown): IAutomationRunHost['scheduled'] | undefined {
	const scheduled = (host as Partial<IAutomationRunHost> | undefined)?.scheduled;
	return scheduled && typeof scheduled.id === 'string' && typeof scheduled.title === 'string' ? scheduled : undefined;
}
