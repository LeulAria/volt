/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** `(taskId?: string)`: opens the Scheduled Tasks tab, with that task's row highlighted. */
export const OPEN_AGENT_SCHEDULES_COMMAND_ID = 'voltAgent.schedules.open';

/** `(options?: { threadId?: string; prompt?: string })`: the New scheduled task dialog. */
export const NEW_AGENT_SCHEDULE_COMMAND_ID = 'voltAgent.schedules.new';

/** Send options a scheduled run carries in its prompt's `host`: the transcript marks the turn. */
export interface IAgentScheduledRunHost {
	readonly scheduled: { readonly id: string; readonly title: string };
}

export function scheduledRunOf(host: unknown): IAgentScheduledRunHost['scheduled'] | undefined {
	const scheduled = (host as Partial<IAgentScheduledRunHost> | undefined)?.scheduled;
	return scheduled && typeof scheduled.id === 'string' && typeof scheduled.title === 'string' ? scheduled : undefined;
}
