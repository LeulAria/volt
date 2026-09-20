/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyExploreInputToActivity, applyExploreResultToActivity, applyFileTargetToActivity, classifyToolActivity, collectBlocks, createToolBlock, describeExploreActivity, IAgentActivityItem, isExploreItemClickable, isExploreTool, isFileChangeTool, isShellTool, parseExploreResultFiles, parseFileTarget, splitActivityLabel, workCountsForSegments } from '../../browser/blocks/agentBlocks.js';

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

	test('counts work from segments for the status line', () => {
		const counts = workCountsForSegments([
			{ kind: 'activity', item: { kind: 'read', label: 'Read', detail: 'a.ts' } },
			{ kind: 'activity', item: { kind: 'search', label: 'Searched' } },
			{ kind: 'block', block: createToolBlock({ id: 'edit', callId: '3', name: 'Edit', title: 'Edit' }) },
		]);
		assert.strictEqual(counts.reads, 1);
		assert.strictEqual(counts.searches, 1);
	});

	test('classifies mystery tools from activity kind', () => {
		assert.strictEqual(isExploreTool('mystery', undefined, 'read'), true);
		assert.strictEqual(isExploreTool('Read File', undefined, 'edit'), false);
		assert.strictEqual(isFileChangeTool('mystery', undefined, 'edit'), true);
		assert.strictEqual(isFileChangeTool('Edit', undefined, 'read'), false);
		assert.strictEqual(isShellTool('bash', undefined, undefined, 'execute'), true);
		assert.strictEqual(isShellTool('bash', undefined, undefined, 'read'), false);
		assert.strictEqual(classifyToolActivity('mystery', undefined, 'search'), 'search');
	});

	test('treats edit tools as file changes', () => {
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
		assert.strictEqual(applyFileTargetToActivity(item, parseFileTarget('{"path":"src/vs/workbench/contrib/voltAgent/browser/editor/agentEditor.ts"}')), true);
		assert.strictEqual(item.label, 'Read');
		assert.strictEqual(item.detail, 'agentEditor.ts');
		assert.ok(item.path?.endsWith('agentEditor.ts'));
	});
});

