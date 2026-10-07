/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { fitSize, nativeWindowId, platformCaptureCommand } from '../../common/voltCapture.js';

suite('Volt capture', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('native window ids come from desktopCapturer source ids', () => {
		assert.strictEqual(nativeWindowId('window:31337:0'), '31337');
		assert.strictEqual(nativeWindowId('screen:1:0'), undefined);
		assert.strictEqual(nativeWindowId('window:abc:0'), undefined);
	});

	test('platform fallbacks: screencapture on macOS, ImageMagick import on Linux, none on Windows', () => {
		assert.deepStrictEqual(platformCaptureCommand('darwin', 'window:4242:0', '/tmp/o.png'), { file: 'screencapture', args: ['-x', '-o', '-l4242', '-t', 'png', '/tmp/o.png'] });
		assert.deepStrictEqual(platformCaptureCommand('darwin', 'screen:69732928:0', '/tmp/o.png'), { file: 'screencapture', args: ['-x', '-t', 'png', '/tmp/o.png'] });
		assert.deepStrictEqual(platformCaptureCommand('linux', 'window:62914567:0', '/tmp/o.png'), { file: 'import', args: ['-window', '0x3c00007', 'png:/tmp/o.png'] });
		assert.deepStrictEqual(platformCaptureCommand('linux', 'screen:0:0', '/tmp/o.png'), { file: 'import', args: ['-window', 'root', 'png:/tmp/o.png'] });
		assert.strictEqual(platformCaptureCommand('win32', 'window:1:0', 'C:\\o.png'), undefined);
		assert.strictEqual(platformCaptureCommand('darwin', 'weird', '/tmp/o.png'), undefined);
	});

	test('fitSize keeps the aspect ratio and never upscales', () => {
		assert.deepStrictEqual(fitSize(3024, 1964, 1280), { width: 1280, height: 831 });
		assert.deepStrictEqual(fitSize(800, 600, 1280), { width: 800, height: 600 });
		assert.deepStrictEqual(fitSize(1000, 4000, 1000), { width: 250, height: 1000 });
	});
});
