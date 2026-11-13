#!/usr/bin/env node
// Test 2 (load earlier turns) and A11 step 2 (scroll stutter).
//
// --mode top (default): open the chat at its end, then wheel up at 60 Hz (deltaY -1500 per event,
// a fast fling) until the chat's first prompt (`--top` text) is on screen and the thread stops
// changing. Value: ms from the first wheel event (renderer clock), plus frame gaps meanwhile.
//
// --mode stutter: ADEMark A11 step 2. 20 wheel events at 60 Hz toward the top (deltaY -100 each,
// one notch), frames counted from the first event to the last event plus 16.7 ms; value: frame
// gaps over 33 ms. Then the chat is scrolled back to its end.
//
//   node scroll-bench.mjs --chat "Long thread 45k" --top "Turn 1: keep reading the modules (long45k)" [--runs 3]
//   node scroll-bench.mjs --mode stutter --chat "Long thread A11 (seeded)" [--runs 5]
import fs from 'node:fs';
import { connect, rowCenter, sleep, load, stats } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const port = Number(opt('port', '9953'));
const mode = opt('mode', 'top');
const chat = opt('chat', 'Long thread 45k');
const top = opt('top', 'Turn 1: keep reading the modules (long45k)');
const from = opt('from', 'Short thread');
const runs = Number(opt('runs', '3'));
const out = opt('out');

const PROBE = `window.__voltScrollProbe = (top) => {
	const st = { t0: 0, frames: [], done: false, longTasks: [] };
	const po = new PerformanceObserver(list => { for (const e of list.getEntries()) st.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); });
	po.observe({ type: 'longtask' });
	const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent);
	const scroll = ed.querySelector('.volt-agent-thread-scroll');
	const inner = ed.querySelector('.volt-agent-thread-inner');
	const check = () => {
		const first = inner.querySelector(':scope > .volt-agent-exchange .volt-agent-turn.user');
		const vr = scroll.getBoundingClientRect();
		let visible = false;
		if (first && first.textContent.includes(top)) { const r = first.getBoundingClientRect(); visible = r.height > 0 && r.bottom > vr.top && r.top < vr.bottom; }
		return [visible, inner.childElementCount + '|' + Math.round(inner.scrollTop) + '|' + inner.scrollHeight];
	};
	let stableSince = 0, lastSig = '';
	const tick = () => requestAnimationFrame(ts => {
		const [visible, sig] = check();
		st.frames.push([Math.round(ts * 10) / 10, visible, sig]);
		if (!visible || sig !== lastSig) { stableSince = ts; lastSig = sig; }
		if ((st.stopAt && ts > st.stopAt) || (!st.stopAt && visible && ts - stableSince > 800) || ts - st.t0 > 90000) { st.done = true; po.disconnect(); return; }
		tick();
	});
	const onWheel = e => { if (!st.t0) { st.t0 = e.timeStamp; tick(); } st.lastWheel = e.timeStamp; };
	document.addEventListener('wheel', onWheel, { capture: true, passive: true });
	st.stop = () => document.removeEventListener('wheel', onWheel, true);
	return st;
};`;

async function threadCenter(cdp) {
	return cdp.evaluate(`(() => { const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent); const b = ed.querySelector('.volt-agent-thread-scroll').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
}

const cdp = await connect(port);
const results = [];
for (let run = 0; run < runs; run++) {
	// Fresh draw each run: away and back, so the chat opens at its end with only its tail drawn.
	const fromAt = await rowCenter(cdp, from);
	await cdp.click(fromAt.x, fromAt.y);
	await sleep(1500);
	const at = await rowCenter(cdp, chat);
	await cdp.click(at.x, at.y);
	await sleep(3000);
	const c = await threadCenter(cdp);
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
	await cdp.evaluate(PROBE);
	await cdp.evaluate(`window.__voltScrollState = window.__voltScrollProbe(${JSON.stringify(top)}), true`);
	let result;
	if (mode === 'stutter') {
		const started = Date.now();
		for (let i = 0; i < 20; i++) {
			await cdp.wheel(c.x, c.y, -100);
			const next = started + (i + 1) * 1000 / 60;
			await sleep(Math.max(0, next - Date.now()));
		}
		await cdp.evaluate('(() => { const s = window.__voltScrollState; s.stopAt = s.lastWheel + 16.7; s.stop(); return true; })()');
		let state;
		for (let i = 0; i < 50 && !state; i++) {
			await sleep(100);
			state = await cdp.evaluate('window.__voltScrollState.done ? window.__voltScrollState : null');
		}
		const frames = state.frames.filter(f => f[0] >= state.t0 && f[0] <= state.stopAt);
		const gaps = frames.slice(1).map((f, i) => f[0] - frames[i][0]);
		// The first frame after the first event can only come one frame later: count the gap from t0 too.
		const firstGap = frames.length ? frames[0][0] - state.t0 : 0;
		const all = [firstGap, ...gaps];
		result = { gapsOver33: all.filter(g => g > 33).length, maxGap: Math.round(Math.max(...all)), frames: frames.length, longTaskMs: state.longTasks.filter(([s]) => s >= state.t0 && s <= state.stopAt).reduce((a, [, d]) => a + d, 0) };
		console.log(`run ${run + 1}: ${result.gapsOver33} gaps > 33 ms, max gap ${result.maxGap} ms, ${result.frames} frames, long tasks ${result.longTaskMs} ms  (load ${load()})`);
	} else {
		let state;
		const started = Date.now();
		for (let i = 0; i < 90 * 60 && !state; i++) {
			await cdp.wheel(c.x, c.y, -1500);
			if (i % 6 === 5) {
				state = await cdp.evaluate('(() => { const s = window.__voltScrollState; return s.frames.length && s.frames[s.frames.length - 1][1] ? s.frames.length : null; })()');
			}
			const next = started + (i + 1) * 1000 / 60;
			await sleep(Math.max(0, next - Date.now()));
		}
		state = null;
		for (let i = 0; i < 100 && !state; i++) {
			await sleep(100);
			state = await cdp.evaluate('window.__voltScrollState.done ? window.__voltScrollState : null');
		}
		await cdp.evaluate('window.__voltScrollState.stop(), true');
		const frames = state.frames;
		let at = -1;
		for (let i = frames.length - 1; i >= 0; i--) {
			if (!frames[i][1] || (i < frames.length - 1 && frames[i][2] !== frames[i + 1][2])) {
				break;
			}
			at = i;
		}
		const gaps = frames.slice(1).map((f, i) => f[0] - frames[i][0]).filter((_, i) => at < 0 || i < at);
		result = at < 0 ? null : { toTop: frames[at][0] - state.t0, gapsOver33: gaps.filter(g => g > 33).length, maxGap: Math.round(Math.max(0, ...gaps)), longTaskMs: state.longTasks.filter(([s]) => s >= state.t0).reduce((a, [, d]) => a + d, 0) };
		console.log(`run ${run + 1}: ${result ? `top on screen after ${result.toTop.toFixed(0)} ms, ${result.gapsOver33} gaps > 33 ms, max gap ${result.maxGap} ms, long tasks ${result.longTaskMs} ms` : 'top never settled'}  (load ${load()})`);
	}
	results.push(result);
}
const ok = results.filter(Boolean);
const key = mode === 'stutter' ? 'gapsOver33' : 'toTop';
const summary = { mode, chat, runs, load: load(), [key]: ok.length ? stats(ok.map(r => r[key])) : null, results };
console.log(JSON.stringify({ [key]: summary[key] }));
if (out) {
	fs.writeFileSync(out, JSON.stringify(summary, null, 1));
}
cdp.close();
