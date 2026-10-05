/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from '../../../base/common/path.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { getResolvedShellEnv } from '../../shell/node/shellEnv.js';
import { VoltUsageService } from '../node/voltUsageService.js';

/** Usage runs in the main process: it reads hundreds of MB of transcripts and talks to the provider APIs. */
export class VoltUsageMainService extends VoltUsageService {

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
	) {
		super(() => getResolvedShellEnv(configurationService, logService, { _: [] }, process.env)
			.then(resolved => ({ ...process.env, ...resolved }))
			.catch(() => process.env),
			logService,
			join(environmentMainService.userDataPath, 'volt-usage'));
	}
}
