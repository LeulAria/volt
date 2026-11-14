/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../base/test/common/timeTravelScheduler.js';
import { OnDemandSweep } from '../../../node/voltAgent/onDemandSweep.js';

suite('OnDemandSweep (device sweep of the agent server)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('with no device connected it never ticks', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		let sweeps = 0;
		const sweep = store.add(new OnDemandSweep(2_000, () => false, () => sweeps++));
		sweep.wake();
		await new Promise(resolve => setTimeout(resolve, 10_000));
		assert.strictEqual(sweeps, 0);
		assert.strictEqual(sweep.running, false);
	}));

	test('a connected device is swept every interval (INV-08), and the sweep stops once none is left', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		let devices = 1;
		let sweeps = 0;
		const sweep = store.add(new OnDemandSweep(2_000, () => devices > 0, () => { sweeps++; if (sweeps === 3) { devices = 0; } }));
		sweep.wake();
		sweep.wake();
		await new Promise(resolve => setTimeout(resolve, 4_100));
		assert.strictEqual(sweeps, 2);
		await new Promise(resolve => setTimeout(resolve, 10_000));
		assert.strictEqual(sweeps, 3, 'stopped after the sweep that left no device');
		assert.strictEqual(sweep.running, false);
		devices = 1;
		sweep.wake();
		await new Promise(resolve => setTimeout(resolve, 2_100));
		assert.strictEqual(sweeps, 4, 'a new device starts it again');
	}));
});
