/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEditorImportService, IVoltImportedEditor } from '../../../../platform/voltEditorImport/common/voltEditorImport.js';
import { IVoltStorageCleanResult, IVoltStorageReport, IVoltStorageService } from '../../../../platform/voltStorage/common/voltStorage.js';

/** Storage is measured by the desktop main process; elsewhere there is nothing to show. */
export class NullVoltStorageService implements IVoltStorageService {
	declare readonly _serviceBrand: undefined;
	async machineReport(): Promise<IVoltStorageReport> { return { items: [], measuredAt: Date.now(), durationMs: 0 }; }
	async projectReport(): Promise<IVoltStorageReport> { return { items: [], measuredAt: Date.now(), durationMs: 0 }; }
	async clean(): Promise<IVoltStorageCleanResult> { return { freedBytes: 0, removed: 0, skipped: [], errors: [] }; }
}

/** Other editors' recent folders can only be read on the desktop. */
export class NullVoltEditorImportService implements IVoltEditorImportService {
	declare readonly _serviceBrand: undefined;
	async recentFolders(): Promise<readonly IVoltImportedEditor[]> { return []; }
}
