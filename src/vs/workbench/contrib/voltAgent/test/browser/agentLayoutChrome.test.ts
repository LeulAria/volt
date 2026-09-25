/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyAgentStatusbarShift, getAgentRightDockInset, resetAgentStatusbarShift } from '../../../../browser/parts/titlebar/agentLayoutChrome.js';

suite('Agent layout chrome', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('records the sidebar width for agent chrome', () => {
		const root = document.createElement('div');

		applyAgentStatusbarShift(root, 240);

		assert.strictEqual(root.style.getPropertyValue('--volt-agent-sidebar-width'), '240px');
		assert.strictEqual(root.style.getPropertyValue('--volt-agent-statusbar-height'), '');
	});

	test('clears leftover status bar shift when leaving agent layout', () => {
		const root = document.createElement('div');
		const wrap = document.createElement('div');
		const status = document.createElement('div');
		status.className = 'part statusbar';
		wrap.style.left = '240px';
		wrap.style.width = 'calc(100% - 240px)';
		wrap.appendChild(status);
		root.appendChild(wrap);
		root.style.setProperty('--volt-agent-sidebar-width', '240px');
		root.style.setProperty('--volt-agent-right-dock-width', '46px');
		root.style.setProperty('--volt-agent-statusbar-height', '22px');
		root.classList.add('volt-agent-right-collapsed');

		resetAgentStatusbarShift(root);

		assert.strictEqual(root.style.getPropertyValue('--volt-agent-sidebar-width'), '');
		assert.strictEqual(root.style.getPropertyValue('--volt-agent-right-dock-width'), '');
		assert.strictEqual(root.style.getPropertyValue('--volt-agent-statusbar-height'), '');
		assert.strictEqual(root.classList.contains('volt-agent-right-collapsed'), false);
		assert.strictEqual(wrap.style.left, '');
		assert.strictEqual(wrap.style.width, '');
	});

	test('reserves editor space for the agent right dock', () => {
		const root = document.createElement('div');
		root.style.setProperty('--volt-agent-right-dock-width', '252px');

		assert.strictEqual(getAgentRightDockInset(root), 0);

		root.classList.add('volt-layout-agent');

		assert.strictEqual(getAgentRightDockInset(root), 252);
	});
});
