/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAtLeastAsStrict, ISandboxScope, ISpawnSandboxDecision, spawnSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxInheritance.js';
import { describeSandbox, IVoltSandboxSettings, sandboxStrategy, sandboxWorkspaceRoots, strategyAtLeast } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';

/** The part of the runtime that keeps each chat's sandbox (local, or over the agent server). */
export interface IChatSandboxStore {
	getSandboxSettings(sessionId: string): IVoltSandboxSettings;
	setSandboxSettings(sessionId: string, settings: IVoltSandboxSettings): Promise<void>;
	/** The folder the chat's agent works in (its checkout or worktree); undefined: it has none. */
	workingFolder?(sessionId: string): string | undefined;
}

/**
 * A chat's sandbox scope as the store knows it (INV-11): the folder its agent works in, as a real
 * path when `realpath` is given; `[]` when it has none. A store that can't tell gives unknown roots,
 * which fail closed.
 */
export async function chatSandboxScope(store: IChatSandboxStore, chatId: string, realpath?: (path: string) => Promise<string | undefined>): Promise<ISandboxScope> {
	if (!store.workingFolder) {
		return {};
	}
	const folder = store.workingFolder(chatId);
	if (!folder) {
		return { roots: [] };
	}
	const real = realpath ? await realpath(folder).catch(() => undefined) ?? folder : folder;
	return { roots: sandboxWorkspaceRoots(real, undefined, false) };
}

/**
 * Confines `chatId` at least as tightly as `floor` (the sandbox of the chat that delegated to it,
 * launched, forked or scheduled it). Call before its prompt goes out: the agent process takes its
 * sandbox when it starts. With scopes (INV-11): a child whose agent would be sandboxed more weakly
 * is refused (nothing is stored; the caller must not start it), and a child whose workspace is
 * outside what the floor's chat may write runs read-only. A child that would write a workspace
 * whose roots aren't passed runs read-only too (fails closed): callers pass both sides' roots.
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
 * less confined, so the instructions would do there what this chat's sandbox forbids. Compared with
 * both chats' folders (`scopes`, else what the store knows): a target that writes a workspace the
 * sender can't, or whose workspace is unknown, is refused (INV-11, B-11).
 */
export function sandboxedInstructionRefusal(store: IChatSandboxStore, fromId: string, toId: string, toTitle: string, scopes?: { readonly from: ISandboxScope; readonly to: ISandboxScope }): string | undefined {
	const from = store.getSandboxSettings(fromId);
	if (from.level === 'off' || fromId === toId) {
		return undefined;
	}
	const to = store.getSandboxSettings(toId);
	const known = scopes ?? { from: storeScope(store, fromId), to: storeScope(store, toId) };
	if (isAtLeastAsStrict(to, from, { a: known.to, b: known.from })) {
		return undefined;
	}
	return `Not sent: "${toTitle}" is less sandboxed than this chat (${describeSandbox(to)} This chat: ${describeSandbox(from)}${isAtLeastAsStrict(to, from) ? ' It writes a folder this chat cannot.' : ''}). A sandboxed chat cannot send instructions to a chat that would carry them out with more access. Ask the user to send it, or to give that chat at least this chat's sandbox.`;
}

/** {@link chatSandboxScope} without real paths (synchronous). */
function storeScope(store: IChatSandboxStore, chatId: string): ISandboxScope {
	if (!store.workingFolder) {
		return {};
	}
	const folder = store.workingFolder(chatId);
	return { roots: folder ? sandboxWorkspaceRoots(folder, undefined, false) : [] };
}
