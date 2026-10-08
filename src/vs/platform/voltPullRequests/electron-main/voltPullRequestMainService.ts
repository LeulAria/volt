/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ILogService } from '../../log/common/log.js';
import { getResolvedShellEnv } from '../../shell/node/shellEnv.js';
import { VOLT_SOURCE_CONTROL_HOSTS_SETTING } from '../common/voltPrHosts.js';
import { VoltPullRequestService } from '../node/voltPullRequestService.js';

/** Runs `gh` and git with the user's shell environment, so the CLI and logins from their terminal are found. */
export class VoltPullRequestMainService extends VoltPullRequestService {

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		super(() => getResolvedShellEnv(configurationService, logService, { _: [] }, process.env)
			.then(resolved => ({ ...process.env, ...resolved }))
			.catch(err => {
				logService.warn('[volt-pr] could not resolve the shell environment', err);
				return process.env;
			}), logService, 'gh', {
			// Which kind of server a self-hosted host is, and where its web UI lives (Settings > Volt).
			hostSettings: () => configurationService.getValue(VOLT_SOURCE_CONTROL_HOSTS_SETTING),
		});
	}
}
