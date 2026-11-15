/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InputFirstGate, isTextFrame, TextFrameClock } from '../../browser/editor/agentInputFirst.js';

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

	test('streamed text is painted in the frames its fade steps in', () => {
		const step = 1000 / 60;
		// 120 Hz: every other frame, the first one after each step.
		const at120 = Array.from({ length: 8 }, (_, i) => isTextFrame(3 + i * step / 2, step / 2, step));
		assert.deepStrictEqual(at120, [true, false, true, false, true, false, true, false]);
		// 60 Hz and slower, and a screen not measured yet: every frame.
		assert.ok(Array.from({ length: 8 }, (_, i) => isTextFrame(11 + i * step, step, step)).every(Boolean));
		assert.ok(isTextFrame(11, 33.3, step) && isTextFrame(11, undefined, step));
		// 144 Hz: one frame per step, the first after it.
		const at144 = Array.from({ length: 24 }, (_, i) => isTextFrame(i * 1000 / 144, 1000 / 144, step));
		assert.strictEqual(at144.filter(Boolean).length, 10);
	});

	test('a stream paint between two text frames waits for the next one, on a fast screen only', () => {
		for (const [hz, expectWaits] of [[120, true], [60, false]] as const) {
			const frames = new FakeFrames();
			let now = 0;
			const clock = store.add(new TextFrameClock(callback => frames.schedule(callback, 0), () => now, 1000 / 60));
			const waits: boolean[] = [];
			for (let i = 0; i < 12; i++) {
				now = 2 + i * 1000 / hz;
				frames.frame();
				waits.push(clock.shouldWait());
			}
			// The first frames run unmeasured (no wait); once the frame interval is known, every other frame waits at 120 Hz.
			assert.deepStrictEqual(waits.slice(0, 2), [false, false]);
			assert.strictEqual(waits.slice(4).some(Boolean), expectWaits, `${hz} Hz: ${waits.join(',')}`);
			if (expectWaits) {
				assert.deepStrictEqual(waits.slice(4), [false, true, false, true, false, true, false, true]);
			}
		}
	});
});
