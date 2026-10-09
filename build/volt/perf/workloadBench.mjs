/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Multi-chat / browser / terminal workload with process-tree memory, renderer heap, latency and
// main-thread responsiveness, followed by a close-everything step that checks what is released.
// Usage: node build/volt/perf/workloadBench.mjs --app dev|<path/to/VOLT.app> --fixtures <agentSessions dir>
//        [--chats 20] [--browsers 4] [--terminals 4] [--url http://127.0.0.1:9958/] [--port 9932] [--out file.json] [--hold]
// --hold leaves the instance running (e.g. for build/volt/perf/heapRetainers.mjs).
// The page at --url should exist (any local page; the bench uses a 3,000-row table with a canvas animation).

import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import { connectWorkbench, createProfile, evaluate, launch, median, memorySnapshot, press, rendererMetrics, runCommand, sleep, stop, waitFor } from './lib.mjs';

const { values: opts } = parseArgs({
	options: {
		app: { type: 'string', default: 'dev' },
		port: { type: 'string', default: '9932' },
		profile: { type: 'string', default: '/tmp/vpf-w' },
		fixtures: { type: 'string', multiple: true, default: [] },
		chats: { type: 'string', default: '20' },
		browsers: { type: 'string', default: '4' },
		terminals: { type: 'string', default: '4' },
		url: { type: 'string', default: 'http://127.0.0.1:9958/' },
		settle: { type: 'string', default: '8000' },
		hold: { type: 'boolean', default: false },
		out: { type: 'string' },
	}
});

const SESSION_ROW = '.volt-agent-home-row.is-session';

// Main-thread responsiveness probe: long tasks and timer drift, collected inside the page.
const INSTALL_PROBE = `(() => {
	if (globalThis.__vpf) { return true; }
	const p = globalThis.__vpf = { longTasks: 0, longTaskMs: 0, lags: [] };
	new PerformanceObserver(list => { for (const e of list.getEntries()) { p.longTasks++; p.longTaskMs += e.duration; } }).observe({ type: 'longtask' });
	let last = performance.now();
	setInterval(() => { const now = performance.now(); p.lags.push(Math.max(0, now - last - 50)); last = now; }, 50);
	return true;
})()`;
const READ_PROBE = `(() => { const p = globalThis.__vpf; const lags = p.lags.splice(0).sort((a, b) => a - b); const r = { longTasks: p.longTasks, longTaskMs: Math.round(p.longTaskMs), lagP95: Math.round(lags[Math.floor(lags.length * 0.95)] ?? 0), lagMax: Math.round(lags[lags.length - 1] ?? 0) }; p.longTasks = 0; p.longTaskMs = 0; return r; })()`;

