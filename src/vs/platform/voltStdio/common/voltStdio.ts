/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltStdioService = createDecorator<IVoltStdioService>('voltStdioService');
export const VOLT_STDIO_CHANNEL_NAME = 'voltStdio';

export interface IVoltStdioSpawnOptions {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export interface IVoltStdioService {
	readonly _serviceBrand: undefined;
	readonly onData: Event<{ id: string; data: string }>;
	readonly onExit: Event<{ id: string; code: number | null; stderr?: string }>;
	spawn(options: IVoltStdioSpawnOptions): Promise<string>;
	write(id: string, data: string): Promise<void>;
	kill(id: string): Promise<void>;
	which(command: string): Promise<string | undefined>;
}
