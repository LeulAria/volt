/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { inflateSync } from 'zlib';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { pngSize } from '../../common/deviceCommands.js';
import { downscale, encodePng } from '../../node/frameEncoding.js';

suite('Volt devices: frame encoding', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function gradient(width: number, height: number) {
		const rgba = new Uint8Array(width * height * 4);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				rgba.set([x * 10, y * 10, 99, 255], (y * width + x) * 4);
			}
		}
		return { width, height, rgba };
	}

	test('a PNG made from raw pixels has the right size and decodes back to them', () => {
		const frame = gradient(5, 4);
		const png = encodePng(frame);
		assert.deepStrictEqual(pngSize(png), { width: 5, height: 4 });
		// IHDR is 25 bytes after the signature; IDAT follows it.
		const idatLength = png.readUInt32BE(33);
		assert.strictEqual(png.toString('ascii', 37, 41), 'IDAT');
		const rows = inflateSync(png.subarray(41, 41 + idatLength));
		assert.strictEqual(rows.length, (5 * 4 + 1) * 4);
		assert.strictEqual(rows[0], 0, 'filter type none');
		assert.deepStrictEqual(Array.from(rows.subarray(1, 9)), Array.from(frame.rgba.subarray(0, 8)));
		assert.strictEqual(png.toString('ascii', png.length - 8, png.length - 4), 'IEND');
	});

	test('shrinking keeps the corners', () => {
		const frame = gradient(8, 8);
		const small = downscale(frame, 4, 4);
		assert.deepStrictEqual([small.width, small.height, small.rgba.length], [4, 4, 64]);
		// The last pixel of the small image comes from the bottom right area of the big one.
		assert.ok(small.rgba[(4 * 4 - 1) * 4] >= 60);
		assert.strictEqual(small.rgba[3], 255);
	});
});
