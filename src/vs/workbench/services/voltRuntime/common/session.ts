/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VoltLane } from './harness/lanes.js';
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

export interface IVoltSession {
	sessionId: string;
	conversationId: string;
	mode: VoltMode;
	providerRef?: string;
	profileId?: string;
	messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
	activeRun?: IVoltRunSnapshot;
	/** Lane of the most recent run; the intent router uses it to keep follow-ups in a coding lane. */
	lastLane?: VoltLane;
	/** Human pause: the native loop waits between steps. */
	paused?: boolean;
}

export interface IVoltSendRequest {
	text: string;
	mode: VoltMode;
	providerRef?: string;
	mentions?: string[];
	options?: IVoltModelOptions;
}
