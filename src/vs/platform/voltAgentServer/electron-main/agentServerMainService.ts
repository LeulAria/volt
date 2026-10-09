/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { powerMonitor } from 'electron';
import { Disposable } from '../../../base/common/lifecycle.js';
import { FileAccess } from '../../../base/common/network.js';
import { IProductService } from '../../product/common/productService.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltAgentServerEndpoint, IVoltAgentServerMainService } from '../common/agentServerService.js';
import { AgentServerLauncher } from '../node/agentServerLauncher.js';

export class VoltAgentServerMainService extends Disposable implements IVoltAgentServerMainService {

	declare readonly _serviceBrand: undefined;

	private readonly launcher: AgentServerLauncher;
	/** A window asked for the server: keep it up across sleep even while no window is open. */
	private wanted = false;

	constructor(
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@ILogService logService: ILogService,
		@IProductService productService: IProductService,
	) {
		super();
		this.launcher = new AgentServerLauncher({
			userDataDir: environmentMainService.userDataPath,
			// The checkout in dev builds.
			appRoot: FileAccess.asFileUri('').fsPath.replace(/[\\/]out[\\/]?$/, ''),
			electronPath: process.execPath,
			commit: productService.commit,
			log: message => logService.info(message),
		});
		const onResume = () => {
			if (this.wanted) {
				this.launcher.ensureRunning().catch(err => logService.error('[volt agent server] could not start the agent server after the system woke up', err));
			}
		};
		powerMonitor.on('resume', onResume);
		this._register({ dispose: () => powerMonitor.removeListener('resume', onResume) });
	}

	ensureRunning(): Promise<IVoltAgentServerEndpoint> {
		this.wanted = true;
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
