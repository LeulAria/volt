/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createFileChangeBlock, createTerminalBlock } from '../../browser/blocks/agentBlocks.js';
import { buildThreadParts, fileChangeGroupTitle, isProcessNarration, partitionAssistantText } from '../../browser/agentTimeline.js';

suite('Agent timeline', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('folds harness and MCP narration into thought', () => {
		assert.strictEqual(isProcessNarration('No browser MCP tools are available. The in-app browser cannot be used to open the URL.'), true);
		assert.strictEqual(isProcessNarration('Preparing to run the project per Volt\'s instructions. Skipping repo-wide search.'), true);
		assert.strictEqual(isProcessNarration('I\'ll inspect the project to see what it is and how to start it.'), false);
	});

	test('keeps the URL reply visible', () => {
		const parts = partitionAssistantText([
			'No browser MCP tools are available. The in-app browser cannot be used to open the URL.',
			'The 2048 game is running at http://127.0.0.1:8080/.',
		].join('\n\n'));
		assert.deepStrictEqual(parts.map(part => part.kind), ['thought', 'reply']);
		assert.ok(parts[1].text.includes('127.0.0.1:8080'));
	});

	test('interleaves collapsed explore groups with the visible reply and terminal', () => {
		const parts = buildThreadParts([
			{ kind: 'thought', text: 'Exploring the workspace to identify the project type.' },
			{ kind: 'activity', item: { kind: 'search', label: 'Searched', detail: '*' } },
			{ kind: 'activity', item: { kind: 'read', label: 'Read', detail: 'index.html' } },
			{ kind: 'text', text: 'It\'s a standalone 2048 game.\n\nNo browser MCP tools are available.\n\nThe 2048 game is running at http://127.0.0.1:8080/.' },
			{
				kind: 'block',
				block: createTerminalBlock({
					id: 'term',
					callId: '1',
					title: 'Start HTTP server',
					command: 'python3 -m http.server 8080',
					output: '',
				}),
			},
		]);
		assert.strictEqual(parts[0].kind, 'group');
		assert.ok(parts[0].kind === 'group' && /Explored/.test(parts[0].title));
		assert.strictEqual(parts[1].kind, 'markdown');
		assert.ok(parts[1].kind === 'markdown' && parts[1].content.includes('standalone 2048'));
		assert.ok(parts.some(part => part.kind === 'markdown' && part.content.includes('127.0.0.1:8080')));
		assert.ok(parts.some(part => part.kind === 'block' && part.block.type === 'terminal'));
		assert.ok(!parts.some(part => part.kind === 'markdown' && /MCP/.test(part.content)));
	});

	test('lifts snapshot activity out of the explore group', () => {
		const parts = buildThreadParts([
			{ kind: 'activity', item: { kind: 'search', label: 'Searched', detail: '*' } },
			{ kind: 'activity', item: { kind: 'browser', label: 'Took snapshot', image: 'data:image/png;base64,abc' } },
			{ kind: 'text', text: 'The 2048 game is running at http://127.0.0.1:8080/.' },
		]);
		assert.strictEqual(parts[0].kind, 'group');
		assert.ok(parts[0].kind === 'group' && /Explored/.test(parts[0].title));
		assert.strictEqual(parts[1].kind, 'snapshot');
		assert.ok(parts[1].kind === 'snapshot' && parts[1].item.image?.startsWith('data:image/'));
		assert.strictEqual(parts[2].kind, 'markdown');
	});

	test('keeps a streaming snapshot as the tail instead of an extra thinking group', () => {
		const parts = buildThreadParts([
			{ kind: 'activity', item: { kind: 'browser', label: 'Took snapshot' } },
		], undefined, true);
		assert.strictEqual(parts.length, 1);
		assert.strictEqual(parts[0].kind, 'snapshot');
	});

	test('names a single read after the file', () => {
		const parts = buildThreadParts([
			{ kind: 'activity', item: { kind: 'read', label: 'Read', detail: 'package.json', path: 'src/package.json' } },
		]);
		assert.ok(parts[0].kind === 'group' && parts[0].title === 'Explored package.json');
		assert.ok(parts[0].kind === 'group' && parts[0].items[0].path === 'src/package.json');
	});

	test('shows thinking immediately while streaming with no content yet', () => {
		const parts = buildThreadParts([], undefined, true);
		assert.strictEqual(parts.length, 1);
		assert.ok(parts[0].kind === 'group' && parts[0].title === 'Thinking');
	});

	test('keeps a trailing thinking group after a terminal while streaming', () => {
		const parts = buildThreadParts([
			{ kind: 'text', text: 'I\'ll start the local server.' },
			{
				kind: 'block',
				block: createTerminalBlock({
					id: 'term',
					callId: '1',
					title: 'Start HTTP server',
					command: 'python3 -m http.server 8080',
					output: '',
				}),
			},
		], undefined, true);
		const last = parts.at(-1);
		assert.ok(last?.kind === 'group' && last.title === 'Thinking');
		assert.ok(parts.some(part => part.kind === 'block' && part.block.type === 'terminal'));
	});

	test('groups multiple file edits into an expandable changes summary', () => {
		const parts = buildThreadParts([
			{
				kind: 'block',
				block: createFileChangeBlock({
					id: 'f1',
					callId: '1',
					path: 'src/TariffPackageSelector.tsx',
					verb: 'Edited',
					original: 'a\n',
					modified: 'b\n',
				}),
			},
			{
				kind: 'block',
				block: createFileChangeBlock({
					id: 'f2',
					callId: '2',
					path: 'src/TariffPackageSelector.tsx',
					verb: 'Edited',
					original: 'onToggle={togglePackage(roomPackageField)}',
					modified: 'onToggle={togglePackage(\n  roomPackageField.field.onChange,\n  roomPackage,\n)}',
				}),
			},
			{
				kind: 'block',
				block: createTerminalBlock({
					id: 'term',
					callId: '3',
					title: 'Run tests',
					command: 'npm test',
					output: '',
				}),
			},
		]);
		const group = parts.find(part => part.kind === 'changes');
		assert.ok(group && group.kind === 'changes');
		assert.strictEqual(group.files.length, 2);
		assert.strictEqual(group.commands.length, 1);
		assert.ok(group.additions >= 1);
		assert.ok(/Editing 2 files/.test(fileChangeGroupTitle(group.files.length, group.commands.length, group.additions, group.deletions)));
		assert.ok(/ran 1 command/.test(fileChangeGroupTitle(group.files.length, group.commands.length, group.additions, group.deletions)));
	});

	test('keeps a single file edit as its own preview card', () => {
		const parts = buildThreadParts([
			{
				kind: 'block',
				block: createFileChangeBlock({
					id: 'f1',
					path: 'src/app.ts',
					verb: 'Edited',
					original: 'a',
					modified: 'b',
				}),
			},
		]);
		assert.strictEqual(parts.length, 1);
		assert.ok(parts[0].kind === 'block' && parts[0].block.type === 'file');
	});
});
