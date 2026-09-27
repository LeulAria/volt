/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AGENT_HOME_FILTER_ICON_PATH,
	AGENT_HOME_FOLDER_ICON_PATH,
	AGENT_SESSION_HOVER_FOLDER_ICON_PATH,
	AGENT_HOME_NEW_CHAT_ICON_PATH,
	AGENT_HOME_NEW_PROJECT_ICON_PATH,
	AGENT_HOME_SEARCH_ICON_PATH,
	AGENT_HOME_STATUS_ICON_PATHS,
	createHomeFilterIcon,
	createHomeFolderIcon,
	createSessionHoverFolderIcon,
	createHomeNewChatIcon,
	createHomeNewProjectIcon,
	createHomeSearchIcon,
	createHomeStatusIcon,
} from '../../browser/home/agentHomeIcons.js';

suite('Agent home icons', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('search icon uses the stroke magnifier path', () => {
		const icon = createHomeSearchIcon();
		const path = icon.querySelector('path');
		assert.ok(icon.classList.contains('search'));
		assert.strictEqual(path?.getAttribute('d'), AGENT_HOME_SEARCH_ICON_PATH);
		assert.strictEqual(path?.getAttribute('stroke'), 'currentColor');
		assert.strictEqual(path?.getAttribute('stroke-width'), '2');
	});

	test('new chat icon uses the folded-page stroke path', () => {
		const icon = createHomeNewChatIcon();
		const path = icon.querySelector('path');
		assert.ok(icon.classList.contains('new-chat'));
		assert.strictEqual(path?.getAttribute('d'), AGENT_HOME_NEW_CHAT_ICON_PATH);
		assert.strictEqual(path?.getAttribute('stroke'), 'currentColor');
		assert.strictEqual(path?.getAttribute('stroke-width'), '2');
		assert.ok(AGENT_HOME_NEW_CHAT_ICON_PATH.includes('8.87'));
	});

	test('new project icon uses the folder-plus path with square caps', () => {
		const icon = createHomeNewProjectIcon();
		const path = icon.querySelector('path');
		assert.ok(icon.classList.contains('new-project'));
		assert.strictEqual(path?.getAttribute('d'), AGENT_HOME_NEW_PROJECT_ICON_PATH);
		assert.strictEqual(path?.getAttribute('stroke'), 'currentColor');
		assert.strictEqual(path?.getAttribute('stroke-width'), '2');
		assert.strictEqual(path?.getAttribute('stroke-linecap'), 'square');
		assert.strictEqual(path?.getAttribute('fill'), 'none');
		assert.strictEqual(path?.hasAttribute('stroke-linejoin'), false);
		assert.strictEqual(icon.querySelector('svg')?.getAttribute('viewBox'), '0 0 24 24');
	});

	test('session hover folder icon uses the rounded tab path at stroke 1.5', () => {
		const icon = createSessionHoverFolderIcon();
		const path = icon.querySelector('path');
		assert.ok(icon.classList.contains('session-folder'));
		assert.strictEqual(path?.getAttribute('d'), AGENT_SESSION_HOVER_FOLDER_ICON_PATH);
		assert.strictEqual(path?.getAttribute('stroke'), 'currentColor');
		assert.strictEqual(path?.getAttribute('stroke-width'), '1.5');
		assert.strictEqual(path?.getAttribute('stroke-linecap'), 'round');
		assert.strictEqual(path?.getAttribute('stroke-linejoin'), 'round');
		assert.strictEqual(path?.getAttribute('fill'), 'none');
		assert.strictEqual(icon.querySelector('svg')?.getAttribute('viewBox'), '0 0 24 24');
	});

	test('folder icon keeps the provided path with currentColor stroke', () => {
		const icon = createHomeFolderIcon();
		const path = icon.querySelector('path');
		assert.ok(icon.classList.contains('folder'));
		assert.strictEqual(path?.getAttribute('d'), AGENT_HOME_FOLDER_ICON_PATH);
		assert.strictEqual(path?.getAttribute('stroke'), 'currentColor');
		assert.strictEqual(path?.getAttribute('stroke-width'), '1');
		assert.strictEqual(path?.getAttribute('fill'), 'none');
	});

	test('filter icon uses the stroke bars path with currentColor', () => {
		const icon = createHomeFilterIcon();
		const path = icon.querySelector('path');
		assert.ok(icon.classList.contains('filter'));
		assert.strictEqual(path?.getAttribute('d'), AGENT_HOME_FILTER_ICON_PATH);
		assert.strictEqual(path?.getAttribute('stroke'), 'currentColor');
		assert.strictEqual(path?.getAttribute('stroke-width'), '1.5');
		assert.strictEqual(path?.getAttribute('stroke-linecap'), 'round');
		assert.strictEqual(path?.getAttribute('stroke-linejoin'), 'round');
		assert.strictEqual(path?.getAttribute('fill'), 'none');
		assert.strictEqual(icon.querySelector('svg')?.getAttribute('viewBox'), '0 0 24 24');
		assert.strictEqual(AGENT_HOME_FILTER_ICON_PATH, 'M2 5.5h20M5.333 12h13.334m-9.334 6.5h5.334');
	});

	test('status icon uses the broken-ring paths with currentColor stroke', () => {
		const icon = createHomeStatusIcon();
		const paths = [...icon.querySelectorAll('path')];
		const circle = icon.querySelector('circle');
		assert.ok(icon.classList.contains('status'));
		assert.strictEqual(paths.length, AGENT_HOME_STATUS_ICON_PATHS.length);
		assert.deepStrictEqual(paths.map(p => p.getAttribute('d')), [...AGENT_HOME_STATUS_ICON_PATHS]);
		for (const path of paths) {
			assert.strictEqual(path.getAttribute('stroke'), 'currentColor');
			assert.strictEqual(path.getAttribute('stroke-width'), '1');
			assert.strictEqual(path.getAttribute('stroke-linecap'), 'round');
			assert.strictEqual(path.getAttribute('stroke-linejoin'), 'round');
			assert.strictEqual(path.getAttribute('fill'), 'none');
		}
		assert.ok(circle);
		assert.strictEqual(circle?.getAttribute('cx'), '12');
		assert.strictEqual(circle?.getAttribute('cy'), '12');
		assert.strictEqual(circle?.getAttribute('r'), '1');
		assert.strictEqual(circle?.getAttribute('stroke'), 'currentColor');
		assert.strictEqual(circle?.getAttribute('stroke-width'), '1');
	});
});
