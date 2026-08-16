/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltModelOptions } from './modelOptions.js';
import { VoltMode } from './modes.js';

export type VoltRunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface IVoltRunSnapshot {
	runId: string;
	sessionId: string;
	status: VoltRunStatus;
	startedAt: number;
	endedAt?: number;
	providerRef?: string;
}

export interface IVoltSession {
	sessionId: string;
	conversationId: string;
	mode: VoltMode;
	providerRef?: string;
	profileId?: string;
	messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
	activeRun?: IVoltRunSnapshot;
}

export interface IVoltSendRequest {
	text: string;
	mode: VoltMode;
	providerRef?: string;
	mentions?: string[];
	options?: IVoltModelOptions;
}
