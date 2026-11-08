/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAtLeastAsStrict, ISandboxScope, ISpawnSandboxDecision, spawnSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxInheritance.js';
import { describeSandbox, IVoltSandboxSettings, sandboxStrategy, strategyAtLeast } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';

/** The part of the runtime that keeps each chat's sandbox (local, or over the agent server). */
export interface IChatSandboxStore {
	getSandboxSettings(sessionId: string): IVoltSandboxSettings;
	setSandboxSettings(sessionId: string, settings: IVoltSandboxSettings): Promise<void>;
}

/**
 * Confines `chatId` at least as tightly as `floor` (the sandbox of the chat that delegated to it,
 * launched, forked or scheduled it). Call before its prompt goes out: the agent process takes its
 * sandbox when it starts. With scopes (INV-11): a child whose agent would be sandboxed more weakly
 * is refused (nothing is stored; the caller must not start it), and a child whose workspace is
 * outside what the floor's chat may write runs read-only.
 */
export async function confineChatSandbox(store: IChatSandboxStore, chatId: string, floor: IVoltSandboxSettings | undefined, scopes?: { readonly caller?: ISandboxScope; readonly child?: ISandboxScope }): Promise<ISpawnSandboxDecision> {
	if (!floor) {
		return {};
	}
	const decision = spawnSandboxSettings(floor, store.getSandboxSettings(chatId), scopes);
	if (decision.settings && !decision.refused) {
		await store.setSandboxSettings(chatId, decision.settings);
	}
	return decision;
}

/** This machine as `sandboxStrategy` names platforms. */
export const CHAT_SANDBOX_PLATFORM = isWindows ? 'win32' : isMacintosh ? 'darwin' : 'linux';

/**
 * Why a sandboxed chat may not move to `toProvider` (handoff, thread_configure; B-10): the chat
 * keeps its sandbox, and the new agent would be sandboxed more weakly there than the current one.
 */
export function handoffSandboxRefusal(settings: IVoltSandboxSettings, fromProvider: string | undefined, toProvider: string, toLabel: string, platform: string = CHAT_SANDBOX_PLATFORM): string | undefined {
	if (settings.level === 'off') {
		return undefined;
	}
	const now = fromProvider ? sandboxStrategy(fromProvider, settings.level, platform) : 'wrap';
	const next = sandboxStrategy(toProvider, settings.level, platform);
	if (strategyAtLeast(next, now)) {
		return undefined;
	}
	return `Not handed off: this chat runs in Volt's sandbox, and ${toLabel} would run with a weaker one${next === 'none' ? ' (none on this machine)' : ''}. Keep working on this model, or ask the user to move the chat.`;
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
