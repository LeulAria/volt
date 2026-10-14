/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FileAccess } from '../../../base/common/network.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltAgentServerEndpoint, IVoltAgentServerMainService } from '../common/agentServerService.js';
import { AgentServerLauncher } from '../node/agentServerLauncher.js';

export class VoltAgentServerMainService implements IVoltAgentServerMainService {

	declare readonly _serviceBrand: undefined;

	private readonly launcher: AgentServerLauncher;

	constructor(
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@ILogService logService: ILogService,
	) {
		this.launcher = new AgentServerLauncher({
			userDataDir: environmentMainService.userDataPath,
			// The checkout in dev builds.
			appRoot: FileAccess.asFileUri('').fsPath.replace(/[\\/]out[\\/]?$/, ''),
			electronPath: process.execPath,
			log: message => logService.info(message),
		});
	}

	ensureRunning(): Promise<IVoltAgentServerEndpoint> {
		return this.launcher.ensureRunning();
	}

	restart(): Promise<IVoltAgentServerEndpoint> {
		return this.launcher.restart();
	}

	stop(): Promise<void> {
		return this.launcher.stop();
	}

	setNetworkAccess(enabled: boolean): Promise<IVoltAgentServerEndpoint> {
		return this.launcher.setNetworkAccess(enabled);
	}
}
