/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentPromptDisplay } from '../editor/agentEditor.js';

/**
 * The composer's live display (mentions with image bytes) for prompts it just submitted, by turn
 * id. The orchestrator stores a frozen copy; a turn started right away uses this one and skips
 * reading attachments back from disk.
 */
const liveDisplays = new Map<string, IAgentPromptDisplay>();

export function stashTurnDisplay(turnId: string, display: IAgentPromptDisplay | undefined): void {
	if (display) {
		liveDisplays.set(turnId, display);
		if (liveDisplays.size > 64) {
			liveDisplays.delete(liveDisplays.keys().next().value!);
		}
	}
}

/** Takes the live display stashed for `turnId` (once). */
export function takeTurnDisplay(turnId: string): IAgentPromptDisplay | undefined {
	const display = liveDisplays.get(turnId);
	liveDisplays.delete(turnId);
	return display;
}
