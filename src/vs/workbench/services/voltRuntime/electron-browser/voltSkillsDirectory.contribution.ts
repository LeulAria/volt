/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IVoltSkillsDirectoryService, VOLT_SKILLS_DIRECTORY_CHANNEL_NAME } from '../../../../platform/voltMarketplace/common/voltMarketplace.js';

registerMainProcessRemoteService(IVoltSkillsDirectoryService, VOLT_SKILLS_DIRECTORY_CHANNEL_NAME);
