/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { htmlToText, isBlockedFetchUrl } from '../../../common/harness/htmlText.js';

suite('Volt html text', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('strips scripts and decodes entities', () => {
		const text = htmlToText('<html><script>alert(1)</script><p>Nissan Kicks &amp; price</p>');
		assert.ok(!/alert/.test(text));
		assert.ok(text.includes('Nissan Kicks & price'));
	});

	test('blocks loopback and private URLs', () => {
		assert.strictEqual(isBlockedFetchUrl('http://127.0.0.1:8080/'), true);
		assert.strictEqual(isBlockedFetchUrl('http://192.168.1.9/'), true);
		assert.strictEqual(isBlockedFetchUrl('file:///etc/passwd'), true);
		assert.strictEqual(isBlockedFetchUrl('https://example.com/docs'), false);
	});
});
