/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IVoltUsageService, VOLT_USAGE_CHANNEL_NAME } from '../../../../platform/voltUsage/common/voltUsage.js';

registerMainProcessRemoteService(IVoltUsageService, VOLT_USAGE_CHANNEL_NAME);
