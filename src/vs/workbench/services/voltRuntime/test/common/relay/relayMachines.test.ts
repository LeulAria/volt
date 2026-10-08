/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { canTakeAgent, cpuPressure, describeMachineLoad, IRelayMachine, IRelayMachineLoad, machineLoadLevel, memoryPressure } from '../../../common/relay/relayMachines.js';

const GB = 1024 ** 3;

function runner(name: string, load: IRelayMachineLoad, extra: Partial<IRelayMachine> = {}): IRelayMachine {
	return {
		id: `run_${name}`,
		kind: 'runner',
		name,
		online: true,
		lastSeenAt: 0,
		load: { cpus: 4, memFree: 6 * GB, memTotal: 8 * GB, running: 0, slots: 1, ...load },
		caps: { agents: { claude: { installed: true, credentials: true } } },
		...extra,
	};
}

suite('Volt relay machines', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('CPU pressure prefers the measured busy fraction over the load average', () => {
		// In a container the load average is the whole Docker VM's; the cgroup figure is its own.
		assert.strictEqual(cpuPressure({ cpu: 0.1, load1: 8, cpus: 4 }), 0.1);
		assert.strictEqual(cpuPressure({ load1: 2, cpus: 4 }), 0.5);
		assert.strictEqual(cpuPressure({}), 0);
		assert.strictEqual(memoryPressure({ memFree: 2 * GB, memTotal: 8 * GB }), 0.75);
		assert.strictEqual(machineLoadLevel({ load: { cpu: 3 } }), 1);
	});

	test('a machine takes an agent\'s task only where the relay says so', () => {
		const idle = runner('idle', { cpu: 0.05 }, { placement: { claude: { eligible: true, reason: null }, codex: { eligible: false, reason: 'codex is not installed' } } });
		assert.strictEqual(canTakeAgent(idle, 'claude'), true);
		assert.strictEqual(canTakeAgent(idle, 'codex'), false);
		// A machine the relay did not report on cannot take anything.
		assert.strictEqual(canTakeAgent(runner('unreported', {}), 'claude'), false);
	});

	test('describes load for the picker', () => {
		assert.strictEqual(describeMachineLoad(runner('a', { cpu: 0.234, running: 1 }), 0), '4 cores · 23% CPU · 2.0 of 8 GB · 1 running');
		assert.strictEqual(describeMachineLoad({ ...runner('a', {}), online: false, lastSeenAt: 0 }, 5 * 60_000), 'Offline 5 min');
	});
});
