/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IVoltEditorImportService, VOLT_EDITOR_IMPORT_CHANNEL_NAME } from '../../../../platform/voltEditorImport/common/voltEditorImport.js';
import { IVoltStorageService, VOLT_STORAGE_CHANNEL_NAME } from '../../../../platform/voltStorage/common/voltStorage.js';

registerMainProcessRemoteService(IVoltStorageService, VOLT_STORAGE_CHANNEL_NAME);
registerMainProcessRemoteService(IVoltEditorImportService, VOLT_EDITOR_IMPORT_CHANNEL_NAME);
