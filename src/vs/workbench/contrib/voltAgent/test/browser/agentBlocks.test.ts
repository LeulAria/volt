/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyFileTargetToActivity, collectBlocks, createToolBlock, IAgentActivityItem, isExploreTool, isFileChangeTool, parseFileTarget, splitActivityLabel } from '../../browser/blocks/agentBlocks.js';

suite('Agent explore tool cards', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('treats Find and Read File as explore tools', () => {
		assert.strictEqual(isExploreTool('Find'), true);
		assert.strictEqual(isExploreTool('Read File'), true);
		assert.strictEqual(isExploreTool('read_file'), true);
		assert.strictEqual(isExploreTool('Grep'), true);
		assert.strictEqual(isExploreTool('Glob'), true);
		assert.strictEqual(isExploreTool('WebFetch'), true);
		assert.strictEqual(isExploreTool('List MCP Resources'), true);
	});

	test('keeps mutating tools visible', () => {
		assert.strictEqual(isExploreTool('Edit'), false);
		assert.strictEqual(isExploreTool('StrReplace'), false);
		assert.strictEqual(isExploreTool('Write'), false);
		assert.strictEqual(isFileChangeTool('Edit'), true);
		assert.strictEqual(isFileChangeTool('StrReplace'), true);
		assert.strictEqual(isFileChangeTool('Write'), true);
		assert.strictEqual(isFileChangeTool('Read File'), false);
	});

	test('collectBlocks hides explore pills from the response body', () => {
		const blocks = collectBlocks([
			{
				kind: 'block',
				block: createToolBlock({ id: 'find', callId: '1', name: 'Find', title: 'Find' }),
			},
			{
				kind: 'block',
				block: createToolBlock({ id: 'read', callId: '2', name: 'Read', title: 'Read File' }),
			},
			{
				kind: 'block',
				block: createToolBlock({ id: 'edit', callId: '3', name: 'Edit', title: 'Edit' }),
			},
		]);
		assert.deepStrictEqual(blocks.map(block => block.id), ['edit']);
	});
});

suite('Agent file activity labels', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('does not treat Read File as a file named File', () => {
		assert.deepStrictEqual(splitActivityLabel('Read', 'Read File'), { label: 'Read File' });
	});

	test('parses target_file and file_path from tool input', () => {
		assert.deepStrictEqual(parseFileTarget('{"target_file":"src/app.ts","offset":10}'), {
			path: 'src/app.ts',
			startLine: 10,
			endLine: undefined,
		});
		assert.deepStrictEqual(parseFileTarget('{"file_path":"/tmp/index.html"}')?.path, '/tmp/index.html');
	});

	test('uses the file name as the clickable detail', () => {
		const split = splitActivityLabel('Read', 'Read File', { path: 'src/package.json', startLine: 4, endLine: 20 });
		assert.deepStrictEqual(split, { label: 'Read', detail: 'package.json L4-20' });
	});

	test('applies a streamed path onto a Read File activity', () => {
		const item: IAgentActivityItem = { kind: 'read', label: 'Read File' };
		assert.strictEqual(applyFileTargetToActivity(item, parseFileTarget('{"path":"src/vs/workbench/contrib/voltAgent/browser/agentEditor.ts"}')), true);
		assert.strictEqual(item.label, 'Read');
		assert.strictEqual(item.detail, 'agentEditor.ts');
		assert.ok(item.path?.endsWith('agentEditor.ts'));
	});
});
