#!/usr/bin/env node
// Test 2 (load earlier turns) and A11 step 2 (scroll stutter). Every run opens the chat at its end
// (away and back) and leaves it at its end again (End key), so the next open is the same.
//
// CDP wheel events move Volt's thread 50 px each whatever their deltaY (the scrollable reads them
// as one notch), so a synthetic "fling" can never cross a 600,000 px thread; the modes below use
// what a reader would: the Home key, or steady scrolling at the top of what is drawn.
//
// --mode home (default): press Home (Scroll Chat to Top) and time until the chat's first prompt
// (`--top` text) is on screen and the thread stops changing for 800 ms; frame gaps meanwhile.
//
// --mode earlier: scroll to the top of what is drawn, then wheel up at 60 Hz for `--ms` (5000);
// value: sent messages drawn above per second (each brings its whole exchange), and frame gaps.
//
// --mode stutter: ADEMark A11 step 2. 20 wheel events at 60 Hz toward the top (one notch each),
// frames counted from the first event to the last event plus 16.7 ms; value: frame gaps over 33 ms.
//
//   node scroll-bench.mjs --chat "Long thread 45k" --top "Turn 1: keep reading the modules (long45k)" [--runs 3]
//   node scroll-bench.mjs --mode earlier --chat "Long thread 45k" [--runs 3]
//   node scroll-bench.mjs --mode stutter --chat "Long thread A11 (seeded)" [--runs 5]
import fs from 'node:fs';
import { connect, rowCenter, sleep, load, stats, waitLoad, withLoad } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const port = Number(opt('port', '9953'));
const mode = opt('mode', 'home');
const chat = opt('chat', 'Long thread 45k');
const top = opt('top', 'Turn 1: keep reading the modules (long45k)');
const from = opt('from', 'Short thread');
const runs = Number(opt('runs', '3'));
const ms = Number(opt('ms', '5000'));
const out = opt('out');

const PROBE = `window.__voltScrollProbe = (top) => {
	const st = { t0: 0, frames: [], done: false, longTasks: [] };
	const po = new PerformanceObserver(list => { for (const e of list.getEntries()) st.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); });
	po.observe({ type: 'longtask' });
	const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent);
	const scroll = ed.querySelector('.volt-agent-thread-scroll');
	const inner = ed.querySelector('.volt-agent-thread-inner');
	st.users = () => inner.querySelectorAll('.volt-agent-turn.user').length;
	st.users0 = st.users();
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
		if ((st.stopAt && ts > st.stopAt) || (!st.stopAt && st.untilTop && visible && ts - stableSince > 800) || ts - st.t0 > 60000) { st.done = true; po.disconnect(); return; }
		tick();
	});
	const start = e => { if (!st.t0) { st.t0 = e.timeStamp; tick(); } };
	const onWheel = e => { start(e); st.lastWheel = e.timeStamp; };
	const onKey = e => { if (e.key === 'Home') { st.untilTop = true; start(e); } };
	document.addEventListener('wheel', onWheel, { capture: true, passive: true });
	document.addEventListener('keydown', onKey, true);
	st.stop = () => { document.removeEventListener('wheel', onWheel, true); document.removeEventListener('keydown', onKey, true); };
	return st;
};`;

async function threadPoint(cdp, dx) {
	return cdp.evaluate(`(() => { const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent); const b = ed.querySelector('.volt-agent-thread-scroll').getBoundingClientRect(); return { x: Math.round(${dx === undefined ? 'b.x + b.width / 2' : `b.x + ${dx}`}), y: Math.round(b.y + b.height / 2) }; })()`);
}

async function key(cdp, name, code) {
	await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code });
	await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
}

async function waitDone(cdp, tries = 700) {
	for (let i = 0; i < tries; i++) {
		await sleep(100);
		const state = await cdp.evaluate('window.__voltScrollState.done ? window.__voltScrollState : null');
		if (state) {
			return state;
		}
	}
	return null;
}

