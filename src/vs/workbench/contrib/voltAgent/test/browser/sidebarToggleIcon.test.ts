/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PRIMARY_SIDEBAR_TOGGLE_CLOSED_BAR_PATH, PRIMARY_SIDEBAR_TOGGLE_CLOSED_FRAME_PATH, PRIMARY_SIDEBAR_TOGGLE_OPEN_DIVIDER_PATH, agentPrimarySidebarToggleInTitlebar, createPrimarySidebarToggleIcon } from '../../../../browser/parts/titlebar/sidebarToggleIcon.js';

suite('Primary sidebar toggle', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the stroked panel glyph while the sidebar is open', () => {
		const icon = createPrimarySidebarToggleIcon(document.createElement('div'), 'open');
		const frame = icon.querySelector('rect');
		const divider = icon.querySelector('path');

		assert.strictEqual(icon.getAttribute('viewBox'), '0 0 24 24');
		assert.strictEqual(icon.getAttribute('fill'), 'none');
		assert.strictEqual(frame?.getAttribute('x'), '2');
		assert.strictEqual(frame?.getAttribute('y'), '3');
		assert.strictEqual(frame?.getAttribute('width'), '20');
		assert.strictEqual(frame?.getAttribute('height'), '18');
		assert.strictEqual(frame?.getAttribute('rx'), '2');
		assert.strictEqual(frame?.getAttribute('stroke'), 'currentColor');
		assert.strictEqual(frame?.getAttribute('stroke-width'), '1.5');
		assert.strictEqual(frame?.getAttribute('vector-effect'), 'non-scaling-stroke');
		assert.strictEqual(divider?.getAttribute('d'), PRIMARY_SIDEBAR_TOGGLE_OPEN_DIVIDER_PATH);
		assert.strictEqual(divider?.getAttribute('stroke'), 'currentColor');
		assert.strictEqual(divider?.getAttribute('stroke-width'), '1.5');
	});

	test('uses the filled panel glyph on the title bar while the sidebar is closed', () => {
		const icon = createPrimarySidebarToggleIcon(document.createElement('div'), 'closed');
		const paths = icon.querySelectorAll('path');

		assert.strictEqual(icon.getAttribute('viewBox'), '0 0 16 16');
		assert.strictEqual(paths.length, 2);
		assert.strictEqual(paths[0].getAttribute('d'), PRIMARY_SIDEBAR_TOGGLE_CLOSED_FRAME_PATH);
		assert.strictEqual(paths[1].getAttribute('d'), PRIMARY_SIDEBAR_TOGGLE_CLOSED_BAR_PATH);
		assert.strictEqual(paths[0].getAttribute('fill'), 'currentColor');
		assert.strictEqual(paths[1].getAttribute('fill'), 'currentColor');
		assert.strictEqual(icon.querySelector('g')?.getAttribute('fill'), 'currentColor');
		assert.strictEqual(icon.querySelector('g')?.getAttribute('transform'), null);
	});

	test('keeps the toggle in the title bar until the agent sidebar is open', () => {
		assert.strictEqual(agentPrimarySidebarToggleInTitlebar(false, true), true);
		assert.strictEqual(agentPrimarySidebarToggleInTitlebar(false, false), true);
		assert.strictEqual(agentPrimarySidebarToggleInTitlebar(true, false), true);
		assert.strictEqual(agentPrimarySidebarToggleInTitlebar(true, true), false);
	});
});
