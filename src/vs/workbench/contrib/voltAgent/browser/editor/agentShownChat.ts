/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';

/**
 * The chat the main agent panel has drawn. The editor model makes a picked chat active on the
 * click, but the panel keeps the last chat on screen until the picked one's history is read. The
 * Agents list and the title bar name this chat, so they never name one chat over another's
 * transcript.
 */
let shown: string | undefined;
const shownEmitter = new Emitter<void>();

export const onDidChangeShownAgentChat: Event<void> = shownEmitter.event;

export function shownAgentChat(): string | undefined {
	return shown;
}

export function setShownAgentChat(sessionId: string | undefined): void {
	if (shown !== sessionId) {
		shown = sessionId;
		shownEmitter.fire();
	}
}
