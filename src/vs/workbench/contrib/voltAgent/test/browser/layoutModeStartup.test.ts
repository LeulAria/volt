/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { stampLayoutModeChrome } from '../../../../browser/parts/titlebar/agentLayoutChrome.js';
import { agentStartupSidebarWidth, readStoredLayoutModeValue } from '../../../../browser/parts/titlebar/layoutModeStartup.js';
import { isAgentPartsSplash } from '../../../../../platform/theme/common/themeService.js';

suite('Layout mode startup', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('stored mode wins over sidebar side', () => {
		assert.strictEqual(readStoredLayoutModeValue('agent', false), 'agent');
		assert.strictEqual(readStoredLayoutModeValue('ide', true), 'ide');
	});

	test('falls back to sidebar side when nothing is stored', () => {
		assert.strictEqual(readStoredLayoutModeValue('', true), 'agent');
		assert.strictEqual(readStoredLayoutModeValue('', false), 'ide');
	});

	test('keeps a saved agent list width and clamps it to the window', () => {
		assert.strictEqual(agentStartupSidebarWidth(360, false, { min: 180, max: 420, fallback: 290 }), 360);
		assert.strictEqual(agentStartupSidebarWidth(800, false, { min: 180, max: 420, fallback: 290 }), 420);
		assert.strictEqual(agentStartupSidebarWidth(40, false, { min: 180, max: 420, fallback: 290 }), 290);
	});

	test('uses zero width when the agent list is hidden', () => {
		assert.strictEqual(agentStartupSidebarWidth(360, true, { min: 180, max: 420, fallback: 290 }), 0);
	});

	test('stamps agent chrome before the first paint', () => {
		const root = document.createElement('div');

		stampLayoutModeChrome(root, true, 290, 35);

		assert.strictEqual(root.dataset.voltLayoutMode, 'agent');
		assert.strictEqual(root.classList.contains('volt-layout-agent'), true);
		assert.strictEqual(root.classList.contains('volt-agent-left-collapsed'), false);
		assert.strictEqual(root.classList.contains('volt-primary-sidebar-toggle-in-titlebar'), false);
		assert.strictEqual(root.style.getPropertyValue('--volt-agent-sidebar-width'), '290px');
		assert.strictEqual(root.style.getPropertyValue('--volt-agent-titlebar-height'), '35px');

		stampLayoutModeChrome(root, true, 0, 35);

		assert.strictEqual(root.classList.contains('volt-agent-left-collapsed'), true);
		assert.strictEqual(root.classList.contains('volt-primary-sidebar-toggle-in-titlebar'), true);
		assert.strictEqual(root.style.getPropertyValue('--volt-agent-sidebar-width'), '0px');
	});

	test('keeps a saved agent splash from being treated as an IDE sidebar', () => {
		const layoutInfo = {
			sideBarSide: 'right',
			editorPartMinWidth: 220,
			titleBarHeight: 35,
			activityBarWidth: 0,
			sideBarWidth: 0,
			auxiliaryBarWidth: 290,
			statusBarHeight: 0,
			windowBorder: false,
			windowBorderRadius: undefined,
		};

		assert.strictEqual(isAgentPartsSplash(layoutInfo), true);
		assert.strictEqual(isAgentPartsSplash({ ...layoutInfo, agentLayout: true, sideBarWidth: 334 }), true);
		assert.strictEqual(isAgentPartsSplash({ ...layoutInfo, agentLayout: false }), false);
		assert.strictEqual(isAgentPartsSplash({ ...layoutInfo, sideBarSide: 'left' }), false);
	});

	test('stamps ide chrome without agent offsets', () => {
		const root = document.createElement('div');
		stampLayoutModeChrome(root, true, 290, 35);

		stampLayoutModeChrome(root, false, 0);

		assert.strictEqual(root.dataset.voltLayoutMode, 'ide');
		assert.strictEqual(root.classList.contains('volt-layout-agent'), false);
		assert.strictEqual(root.style.getPropertyValue('--volt-agent-sidebar-width'), '');
		assert.strictEqual(root.style.getPropertyValue('--volt-agent-titlebar-height'), '');
	});
});