suite('Agent explore activity details', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('formats Find glob searches like Cursor', () => {
		const described = describeExploreActivity('Find', 'Find', '{"pattern":"**/*.{ts,tsx,css}","path":".alnsp"}');
		assert.strictEqual(described.label, 'Searched files');
		assert.strictEqual(described.detail, '**/*.{ts,tsx,css} in .alnsp');
		assert.strictEqual(described.clickable, false);
	});

	test('formats grep pattern and directory', () => {
		const described = describeExploreActivity('grep', 'grep', '{"pattern":"contextUsage","path":"t3code"}');
		assert.strictEqual(described.label, 'Grepped');
		assert.strictEqual(described.detail, 'contextUsage in t3code');
		assert.strictEqual(described.clickable, false);
	});

	test('formats read with offset and limit', () => {
		const described = describeExploreActivity('Read File', 'Read File', '{"path":"src/agentEditor.ts","offset":300,"limit":150}');
		assert.strictEqual(described.label, 'Read');
		assert.strictEqual(described.detail, 'agentEditor.ts L300-449');
		assert.strictEqual(described.path, 'src/agentEditor.ts');
		assert.strictEqual(described.startLine, 300);
		assert.strictEqual(described.endLine, 449);
		assert.strictEqual(described.clickable, true);
	});

	test('applies streamed rawInput onto a generic grep row', () => {
		const item: IAgentActivityItem = { kind: 'search', label: 'grep', toolName: 'grep', toolTitle: 'grep' };
		assert.strictEqual(applyExploreInputToActivity(item, 'grep', 'grep', '{"pattern":"token.?usage","path":".alnsp"}'), true);
		assert.strictEqual(item.label, 'Grepped');
		assert.strictEqual(item.detail, 'token.?usage in .alnsp');
		assert.strictEqual(isExploreItemClickable(item), false);
	});

	test('read rows stay clickable after a later input update', () => {
		const item: IAgentActivityItem = { kind: 'read', label: 'Read File', toolName: 'Read File', toolTitle: 'Read File' };
		applyExploreInputToActivity(item, 'Read File', 'Read File', '{"target_file":"browserDock.ts","offset":430,"limit":80}');
		assert.strictEqual(item.detail, 'browserDock.ts L430-509');
		assert.strictEqual(isExploreItemClickable(item), true);
	});

	test('keeps grep hit files from tool input', () => {
		const described = describeExploreActivity('grep', 'grep', JSON.stringify({
			pattern: 'DiffEditorWidget',
			path: 'src',
			files: [
				'src/vs/workbench/contrib/chat/browser/codeBlockPart.ts',
				'src/vs/workbench/contrib/chat/browser/chatWidget.ts',
			],
		}));
		assert.strictEqual(described.label, 'Grepped');
		assert.strictEqual(described.detail, 'DiffEditorWidget in src');
		assert.deepStrictEqual(described.files, [
			'src/vs/workbench/contrib/chat/browser/codeBlockPart.ts',
			'src/vs/workbench/contrib/chat/browser/chatWidget.ts',
		]);
	});

	test('parses grep result paths from text and locations', () => {
		assert.deepStrictEqual(parseExploreResultFiles([
			'src/vs/workbench/contrib/chat/browser/codeBlockPart.ts:520:export class CodeCompareBlockPart',
			{ path: 'src/vs/workbench/contrib/chat/browser/chatWidget.ts' },
		]), [
			'src/vs/workbench/contrib/chat/browser/codeBlockPart.ts',
			'src/vs/workbench/contrib/chat/browser/chatWidget.ts',
		]);
	});

	test('fills a Read File row from the tool result path', () => {
		const item: IAgentActivityItem = { kind: 'read', label: 'Read File', toolName: 'Read File', toolTitle: 'Read File' };
		applyExploreResultToActivity(item, [{ path: 'src/codeBlockPart.ts' }]);
		assert.strictEqual(item.label, 'Read');
		assert.strictEqual(item.detail, 'codeBlockPart.ts');
		assert.strictEqual(item.path, 'src/codeBlockPart.ts');
		assert.strictEqual(isExploreItemClickable(item), true);
	});

	test('keeps grep hits when a later input update has no files', () => {
		const item: IAgentActivityItem = { kind: 'search', label: 'grep', toolName: 'grep', toolTitle: 'grep' };
		applyExploreInputToActivity(item, 'grep', 'grep', JSON.stringify({
			pattern: 'DiffEditorWidget',
			path: 'src',
			files: ['src/vs/workbench/contrib/chat/browser/codeBlockPart.ts'],
		}));
		applyExploreInputToActivity(item, 'grep', 'grep', JSON.stringify({
			pattern: 'DiffEditorWidget',
			path: 'src',
		}));
		assert.strictEqual(item.label, 'Grepped');
		assert.deepStrictEqual(item.files, ['src/vs/workbench/contrib/chat/browser/codeBlockPart.ts']);
	});

	test('adds grep result paths without losing the pattern', () => {
		const item: IAgentActivityItem = { kind: 'search', label: 'grep', toolName: 'grep', toolTitle: 'grep' };
		applyExploreInputToActivity(item, 'grep', 'grep', '{"pattern":"CodeEditorWidget","path":"chat"}');
		applyExploreResultToActivity(item, ['src/vs/workbench/contrib/chat/browser/chatWidget.ts:12:class ChatWidget'], item.input);
		assert.strictEqual(item.label, 'Grepped');
		assert.strictEqual(item.detail, 'CodeEditorWidget in chat');
		assert.deepStrictEqual(item.files, ['src/vs/workbench/contrib/chat/browser/chatWidget.ts']);
	});
});
