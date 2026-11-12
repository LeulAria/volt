/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltSandboxRequest, IVoltSandboxSettings, sandboxWorkspaceRoots } from '../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { IVoltExecContext, VoltExecReason } from '../../../../platform/voltStdio/common/voltStdio.js';

/**
 * Who a process Volt starts runs for, and the sandbox it runs in (spec B-04, B-06, N.1 #10).
 * Commands Volt runs for a sandboxed chat (its post-turn check, its terminals, its worktree setup,
 * its model's shell) run inside that chat's sandbox with the chat's own rules: its level, its
 * network, its allowed folders and hosts. Spread into a spawn or command request.
 */
export interface IChatExec {
	readonly context: IVoltExecContext;
	/** Set exactly when the chat is sandboxed. */
	readonly sandbox?: IVoltSandboxRequest;
}

/**
 * The provider id a command for a chat is sandboxed as: none. A project's commands get no agent
 * CLI's state folders or API hosts; only an agent CLI's own process (titles, probes) names its
 * provider.
 */
export const CHAT_COMMAND_PROVIDER = '';

/** The OS sandbox of a command Volt runs for a chat with `settings`; undefined when the chat runs unconfined. */
export function chatExecSandbox(settings: IVoltSandboxSettings | undefined, workspaceRoots: readonly string[], providerId = CHAT_COMMAND_PROVIDER): IVoltSandboxRequest | undefined {
	if (!settings || settings.level === 'off') {
		return undefined;
	}
	return {
		level: settings.level,
		network: settings.network,
		providerId,
		workspaceRoots: [...workspaceRoots],
		...(settings.extraWritableRoots?.length ? { extraWritableRoots: [...settings.extraWritableRoots] } : {}),
		...(settings.allowedDomains?.length ? { allowedDomains: [...settings.allowedDomains] } : {}),
	};
}

/**
 * A process for chat `sessionId` (its principal), or for no chat (`volt`), in the chat's sandbox
 * when it has one.
 */
export function chatExec(sessionId: string | undefined, settings: IVoltSandboxSettings | undefined, workspaceRoots: readonly string[], reason: VoltExecReason, providerId?: string): IChatExec {
	const sandbox = chatExecSandbox(settings, workspaceRoots, providerId);
	return {
		context: { principal: sessionId ? `chat:${sessionId}` : 'volt', reason, sandboxed: !!sandbox },
		...(sandbox ? { sandbox } : {}),
	};
}

/** Setup of chat `chatId`'s worktree, in the chat's sandbox when it has one: the worktree and its repository's `.git` are its workspace. */
export function worktreeSetupExec(chatId: string, settings: IVoltSandboxSettings | undefined, repoRoot: string, worktreePath: string): IChatExec {
	return chatExec(chatId, settings, sandboxWorkspaceRoots(worktreePath, repoRoot, true), 'worktree-setup');
}

/** Volt's own work, for no chat's agent: nothing an agent wrote decides what runs. */
export function voltExec(reason: VoltExecReason, onBehalfOf?: string): IChatExec {
	return { context: { principal: 'volt', reason, sandboxed: false, ...(onBehalfOf ? { onBehalfOf } : {}) } };
}

/** The user's own click (an install, a settings page): runs as the user, outside any chat. */
export function userExec(): IChatExec {
	return { context: { principal: 'user', reason: 'user-action', sandboxed: false } };
}
