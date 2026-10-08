/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { acpResourceBlock, attachmentSavedLine, inlineResourceContext, MAX_EMBEDDED_RESOURCE_CHARS } from '../../common/fileAttachments.js';

suite('fileAttachments', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const paste = { uri: 'file:///att/abc.json', name: 'Pasted text', mimeType: 'application/json', size: 60_000, text: '{"a": 1}' };

	test('a folded paste travels inside the prompt to agents with embedded context', () => {
		assert.deepStrictEqual(acpResourceBlock(paste, true), { type: 'resource', resource: { uri: paste.uri, mimeType: 'application/json', text: '{"a": 1}' } });
	});

	test('agents without embedded context get a link they can read', () => {
		assert.deepStrictEqual(acpResourceBlock(paste, false), { type: 'resource_link', uri: paste.uri, name: 'Pasted text', mimeType: 'application/json', size: 60_000 });
		// A file without its text (a PDF) is always a link.
		assert.strictEqual(acpResourceBlock({ uri: 'file:///att/r.pdf', name: 'r.pdf' }, true).type, 'resource_link');
		// So is a paste too large to inline.
		assert.strictEqual(acpResourceBlock({ ...paste, text: 'x'.repeat(MAX_EMBEDDED_RESOURCE_CHARS + 1) }, true).type, 'resource_link');
	});

	test('models Volt runs itself read the paste as context after the prompt', () => {
		assert.strictEqual(inlineResourceContext([paste, { uri: 'file:///att/r.pdf', name: 'r.pdf' }]), '<context ref="file:///att/abc.json">\n{"a": 1}\n</context>');
		assert.strictEqual(inlineResourceContext(undefined), '');
	});

	test('the saved-path line names the paste\'s language and line count', () => {
		assert.strictEqual(
			attachmentSavedLine({ kind: 'file', name: 'Pasted text', size: 48 * 1024, path: '/a/1.json', pasted: true, lines: 1203, languageLabel: 'JSON' }, 1),
			'[File #1 "Pasted text" (pasted text, JSON, 48 KB, 1,203 lines) is saved at: /a/1.json]',
		);
	});
});
