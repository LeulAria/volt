/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deflateSync } from 'zlib';
import type { IRawFrame } from '../common/deviceCommands.js';

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(chunks: readonly Uint8Array[]): number {
	let crc = 0xffffffff;
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.length; i++) {
			crc = CRC_TABLE[(crc ^ chunk[i]) & 0xff] ^ crc >>> 8;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	out.set(data, 8);
	out.writeUInt32BE(crc32([out.subarray(4, 8), data]), 8 + data.length);
	return out;
}

/** An RGBA PNG at the fastest deflate level: the frames are for a live preview, not for the archive. */
export function encodePng(frame: IRawFrame): Buffer {
	const { width, height, rgba } = frame;
	const stride = width * 4;
	const rows = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		// Filter type 0 (none), then the row.
		rows.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(rows, { level: 1 })),
		chunk('IEND', new Uint8Array(0)),
	]);
}

/** Nearest-neighbour shrink: the fallback when no native encoder is available. */
export function downscale(frame: IRawFrame, width: number, height: number): IRawFrame {
	const out = new Uint8Array(width * height * 4);
	const src = new Uint32Array(frame.rgba.buffer, frame.rgba.byteOffset, frame.rgba.byteLength >> 2);
	const dst = new Uint32Array(out.buffer);
	for (let y = 0; y < height; y++) {
		const row = Math.min(frame.height - 1, Math.floor((y + 0.5) * frame.height / height)) * frame.width;
		for (let x = 0; x < width; x++) {
			dst[y * width + x] = src[row + Math.min(frame.width - 1, Math.floor((x + 0.5) * frame.width / width))];
		}
	}
	return { width, height, rgba: out };
}
