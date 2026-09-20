/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	agentSearchTitle,
	buildSearchSections,
	fileParentPath,
	flattenSearchItems,
	formatCompactAge,
	IAgentSearchItem,
	matchesSearchQuery,
	nextSearchFilter,
	previousSearchFilter,
	settingDisplayName,
} from '../../browser/search/agentSearchModel.js';

function item(kind: IAgentSearchItem['kind'], label: string, id = label): IAgentSearchItem {
	return { id, kind, label };
}

suite('Agent search palette', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('cycles filters with bracket shortcuts', () => {
		assert.strictEqual(nextSearchFilter('all'), 'agents');
		assert.strictEqual(nextSearchFilter('settings'), 'all');
		assert.strictEqual(previousSearchFilter('all'), 'settings');
		assert.strictEqual(previousSearchFilter('files'), 'agents');
	});

	test('formats compact ages like 5m / 1h', () => {
		const now = Date.parse('2026-09-20T14:00:00Z');
		assert.strictEqual(formatCompactAge(now - 12_000, now), 'now');
		assert.strictEqual(formatCompactAge(now - 5 * 60_000, now), '5m');
		assert.strictEqual(formatCompactAge(now - 14 * 60_000, now), '14m');
		assert.strictEqual(formatCompactAge(now - 60 * 60_000, now), '1h');
		assert.strictEqual(formatCompactAge(now - 3 * 60 * 60_000, now), '3h');
		assert.strictEqual(formatCompactAge(now - 2 * 24 * 60 * 60_000, now), '2d');
	});

	test('shows the parent folder for recent files', () => {
		assert.strictEqual(fileParentPath('todo.md'), '');
		assert.strictEqual(fileParentPath('src/vs/workbench/contrib/chat/browser/codeBlockPart.ts'), 'src/vs/workbench/contrib/chat/browser');
		assert.strictEqual(fileParentPath('src\\vs\\workbench\\contrib\\voltAgent\\browser\\media\\agentEditor.css'), 'src/vs/workbench/contrib/voltAgent/browser/media');
	});

	test('idle All view is recent agents and files only', () => {
		const agents = Array.from({ length: 8 }, (_, i) => item('agent', `Agent ${i}`));
		const files = Array.from({ length: 8 }, (_, i) => item('file', `file-${i}.ts`));
		const sections = buildSearchSections('all', '', agents, files, [item('action', 'Show All Commands')], [item('setting', 'editor.fontSize')]);
		assert.deepStrictEqual(sections.map(section => section.title), ['Recent Agents', 'Recent Files']);
		assert.deepStrictEqual(sections.map(section => section.items.length), [5, 5]);
		assert.strictEqual(flattenSearchItems(sections).length, 10);
	});

	test('All search mixes matching categories and hides empty ones', () => {
		const sections = buildSearchSections(
			'all',
			'todo',
			[item('agent', 'Fix todo list')],
			[item('file', 'todo.md')],
			[],
			[item('setting', 'files.autoSave')],
		);
		assert.deepStrictEqual(sections.map(section => section.title), ['Agents', 'Files', 'Settings']);
	});

	test('filter tabs isolate a single category', () => {
		const agents = [item('agent', 'Gateway setup')];
		const files = [item('file', 'todo.md')];
		const actions = [item('action', 'Show All Commands')];
		assert.deepStrictEqual(buildSearchSections('agents', '', agents, files, actions, []).map(s => s.title), ['Recent Agents']);
		assert.deepStrictEqual(buildSearchSections('files', 'todo', agents, files, actions, []).map(s => s.title), ['Files']);
		assert.deepStrictEqual(buildSearchSections('actions', '', agents, files, actions, []).map(s => s.title), ['Actions']);
	});

	test('matches titles fuzzily and prefers a real session title', () => {
		assert.ok(matchesSearchQuery('vgs', 'Vercel AI Gateway setup'));
		assert.ok(matchesSearchQuery('todo', 'todo.md', 'src/todo.md'));
		assert.ok(!matchesSearchQuery('xyz', 'todo.md'));
		assert.strictEqual(agentSearchTitle({ title: 'Gateway setup', preview: 'please set up', id: 's1' }), 'Gateway setup');
		assert.strictEqual(agentSearchTitle({ title: '', preview: 'please set up', id: 's1' }), 'please set up');
	});

	test('setting names stay short enough for the list', () => {
		assert.strictEqual(settingDisplayName('editor.fontSize', 'Controls the font size in pixels.'), 'Controls the font size in pixels');
		assert.strictEqual(settingDisplayName('editor.fontSize', 'A'.repeat(80)), 'editor.fontSize');
	});
});
