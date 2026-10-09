/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { session } from 'electron';
import { homedir } from 'os';
import { join } from '../../../base/common/path.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { getResolvedShellEnv } from '../../shell/node/shellEnv.js';
import { VOLT_BROWSER_PARTITION } from '../../voltBrowser/common/voltBrowser.js';
import { VoltStorageService } from '../node/voltStorageService.js';

/**
 * Storage cleanup in the main process. The app's own HTTP and code caches, and the in-app
 * browser's, are open while it runs, so Electron clears those instead of deleting files.
 */
export class VoltStorageMainService extends VoltStorageService {

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IProductService productService: IProductService,
	) {
		super(
			{
				userDataPath: environmentMainService.userDataPath,
				userRoamingPath: environmentMainService.appSettingsHome.fsPath,
				logsSessionPath: environmentMainService.logsHome.fsPath,
				worktreesRoot: join(homedir(), '.volt', 'worktrees'),
				commit: productService.commit,
			},
			() => getResolvedShellEnv(configurationService, logService, { _: [] }, process.env).then(resolved => ({ ...process.env, ...resolved })),
			logService,
			{
				chromiumCache: () => session.defaultSession.clearCache(),
				codeCache: () => session.defaultSession.clearCodeCaches({}),
				browserCache: async () => {
					const browser = session.fromPartition(VOLT_BROWSER_PARTITION);
					await browser.clearCache();
					await browser.clearCodeCaches({});
				},
				// Cookies and site storage: signs the in-app browser out of every site.
				browserData: () => session.fromPartition(VOLT_BROWSER_PARTITION).clearStorageData(),
			},
		);
	}
}
