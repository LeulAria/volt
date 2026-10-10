/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What Volt does while nobody touches it: CPU time per process role and processes spawned over a
// fixed window, on the home screen and with a chat open.
// Usage: node build/volt/perf/idleBench.mjs --app dev|<path/to/VOLT.app> --fixtures <agentSessions dir> [--seconds 60] [--port 9935] [--out file.json]

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import { connectWorkbench, createProfile, evaluate, launch, processTree, sleep, stop, waitFor } from './lib.mjs';

const { values: opts } = parseArgs({
	options: {
		app: { type: 'string', default: 'dev' },
		port: { type: 'string', default: '9935' },
		profile: { type: 'string', default: '/tmp/vpf-i' },
		fixtures: { type: 'string', multiple: true, default: [] },
		seconds: { type: 'string', default: '60' },
		out: { type: 'string' },
	}
});

function cpuSeconds(pids) {
	if (!pids.length) {
		return new Map();
	}
	const out = execFileSync('ps', ['-o', 'pid=,time=', '-p', pids.join(',')], { encoding: 'utf8' });
	const result = new Map();
	for (const line of out.split('\n').filter(Boolean)) {
		const [pid, time] = line.trim().split(/\s+/);
		const parts = time.split(':').map(Number);
		result.set(+pid, parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]);
	}
	return result;
}

async function measure(label, instance) {
	const seconds = +opts.seconds;
	const before = processTree(instance.pid);
	const cpu0 = cpuSeconds(before.map(p => p.pid));
	const spawned = new Map();
	const known = new Set(before.map(p => p.pid));
	const deadline = Date.now() + seconds * 1000;
	let last = before;
	while (Date.now() < deadline) {
		await sleep(100);
		last = processTree(instance.pid);
		for (const p of last) {
			if (!known.has(p.pid)) {
				known.add(p.pid);
				spawned.set(p.pid, p.args.split(' ').slice(0, 2).map(a => a.split('/').pop()).join(' ').slice(0, 50));
			}
		}
	}
	const cpu1 = cpuSeconds(last.map(p => p.pid));
	const byRole = {};
	for (const p of last) {
		const delta = (cpu1.get(p.pid) ?? 0) - (cpu0.get(p.pid) ?? 0);
		byRole[p.role] = Math.round(((byRole[p.role] ?? 0) + delta) * 100) / 100;
	}
	const total = Object.values(byRole).reduce((a, b) => a + b, 0);
	const commands = Object.entries([...spawned.values()].reduce((acc, c) => (acc[c] = (acc[c] ?? 0) + 1, acc), {})).sort((a, b) => b[1] - a[1]).slice(0, 10);
	const row = { label, seconds, cpuSeconds: Math.round(total * 100) / 100, cpuPercent: Math.round(total / seconds * 1000) / 10, byRole, spawned: spawned.size, commands };
	console.log(JSON.stringify(row));
	return row;
}

createProfile(opts.profile, { fixtures: opts.fixtures });
const instance = launch({ app: opts.app, profile: opts.profile, port: +opts.port });
const rows = [];
try {
	const client = await connectWorkbench(+opts.port);
	await waitFor(client, `!!document.querySelector('.volt-agent-home-row.is-session')`, 120_000);
	await sleep(20_000); // let startup work finish
	rows.push(await measure('home', instance));
	const box = await evaluate(client, `(() => { const b = document.querySelector('.volt-agent-home-row.is-session').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + 12 }; })()`);
	for (const type of ['mousePressed', 'mouseReleased']) {
		await client.Input.dispatchMouseEvent({ type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
	}
	await sleep(15_000); // prewarm and first render
	rows.push(await measure('chat open', instance));
	await client.close();
} finally {
	await stop(instance);
}
if (opts.out) {
	fs.writeFileSync(opts.out, JSON.stringify({ app: opts.app, rows }, null, 1));
}
process.exit(0);
