/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Streaming benchmark for the agent chat in a Volt test instance, driven over CDP.
//
// Usage: node build/volt/renderSuite/voltBench.mjs --port 9961 [--runs 3] [--out results.json]
//          [--prefix 'cps=600'] [--history N] scenario...
//
// Each scenario (e.g. `bench:r09`, `bench:long`, `bench:t01`) opens a new chat, sends the
// prompt (plus `--prefix` options) to the selected model (pick the fake ACP agent from
// fakeAcpAgent.mjs first), and records until the turn's footer appears:
//   - time from Enter to the first visible reply text, and to completion
//   - frames (requestAnimationFrame deltas): count, p50/p95/max, frames over 16.7 / 33.3 ms
//   - long tasks (> 50 ms): count, total, max
//   - CDP Performance.getMetrics deltas: script, layout, style recalc, task time, layout count
//   - DOM mutations: nodes added/removed, removed nodes that held reply text (finished blocks
//     torn down and rebuilt), text-node changes
//   - follow: frames where the view was meant to stick to the bottom but was > 4 px away from it,
//     and frames where scrollTop went backwards
//   - heap used and DOM node count after the run
// `--history N` first sends N short turns (bench:r01 at high cps) in the same chat, to measure
// streaming cost at the end of a long conversation.

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(path.join(import.meta.dirname, '..', '..', '..', 'package.json'));
const CDP = require('chrome-remote-interface');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	if (i < 0) {
		return fallback;
	}
	const [value] = args.splice(i, 2).slice(1);
	return value;
};
const port = Number(opt('port', '9961'));
const runs = Number(opt('runs', '1'));
const out = opt('out', undefined);
const prefix = opt('prefix', 'cps=600');
const history = Number(opt('history', '0'));
const scenarios = args.filter(a => !a.startsWith('--')).length ? args.filter(a => !a.startsWith('--')) : ['bench:r09'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect() {
	const targets = await CDP.List({ port });
	const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url));
	const client = await CDP({ port, target: page });
	await client.Runtime.enable();
	await client.Performance.enable({ timeDomain: 'timeTicks' });
	return client;
}

