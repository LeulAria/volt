/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { powerMonitor } from 'electron';
import { Event } from '../../../base/common/event.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { VOLT_AGENT_SERVER_ENABLED_SETTING } from '../../voltAgentServer/common/agentServerService.js';
import { IVoltAppliedCloudResult, IVoltCloudSourceSummary, IVoltCloudTaskInput, IVoltDeliveryOutcome, IVoltHeldDelivery, IVoltLocalHook, IVoltRelayEvent, IVoltRelayService, IVoltRelayState } from '../common/voltRelay.js';
import { VoltRelayService } from '../node/voltRelayService.js';

/** The relay in Volt's main process, for windows that run their agents themselves. */
class MainProcessRelay extends VoltRelayService {
	constructor(userDataPath: string, logService: ILogService) {
		super(userDataPath, logService, {
			thermalState: () => powerMonitor.getCurrentThermalState?.(),
			onBattery: () => powerMonitor.isOnBatteryPower(),
		});
	}
}

const SERVER_HOLDS_IT = 'The Volt agent server holds the relay connection while agents run there.';

/**
 * The main process's relay channel. With the agent server on (the default) the server holds the
 * relay, the local webhook URL and the delivery queue, so webhooks run with no window open; this
 * then stays idle (one connection per device token, one listener on the local port). Read once at
 * startup, like the windows read the setting.
 */
export class VoltRelayMainService implements IVoltRelayService {

	declare readonly _serviceBrand: undefined;

	private readonly inner: MainProcessRelay | undefined;
	readonly onDidChangeState: Event<IVoltRelayState>;
	readonly onDidEvent: Event<IVoltRelayEvent>;

	constructor(
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@ILogService logService: ILogService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		const serverHoldsIt = configurationService.getValue<boolean>(VOLT_AGENT_SERVER_ENABLED_SETTING) !== false;
		this.inner = serverHoldsIt ? undefined : new MainProcessRelay(environmentMainService.userDataPath, logService);
		this.onDidChangeState = this.inner?.onDidChangeState ?? Event.None;
		this.onDidEvent = this.inner?.onDidEvent ?? Event.None;
	}

	private relay(): MainProcessRelay {
		if (!this.inner) {
			throw new Error(SERVER_HOLDS_IT);
		}
		return this.inner;
	}

	async getState(): Promise<IVoltRelayState> {
		return this.inner ? this.inner.getState() : { status: 'off' };
	}

	connect(link: string, deviceName?: string): Promise<IVoltRelayState> { return this.relay().connect(link, deviceName); }
	disconnect(): Promise<void> { return this.relay().disconnect(); }
	request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> { return this.relay().request<T>(method, path, body); }
	async setLocalHooks(hooks: readonly IVoltLocalHook[]): Promise<void> { await this.inner?.setLocalHooks(hooks); }
	async nextDelivery(waitMs: number): Promise<IVoltHeldDelivery | undefined> { return this.inner?.nextDelivery(waitMs); }
	async ackDelivery(id: string, source: 'relay' | 'local', outcome: IVoltDeliveryOutcome): Promise<void> { await this.inner?.ackDelivery(id, source, outcome); }
	createCloudTask(input: IVoltCloudTaskInput): Promise<{ readonly task: unknown; readonly source: IVoltCloudSourceSummary }> { return this.relay().createCloudTask(input); }
	fetchCloudResult(taskId: string, repoRoot: string): Promise<IVoltAppliedCloudResult> { return this.relay().fetchCloudResult(taskId, repoRoot); }
	readBlobText(blobId: string, maxBytes: number): Promise<string> { return this.relay().readBlobText(blobId, maxBytes); }

	dispose(): void {
		this.inner?.dispose();
	}
}
