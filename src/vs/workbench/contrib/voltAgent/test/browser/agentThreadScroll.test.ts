/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { followScrollStep, pageScrollTarget, stepTurnIndex } from '../../browser/editor/agentThreadScroll.js';

suite('Agent thread scroll', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a page is the view height less a strip of overlap', () => {
		assert.strictEqual(pageScrollTarget(0, 500, 5000, 1), 440);
		assert.strictEqual(pageScrollTarget(1000, 500, 5000, -1), 560);
		// Tall views keep at most 64px of overlap.
		assert.strictEqual(pageScrollTarget(0, 1000, 5000, 1), 936);
	});

	test('paging stops at the ends', () => {
		assert.strictEqual(pageScrollTarget(100, 500, 5000, -1), 0);
		assert.strictEqual(pageScrollTarget(4400, 500, 5000, 1), 4500);
		assert.strictEqual(pageScrollTarget(0, 500, 300, 1), 0);
	});

	test('steps to the previous and next message from the landing line', () => {
		const tops = [-900, -300, 8, 400, 1200];
		assert.strictEqual(stepTurnIndex(tops, 8, -1), 1);
		assert.strictEqual(stepTurnIndex(tops, 8, 1), 3);
		assert.strictEqual(stepTurnIndex([8, 400], 8, -1), -1);
		assert.strictEqual(stepTurnIndex([-400, 8], 8, 1), -1);
	});

	test('a message a pixel off the landing line counts as the current one', () => {
		assert.strictEqual(stepTurnIndex([-500, 9, 600], 8, -1), 0);
		assert.strictEqual(stepTurnIndex([-500, 9, 600], 8, 1), 2);
	});

	/** Frames of 16ms from `position` toward `target` until it lands (or `limit` frames pass). */
	function follow(position: number, target: number, limit = 200): number[] {
		const frames: number[] = [];
		let velocity = 0;
		for (let i = 0; i < limit; i++) {
			const step = followScrollStep(position, target, velocity, 16);
			position = step.position;
			velocity = step.velocity;
			frames.push(position);
			if (step.done) {
				break;
			}
		}
		return frames;
	}

	test('following the end eases there over several frames and lands exactly', () => {
		const frames = follow(0, 22);
		assert.ok(frames.length > 4 && frames.length < 40, `${frames.length} frames`);
		assert.ok(frames[0] > 0 && frames[0] < 11, `first frame moved ${frames[0]}px`);
		assert.strictEqual(frames.at(-1), 22);
	});

	test('following never passes the end and never moves back', () => {
		const frames = follow(0, 300);
		for (let i = 1; i < frames.length; i++) {
			assert.ok(frames[i] >= frames[i - 1], `frame ${i} moved back`);
			assert.ok(frames[i] <= 300, `frame ${i} passed the end`);
		}
	});

	test('a chunk landing mid-glide keeps the speed it had', () => {
		const first = followScrollStep(0, 22, 0, 16);
		const second = followScrollStep(first.position, 22, first.velocity, 16);
		// The end moves 22px further: the next frame goes on at least as fast instead of stopping short.
		const third = followScrollStep(second.position, 44, second.velocity, 16);
		assert.ok(third.position - second.position >= second.position - first.position);
	});

	test('following trails the end by at most the given lag', () => {
		const step = followScrollStep(0, 5000, 0, 16, 600);
		assert.ok(step.position >= 4400, `${step.position}`);
	});
});
