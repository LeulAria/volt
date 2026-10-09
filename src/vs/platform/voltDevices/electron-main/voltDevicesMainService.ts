/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { nativeImage } from 'electron';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ILogService } from '../../log/common/log.js';
import { getResolvedShellEnv } from '../../shell/node/shellEnv.js';
import { IRawFrame } from '../common/deviceCommands.js';
import { VoltDevicesService } from '../node/voltDevicesService.js';

/** The device's RGBA pixels as a JPEG of the given size, made natively (a JS encoder would take longer than the capture). */
function encodeJpeg(frame: IRawFrame, width: number, height: number): Buffer {
	// nativeImage reads BGRA: swap red and blue.
	const pixels = Buffer.alloc(frame.rgba.byteLength);
	const src = new Uint32Array(frame.rgba.buffer, frame.rgba.byteOffset, frame.rgba.byteLength >> 2);
	const dst = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >> 2);
	for (let i = 0; i < src.length; i++) {
		const v = src[i];
		dst[i] = (v & 0xff00ff00 | v >>> 16 & 0xff | (v & 0xff) << 16) >>> 0;
	}
	return nativeImage.createFromBitmap(pixels, { width: frame.width, height: frame.height }).resize({ width, height, quality: 'good' }).toJPEG(82);
}

/** Runs simctl, adb and ssh with the user's shell environment, so tools from their terminal (Homebrew, the Android SDK) are found. */
export class VoltDevicesMainService extends VoltDevicesService {

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		let env: Promise<NodeJS.ProcessEnv> | undefined;
		super(() => env ??= getResolvedShellEnv(configurationService, logService, { _: [] }, process.env)
			.then(resolved => ({ ...process.env, ...resolved }))
			.catch(err => {
				logService.warn('[volt-devices] could not resolve the shell environment', err);
				return process.env;
			}), logService, encodeJpeg);
	}
}
