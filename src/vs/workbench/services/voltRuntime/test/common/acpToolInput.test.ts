/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { collectAcpToolInput, mergeToolInput } from '../../common/acpToolInput.js';

suite('ACP tool input', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads Cursor-style rawInput for Find', () => {
		const input = collectAcpToolInput({
			sessionUpdate: 'tool_call',
			title: 'Find',
			kind: 'search',
			rawInput: { pattern: '**/*.{ts,tsx,css}', path: '.alnsp' },
		});
		assert.deepStrictEqual(JSON.parse(input!), { pattern: '**/*.{ts,tsx,css}', path: '.alnsp' });
	});

	test('reads t3code nested item.input and locations', () => {
		const input = collectAcpToolInput({
			title: 'Read File',
			kind: 'read',
			item: { input: { target_file: 'src/app.ts', offset: 10 } },
			locations: [{ path: '/tmp/app.ts', line: 10 }],
		});
		assert.deepStrictEqual(JSON.parse(input!), { target_file: 'src/app.ts', offset: 10, files: ['/tmp/app.ts'] });
	});

	test('reads pi-style _meta.rawInput for grep', () => {
		const input = collectAcpToolInput({
			title: 'grep',
			kind: 'search',
			_meta: { rawInput: { pattern: 'contextUsage', path: 't3code', glob: '*.ts' } },
		});
		assert.deepStrictEqual(JSON.parse(input!), { pattern: 'contextUsage', path: 't3code', glob: '*.ts' });
	});

	test('fills path from locations when rawInput has no file', () => {
		const input = collectAcpToolInput({
			title: 'Read File',
			kind: 'read',
			rawInput: {},
			locations: [{ path: 'src/browserDock.ts', line: 430 }],
		});
		assert.deepStrictEqual(JSON.parse(input!), { path: 'src/browserDock.ts', line: 430, files: ['src/browserDock.ts'] });
	});

	test('collects every location path for the grep hover list', () => {
		const input = collectAcpToolInput({
			title: 'grep',
			rawInput: { pattern: 'DiffEditorWidget', path: 'src' },
			locations: [
				{ path: 'src/vs/workbench/contrib/chat/browser/codeBlockPart.ts' },
				{ path: 'src/vs/workbench/contrib/chat/browser/chatWidget.ts' },
			],
		});
		assert.deepStrictEqual(JSON.parse(input!), {
			pattern: 'DiffEditorWidget',
			path: 'src',
			files: [
				'src/vs/workbench/contrib/chat/browser/codeBlockPart.ts',
				'src/vs/workbench/contrib/chat/browser/chatWidget.ts',
			],
		});
	});

	test('does not let later location-only updates overwrite a grep directory', () => {
		const start = collectAcpToolInput({
			title: 'grep',
			rawInput: { pattern: 'token.usage', path: '.alnsp' },
		});
		const update = collectAcpToolInput({
			title: 'grep',
			locations: [{ path: 'src/agentEditor.ts', line: 12 }],
		});
		const merged = mergeToolInput(start, update);
		assert.deepStrictEqual(JSON.parse(merged!), { pattern: 'token.usage', path: '.alnsp', files: ['src/agentEditor.ts'] });
	});

	test('merges streamed JSON fragments', () => {
		assert.strictEqual(
			mergeToolInput('{"pattern":"foo"', ',"path":"src"}'),
			'{"pattern":"foo","path":"src"}',
		);
	});
});
