/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InputFirstGate } from '../../browser/editor/agentInputFirst.js';

/** A frame runner: callbacks queued for the next frame run by priority, highest first. */
class FakeFrames {
	private next: { callback: () => void; priority: number; live: boolean }[] = [];
	readonly schedule = (callback: () => void, priority: number): IDisposable => {
		const item = { callback, priority, live: true };
		this.next.push(item);
		// A plain handle, as the DOM frame runner's (not tracked as a disposable).
		const handle: IDisposable = { dispose: () => item.live = false };
		return handle;
	};
	frame(): void {
		const items = this.next.sort((a, b) => b.priority - a.priority);
		this.next = [];
		for (const item of items) {
			if (item.live) {
				item.callback();
			}
		}
	}
}

suite('Agent input first', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a stream paint in the frame of a key moves to the next frame, once', () => {
		const frames = new FakeFrames();
		const gate = store.add(new InputFirstGate(frames.schedule));
		const painted: number[] = [];
		let frame = 0;
		const paint = () => {
			if (gate.shouldYield()) {
				frames.schedule(paint, 0);
				return;
			}
			painted.push(frame);
		};
		// A frame with a chunk and no key paints.
		frames.schedule(paint, 0);
		frame = 1; frames.frame();
		assert.deepStrictEqual(painted, [1]);
		// A key and a chunk before frame 2: the key's frame skips the paint, frame 3 paints.
		gate.noteKey();
		frames.schedule(paint, 0);
		frame = 2; frames.frame();
		assert.deepStrictEqual(painted, [1]);
		frame = 3; frames.frame();
		assert.deepStrictEqual(painted, [1, 3]);
		// The key's mark ends with its frame: a later chunk paints in its own frame.
		frames.schedule(paint, 0);
		frame = 4; frames.frame();
		assert.deepStrictEqual(painted, [1, 3, 4]);
	});

	test('a key in every frame never holds the reply two frames in a row', () => {
		const frames = new FakeFrames();
		const gate = store.add(new InputFirstGate(frames.schedule));
		const painted: number[] = [];
		// A chunk and a key before every frame.
		for (let frame = 1; frame <= 6; frame++) {
			gate.noteKey();
			frames.schedule(() => {
				if (!gate.shouldYield()) {
					painted.push(frame);
				}
			}, 0);
			frames.frame();
		}
		assert.deepStrictEqual(painted, [2, 4, 6]);
	});

	test('no key, no yield; disposing drops the pending frame-end mark', () => {
		const frames = new FakeFrames();
		const gate = new InputFirstGate(frames.schedule);
		assert.strictEqual(gate.shouldYield(), false);
		gate.noteKey();
		gate.noteKey();
		assert.strictEqual(gate.shouldYield(), true);
		gate.dispose();
		assert.strictEqual(gate.shouldYield(), false);
		frames.frame();
	});
});
