/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IVoltStdioService, VOLT_STDIO_CHANNEL_NAME } from '../../../../platform/voltStdio/common/voltStdio.js';

registerMainProcessRemoteService(IVoltStdioService, VOLT_STDIO_CHANNEL_NAME);
