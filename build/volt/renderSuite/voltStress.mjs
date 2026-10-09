/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Generate/cancel stress for the agent chat: rounds of (new chat, send, stop mid-stream or let it
// finish), checking that every run settles (no spinner left, the stop hands the prompt back) and
// recording heap after GC, DOM nodes, listeners and live animations after each round. Growth
// that keeps going round after round is a leak; growth that levels off is the chat stash.
// Usage: node build/volt/renderSuite/voltStress.mjs --port 9961 [--rounds 3] [--per 6] [--prompt 'bench:r09 cps=1500']

import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(path.join(import.meta.dirname, '..', '..', '..', 'package.json'));
const CDP = require('chrome-remote-interface');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : fallback;
};
const port = Number(opt('port', '9961'));
const rounds = Number(opt('rounds', '3'));
const per = Number(opt('per', '6'));
const prompt = opt('prompt', 'bench:r09 cps=1500');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const targets = await CDP.List({ port });
const client = await CDP({ port, target: targets.find(t => t.type === 'page' && /workbench/.test(t.url)) });
await client.Performance.enable();
const ev = async body => {
	const r = await client.Runtime.evaluate({ expression: `(() => { ${body} })()`, returnByValue: true });
	if (r.exceptionDetails) {
		throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
	}
	return r.result.value;
};
const click = async selector => {
	const p = await ev(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) { return null; } const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
	if (!p) {
		return false;
	}
	for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
		await client.Input.dispatchMouseEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
	}
	return true;
};
const send = async text => {
	await ev(`const ta = [...document.querySelectorAll('textarea.inputarea')].find(t => t.getClientRects().length && t.closest('.volt-agent-editor')); ta.focus(); return 1;`);
	await client.Input.insertText({ text });
	await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
	await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const sample = async () => {
	await client.HeapProfiler.collectGarbage();
	await sleep(300);
	await client.HeapProfiler.collectGarbage();
	const { metrics } = await client.Performance.getMetrics();
	const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
	const page = await ev(`return { animations: document.getAnimations().length, fresh: document.querySelectorAll('.volt-agent-fresh-text').length, editors: document.querySelectorAll('.monaco-editor').length };`);
	return { heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents, ...page };
};

const problems = [];
const samples = [await sample()];
console.log('start', JSON.stringify(samples[0]));
try {
	for (let round = 0; round < rounds; round++) {
		for (let i = 0; i < per; i++) {
			const cancel = i % 2 === 0;
			await click('.volt-agent-home-row.is-new');
			await sleep(900);
			await send(`${prompt} stress${round}-${i}`);
			if (cancel) {
				await sleep(1200);
				if (!await ev(`const b = document.querySelector('.volt-agent-turn.user .volt-agent-user-stop'); b?.click(); return !!b;`)) {
					problems.push(`round ${round} run ${i}: no stop button 1.2 s into the run`);
				}
				await sleep(1500);
				const state = await ev(`const user = [...document.querySelectorAll('.volt-agent-turn.user')].pop(); return { editing: !!user?.classList.contains('editing'), running: !!document.querySelector('.volt-agent-turn.user.running'), live: !!document.querySelector('.volt-tr-row.live, .volt-agent-thinking-live, .volt-agent-turn.agent .volt-agent-status-live') };`);
				if (!state.editing || state.running) {
					problems.push(`round ${round} run ${i}: after Stop ${JSON.stringify(state)}`);
				}
				// Leave the edit as Cursor does: Escape puts the sent message back.
				await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
				await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
				await sleep(400);
			} else {
				let done = false;
				for (let k = 0; k < 300 && !done; k++) {
					await sleep(200);
					done = await ev(`const t = [...document.querySelectorAll('.volt-agent-turn.agent')].pop(); return !!t?.querySelector('.volt-agent-footer') && !document.querySelector('.volt-agent-turn.user.running');`);
				}
				if (!done) {
					problems.push(`round ${round} run ${i}: did not finish in 60 s`);
				}
			}
		}
		const s = await sample();
		samples.push(s);
		console.log(`round ${round + 1}`, JSON.stringify(s));
	}
} finally {
	await client.close();
}
const growth = samples.slice(1).map((s, i) => ({ heapMB: +(s.heapMB - samples[i].heapMB).toFixed(1), nodes: s.nodes - samples[i].nodes, listeners: s.listeners - samples[i].listeners }));
console.log('growth per round', JSON.stringify(growth));
console.log(problems.length ? `PROBLEMS\n${problems.join('\n')}` : 'no stuck runs');
process.exitCode = problems.length ? 1 : 0;
