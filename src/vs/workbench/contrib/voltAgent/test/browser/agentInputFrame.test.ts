/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { noteComposerInput, yieldsToInput } from '../../browser/editor/agentInputFrame.js';

/** What transcript work (priority 0) sees in the next animation frame. */
function nextFrame(during?: () => void): Promise<boolean> {
	return new Promise(resolve => scheduleAtNextAnimationFrame(mainWindow, () => {
		const yielded = yieldsToInput(mainWindow);
		during?.();
		resolve(yielded);
	}));
}

suite('Agent keystroke-first frames', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the frame after a keystroke yields, the one after it does not', async () => {
		assert.strictEqual(await nextFrame(), false, 'no key, no yield');
		noteComposerInput(mainWindow);
		assert.strictEqual(yieldsToInput(mainWindow), false, 'not before the frame');
		assert.strictEqual(await nextFrame(), true, 'the frame that draws the key');
		assert.strictEqual(await nextFrame(), false, 'deferred work runs in the next one');
	});

	test('never two frames in a row: a key typed in the yielding frame does not make the next one yield', async () => {
		await nextFrame();
		await nextFrame();
		noteComposerInput(mainWindow);
		assert.strictEqual(await nextFrame(() => noteComposerInput(mainWindow)), true);
		assert.strictEqual(await nextFrame(() => noteComposerInput(mainWindow)), false, 'cooling down');
		assert.strictEqual(await nextFrame(), true, 'the key typed after the cool-down frame yields again');
		assert.strictEqual(await nextFrame(), false);
	});
});
