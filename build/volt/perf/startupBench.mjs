/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Cold and warm startup of Volt, plus idle memory of the whole process tree.
// Usage: node build/volt/perf/startupBench.mjs --app dev|<path/to/VOLT.app> [--runs 5] [--port 9931]
//        [--profile /tmp/vpf-s] [--fixtures <dir>...] [--settle 15000] [--out results.json]
// Cold = first launch of a fresh profile (no V8 code cache, no state). Warm = relaunch of that profile.
// The OS file cache stays warm in both cases (purging it needs root).

import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import { connectWorkbench, createProfile, evaluate, launch, marks, median, memorySnapshot, processTree, rendererMetrics, sleep, stop, waitFor } from './lib.mjs';

const { values: opts } = parseArgs({
	options: {
		app: { type: 'string', default: 'dev' },
		runs: { type: 'string', default: '5' },
		port: { type: 'string', default: '9931' },
		profile: { type: 'string', default: '/tmp/vpf-s' },
		fixtures: { type: 'string', multiple: true, default: [] },
		settle: { type: 'string', default: '15000' },
		folder: { type: 'string' },
		out: { type: 'string' },
	}
});

// Volt's agent layout is ready once its sidebar or home pane has rendered.
const READY = `!!document.querySelector('.volt-agent-home-row.is-session')`;

async function once(kind) {
	const port = +opts.port;
	const instance = launch({ app: opts.app, profile: opts.profile, port, args: opts.folder ? [opts.folder] : [] });
	// Child processes (CLI probes, agents, git...) seen during startup and the settle period,
	// sampled every 100 ms, so very short-lived ones can be missed.
	const spawned = new Map();
	const poll = setInterval(() => {
		for (const p of processTree(instance.pid)) {
			if (p.role === 'child-process' && !spawned.has(p.pid)) {
				spawned.set(p.pid, p.args.split(' ').slice(0, 3).map(a => a.split('/').pop()).join(' ').slice(0, 60));
			}
		}
	}, 100);
	try {
		const client = await connectWorkbench(port);
		const targetAt = Date.now();
		const m = await waitFor(client, `(() => { const m = globalThis.MonacoPerformanceMarks?.getMarks() ?? []; return m.some(x => x.name === 'code/didStartWorkbench') && Object.fromEntries(m.map(x => [x.name, x.startTime])); })()`, 120_000);
		await waitFor(client, READY, 60_000);
		const readyAt = Date.now();
		// Extensions registered = the extension host answered; the usual "fully interactive" point.
		const all = await waitFor(client, `(() => { const m = globalThis.MonacoPerformanceMarks?.getMarks() ?? []; return m.some(x => x.name === 'code/didLoadExtensions') && Object.fromEntries(m.map(x => [x.name, x.startTime])); })()`, 120_000).catch(() => marks(client));
		await sleep(+opts.settle);
		clearInterval(poll);
		const memory = memorySnapshot(instance.pid);
		const renderer = await rendererMetrics(client);
		const longTasks = await evaluate(client, `(() => performance.getEntriesByType('longtask')?.length ?? null)()`).catch(() => null);
		await client.close();
		const rel = name => all[name] ? Math.round(all[name] - instance.startedAt) : null;
		return {
			kind,
			pageTargetMs: targetAt - instance.startedAt,
			didStartWorkbenchMs: Math.round(m['code/didStartWorkbench'] - instance.startedAt),
			didRestoreEditorsMs: rel('code/didRestoreEditors'),
			didLoadExtensionsMs: rel('code/didLoadExtensions'),
			readyDomMs: readyAt - instance.startedAt,
			memory, renderer, longTasks,
			childProcesses: spawned.size,
			childCommands: Object.entries([...spawned.values()].reduce((acc, c) => (acc[c] = (acc[c] ?? 0) + 1, acc), {})).sort((x, y) => y[1] - x[1]).slice(0, 12),
		};
	} finally {
		clearInterval(poll);
		await stop(instance);
		await sleep(1500);
	}
}

const results = [];
for (let i = 0; i < +opts.runs; i++) {
	createProfile(opts.profile, { fixtures: opts.fixtures });
	results.push(await once('cold'));
	results.push(await once('warm'));
	console.log(JSON.stringify(results.slice(-2)));
}

const summary = {};
for (const kind of ['cold', 'warm']) {
	const rows = results.filter(r => r.kind === kind);
	summary[kind] = Object.fromEntries(['pageTargetMs', 'didStartWorkbenchMs', 'didRestoreEditorsMs', 'didLoadExtensionsMs', 'readyDomMs'].map(key => [key, median(rows.map(r => r[key] ?? NaN))]));
	summary[kind].idleTotalMiB = median(rows.map(r => r.memory.totalMiB));
	summary[kind].idleJsHeapMiB = median(rows.map(r => r.renderer.jsHeapUsedMiB));
	summary[kind].domNodes = median(rows.map(r => r.renderer.domNodes));
	summary[kind].childProcesses = median(rows.map(r => r.childProcesses));
}
console.log(JSON.stringify({ app: opts.app, runs: +opts.runs, summary }, null, 1));
if (opts.out) {
	fs.writeFileSync(opts.out, JSON.stringify({ app: opts.app, opts, summary, results }, null, 1));
}
process.exit(0);
