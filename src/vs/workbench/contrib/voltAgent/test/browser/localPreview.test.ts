/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractHttpUrl, extractLocalPreviewUrl, inferPreviewUrlFromCommand, linkifyPreviewUrls, sanitizeBrowserUrl } from '../../browser/preview/localPreview.js';

suite('Local preview URL', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('extracts localhost from curl output', () => {
		assert.strictEqual(
			extractLocalPreviewUrl('URL: http://127.0.0.1:5500/'),
			'http://127.0.0.1:5500/',
		);
	});

	test('extracts python http.server banner', () => {
		assert.strictEqual(
			extractLocalPreviewUrl('Serving HTTP on 127.0.0.1 port 5500 (http://127.0.0.1:5500/) ...'),
			'http://127.0.0.1:5500/',
		);
	});

	test('infers port from python http.server command', () => {
		assert.strictEqual(
			inferPreviewUrlFromCommand('python3 -m http.server 5500 --bind 127.0.0.1'),
			'http://127.0.0.1:5500/',
		);
	});

	test('ignores node inspect', () => {
		assert.strictEqual(extractLocalPreviewUrl('Debugger listening on ws://127.0.0.1:9229/uuid'), undefined);
	});

	test('extracts a clickable http url', () => {
		assert.strictEqual(extractHttpUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080/');
		assert.strictEqual(extractHttpUrl('http://127.0.0.1:8080/.'), 'http://127.0.0.1:8080/');
		assert.strictEqual(extractHttpUrl('http://127.0.0.1:8080/.The'), 'http://127.0.0.1:8080/');
		assert.strictEqual(sanitizeBrowserUrl('http://127.0.0.1:8080/.The'), 'http://127.0.0.1:8080/');
		assert.strictEqual(
			extractLocalPreviewUrl('The local preview is ready at http://127.0.0.1:8080/.The local preview is ready'),
			'http://127.0.0.1:8080/',
		);
	});

	test('strips markdown bold stars glued to a preview url', () => {
		assert.strictEqual(extractHttpUrl('http://127.0.0.1:8080/**'), 'http://127.0.0.1:8080/');
		assert.strictEqual(sanitizeBrowserUrl('http://127.0.0.1:8080/**'), 'http://127.0.0.1:8080/');
		assert.strictEqual(
			extractLocalPreviewUrl('Open **http://127.0.0.1:8080/** in the in-app browser'),
			'http://127.0.0.1:8080/',
		);
		assert.strictEqual(
			linkifyPreviewUrls('Open **http://127.0.0.1:8080/** in the in-app browser'),
			'Open [`http://127.0.0.1:8080/`](http://127.0.0.1:8080/) in the in-app browser',
		);
	});

	test('linkifies a bare preview url and keeps trailing punctuation', () => {
		assert.strictEqual(
			linkifyPreviewUrls('The project is running at http://127.0.0.1:8080/.'),
			'The project is running at [`http://127.0.0.1:8080/`](http://127.0.0.1:8080/).',
		);
		assert.strictEqual(
			linkifyPreviewUrls('ready at http://127.0.0.1:8080/.The local preview is ready'),
			'ready at [`http://127.0.0.1:8080/`](http://127.0.0.1:8080/). The local preview is ready',
		);
		assert.strictEqual(
			linkifyPreviewUrls('Open [`http://127.0.0.1:8080/`](http://127.0.0.1:8080/).'),
			'Open [`http://127.0.0.1:8080/`](http://127.0.0.1:8080/).',
		);
		assert.strictEqual(
			linkifyPreviewUrls('```\nhttp://127.0.0.1:8080/\n```'),
			'```\nhttp://127.0.0.1:8080/\n```',
		);
	});

	test('strips markdown link syntax from a preview url', () => {
		assert.strictEqual(
			extractLocalPreviewUrl('Open it here: [http://127.0.0.1:8081/](http://127.0.0.1:8081/)'),
			'http://127.0.0.1:8081/',
		);
		assert.strictEqual(
			extractLocalPreviewUrl('http://127.0.0.1:8081/](http://127.0.0.1:8081/'),
			'http://127.0.0.1:8081/',
		);
		assert.strictEqual(
			extractHttpUrl('http://127.0.0.1:8081/](http://127.0.0.1:8081/'),
			'http://127.0.0.1:8081/',
		);
		assert.strictEqual(
			sanitizeBrowserUrl('http://127.0.0.1:8081/](http://127.0.0.1:8081/'),
			'http://127.0.0.1:8081/',
		);
		assert.strictEqual(
			sanitizeBrowserUrl('[game](http://localhost:5173/)'),
			'http://localhost:5173/',
		);
		assert.strictEqual(
			sanitizeBrowserUrl('http://127.0.0.1:8081/%5D(http://127.0.0.1:8081/'),
			'http://127.0.0.1:8081/',
		);
		assert.strictEqual(
			sanitizeBrowserUrl('http://127.0.0.1:8081/(http://127.0.0.1:8081/'),
			'http://127.0.0.1:8081/',
		);
		assert.strictEqual(
			extractHttpUrl('http://127.0.0.1:8081/%5D(http://127.0.0.1:8081/'),
			'http://127.0.0.1:8081/',
		);
		assert.strictEqual(
			extractLocalPreviewUrl('http://127.0.0.1:8081/%5D(http://127.0.0.1:8081/'),
			'http://127.0.0.1:8081/',
		);
	});

	test('ignores an incomplete streaming localhost url', () => {
		assert.strictEqual(extractLocalPreviewUrl('Open it here: http://127.0.0.1'), undefined);
		assert.strictEqual(extractLocalPreviewUrl('Open it here: http://127.0.0.1:80'), undefined);
		assert.strictEqual(extractLocalPreviewUrl('Open it here: http://127.0.0.1:808'), undefined);
		assert.strictEqual(extractLocalPreviewUrl('Open it here: http://127.0.0.1:8081/'), 'http://127.0.0.1:8081/');
	});
});
