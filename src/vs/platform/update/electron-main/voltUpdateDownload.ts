/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { checksum } from '../../../base/node/crypto.js';
import { IRequestService } from '../../request/common/request.js';

export interface IVoltDownloadOptions {
	readonly sha256hash?: string;
	/** Expected size, for progress when the response has no content-length. */
	readonly size?: number;
	/** Called about every 2% with a fraction between 0 and 1. */
	readonly onProgress?: (progress: number) => void;
}

/**
 * Downloads an update to `path`: written to `<path>.tmp` and renamed once the checksum passes.
 * The response is read by this one listener, which writes and counts progress together; a second
 * `data` listener joining after the stream started flowing would miss the first chunks.
 */
export async function downloadVoltUpdate(requestService: IRequestService, url: string, path: string, options: IVoltDownloadOptions = {}): Promise<void> {
	const context = await requestService.request({ url }, CancellationToken.None);
	const status = context.res.statusCode;
	if (status && (status < 200 || status >= 300)) {
		context.stream.destroy();
		throw new Error(`Download failed (HTTP ${status})`);
	}
	const total = Number(context.res.headers['content-length']) || options.size || 0;
	const partial = `${path}.tmp`;
	try {
		await new Promise<void>((resolve, reject) => {
			const file = fs.createWriteStream(partial);
			let received = 0;
			let reported = 0;
			const fail = (err: unknown) => {
				context.stream.destroy();
				file.destroy();
				reject(err);
			};
			file.on('error', fail);
			context.stream.on('error', fail);
			context.stream.on('end', () => file.end(() => resolve()));
			context.stream.on('data', chunk => {
				received += chunk.byteLength;
				if (total && options.onProgress) {
					const progress = Math.min(1, received / total);
					if (progress - reported >= 0.02) {
						reported = progress;
						options.onProgress(progress);
					}
				}
				if (!file.write(chunk.buffer)) {
					context.stream.pause();
					file.once('drain', () => context.stream.resume());
				}
			});
		});
		await checksum(partial, options.sha256hash);
		await fs.promises.rename(partial, path);
	} catch (err) {
		await fs.promises.rm(partial, { force: true });
		throw err;
	}
}
