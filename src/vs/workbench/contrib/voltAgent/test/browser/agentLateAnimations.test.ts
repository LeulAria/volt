/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILateSteppedAnimation, LateAnimationDriver } from '../../browser/chrome/agentLateAnimations.js';

class FakeAnimation implements ILateSteppedAnimation {
	playState = 'running';
	effect = { target: { isConnected: true } };
	constructor(public currentTime: number | null) { }
	pause(): void { this.playState = 'paused'; }
	play(): void { this.playState = 'running'; }
}

suite('Agent late-stepped animations', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const state = { now: 1000 as number | undefined, pending: [] as (() => void)[] };
		const schedule = (callback: () => void): IDisposable => {
			state.pending.push(callback);
			return { dispose: () => { state.pending = state.pending.filter(c => c !== callback); } };
		};
		const driver = store.add(new LateAnimationDriver(schedule, () => state.now));
		const frame = (now: number) => {
			state.now = now;
			const run = state.pending;
			state.pending = [];
			run.forEach(callback => callback());
		};
		return { state, driver, frame };
	}

	test('a held animation shows in each frame the time it would have reached running', () => {
		const { state, driver, frame } = setup();
		const shimmer = new FakeAnimation(250);
		driver.adopt(shimmer);
		assert.strictEqual(shimmer.playState, 'paused');
		assert.strictEqual(state.pending.length, 1, 'one frame asked for');
		frame(1008);
		assert.strictEqual(shimmer.currentTime, 258);
		frame(1016.5);
		assert.strictEqual(shimmer.currentTime, 266.5);
		// Adopting it again changes nothing.
		driver.adopt(shimmer);
		assert.strictEqual(driver.size, 1);
		assert.strictEqual(state.pending.length, 1);
	});

	test('an animation that ended, was removed or was started again by others is let go, and the frames stop', () => {
		const { state, driver, frame } = setup();
		const gone = new FakeAnimation(0);
		const cancelled = new FakeAnimation(0);
		const kept = new FakeAnimation(0);
		driver.adopt(gone);
		driver.adopt(cancelled);
		driver.adopt(kept);
		gone.effect.target.isConnected = false;
		cancelled.playState = 'idle';
		frame(1100);
		assert.strictEqual(driver.size, 1);
		assert.strictEqual(kept.currentTime, 100);
		assert.strictEqual(gone.currentTime, 0);
		kept.playState = 'running';
		frame(1200);
		assert.strictEqual(driver.size, 0);
		assert.strictEqual(state.pending.length, 0, 'no frame asked for with nothing held');
	});

	test('left alone without a timeline or when not running; all run on their own again on dispose', () => {
		const { state, driver } = setup();
		state.now = undefined;
		const a = new FakeAnimation(10);
		driver.adopt(a);
		assert.strictEqual(a.playState, 'running');
		state.now = 5;
		const idle = new FakeAnimation(null);
		driver.adopt(idle);
		assert.strictEqual(idle.playState, 'running');
		assert.strictEqual(driver.size, 0);
		driver.adopt(a);
		assert.strictEqual(a.playState, 'paused');
		driver.dispose();
		assert.strictEqual(a.playState, 'running');
		assert.strictEqual(state.pending.length, 0);
	});
});
