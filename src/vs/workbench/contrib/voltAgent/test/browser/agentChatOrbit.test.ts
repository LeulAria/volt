/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentChatOrbit, orbitStopVisibility } from '../../browser/chat/agentChatOrbit.js';

suite('agentChatOrbit', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const pickers = { left: 320, top: 239, right: 750, bottom: 261 };

	test('a stop name over a control is hidden', () => {
		assert.strictEqual(orbitStopVisibility({ left: 400, top: 245, right: 460, bottom: 258 }, [pickers], 14), 0);
	});

	test('a stop name touching a control is hidden', () => {
		assert.strictEqual(orbitStopVisibility({ left: 750, top: 245, right: 800, bottom: 258 }, [pickers], 14), 0);
	});

	test('a stop name fades in as it moves away', () => {
		assert.strictEqual(orbitStopVisibility({ left: 757, top: 245, right: 800, bottom: 258 }, [pickers], 14), 0.5);
		assert.strictEqual(orbitStopVisibility({ left: 400, top: 200, right: 460, bottom: 232 }, [pickers], 14), 0.5);
	});

	test('a stop name far from every control is fully shown', () => {
		assert.strictEqual(orbitStopVisibility({ left: 900, top: 100, right: 960, bottom: 113 }, [pickers], 14), 1);
		assert.strictEqual(orbitStopVisibility({ left: 900, top: 100, right: 960, bottom: 113 }, [], 14), 1);
	});

	test('at rest the canvas lets its bitmap go behind a picture of its frame, and comes back on play', async function () {
		// The picture is encoded in the window's idle time. The test window is hidden and has none, so the
		// encoder starts on its own fallback about a second in (1.2 s on CI when it passed), and later on a busy runner.
		this.timeout(30_000);
		const parent = mainWindow.document.createElement('div');
		parent.style.cssText = 'position: relative; width: 200px; height: 100px';
		mainWindow.document.body.appendChild(parent);
		const orbit = new AgentChatOrbit(parent, () => false, () => [], 10);
		try {
			orbit.resize(200, 100);
			const canvas = parent.querySelector('canvas')!;
			const width = canvas.width;
			assert.ok(width >= 200, 'drawn at its size');
			orbit.rest();
			for (const until = Date.now() + 20_000; Date.now() < until && !parent.querySelector('img.volt-agent-chat-orbit-still');) {
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			const picture = parent.querySelector<HTMLImageElement>('img.volt-agent-chat-orbit-still');
			assert.ok(picture?.src.startsWith('blob:'), 'a picture of the frame shows');
			assert.strictEqual(canvas.width, 0, 'the canvas let its bitmap go');
			orbit.play();
			assert.strictEqual(canvas.width, width, 'the canvas is back at its size at once');
			await Promise.resolve();
			assert.strictEqual(parent.querySelector('img.volt-agent-chat-orbit-still'), null, 'the picture is gone');
			orbit.pause();
		} finally {
			orbit.dispose();
			parent.remove();
		}
	});

	test('a rest is dropped when the scene plays before it is taken', async () => {
		const parent = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(parent);
		const orbit = new AgentChatOrbit(parent, () => false, () => [], 10);
		try {
			orbit.resize(200, 100);
			orbit.rest();
			orbit.play();
			await new Promise(resolve => setTimeout(resolve, 100));
			assert.strictEqual(parent.querySelector('img'), null);
			assert.ok(parent.querySelector('canvas')!.width >= 200);
			orbit.pause();
		} finally {
			orbit.dispose();
			parent.remove();
		}
	});

	test('the nearest control decides', () => {
		const composer = { left: 320, top: 271, right: 880, bottom: 381 };
		assert.strictEqual(orbitStopVisibility({ left: 890, top: 300, right: 950, bottom: 313 }, [pickers, composer], 14), 10 / 14);
	});
});
