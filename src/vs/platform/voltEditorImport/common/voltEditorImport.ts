/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltEditorImportService = createDecorator<IVoltEditorImportService>('voltEditorImportService');
export const VOLT_EDITOR_IMPORT_CHANNEL_NAME = 'voltEditorImport';

export type VoltImportEditorId = 'vscode' | 'vscodeInsiders' | 'cursor' | 'windsurf' | 'vscodium';

export interface IVoltImportedFolder {
	/** Absolute local path. */
	readonly path: string;
	readonly name: string;
	readonly exists: boolean;
	readonly gitRepo: boolean;
}

export interface IVoltImportedEditor {
	readonly id: VoltImportEditorId;
	readonly label: string;
	/** Most recent first, local folders only. */
	readonly folders: readonly IVoltImportedFolder[];
}

/**
 * Recently opened folders of the VS Code family of editors on this machine (VS Code, Cursor, ...),
 * read without changing anything: their `state.vscdb` is opened read-only.
 */
export interface IVoltEditorImportService {
	readonly _serviceBrand: undefined;
	/** Editors that have any recent local folder. */
	recentFolders(): Promise<readonly IVoltImportedEditor[]>;
}
