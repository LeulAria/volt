/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ILogService } from '../../log/common/log.js';
import { getResolvedShellEnv } from '../../shell/node/shellEnv.js';
import { VoltDevicesService } from '../node/voltDevicesService.js';

/** Runs simctl, adb and ssh with the user's shell environment, so tools from their terminal (Homebrew, the Android SDK) are found. */
export class VoltDevicesMainService extends VoltDevicesService {

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		let env: Promise<NodeJS.ProcessEnv> | undefined;
		super(() => env ??= getResolvedShellEnv(configurationService, logService, { _: [] }, process.env)
			.then(resolved => ({ ...process.env, ...resolved }))
			.catch(err => {
				logService.warn('[volt-devices] could not resolve the shell environment', err);
				return process.env;
			}), logService);
	}
}
