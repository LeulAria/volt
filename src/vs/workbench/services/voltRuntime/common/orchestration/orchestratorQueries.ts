/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { harnessTaskId } from './orchestratorDecider.js';
import { IOrchState, IOrchTask } from './orchestrator.js';

// Reads over an orchestrator state. The orchestrator service answers with them, and so do the
// agent server's clients from their mirror of its state.

/** Tasks a thread started, oldest first. */
export function orchTasksOf(state: IOrchState, threadId: string): readonly IOrchTask[] {
	return Object.values(state.tasks).filter(task => task.parentId === threadId).sort((a, b) => a.createdAt - b.createdAt);
}

/** The task behind a parent's tool call (a `delegate_task` call or the harness's own Task call). */
export function orchTaskForToolCall(state: IOrchState, threadId: string, toolCallId: string): IOrchTask | undefined {
	return state.tasks[harnessTaskId(toolCallId)]
		?? Object.values(state.tasks).find(task => task.parentId === threadId && task.toolCallId === toolCallId);
}

/** The turn is the chat's active one and is not being stopped. */
export function orchIsTurnCurrent(state: IOrchState, threadId: string, turnId: string): boolean {
	const active = state.threads[threadId]?.active;
	return active?.id === turnId && active.phase !== 'cancelling';
}
