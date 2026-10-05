/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VoltLane } from './harness/lanes.js';
import { AgentRunOn, AgentWorktreeTarget } from './git/agentWorktree.js';
import { IVoltModelOptions } from './models/modelOptions.js';
import { VoltMode } from './modes.js';

export type VoltRunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface IVoltRunSnapshot {
	runId: string;
	sessionId: string;
	status: VoltRunStatus;
	startedAt: number;
	endedAt?: number;
	providerRef?: string;
	lane?: VoltLane;
}

export interface IVoltSessionMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
	/** A user message sent into a live run (steering), not a turn of its own. */
	steer?: boolean;
	/** The model that wrote a reply, so a model handed the chat later knows who said what. */
	model?: string;
}

/** User turns in `messages`: user messages that were not steering a live run. */
export function countUserTurns(messages: readonly IVoltSessionMessage[]): number {
	return messages.filter(message => message.role === 'user' && !message.steer).length;
}

/** An image the user attached to a message: pasted, dropped, or picked. */
export interface IVoltImageAttachment {
	/** `image/png`, `image/jpeg`, `image/webp` or `image/gif`. */
	readonly mediaType: string;
	/** Base64, without a `data:` prefix. */
	readonly data: string;
	/** The composer's label for it (`Image1`), so a `@Image1` mention in the text resolves. */
	readonly name?: string;
}

export interface IVoltSession {
	sessionId: string;
	conversationId: string;
	mode: VoltMode;
	providerRef?: string;
	profileId?: string;
	messages: IVoltSessionMessage[];
	activeRun?: IVoltRunSnapshot;
	/** Lane of the most recent run; the intent router uses it to keep follow-ups in a coding lane. */
	lastLane?: VoltLane;
	/** Human pause: the native loop waits between steps. */
	paused?: boolean;
	/** Set when this chat runs in a managed worktree instead of the open checkout. */
	worktreePath?: string;
	worktreeBranch?: string;
}

export interface IVoltSendRequest {
	text: string;
	mode: VoltMode;
	providerRef?: string;
	mentions?: string[];
	/** Images attached to this message. Native models get them as image content, ACP agents as prompt image blocks. */
	images?: readonly IVoltImageAttachment[];
	options?: IVoltModelOptions;
	/** Same branch uses the open checkout. Worktree creates a checkout on the first send. */
	runOn?: AgentRunOn;
	/** With `runOn: 'worktree'`: the branch the new checkout uses. */
	worktreeTarget?: AgentWorktreeTarget;
}
