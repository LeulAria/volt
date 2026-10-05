/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IVoltGitService, VOLT_GIT_CHANNEL_NAME } from '../../../../platform/voltGit/common/voltGit.js';
import { IVoltPullRequestService, VOLT_PULL_REQUEST_CHANNEL_NAME } from '../../../../platform/voltPullRequests/common/voltPullRequests.js';

registerMainProcessRemoteService(IVoltGitService, VOLT_GIT_CHANNEL_NAME);

registerMainProcessRemoteService(IVoltPullRequestService, VOLT_PULL_REQUEST_CHANNEL_NAME);
