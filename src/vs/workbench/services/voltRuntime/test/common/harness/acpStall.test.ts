/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ACP_IDLE_TIMINGS, declaredToolWaitMs, IdleWatchdog, IIdleStageInfo } from '../../../common/harness/acpStall.js';
import { FakeWatchdogClock } from './fakeWatchdogClock.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

suite('Volt ACP idle watchdog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function watch(clock: FakeWatchdogClock) {
		const stages: IIdleStageInfo[] = [];
		const dog = new IdleWatchdog(info => stages.push(info), ACP_IDLE_TIMINGS, clock);
		return { dog, stages, names: () => stages.map(stage => `${stage.stage}@${Math.round(stage.quietMs / SECOND)}s`) };
	}

	test('a quiet model escalates notice -> recover -> fail on the default schedule', () => {
		const clock = new FakeWatchdogClock();
		const { dog, stages, names } = watch(clock);
		clock.advance(119 * SECOND);
		assert.deepStrictEqual(names(), []);
		clock.advance(1 * SECOND);
		assert.deepStrictEqual(names(), ['notice@120s']);
		assert.strictEqual(stages[0].neverActive, true);
		assert.strictEqual(stages[0].owner, 'model');
		clock.advance(4 * MINUTE);
		assert.deepStrictEqual(names(), ['notice@120s', 'recover@360s']);
		dog.recovered();
		clock.advance(3 * MINUTE);
		assert.deepStrictEqual(names(), ['notice@120s', 'recover@360s', 'fail@540s']);
		assert.strictEqual(stages[2].recoveries, 1);
		clock.advance(60 * MINUTE);
		assert.strictEqual(stages.length, 3, 'nothing fires after fail');
		dog.dispose();
	});

	test('activity slides the window; a 300 s first token (Cursor, 400k-char prompt) is never interrupted', () => {
		const clock = new FakeWatchdogClock();
		const { dog, names } = watch(clock);
		clock.advance(300 * SECOND);
		dog.modelOutput();
		for (let i = 0; i < 40; i++) {
			clock.advance(50 * SECOND);
			dog.activity();
		}
		assert.deepStrictEqual(names(), ['notice@120s'], 'only the heads-up for the slow first token');
		dog.dispose();
	});

	test('a running tool gets the tool budget; a long silent shell (596 s) is fine', () => {
		const clock = new FakeWatchdogClock();
		const { dog, names } = watch(clock);
		dog.toolStarted('shell-1');
		clock.advance(596 * SECOND);
		assert.deepStrictEqual(names(), []);
		dog.toolEnded('shell-1');
		clock.advance(60 * SECOND);
		assert.deepStrictEqual(names(), []);
		clock.advance(60 * SECOND);
		assert.deepStrictEqual(names(), ['notice@120s'], 'back to the model budget once the tool returned');
		dog.dispose();
	});

	test('a call that declares a long wait (AwaitShell block_until_ms) extends the tool budget', () => {
		const clock = new FakeWatchdogClock();
		const { dog, names } = watch(clock);
		dog.toolStarted('await-1');
		dog.toolDeclared('await-1', 40 * MINUTE);
		clock.advance(40 * MINUTE);
		assert.deepStrictEqual(names(), []);
		clock.advance(1 * MINUTE);
		assert.deepStrictEqual(names(), ['notice@2460s']);
		assert.strictEqual(dog.thresholds().recoverMs, 45 * MINUTE);
		dog.dispose();
	});

	test('model output releases calls the agent never closed', () => {
		const clock = new FakeWatchdogClock();
		const { dog, names } = watch(clock);
		dog.toolStarted('leaked');
		dog.modelOutput();
		assert.strictEqual(dog.owner, 'model');
		clock.advance(120 * SECOND);
		assert.deepStrictEqual(names(), ['notice@120s']);
		dog.dispose();
	});

	test('waiting on the user pauses the clock; the release restarts it', () => {
		const clock = new FakeWatchdogClock();
		const { dog, names } = watch(clock);
		clock.advance(50 * SECOND);
		const approval = dog.pause();
		const question = dog.pause();
		clock.advance(30 * MINUTE);
		approval.dispose();
		clock.advance(30 * MINUTE);
		assert.deepStrictEqual(names(), [], 'still paused while one wait is open');
		question.dispose();
		question.dispose();
		clock.advance(119 * SECOND);
		assert.deepStrictEqual(names(), []);
		clock.advance(1 * SECOND);
		assert.deepStrictEqual(names(), ['notice@120s']);
		dog.dispose();
	});

	test('recoveries are capped; past the cap a stall goes straight to fail', () => {
		const clock = new FakeWatchdogClock();
		const { dog, names } = watch(clock);
		for (let i = 0; i < ACP_IDLE_TIMINGS.maxRecoveries; i++) {
			clock.advance(6 * MINUTE);
			dog.recovered();
			dog.activity();
		}
		const before = names().filter(name => name.startsWith('recover')).length;
		assert.strictEqual(before, ACP_IDLE_TIMINGS.maxRecoveries);
		clock.advance(9 * MINUTE);
		assert.deepStrictEqual(names().slice(-2), ['notice@120s', 'fail@540s']);
		dog.dispose();
	});

	test('time the computer spent asleep (lid closed) is not silence', () => {
		const clock = new FakeWatchdogClock();
		const { dog, names } = watch(clock);
		dog.modelOutput();
		clock.advance(1 * MINUTE);
		clock.sleep(30 * MINUTE);
		clock.advance(59 * SECOND);
		assert.deepStrictEqual(names(), [], 'woke 59 s ago after 1 min of quiet: nothing due yet');
		clock.advance(1 * SECOND);
		assert.deepStrictEqual(names(), ['notice@120s'], 'two awake minutes, not 32');
		dog.modelOutput();
		clock.advance(1 * MINUTE);
		assert.deepStrictEqual(names(), ['notice@120s']);
		dog.dispose();
	});

	test('a timer a throttled window ran a minute late still counts the whole wait', () => {
		const clock = new FakeWatchdogClock();
		const { dog, names } = watch(clock);
		clock.advance(1 * MINUTE);
		clock.sleep(1 * MINUTE);
		clock.advance(1 * MINUTE);
		assert.deepStrictEqual(names(), ['notice@180s']);
		dog.dispose();
	});

	test('dispose stops all timers', () => {
		const clock = new FakeWatchdogClock();
		const { dog, names } = watch(clock);
		dog.dispose();
		clock.advance(60 * MINUTE);
		assert.deepStrictEqual(names(), []);
	});

	test('reads the wait a call declared', () => {
		assert.strictEqual(declaredToolWaitMs('{"command":"npm test","timeout":150000}'), 150_000);
		assert.strictEqual(declaredToolWaitMs('{"taskId":"1","blockUntilMs":650000}'), 650_000);
		assert.strictEqual(declaredToolWaitMs('{"block_until_ms":"30000"}'), 30_000);
		assert.strictEqual(declaredToolWaitMs('{"timeout":0}'), undefined);
		assert.strictEqual(declaredToolWaitMs('not json'), undefined);
		assert.strictEqual(declaredToolWaitMs(undefined), undefined);
	});
});
