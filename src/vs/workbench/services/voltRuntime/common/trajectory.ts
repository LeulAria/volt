/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ITrajectoryRequest, ITrajectoryRequestInput } from './harness/trajectory.js';

export const VOLT_TRAJECTORY_ENABLED_SETTING = 'volt.agent.trajectory.enabled';

export const IVoltTrajectoryService = createDecorator<IVoltTrajectoryService>('voltTrajectoryService');

export interface IVoltTrajectoryChat {
	readonly sessionId: string;
	readonly label?: string;
	readonly updatedAt: number;
	readonly requests: number;
}

/**
 * Model requests of native runs in this window, per chat, kept in memory (the last few hundred
 * per chat). The runtime records; the Trajectory panel reads.
 */
export interface IVoltTrajectoryService {
	readonly _serviceBrand: undefined;
	/** A chat's requests changed; fires at most every ~150ms per chat while a stream runs. */
	readonly onDidChange: Event<string>;
	/** Whether runs are recorded (`volt.agent.trajectory.enabled`). */
	readonly enabled: boolean;
	/** A request is about to go out; `undefined` when recording is off. */
	begin(input: Omit<ITrajectoryRequestInput, 'id' | 'index'>): ITrajectoryRequest | undefined;
	/** The latest request of a run, for tool calls and usage that arrive after its stream. */
	latest(sessionId: string, runId: string): ITrajectoryRequest | undefined;
	/** A request recorded earlier grew (stream chunk, tool result). */
	changed(sessionId: string): void;
	requests(sessionId: string): readonly ITrajectoryRequest[];
	chats(): readonly IVoltTrajectoryChat[];
	setLabel(sessionId: string, label: string): void;
	clear(sessionId: string): void;
}