async function ev(client, body) {
	const r = await client.Runtime.evaluate({ expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) {
		throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
	}
	return r.result.value;
}

async function clickAt(client, selector, text) {
	const p = await ev(client, `const re = ${text ? `new RegExp(${JSON.stringify(text)})` : 'null'};
		const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => (!re || re.test(e.textContent.trim())) && e.getClientRects().length);
		if (!el) { return null; } const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
	if (!p) {
		throw new Error(`nothing matches ${selector} ${text ?? ''}`);
	}
	for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
		await client.Input.dispatchMouseEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
	}
}

async function newChat(client) {
	await clickAt(client, '.volt-agent-home-row.is-new');
	for (let i = 0; i < 40; i++) {
		await sleep(100);
		if (await ev(client, `return !document.querySelector('.volt-agent-turn') && !!document.querySelector('textarea.inputarea');`)) {
			return;
		}
	}
	throw new Error('new chat did not open');
}

async function typeAndSend(client, text) {
	await ev(client, `const ta = [...document.querySelectorAll('textarea.inputarea')].find(t => t.getClientRects().length && t.closest('.volt-agent-editor')); ta.focus(); return 1;`);
	await client.Input.insertText({ text });
	await sleep(120);
	await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
	await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}

/** Footers on finished agent turns. */
const footers = client => ev(client, `return document.querySelectorAll('.volt-agent-turn.agent .volt-agent-footer').length;`);

async function waitForFooters(client, n, timeoutMs) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (await footers(client) >= n) {
			return true;
		}
		await sleep(100);
	}
	return false;
}

const INSTALL = `
	const inner = document.querySelector('.volt-agent-thread-inner');
	const s = window.__voltBench = { t0: performance.now(), firstText: 0, frames: [], longTasks: [], added: 0, removed: 0, removedText: 0, chars: 0, behind: 0, back: 0, maxBehind: 0, lastTop: -1, done: false };
	const replyText = () => { const turns = inner.querySelectorAll('.volt-agent-turn.agent'); const last = turns[turns.length - 1]; return last ? (last.querySelector('.volt-agent-thread-body')?.textContent.length ?? 0) : 0; };
	s.baseTurns = inner.querySelectorAll('.volt-agent-turn.agent').length;
	const mo = new MutationObserver(records => {
		for (const r of records) {
			if (r.type === 'characterData') { s.chars++; continue; }
			s.added += r.addedNodes.length;
			s.removed += r.removedNodes.length;
			for (const n of r.removedNodes) {
				if (n.nodeType === 1 && n.querySelector && n.querySelector('.volt-agent-reply, .volt-agent-markdown')) { s.removedText++; }
			}
		}
	});
	mo.observe(inner, { childList: true, subtree: true, characterData: true });
	const po = new PerformanceObserver(list => { for (const e of list.getEntries()) { s.longTasks.push(e.duration); } });
	po.observe({ type: 'longtask' });
	let prev = performance.now();
	const tick = now => {
		if (s.done) { mo.disconnect(); po.disconnect(); return; }
		s.frames.push(now - prev);
		prev = now;
		const turns = inner.querySelectorAll('.volt-agent-turn.agent');
		if (!s.firstText && turns.length > s.baseTurns && replyText() > 0) { s.firstText = now - s.t0; }
		const editor = inner.closest('.volt-agent-thread');
		const following = editor && editor.classList.contains('at-end');
		const behind = inner.scrollHeight - inner.clientHeight - inner.scrollTop;
		if (turns.length > s.baseTurns && following && behind > 4) { s.behind++; s.maxBehind = Math.max(s.maxBehind, behind); }
		if (s.lastTop >= 0 && inner.scrollTop < s.lastTop - 1 && following) { s.back++; }
		s.lastTop = inner.scrollTop;
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	return 1;`;

const COLLECT = `const s = window.__voltBench; s.done = true; s.total = performance.now() - s.t0;
	return { firstText: s.firstText, total: s.total, frames: s.frames, longTasks: s.longTasks, added: s.added, removed: s.removed, removedText: s.removedText, chars: s.chars, behind: s.behind, maxBehind: s.maxBehind, back: s.back,
		nodes: document.getElementsByTagName('*').length, heap: performance.memory ? performance.memory.usedJSHeapSize : 0 };`;

async function metrics(client) {
	const { metrics: list } = await client.Performance.getMetrics();
	return Object.fromEntries(list.map(m => [m.name, m.value]));
}

const pct = (values, p) => {
	if (!values.length) {
		return 0;
	}
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
const round = n => Math.round(n * 10) / 10;

async function runScenario(client, scenario) {
	await newChat(client);
	for (let i = 0; i < history; i++) {
		await typeAndSend(client, `bench:r0${1 + (i % 7)} cps=20000`);
		if (!await waitForFooters(client, i + 1, 30000)) {
			throw new Error('history turn did not finish');
		}
	}
	await sleep(400);
	await client.HeapProfiler.collectGarbage().catch(() => undefined);
	const before = await metrics(client);
	await ev(client, INSTALL);
	await typeAndSend(client, `${scenario} ${prefix}`);
	const finished = await waitForFooters(client, history + 1, 180000);
	// Let the last frames and the fade settle into the numbers like a user would see them.
	await sleep(300);
	const raw = await ev(client, COLLECT);
	const after = await metrics(client);
	const frames = raw.frames.slice(1);
	const delta = name => round(((after[name] ?? 0) - (before[name] ?? 0)) * 1000);
	return {
		scenario, history, finished,
		firstTextMs: round(raw.firstText), totalMs: round(raw.total),
		frames: frames.length, frameP50: round(pct(frames, 0.5)), frameP95: round(pct(frames, 0.95)), frameMax: round(Math.max(0, ...frames)),
		over16: frames.filter(f => f > 16.7).length, over33: frames.filter(f => f > 33.4).length,
		longTasks: raw.longTasks.length, longTaskMs: round(raw.longTasks.reduce((a, b) => a + b, 0)), longTaskMax: round(Math.max(0, ...raw.longTasks)),
		scriptMs: delta('ScriptDuration'), layoutMs: delta('LayoutDuration'), styleMs: delta('RecalcStyleDuration'), taskMs: delta('TaskDuration'),
		layouts: Math.round((after.LayoutCount ?? 0) - (before.LayoutCount ?? 0)), styleRecalcs: Math.round((after.RecalcStyleCount ?? 0) - (before.RecalcStyleCount ?? 0)),
		nodesAdded: raw.added, nodesRemoved: raw.removed, replyBlocksRebuilt: raw.removedText, textChanges: raw.chars,
		followMissFrames: raw.behind, followMaxBehindPx: round(raw.maxBehind), scrollBackFrames: raw.back,
		domNodes: raw.nodes, heapMB: round(raw.heap / 1048576),
	};
}

const client = await connect();
// Dev builds track every disposable with an Error stack (performance.contribution.ts); built apps do not.
// Turn it off so dev numbers are closer to a shipped build. `--keep-tracker` keeps it.
if (!args.includes('--keep-tracker')) {
	await client.Runtime.evaluate({ expression: `import(new URL('../../../base/common/lifecycle.js', location.href).href).then(m => { m.setDisposableTracker(null); return 1; })`, awaitPromise: true });
}
const results = [];
try {
	for (const scenario of scenarios) {
		for (let r = 0; r < runs; r++) {
			const result = await runScenario(client, scenario);
			results.push(result);
			console.log(JSON.stringify(result));
		}
	}
} finally {
	await client.close();
}
if (out) {
	fs.writeFileSync(out, JSON.stringify(results, null, '\t'));
}
