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

const PREWARM_DELAY_MS = 20_000;

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
		// The first transcript scan takes seconds; run it once the app has settled so the Usage
		// page and the context meter open on fresh numbers.
		const prewarm = setTimeout(() => {
			void this.getUsage().catch(() => undefined);
			void this.getLimits().catch(() => undefined);
		}, PREWARM_DELAY_MS);
		// Which setTimeout typing wins depends on the program's file order; Node's timer has unref.
		(prewarm as unknown as { unref?(): void }).unref?.();
	}
}
