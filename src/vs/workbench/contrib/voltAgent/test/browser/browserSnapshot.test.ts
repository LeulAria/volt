/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractToolImage, isSnapshotActivity, isSnapshotTool } from '../../browser/preview/browserSnapshot.js';

suite('Browser snapshot', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognizes snapshot tools and activity', () => {
		assert.strictEqual(isSnapshotTool('browser_take_screenshot', 'Took snapshot'), true);
		assert.strictEqual(isSnapshotTool('Read', 'Read File'), false);
		assert.strictEqual(isSnapshotActivity({ kind: 'browser', label: 'Took snapshot' }), true);
		assert.strictEqual(isSnapshotActivity({ kind: 'browser', label: 'Locked browser' }), false);
		assert.strictEqual(isSnapshotActivity({ kind: 'browser', label: 'Navigated', image: 'data:image/png;base64,abcd' }), true);
	});

	test('extracts ACP image content', () => {
		const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
		assert.strictEqual(
			extractToolImage({
				type: 'content',
				content: { type: 'image', mimeType: 'image/png', data: png },
			}),
			`data:image/png;base64,${png}`,
		);
		assert.strictEqual(
			extractToolImage([{ type: 'image', data: `data:image/jpeg;base64,${png}` }]),
			`data:image/jpeg;base64,${png}`,
		);
	});

	test('ignores non-image tool output', () => {
		assert.strictEqual(extractToolImage('The page loaded.'), undefined);
		assert.strictEqual(extractToolImage({ text: 'ok', output: 'done' }), undefined);
	});
});
