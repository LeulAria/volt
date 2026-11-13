#!/usr/bin/env node
// Test 7: a long reasoning preview. Opens the seeded "Long reasoning" chat (a reply that thought
// for 2,500 lines, 224k characters; seed.mjs --chats reasoning) and clicks its "Thought" row open.
// Measured in the renderer from the click's mousedown: the reasoning's text on screen, and the
// frame from which the thread stops changing for 800 ms; long tasks meanwhile. Then it is closed.
// (While a reply streams, Volt shows a live thought as one "Thinking" row and does not draw its
// growing text, so the open row is where a long reasoning text is drawn.)
//
//   node reasoning-bench.mjs [--chat "Long reasoning"] [--runs 5] [--out f.json]
import fs from 'node:fs';
import { connect, rowCenter, sleep, load, stats, waitLoad, withLoad } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const port = Number(opt('port', '9953'));
const chat = opt('chat', 'Long reasoning');
const from = opt('from', 'Short thread');
const runs = Number(opt('runs', '5'));
const out = opt('out');

const PROBE = `window.__voltThoughtProbe = () => {
	const st = { t0: 0, frames: [], done: false, longTasks: [] };
	const po = new PerformanceObserver(list => { for (const e of list.getEntries()) st.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); });
	po.observe({ type: 'longtask' });
	const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent);
	const inner = ed.querySelector('.volt-agent-thread-inner');
	let stableSince = 0, lastSig = '';
	const tick = () => requestAnimationFrame(ts => {
		const body = inner.querySelector('.volt-tr-group.thought.open .volt-tr-thinking');
		const shown = !!body && body.textContent.length > 1000 && body.getBoundingClientRect().height > 0;
		const sig = inner.scrollHeight + '|' + Math.round(inner.scrollTop) + '|' + (body ? body.childElementCount : -1);
		st.frames.push([Math.round(ts * 10) / 10, shown]);
		if (!shown || sig !== lastSig) { stableSince = ts; lastSig = sig; }
		if ((shown && ts - stableSince > 800) || ts - st.t0 > 30000) { st.done = true; st.settled = stableSince; st.chars = body ? body.textContent.length : 0; st.blocks = body ? body.childElementCount : 0; po.disconnect(); return; }
		tick();
	});
	const onDown = e => { st.t0 = e.timeStamp; document.removeEventListener('mousedown', onDown, true); tick(); };
	document.addEventListener('mousedown', onDown, true);
	return st;
};`;

const headerAt = cdp => cdp.evaluate(`(() => { const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent); const h = ed.querySelector('.volt-tr-group.thought > .volt-tr-header'); if (!h) return null; h.scrollIntoView({ block: 'center' }); const b = h.getBoundingClientRect(); return { x: Math.round(b.x + 30), y: Math.round(b.y + b.height / 2), open: h.parentElement.classList.contains('open') }; })()`);

const cdp = await connect(port);
const results = [];
for (let run = 0; run < runs; run++) {
	const fromAt = await rowCenter(cdp, from);
	await cdp.click(fromAt.x, fromAt.y);
	await sleep(1500);
	const at = await rowCenter(cdp, chat);
	await cdp.click(at.x, at.y);
	await sleep(2500);
	let h = await headerAt(cdp);
	if (h?.open) {
		await cdp.click(h.x, h.y);
		await sleep(1000);
		h = await headerAt(cdp);
	}
	await sleep(500);
	const before = await waitLoad();
	await cdp.evaluate(PROBE);
	await cdp.evaluate('window.__voltThoughtState = window.__voltThoughtProbe(), true');
	await cdp.click(h.x, h.y);
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 60 });
	let state;
	for (let i = 0; i < 400 && !state; i++) {
		await sleep(100);
		state = await cdp.evaluate('window.__voltThoughtState.done ? window.__voltThoughtState : null');
	}
	const frames = state.frames;
	const first = frames.findIndex(f => f[1]);
	const result = first < 0 ? null : { shownMs: Math.round(frames[first][0] - state.t0), settledMs: Math.round(state.settled - state.t0), chars: state.chars, blocks: state.blocks, longTaskMs: state.longTasks.filter(([s]) => s >= state.t0).reduce((a, [, d]) => a + d, 0), maxLongTask: Math.max(0, ...state.longTasks.filter(([s]) => s >= state.t0).map(([, d]) => d)) };
	console.log(`run ${run + 1}: ${result ? `reasoning on screen ${result.shownMs} ms, settled ${result.settledMs} ms (${result.chars} chars, ${result.blocks} blocks), long tasks ${result.longTaskMs} ms (longest ${result.maxLongTask} ms)` : 'never shown'}  (load ${load()})`);
	results.push(withLoad(result, before));
	// Closed again, so the next run opens it the same way.
	h = await headerAt(cdp);
	if (h?.open) {
		await cdp.click(h.x, h.y);
	}
	await sleep(1000);
}
const ok = results.filter(Boolean);
const summary = { chat, runs, load: load(), shownMs: stats(ok.map(r => r.shownMs)), settledMs: stats(ok.map(r => r.settledMs)), results };
console.log(JSON.stringify({ shownMs: summary.shownMs, settledMs: summary.settledMs }));
if (out) {
	fs.writeFileSync(out, JSON.stringify(summary, null, 1));
}
cdp.close();
