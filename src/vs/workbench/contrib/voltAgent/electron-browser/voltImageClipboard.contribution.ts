/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IVoltImageClipboardService } from '../common/voltImageClipboard.js';

/** The clipboard format name each OS uses for PNG data. */
const PNG_FORMAT = isMacintosh ? 'public.png' : isWindows ? 'PNG' : 'image/png';

class VoltImageClipboardService implements IVoltImageClipboardService {
	declare readonly _serviceBrand: undefined;

	constructor(@INativeHostService private readonly nativeHostService: INativeHostService) { }

	writePng(png: VSBuffer): Promise<void> {
		return this.nativeHostService.writeClipboardBuffer(PNG_FORMAT, png);
	}
}

registerSingleton(IVoltImageClipboardService, VoltImageClipboardService, InstantiationType.Delayed);
