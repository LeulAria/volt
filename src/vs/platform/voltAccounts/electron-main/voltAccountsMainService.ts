/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ILogService } from '../../log/common/log.js';
import { IStateService } from '../../state/node/state.js';
import { IVoltUsageService } from '../../voltUsage/common/voltUsage.js';
import { VoltAccountsService } from '../node/voltAccountsService.js';

/** Whether the Claude accounts extension was on when a window last said; read before any window is open. */
const ENABLED_STATE_KEY = 'volt.claudeAccounts.enabled';

/** The main process's accounts: automatic switching runs here, while any window (or none) is open. */
export class VoltAccountsMainService extends VoltAccountsService {
	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IVoltUsageService usageService: IVoltUsageService,
		@IStateService private readonly stateService: IStateService,
	) {
		super({ autoSwitch: true, enabled: stateService.getItem<boolean>(ENABLED_STATE_KEY, true) !== false }, configurationService, logService, usageService);
	}

	override async setClaudeAccountsEnabled(enabled: boolean): Promise<void> {
		if (enabled !== this.enabled) {
			this.stateService.setItem(ENABLED_STATE_KEY, enabled);
		}
		return super.setClaudeAccountsEnabled(enabled);
	}
}
