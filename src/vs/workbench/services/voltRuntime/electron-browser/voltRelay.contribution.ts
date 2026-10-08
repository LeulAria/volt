/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IVoltRelayService, VOLT_RELAY_CHANNEL_NAME } from '../../../../platform/voltRelay/common/voltRelay.js';

registerMainProcessRemoteService(IVoltRelayService, VOLT_RELAY_CHANNEL_NAME);
