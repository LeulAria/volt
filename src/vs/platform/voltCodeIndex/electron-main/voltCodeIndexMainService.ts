/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from '../../../base/common/path.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { VoltCodeIndexService } from '../node/voltCodeIndexService.js';

/** One code index process for every project window; indexes live in the user data folder. */
export class VoltCodeIndexMainService extends VoltCodeIndexService {

	constructor(
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@ILogService logService: ILogService,
	) {
		super(join(environmentMainService.userDataPath, 'volt-index'), logService);
	}
}