async function clickAt(client, selector, index) {
	const box = await evaluate(client, `(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 12) }; })()`);
	if (!box) {
		return false;
	}
	for (const type of ['mousePressed', 'mouseReleased']) {
		await client.Input.dispatchMouseEvent({ type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
	}
	return true;
}

// Opens the next chat in the home list that has not been opened yet (scrolling the virtualized list
// when every rendered row was visited); resolves with ms until its thread has rendered.
const visited = new Set();
async function openNextChat(client) {
	let index = -1;
	for (let attempt = 0; attempt < 12 && index < 0; attempt++) {
		const rows = await evaluate(client, `[...document.querySelectorAll('${SESSION_ROW}')].map(r => r.getAttribute('aria-label') || r.textContent)`);
		index = rows.findIndex(label => !visited.has(label));
		if (index >= 0) {
			visited.add(rows[index]);
			break;
		}
		const box = await evaluate(client, `(() => { const b = document.querySelector('${SESSION_ROW}').closest('.monaco-list').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
		await client.Input.dispatchMouseEvent({ type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 400 });
		await sleep(300);
	}
	return index < 0 ? null : openChat(client, index);
}

// Opens the index-th rendered chat row; resolves with ms until its thread has rendered.
async function openChat(client, index) {
	const before = await evaluate(client, `(() => document.querySelector('.volt-agent-editor .volt-agent-thread-body')?.textContent.slice(0, 300) ?? '')()`);
	await evaluate(client, `(() => { globalThis.__vpfT0 = performance.now(); return true; })()`);
	if (!await clickAt(client, SESSION_ROW, index)) {
		return null;
	}
	const ms = await waitFor(client, `(() => { const t = document.querySelector('.volt-agent-editor .volt-agent-thread-body')?.textContent.slice(0, 300) ?? ''; return t && t !== ${JSON.stringify(before)} && Math.max(1, Math.round(performance.now() - globalThis.__vpfT0)); })()`, 8_000, 10).catch(() => null);
	await sleep(400);
	return ms;
}

async function sample(label, instance, client) {
	await sleep(+opts.settle);
	const renderer = await rendererMetrics(client);
	const memory = memorySnapshot(instance.pid);
	const probe = await evaluate(client, READ_PROBE);
	const webviews = await evaluate(client, `document.querySelectorAll('webview').length`);
	const row = { label, ...memory, renderer, probe, webviews };
	console.log(JSON.stringify(row));
	return row;
}

createProfile(opts.profile, { fixtures: opts.fixtures });
const instance = launch({ app: opts.app, profile: opts.profile, port: +opts.port });
const result = { app: opts.app, opts, samples: [], chatOpenMs: [], browserOpenMs: [] };
try {
	const client = await connectWorkbench(+opts.port);
	await waitFor(client, `!!document.querySelector('${SESSION_ROW}')`, 120_000);
	await evaluate(client, INSTALL_PROBE);
	result.samples.push(await sample('idle', instance, client));

	// 1. Open many chats, one after another (each replaces the visible one).
	const chats = +opts.chats;
	for (let i = 0; i < chats; i++) {
		result.chatOpenMs.push(await openNextChat(client));
	}
	result.samples.push(await sample(`after ${chats} chats`, instance, client));

	// 2. A browser tab with a heavy local page in several chats.
	for (let i = 0; i < +opts.browsers; i++) {
		await openNextChat(client);
		await evaluate(client, `(() => { document.querySelector('.volt-agent-editor textarea, .volt-agent-editor [contenteditable], .volt-agent-editor .native-edit-context')?.focus(); return true; })()`);
		await press(client, 'B', 4 | 8);
		await waitFor(client, `!![...document.querySelectorAll('.volt-browser-start-input, .volt-browser-url')].find(i => i.offsetParent)`, 10_000).catch(() => null);
		const t0 = Date.now();
		await evaluate(client, `(() => { const i = [...document.querySelectorAll('.volt-browser-start-input, .volt-browser-url')].filter(i => i.offsetParent).pop(); i?.focus(); i?.select?.(); return !!i; })()`);
		await client.Input.insertText({ text: opts.url });
		await press(client, 'Enter');
		const n = i + 1;
		await waitFor(client, `document.querySelectorAll('webview').length >= ${n}`, 15_000).catch(() => null);
		result.browserOpenMs.push(Date.now() - t0);
	}
	result.samples.push(await sample(`+ ${opts.browsers} browser tabs`, instance, client));

	// 3. Terminals.
	for (let i = 0; i < +opts.terminals; i++) {
		await runCommand(client, 'Terminal: Create New Terminal');
		await sleep(800);
	}
	result.samples.push(await sample(`+ ${opts.terminals} terminals`, instance, client));

	// 4. Close everything and check what is released.
	await runCommand(client, 'Terminal: Kill All Terminals');
	await sleep(500);
	await runCommand(client, 'View: Close All Editors');
	await press(client, 'Escape');
	await sleep(5000);
	result.samples.push(await sample('after closing all', instance, client));
	await sleep(20000);
	result.samples.push(await sample('closed + 30s', instance, client));
	await client.close();
} finally {
	if (!opts.hold) {
		await stop(instance);
	}
}

const opened = result.chatOpenMs.filter(ms => typeof ms === 'number');
result.summary = {
	chatOpenMedianMs: median(opened),
	chatOpenMaxMs: Math.max(...opened),
	chatOpenFailures: result.chatOpenMs.length - opened.length,
	browserOpenMedianMs: median(result.browserOpenMs),
	memory: Object.fromEntries(result.samples.map(s => [s.label, { totalMiB: s.totalMiB, processes: s.processes, jsHeapMiB: s.renderer.jsHeapUsedMiB, domNodes: s.renderer.domNodes, listeners: s.renderer.listeners, webviews: s.webviews, longTaskMs: s.probe.longTaskMs, lagP95: s.probe.lagP95, lagMax: s.probe.lagMax }])),
};
console.log(JSON.stringify(result.summary, null, 1));
if (opts.out) {
	fs.writeFileSync(opts.out, JSON.stringify(result, null, 1));
}
process.exit(0);
