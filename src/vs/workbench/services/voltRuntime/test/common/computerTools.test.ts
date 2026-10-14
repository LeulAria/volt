/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { COMPUTER_TOOLS, formatComputerNode, formatComputerTree, parseComputerActions, pickApp } from '../../common/computerTools.js';

suite('Volt computer use', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('acting tools need approval in read-only modes; reading tools do not', () => {
		const gated = COMPUTER_TOOLS.filter(tool => tool.approvalInReadOnlyModes).map(tool => tool.name);
		assert.deepStrictEqual(gated, ['computer_act', 'computer_input']);
		assert.ok(COMPUTER_TOOLS.every(tool => tool.group === 'computer'));
	});

	test('accessibility nodes read as one line each', () => {
		assert.strictEqual(formatComputerNode({ id: 'w.0.3', role: 'Button', depth: 2, name: 'Save', actions: ['press'], frame: { x: 10, y: 20, w: 60, h: 24 } }), '    [w.0.3] Button "Save" actions=[press] at 10,20 60×24');
		assert.strictEqual(formatComputerNode({ id: 'w.1', role: 'TextField', depth: 1, value: 'x'.repeat(100), focused: true, disabled: true }), `  [w.1] TextField value="${'x'.repeat(77)}…" disabled focused`);
		const tree = formatComputerTree('Notes — Untitled', [{ id: 'w', role: 'Window', depth: 0, name: 'Untitled' }, { id: 'w.0', role: 'Button', depth: 1, name: 'New Note', actions: ['press'] }], true, 'new note');
		assert.strictEqual(tree.split('\n')[0], '### Notes — Untitled: 2 element(s), 1 matching "new note" (cut at the limit; pass filter or a lower max_depth)');
		assert.strictEqual(tree.split('\n').length, 2);
	});

	test('input steps are validated before anything moves', () => {
		assert.deepStrictEqual(parseComputerActions([{ click: { x: 1, y: 2 } }, { key: 'cmd+shift+s' }, { type: 'hi' }, { scroll: { dy: 3 } }, { wait: 100 }, { drag: { from: { x: 0, y: 0 }, to: { x: 5, y: 5 } } }]).errors, []);
		const bad = parseComputerActions([{ click: { x: 'a' } }, { key: 'cmd+' }, { fly: 1 }, { drag: { from: { x: 1, y: 1 } } }]);
		assert.strictEqual(bad.errors.length, 4);
		assert.strictEqual(bad.actions.length, 0);
		assert.match(parseComputerActions([]).errors[0], /non-empty/);
	});

	test('apps by pid, bundle id, exact or partial name, or the frontmost one', () => {
		const apps = [{ name: 'Notes', bundleId: 'com.apple.Notes', pid: 10, active: false }, { name: 'Google Chrome', bundleId: 'com.google.Chrome', pid: 20, active: true }];
		assert.strictEqual(pickApp(apps, '10')?.name, 'Notes');
		assert.strictEqual(pickApp(apps, 'com.google.chrome')?.pid, 20);
		assert.strictEqual(pickApp(apps, 'notes')?.pid, 10);
		assert.strictEqual(pickApp(apps, 'chrome')?.pid, 20);
		assert.strictEqual(pickApp(apps, undefined)?.pid, 20);
		assert.strictEqual(pickApp(apps, 'Safari'), undefined);
	});
});
