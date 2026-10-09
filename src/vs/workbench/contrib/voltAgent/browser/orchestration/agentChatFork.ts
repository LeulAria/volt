/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import type { MergeBackOutcome } from '../../../../services/voltRuntime/common/orchestration/chatForks.js';

export const IAgentChatForkService = createDecorator<IAgentChatForkService>('agentChatForkService');

export interface IAgentForkChatOptions {
	/** Keep the turns through this one (by id). Wins over `atTurns`. */
	readonly throughTurnId?: string;
	/** Keep turns 1..atTurns. Default: every finished turn. */
	readonly atTurns?: number;
	readonly title?: string;
	readonly model?: { readonly ref: string; readonly label: string };
	readonly workspace: 'same' | 'worktree';
	/** Mode of the fork's first prompt. Default: the source's mode. */
	readonly mode?: string;
	readonly message?: string;
	readonly open?: boolean;
	/** The chat whose agent asked for the fork; its message is shown as that chat's. */
	readonly from?: { readonly id: string; readonly title: string; readonly kind: 'fork'; readonly external?: boolean };
}

export interface IAgentForkChatResult {
	readonly forkId: string;
	readonly title: string;
	readonly sourceId: string;
	readonly sourceTitle: string;
	readonly branch?: string;
	readonly forkedAtTurns: number;
	readonly totalTurns: number;
	readonly model?: string;
	readonly refused?: string;
}

export interface IAgentMergeBackResult {
	readonly parentId: string;
	readonly parentTitle: string;
	readonly outcome: MergeBackOutcome;
}

export interface IAgentChatForkService {
	readonly _serviceBrand: undefined;
	/** Copies a chat's conversation into a new chat. Throws when there is nothing to fork from. */
	forkChat(sourceId: string, options: IAgentForkChatOptions): Promise<IAgentForkChatResult>;
	/**
	 * Tells the chat a fork came from what the fork changed, and with `apply` merges its branch into
	 * that chat's checkout. Throws when `forkId` was not forked from another chat.
	 */
	mergeBack(forkId: string, options: { readonly apply: boolean }): Promise<IAgentMergeBackResult>;
}
