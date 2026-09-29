/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IVoltGitService, VOLT_GIT_CHANNEL_NAME } from '../../../../platform/voltGit/common/voltGit.js';

registerMainProcessRemoteService(IVoltGitService, VOLT_GIT_CHANNEL_NAME);
