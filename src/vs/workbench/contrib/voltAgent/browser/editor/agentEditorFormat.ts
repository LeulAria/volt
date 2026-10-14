/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import type { IAgentAssistantMessage } from './agentEditor.js';

/** "Worked for 1m 42s": a finished turn's length, in the composer's status chip and the dock. */
export { formatWorkedDuration } from '../../../../services/voltRuntime/common/agentTurnStatus.js';

/** What "Resume" sends after a turn that stopped or failed before it finished. */
export function resumeTurnPrompt(message: IAgentAssistantMessage): string {
	const failure = message.outcome === 'failed' ? message.failure?.message.trim() : undefined;
	return failure
		? localize('voltAgent.resume.promptFailed', "Continue where you left off. The previous turn ended with this error: {0}. Do not redo work that is already done.", failure)
		: localize('voltAgent.resume.prompt', "Continue where you left off. The previous turn stopped before it finished. Do not redo work that is already done.");
}
