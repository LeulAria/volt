/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { agentServerProgram } from '../../../../platform/voltAgentServer/node/agentServerLauncher.js';
import { IVoltEventEnvelope } from '../../../../workbench/services/voltRuntime/common/events.js';
import { ServerMemoryReducer } from '../../../node/voltAgent/serverMemoryReducer.js';

suite('Volt agent server: the heap is collected once the server is quiet (round 7)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const DELAY = 30;
	const run = (type: 'run.start' | 'run.end', runId: string) => ({ sessionId: 's', event: type === 'run.start' ? { type, runId, mode: 'agent' } : { type, runId, reason: 'done' } }) as unknown as IVoltEventEnvelope;

	test('the server runs with gc exposed (a Node option, before the entry)', () => {
		const program = agentServerProgram('/electron', '/out/main.js', '/data', false, {});
		assert.ok(program.indexOf('--expose-gc') > 0 && program.indexOf('--expose-gc') < program.indexOf('/out/main.js'));
	});

	test('once after startup, never during a run, once after the last of overlapping runs ends', async () => {
		const events = store.add(new Emitter<IVoltEventEnvelope>());
		let collected = 0;
		store.add(new ServerMemoryReducer(events.event, () => collected++, DELAY));
		await timeout(DELAY * 3);
		assert.strictEqual(collected, 1, 'after startup');
		events.fire(run('run.start', 'a'));
		events.fire(run('run.start', 'b'));
		events.fire(run('run.end', 'a'));
		await timeout(DELAY * 3);
		assert.strictEqual(collected, 1, 'not while b runs');
		events.fire(run('run.end', 'b'));
		await timeout(DELAY * 3);
		assert.strictEqual(collected, 2, 'once the last run ended');
		events.fire(run('run.start', 'c'));
		events.fire(run('run.end', 'c'));
		events.fire(run('run.start', 'd'));
		await timeout(DELAY * 3);
		assert.strictEqual(collected, 2, 'a run that starts within the delay cancels it');
	});

	test('without gc exposed it does nothing', async () => {
		const events = store.add(new Emitter<IVoltEventEnvelope>());
		store.add(new ServerMemoryReducer(events.event, undefined, DELAY));
		events.fire(run('run.end', 'a'));
		await timeout(DELAY * 2);
	});
});
