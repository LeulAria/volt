/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyAgentStatusbarShift, resetAgentStatusbarShift } from '../../../../browser/parts/titlebar/agentLayoutChrome.js';

suite('Agent layout chrome', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('shifts the status bar by the sidebar width', () => {
		const root = document.createElement('div');
		const wrap = document.createElement('div');
		const status = document.createElement('div');
		status.className = 'part statusbar';
		status.style.height = '22px';
		wrap.appendChild(status);
		root.appendChild(wrap);

		applyAgentStatusbarShift(root, 240);

		assert.strictEqual(root.style.getPropertyValue('--volt-agent-sidebar-width'), '240px');
		assert.strictEqual(root.style.getPropertyValue('--volt-agent-statusbar-height'), '22px');
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
		root.style.setProperty('--volt-agent-statusbar-height', '22px');

		resetAgentStatusbarShift(root);

		assert.strictEqual(root.style.getPropertyValue('--volt-agent-sidebar-width'), '');
		assert.strictEqual(root.style.getPropertyValue('--volt-agent-statusbar-height'), '');
		assert.strictEqual(wrap.style.left, '');
		assert.strictEqual(wrap.style.width, '');
	});
});
