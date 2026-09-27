/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { OperatingSystem, OS } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AGENT_HEADER_FOLDER_PATH,
	AGENT_HEADER_GIT_PATH,
	agentHeaderHoverLines,
	createAgentHeaderFolderIcon,
	createAgentHeaderGitIcon,
	formatHeaderFolderPath,
	headerBranchName,
	headerFolderPath,
	isNewAgentWindow,
	primaryHeaderShowsNewAgent,
	primaryHeaderShowsSearch,
	primaryHeaderSidebarClosed,
	shortTabTitle,
} from '../../browser/chrome/agentTitlebarHeader.js';

suite('Agent primary header', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps a tab title to three words', () => {
		assert.strictEqual(shortTabTitle('Header drag issue'), 'Header drag issue');
		assert.strictEqual(shortTabTitle('Fix the header drag issue'), 'Fix the header');
		assert.strictEqual(shortTabTitle('  one   two  '), 'one two');
		assert.strictEqual(shortTabTitle(''), '');
	});

	test('shows search when the sidebar is closed, and New Agent only outside a fresh agent', () => {
		assert.strictEqual(primaryHeaderSidebarClosed({ toggleInTitlebar: false, auxiliaryBarHidden: false, leftCollapsed: false }), false);
		assert.strictEqual(primaryHeaderSidebarClosed({ toggleInTitlebar: true, auxiliaryBarHidden: false, leftCollapsed: false }), true);
		assert.strictEqual(primaryHeaderSidebarClosed({ toggleInTitlebar: false, auxiliaryBarHidden: true, leftCollapsed: false }), true);
		assert.strictEqual(primaryHeaderSidebarClosed({ toggleInTitlebar: false, auxiliaryBarHidden: false, leftCollapsed: true }), true);
		assert.strictEqual(primaryHeaderShowsSearch(false), false);
		assert.strictEqual(primaryHeaderShowsSearch(true), true);
		assert.strictEqual(primaryHeaderShowsNewAgent(true, false), true);
		assert.strictEqual(primaryHeaderShowsNewAgent(true, true), false);
		assert.strictEqual(primaryHeaderShowsNewAgent(false, false), false);
		assert.strictEqual(isNewAgentWindow(true, 'New Agent', 'New Agent', 0), true);
		assert.strictEqual(isNewAgentWindow(true, 'New Agent', 'New Agent', 2), false);
		assert.strictEqual(isNewAgentWindow(true, 'Header drag issue', 'New Agent', 0), false);
		assert.strictEqual(isNewAgentWindow(false, 'New Agent', 'New Agent', 0), false);
	});

	test('hover shows the project over its branch, then the folder, and folds the path under the name without git', () => {
		assert.strictEqual(headerBranchName('refs/heads/JEv'), 'JEv');
		assert.strictEqual(headerBranchName('   '), undefined);
		assert.strictEqual(headerFolderPath(undefined, '  ', '/from-history', '/workspace'), '/from-history');
		assert.strictEqual(headerFolderPath('/bound', '/history'), '/bound');
		assert.strictEqual(headerFolderPath(undefined, undefined), undefined);
		assert.deepStrictEqual(agentHeaderHoverLines('volt', 'JEv', '~/Desktop/Projects/volt'), [
			{ kind: 'branch', title: 'volt', subtitle: 'JEv' },
			{ kind: 'path', title: '~/Desktop/Projects/volt' },
		]);
		assert.deepStrictEqual(agentHeaderHoverLines('volt', undefined, '~/Desktop/Projects/volt'), [
			{ kind: 'path', title: 'volt', subtitle: '~/Desktop/Projects/volt' },
		]);
		assert.deepStrictEqual(agentHeaderHoverLines(undefined, '  ', '~/volt'), [
			{ kind: 'path', title: '~/volt' },
		]);
		assert.deepStrictEqual(agentHeaderHoverLines('volt', 'main', ''), []);
	});

	test('tildifies and shortens the folder path', () => {
		const home = '/Users/me';
		const folder = '/Users/me/Desktop/Projects/Personal Projects/app';
		const labeled = formatHeaderFolderPath(folder, home);
		if (OS === OperatingSystem.Windows) {
			assert.ok(labeled.startsWith('/Users/me/Desktop/Projects/'));
		} else {
			assert.ok(labeled.startsWith('~/Desktop/Projects/'));
		}
		assert.ok(labeled.endsWith('...'));
		assert.ok(labeled.length <= 37);
		const short = formatHeaderFolderPath(`${home}/volt`, home);
		assert.strictEqual(short, OS === OperatingSystem.Windows ? `${home}/volt` : '~/volt');
	});

	test('folder and git hover icons use the provided strokes', () => {
		const host = document.createElement('div');
		const folder = createAgentHeaderFolderIcon(host);
		const git = createAgentHeaderGitIcon(host);

		assert.strictEqual(folder.getAttribute('viewBox'), '0 0 24 24');
		assert.strictEqual(folder.querySelector('path')?.getAttribute('d'), AGENT_HEADER_FOLDER_PATH);
		assert.strictEqual(folder.querySelector('path')?.getAttribute('stroke'), 'currentColor');
		assert.strictEqual(folder.querySelector('path')?.getAttribute('stroke-width'), '1');
		assert.strictEqual(git.querySelector('path')?.getAttribute('d'), AGENT_HEADER_GIT_PATH);
		assert.strictEqual(git.querySelector('line')?.getAttribute('x1'), '6');
		assert.strictEqual(git.querySelector('line')?.getAttribute('y2'), '15');
		assert.strictEqual(git.querySelectorAll('circle').length, 2);
		assert.strictEqual(git.querySelector('circle')?.getAttribute('stroke-width'), '1');
	});
});
