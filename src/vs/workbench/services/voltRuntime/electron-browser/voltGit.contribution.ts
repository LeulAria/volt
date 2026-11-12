/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IVoltGitService, VOLT_GIT_CHANNEL_NAME } from '../../../../platform/voltGit/common/voltGit.js';
import { IVoltHttpTransport, VOLT_HTTP_TRANSPORT_CHANNEL_NAME } from '../../../../platform/voltHttp/common/voltHttpTransport.js';
import { IVoltPullRequestService, VOLT_PULL_REQUEST_CHANNEL_NAME } from '../../../../platform/voltPullRequests/common/voltPullRequests.js';

registerMainProcessRemoteService(IVoltGitService, VOLT_GIT_CHANNEL_NAME);

registerMainProcessRemoteService(IVoltPullRequestService, VOLT_PULL_REQUEST_CHANNEL_NAME);

// The HTTP client's requests go out from the main process: a window's fetch is subject to CORS.
registerMainProcessRemoteService(IVoltHttpTransport, VOLT_HTTP_TRANSPORT_CHANNEL_NAME);