const cdp = await connect(port);
const results = [];
for (let run = 0; run < runs; run++) {
	const fromAt = await rowCenter(cdp, from);
	await cdp.click(fromAt.x, fromAt.y);
	await sleep(1500);
	const at = await rowCenter(cdp, chat);
	await cdp.click(at.x, at.y);
	await sleep(3000);
	// Focus the transcript (a click in its left margin, on no message): Home and End are its keys then.
	const margin = await threadPoint(cdp, 30);
	await cdp.click(margin.x, margin.y);
	const c = await threadPoint(cdp);
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
	const before = await waitLoad();
	await cdp.evaluate(PROBE);
	await cdp.evaluate(`window.__voltScrollState = window.__voltScrollProbe(${JSON.stringify(top)}), true`);
	let result;
	if (mode === 'stutter') {
		const started = Date.now();
		for (let i = 0; i < 20; i++) {
			await cdp.wheel(c.x, c.y, -100);
			await sleep(Math.max(0, started + (i + 1) * 1000 / 60 - Date.now()));
		}
		await cdp.evaluate('(() => { const s = window.__voltScrollState; s.stopAt = s.lastWheel + 16.7; s.stop(); return true; })()');
		const state = await waitDone(cdp, 50);
		const frames = state.frames.filter(f => f[0] >= state.t0 && f[0] <= state.stopAt);
		const gaps = frames.slice(1).map((f, i) => f[0] - frames[i][0]);
		// The first frame after the first event can only come one frame later: count the gap from t0 too.
		const all = [frames.length ? frames[0][0] - state.t0 : 0, ...gaps];
		result = { gapsOver33: all.filter(g => g > 33).length, maxGap: Math.round(Math.max(...all)), frames: frames.length, longTaskMs: state.longTasks.filter(([s]) => s >= state.t0 && s <= state.stopAt).reduce((a, [, d]) => a + d, 0) };
		console.log(`run ${run + 1}: ${result.gapsOver33} gaps > 33 ms, max gap ${result.maxGap} ms, ${result.frames} frames, long tasks ${result.longTaskMs} ms  (load ${load()})`);
	} else if (mode === 'earlier') {
		// To the top of what is drawn first, without the Home key (which now draws everything).
		await cdp.evaluate('(() => { const ed = [...document.querySelectorAll(".volt-agent-editor")].find(e => e.offsetParent); ed.querySelector(".volt-agent-thread-inner").scrollTop = 0; return true; })()');
		await sleep(500);
		await cdp.evaluate('(() => { const s = window.__voltScrollState; s.users0 = s.users(); return true; })()');
		const started = Date.now();
		let i = 0;
		while (Date.now() - started < ms) {
			await cdp.wheel(c.x, c.y, -100);
			i++;
			await sleep(Math.max(0, started + i * 1000 / 60 - Date.now()));
		}
		const r = await cdp.evaluate('(() => { const s = window.__voltScrollState; s.stopAt = s.lastWheel + 16.7; s.stop(); return { users: s.users() - s.users0, t0: s.t0, last: s.lastWheel }; })()');
		const state = await waitDone(cdp, 50);
		const frames = state.frames.filter(f => f[0] >= state.t0 && f[0] <= state.stopAt);
		const gaps = frames.slice(1).map((f, j) => f[0] - frames[j][0]);
		const secs = (r.last - r.t0) / 1000;
		result = { turnsPerS: Math.round(r.users / secs * 10) / 10, turns: r.users, wheelEvents: i, gapsOver33: gaps.filter(g => g > 33).length, frames: frames.length, maxGap: Math.round(Math.max(0, ...gaps)), longTaskMs: state.longTasks.filter(([s]) => s >= state.t0 && s <= state.stopAt).reduce((a, [, d]) => a + d, 0) };
		console.log(`run ${run + 1}: ${result.turns} earlier turns in ${secs.toFixed(1)} s (${result.turnsPerS}/s), ${result.gapsOver33} of ${result.frames} frame gaps > 33 ms, max gap ${result.maxGap} ms, long tasks ${result.longTaskMs} ms  (load ${load()})`);
	} else {
		await key(cdp, 'Home', 36);
		const state = await waitDone(cdp);
		await cdp.evaluate('window.__voltScrollState.stop(), true');
		const frames = state?.frames ?? [];
		let settledAt = -1;
		for (let j = frames.length - 1; j >= 0; j--) {
			if (!frames[j][1] || (j < frames.length - 1 && frames[j][2] !== frames[j + 1][2])) {
				break;
			}
			settledAt = j;
		}
		const firstVisible = frames.findIndex(f => f[1]);
		const gaps = frames.slice(1).map((f, j) => f[0] - frames[j][0]).filter((_, j) => settledAt < 0 || j < settledAt);
		result = settledAt < 0 ? null : { toTop: frames[settledAt][0] - state.t0, firstVisible: frames[firstVisible][0] - state.t0, gapsOver33: gaps.filter(g => g > 33).length, maxGap: Math.round(Math.max(0, ...gaps)), longTaskMs: state.longTasks.filter(([s]) => s >= state.t0).reduce((a, [, d]) => a + d, 0) };
		console.log(`run ${run + 1}: ${result ? `first message settled on screen after ${result.toTop.toFixed(0)} ms (first seen ${result.firstVisible.toFixed(0)} ms), ${result.gapsOver33} gaps > 33 ms, max gap ${result.maxGap} ms, long tasks ${result.longTaskMs} ms` : 'first message never settled on screen within 60 s'}  (load ${load()})`);
	}
	results.push(withLoad(result, before));
	// Back to the end, so the chat opens following its end next time.
	await key(cdp, 'End', 35);
	await sleep(1500);
}
const ok = results.filter(Boolean);
const valueKey = { stutter: 'gapsOver33', earlier: 'turnsPerS', home: 'toTop' }[mode];
const summary = { mode, chat, runs, load: load(), [valueKey]: ok.length ? stats(ok.map(r => r[valueKey])) : null, results };
console.log(JSON.stringify({ [valueKey]: summary[valueKey] }));
if (out) {
	fs.writeFileSync(out, JSON.stringify(summary, null, 1));
}
cdp.close();
