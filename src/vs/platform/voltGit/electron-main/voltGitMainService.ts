/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from '../../../base/common/path.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { getResolvedShellEnv } from '../../shell/node/shellEnv.js';
import { VoltGitService } from '../node/voltGitService.js';

/** Runs git with the user's shell environment, so the same git they use in a terminal is found. */
export class VoltGitMainService extends VoltGitService {

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
	) {
		super(() => getResolvedShellEnv(configurationService, logService, { _: [] }, process.env)
			.then(resolved => ({ ...process.env, ...resolved }))
			.catch(err => {
				logService.warn('[volt-git] could not resolve the shell environment', err);
				return process.env;
			}), logService, {
			// Agent checkpoints for folders that are not git repos; nothing is written into those folders.
			shadowRoot: join(environmentMainService.userDataPath, 'volt-checkpoints'),
		});
	}
}
