/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { cpuPressure, describeMachineLoad, IRelayMachine, IRelayMachineLoad, machineEligibility, machineLoadLevel, memoryPressure, pickMachine, scoreMachine } from '../../../common/relay/relayMachines.js';

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

	test('Auto picks the least loaded runner', () => {
		const idle = runner('idle', { cpu: 0.05 });
		const busy = runner('busy', { cpu: 0.97 });
		const pick = pickMachine([busy, idle], { agent: 'claude' });
		assert.strictEqual(pick.machine?.name, 'idle');
		assert.strictEqual(pick.why, 'Least loaded');
		assert.deepStrictEqual(pick.ranked.map(entry => entry.machine.name), ['idle', 'busy']);
	});

	test('capability filters: agent installed, logged in, online, a runner', () => {
		const noCodex = runner('a', { cpu: 0 });
		const codexNoLogin = runner('b', { cpu: 0 }, { caps: { agents: { codex: { installed: true, credentials: false } } } });
		const codex = runner('c', { cpu: 0.9 }, { caps: { agents: { codex: { installed: true, credentials: true } } } });
		const offline = runner('d', { cpu: 0 }, { online: false, caps: { agents: { codex: { installed: true, credentials: true } } } });
		const mac: IRelayMachine = { ...runner('mac', { cpu: 0 }), kind: 'client' };
		assert.strictEqual(machineEligibility(noCodex, { agent: 'codex' }).reason, 'No Codex');
		assert.strictEqual(machineEligibility(codexNoLogin, { agent: 'codex' }).reason, 'No Codex login');
		assert.strictEqual(machineEligibility(offline, { agent: 'codex' }).reason, 'Offline');
		assert.strictEqual(machineEligibility(mac, { agent: 'codex' }).reason, 'Not a runner');
		assert.strictEqual(pickMachine([noCodex, codexNoLogin, offline, mac, codex], { agent: 'codex' }).machine?.name, 'c');
	});

	test('no machine fits: says why', () => {
		assert.match(pickMachine([], { agent: 'claude' }).why, /No runners/);
		assert.match(pickMachine([runner('a', {}, { online: false })], { agent: 'claude' }).why, /offline/);
		const pick = pickMachine([runner('a', {}, { caps: { agents: {} } })], { agent: 'claude' });
		assert.strictEqual(pick.machine, undefined);
		assert.match(pick.why, /No Claude Code/);
	});

	test('hysteresis keeps the previous pick until another is clearly better', () => {
		const a = runner('a', { cpu: 0.20 });
		const b = runner('b', { cpu: 0.10 });
		// 0.055 apart: within the margin, so Auto stays where it was.
		assert.strictEqual(pickMachine([a, b], { agent: 'claude' }, { previousId: a.id }).machine?.name, 'a');
		assert.match(pickMachine([a, b], { agent: 'claude' }, { previousId: a.id }).why, /Stays on a/);
		// A big gap moves it.
		const hot = runner('a', { cpu: 0.9 });
		assert.strictEqual(pickMachine([hot, b], { agent: 'claude' }, { previousId: hot.id }).machine?.name, 'b');
		// A previous pick that can no longer run it is dropped.
		assert.strictEqual(pickMachine([{ ...a, online: false }, b], { agent: 'claude' }, { previousId: a.id }).machine?.name, 'b');
	});

	test('queued work, battery and heat count against a machine', () => {
		const free = runner('free', { cpu: 0.3 });
		const reserved = runner('reserved', { cpu: 0.1 }, { reserved: 1 });
		assert.ok(scoreMachine(reserved) > scoreMachine(free), 'a task already on its way counts');
		assert.strictEqual(pickMachine([reserved, free], { agent: 'claude' }).machine?.name, 'free');
		const laptop = runner('laptop', { cpu: 0.1, battery: { percent: 15, charging: false } });
		assert.ok(scoreMachine(laptop) > scoreMachine(runner('plugged', { cpu: 0.1 })) + 0.4);
		assert.ok(scoreMachine(runner('hot', { cpu: 0.1, thermal: 'serious' })) > scoreMachine(runner('cool', { cpu: 0.1 })));
		assert.strictEqual(machineEligibility(runner('melting', { thermal: 'critical' }), { agent: 'claude' }).eligible, false);
	});

	test('describes load for the picker', () => {
		assert.strictEqual(describeMachineLoad(runner('a', { cpu: 0.234, running: 1 }), 0), '4 cores · 23% CPU · 2.0 of 8 GB · 1 running');
		assert.strictEqual(describeMachineLoad({ ...runner('a', {}), online: false, lastSeenAt: 0 }, 5 * 60_000), 'Offline 5 min');
	});
});
