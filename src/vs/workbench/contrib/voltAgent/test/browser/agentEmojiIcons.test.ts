/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { hasEmojiIcon, replaceEmojiWithIcons } from '../../browser/blocks/agentEmojiIcons.js';

const CHECK = '\u{2705}';
const HOURGLASS = '\u{23F3}';
const WARNING = '\u{26A0}\u{FE0F}';
const ARROW = '\u{2194}';

function render(html: string): HTMLElement {
	const root = mainWindow.document.createElement('div');
	root.innerHTML = html;
	replaceEmojiWithIcons(root);
	return root;
}

function icons(root: HTMLElement): string[] {
	return [...root.querySelectorAll('svg.volt-emoji-icon')].map(svg => `${svg.getAttribute('data-icon')}:${svg.getAttribute('data-tone') ?? ''}`);
}

suite('agentEmojiIcons', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('swaps status emoji for toned line icons and keeps the text around them', () => {
		const root = render(`<ol><li>${CHECK} Verify the setup</li><li>${HOURGLASS} Run the checks (in progress)</li><li>${WARNING} Careful</li></ol>`);
		assert.deepStrictEqual(icons(root), ['check-circle:success', 'clock:progress', 'exclamation-triangle:warning']);
		assert.deepStrictEqual([...root.querySelectorAll('li')].map(li => li.textContent), [' Verify the setup', ' Run the checks (in progress)', ' Careful']);
	});

	test('leaves code, plain arrows and unknown emoji alone', () => {
		const root = render(`<p>a ${ARROW} b <code>${CHECK}</code> \u{1F984}</p><pre>${CHECK}</pre>`);
		assert.deepStrictEqual(icons(root), []);
		assert.ok(hasEmojiIcon(`${ARROW}\u{FE0F}`));
	});
});
