/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScore, pickMachine, SWITCH_MARGIN } from '../src/placement.mjs';

const NOW = 1_000_000;
const idle = { load1: 0.5, cpus: 8, memFree: 30e9, memTotal: 32e9, running: 0, thermal: 'nominal' };
const busy = { load1: 24, cpus: 8, memFree: 4e9, memTotal: 32e9, running: 2, thermal: 'nominal' };
const machine = (id, load, extra = {}) => ({
	id, at: NOW - 1000, load, running: [], caps: { agents: { codex: { installed: true, credentials: true }, claude: { installed: true, credentials: true } }, maxParallel: 2 }, ...extra,
});
const task = { agent: 'codex' };

test('load score: idle is near zero, saturated and hot machines score worse', () => {
	assert.ok(loadScore({ load: idle }) < 0.1);
	assert.ok(loadScore({ load: busy }) > 3);
	assert.ok(loadScore({ load: { ...idle, thermal: 'serious' } }) > loadScore({ load: idle }));
});

test('Auto picks the least loaded eligible machine', () => {
	const picked = pickMachine([machine('busy', busy), machine('idle', idle)], task, { now: NOW });
	assert.equal(picked.machineId, 'idle');
});

test('filters: stale heartbeat, missing agent or credentials, full slots, and aimed elsewhere are never picked', () => {
	const stale = machine('stale', idle, { at: NOW - 60_000 });
	const noCodex = machine('nocodex', idle, { caps: { agents: { codex: { installed: false } }, maxParallel: 2 } });
	const noCreds = machine('nocreds', idle, { caps: { agents: { codex: { installed: true, credentials: false } }, maxParallel: 2 } });
	const full = machine('full', idle, { running: [{ id: 'a' }, { id: 'b' }] });
	const good = machine('good', busy);
	const picked = pickMachine([stale, noCodex, noCreds, full, good], task, { now: NOW });
	assert.equal(picked.machineId, 'good');
	assert.equal(picked.reasons.stale, 'stale heartbeat');
	assert.equal(picked.reasons.nocodex, 'codex is not installed');
	assert.equal(picked.reasons.nocreds, 'codex has no credentials');
	assert.equal(picked.reasons.full, 'no free slot');
	assert.equal(pickMachine([machine('a', idle)], { agent: 'codex', machineId: 'b' }, { now: NOW }).machineId, undefined);
});

test('no eligible machine returns undefined with reasons', () => {
	const picked = pickMachine([machine('x', idle, { at: 0 })], task, { now: NOW });
	assert.equal(picked.machineId, undefined);
	assert.equal(picked.reasons.x, 'stale heartbeat');
});

test('hysteresis: the previous machine keeps a task unless another is clearly less loaded', () => {
	const warm = { ...idle, load1: 2.4 }; // score 0.3
	const cool = { ...idle, load1: 0.8 }; // score 0.1
	const previous = machine('previous', warm);
	const other = machine('other', cool);
	assert.ok(loadScore({ load: warm }) - loadScore({ load: cool }) < SWITCH_MARGIN);
	assert.equal(pickMachine([previous, other], task, { now: NOW, previousId: 'previous' }).machineId, 'previous');
	// A clearly idle machine wins even against the incumbent.
	assert.equal(pickMachine([machine('previous', busy), other], task, { now: NOW, previousId: 'previous' }).machineId, 'other');
});

test('ties break by machine id, so the choice is stable', () => {
	assert.equal(pickMachine([machine('b', idle), machine('a', idle)], task, { now: NOW }).machineId, 'a');
});

test('inside a container the cgroup busy fraction is the load, not the shared host load average', () => {
	const shared = { ...idle, container: true, cpu: 0.9, load1: 0.1 };
	const quiet = { ...idle, container: true, cpu: 0.05, load1: 30 };
	assert.ok(loadScore({ load: shared }) > loadScore({ load: quiet }));
	assert.ok(loadScore({ load: quiet }) < 0.1);
});

test('a laptop on battery scores worse than a plugged-in machine, and worse still when nearly empty', () => {
	const plugged = machine('plugged', { cpu: 0.1, load1: 0, cpus: 4 });
	const onBattery = machine('battery', { cpu: 0.1, battery: { percent: 60, charging: false } });
	const nearlyEmpty = machine('empty', { cpu: 0.1, battery: { percent: 10, charging: false } });
	assert.ok(loadScore(onBattery) > loadScore(plugged) + 0.1);
	assert.ok(loadScore(nearlyEmpty) > loadScore(onBattery) + 0.2);
});
