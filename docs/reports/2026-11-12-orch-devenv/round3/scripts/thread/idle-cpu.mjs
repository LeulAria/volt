#!/usr/bin/env node
// Renderer main-thread busy time while a chat sits open and idle: Performance.getMetrics
// TaskDuration (plus Layout/RecalcStyle) over `--ms`, after `--settle` ms. `--chat` opens that chat
// first; `--drawall` then scrolls it to the top of what is drawn every frame until nothing more is
// drawn (every exchange in the DOM, as after a reader scrolled all the way up), and back to its end after.
//   node idle-cpu.mjs --chat "Long thread 45k" [--drawall] [--ms 10000] [--runs 3] [--out f.json]
import fs from 'node:fs';
import { connect, rowCenter, sleep, load, stats, waitLoad, withLoad } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const port = Number(opt('port', '9953'));
const chat = opt('chat');
const ms = Number(opt('ms', '10000'));
const settle = Number(opt('settle', '4000'));
const runs = Number(opt('runs', '3'));
const out = opt('out');

const cdp = await connect(port);
if (chat) {
	const at = await rowCenter(cdp, chat);
	await cdp.click(at.x, at.y);
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 60 });
}
const drawAll = args.includes('--drawall');
if (drawAll) {
	await sleep(2000);
	const drawn = await cdp.evaluate(`new Promise(resolve => {
		const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent);
		const inner = ed.querySelector('.volt-agent-thread-inner');
		let count = -1, since = performance.now();
		const step = () => {
			inner.scrollTop = 0;
			if (inner.childElementCount !== count) { count = inner.childElementCount; since = performance.now(); }
			if (performance.now() - since > 1500) { resolve(count); return; }
			requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	})`);
	console.log(`drawn exchanges: ${drawn}`);
}
await cdp.send('Performance.enable');
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]));
await sleep(settle);
const results = [];
for (let run = 0; run < runs; run++) {
	const before = await waitLoad();
	const a = await metrics();
	await sleep(ms);
	const b = await metrics();
	const per = k => Math.round((b[k] - a[k]) * 1000 / (ms / 1000) * 10) / 10;
	const r = { taskMsPerS: per('TaskDuration'), scriptMsPerS: per('ScriptDuration'), layoutMsPerS: per('LayoutDuration'), styleMsPerS: per('RecalcStyleDuration'), layouts: b.LayoutCount - a.LayoutCount, nodes: b.Nodes };
	console.log(`run ${run + 1}: ${JSON.stringify(r)}  (load ${load()})`);
	results.push(withLoad(r, before));
}
if (drawAll) {
	// Back to the end (a native scroll there makes the chat follow its end again).
	for (let i = 0; i < 3; i++) {
		await cdp.evaluate(`(() => { const inner = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent).querySelector('.volt-agent-thread-inner'); inner.scrollTop = inner.scrollHeight; return true; })()`);
		await sleep(500);
	}
}
const summary = { chat, drawAll, ms, load: load(), taskMsPerS: stats(results.map(r => r.taskMsPerS)), results };
console.log(JSON.stringify(summary.taskMsPerS));
if (out) {
	fs.writeFileSync(out, JSON.stringify(summary, null, 1));
}
cdp.close();
