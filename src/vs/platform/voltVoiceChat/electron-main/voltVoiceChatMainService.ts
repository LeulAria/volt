/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from '../../../base/common/path.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { getResolvedShellEnv } from '../../shell/node/shellEnv.js';
import { VoltVoiceChatService } from '../node/voltVoiceChatService.js';

/** The desktop's voice chat keys and call transcripts, in `<userData>/volt-voice` (the agent server uses the same folder). */
export class VoltVoiceChatMainService extends VoltVoiceChatService {

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
	) {
		super(() => getResolvedShellEnv(configurationService, logService, { _: [] }, process.env)
			.then(resolved => ({ ...process.env, ...resolved }))
			.catch(() => process.env),
			logService,
			join(environmentMainService.userDataPath, 'volt-voice'));
	}
}
