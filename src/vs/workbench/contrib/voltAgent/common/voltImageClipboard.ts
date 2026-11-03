/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IVoltImageClipboardService = createDecorator<IVoltImageClipboardService>('voltImageClipboardService');

/**
 * Puts a PNG on the system clipboard through the main process. The workbench page may not write
 * images itself (Electron denies `navigator.clipboard.write` to it). Only the desktop app registers
 * it (electron-browser/voltImageClipboard.contribution.ts); elsewhere callers use the web clipboard.
 */
export interface IVoltImageClipboardService {
	readonly _serviceBrand: undefined;
	writePng(png: VSBuffer): Promise<void>;
}
