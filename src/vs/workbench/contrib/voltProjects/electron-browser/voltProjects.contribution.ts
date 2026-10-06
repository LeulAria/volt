/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IVoltFsBrowseService, VOLT_FS_BROWSE_CHANNEL_NAME } from '../../../../platform/voltFsBrowse/common/voltFsBrowse.js';
// Storage cleanup and import from other editors (main process)
import '../../voltSetup/electron-browser/voltSetup.contribution.js';

registerMainProcessRemoteService(IVoltFsBrowseService, VOLT_FS_BROWSE_CHANNEL_NAME);
