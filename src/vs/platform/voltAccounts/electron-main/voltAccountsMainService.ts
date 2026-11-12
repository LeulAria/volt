/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltUsageService } from '../../voltUsage/common/voltUsage.js';
import { VoltAccountsService } from '../node/voltAccountsService.js';

/** The main process's accounts: automatic switching runs here, while any window (or none) is open. */
export class VoltAccountsMainService extends VoltAccountsService {
	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IVoltUsageService usageService: IVoltUsageService,
	) {
		super({ autoSwitch: true }, configurationService, logService, usageService);
	}
}
