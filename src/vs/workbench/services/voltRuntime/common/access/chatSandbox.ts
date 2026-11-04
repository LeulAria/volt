/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { inheritedSandboxSettings, isAtLeastAsStrict } from '../../../../../platform/voltSandbox/common/sandboxInheritance.js';
import { describeSandbox, IVoltSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';

/** The part of the runtime that keeps each chat's sandbox (local, or over the agent server). */
export interface IChatSandboxStore {
	getSandboxSettings(sessionId: string): IVoltSandboxSettings;
	setSandboxSettings(sessionId: string, settings: IVoltSandboxSettings): Promise<void>;
}

/**
 * Confines `chatId` at least as tightly as `floor` (the sandbox of the chat that delegated to it,
 * launched, forked or scheduled it). Call before its prompt goes out: the agent process takes its
 * sandbox when it starts.
 */
export async function confineChatSandbox(store: IChatSandboxStore, chatId: string, floor: IVoltSandboxSettings | undefined): Promise<void> {
	const inherited = floor && inheritedSandboxSettings(floor, store.getSandboxSettings(chatId));
	if (inherited) {
		await store.setSandboxSettings(chatId, inherited);
	}
}

/**
 * Why a sandboxed chat may not instruct `toId` (thread_send, editing its queue): that chat runs
 * less confined, so the instructions would do there what this chat's sandbox forbids.
 */
export function sandboxedInstructionRefusal(store: IChatSandboxStore, fromId: string, toId: string, toTitle: string): string | undefined {
	const from = store.getSandboxSettings(fromId);
	if (from.level === 'off' || fromId === toId) {
		return undefined;
	}
	const to = store.getSandboxSettings(toId);
	if (isAtLeastAsStrict(to, from)) {
		return undefined;
	}
	return `Not sent: "${toTitle}" is less sandboxed than this chat (${describeSandbox(to)} This chat: ${describeSandbox(from)}). A sandboxed chat cannot send instructions to a chat that would carry them out with more access. Ask the user to send it, or to give that chat at least this chat's sandbox.`;
}
