/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { IVoltExecResult, IVoltJobOutput, IVoltStdioService, IVoltStdioSpawnOptions } from '../../../../../platform/voltStdio/common/voltStdio.js';

export class NullVoltStdioService implements IVoltStdioService {
	declare readonly _serviceBrand: undefined;
	readonly onData = Event.None;
	readonly onExit = Event.None;

	async spawn(_options: IVoltStdioSpawnOptions): Promise<string> {
		throw new Error('ACP stdio is only available in the Volt desktop app.');
	}

	async write(): Promise<void> { }

	async kill(): Promise<void> { }

	async which(): Promise<string | undefined> {
		return undefined;
	}

	async exec(): Promise<IVoltExecResult> {
		throw new Error('Shell commands are only available in the Volt desktop app.');
	}

	async cancelExec(): Promise<void> { }

	async jobOutput(): Promise<IVoltJobOutput | undefined> {
		return undefined;
	}

	async jobWait(): Promise<IVoltJobOutput | undefined> {
		return undefined;
	}

	async listJobs(): Promise<readonly IVoltJobOutput[]> {
		return [];
	}
}
