#!/usr/bin/env node
// Test 1 (and A11 Open/Switch): time from the click on a chat's sidebar row until its last item is
// on screen and the frame is settled (nothing in the thread moves or changes for 1 s after).
// Measured in the renderer: t0 = the mousedown event's timeStamp, end = the rAF time of the first
// frame from which the end marker stays visible and the thread's size/scroll stays the same.
//
//   node open-bench.mjs --port 9953 --chat "Long thread 41k" --marker "LONGTHREAD-END long41k" \
//        [--from "Short thread"] [--runs 5] [--cold] [--out file.json]
//
// --cold reloads the window before each run (first open in a fresh window); otherwise the runs
// alternate from-chat -> chat, so they include whatever the app keeps for a chat it showed before.
import fs from 'node:fs';
import { connect, rowCenter, sleep, load, stats } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const port = Number(opt('port', '9953'));
const chat = opt('chat', 'Long thread 41k');
const marker = opt('marker', 'LONGTHREAD-END long41k');
const from = opt('from', 'Short thread');
const runs = Number(opt('runs', '5'));
const cold = args.includes('--cold');
const out = opt('out');
// --copies: run i opens "Cold 41k i" (seed.mjs --cold N), a chat neither the window nor the server has loaded.
const copies = args.includes('--copies');
const target = run => copies
	? { chat: `Cold 41k ${run + 1}`, marker: `LONGTHREAD-END long41k-c${run + 1}`, sessionId: `agent-bench-long41k-c${run + 1}` }
	: { chat, marker, sessionId: opt('session', `agent-bench-${marker.split(' ')[1]}`) };

const PROBE = `window.__voltOpenProbe = (sessionId, marker) => {
	const st = { t0: 0, frames: [], done: false, longTasks: [] };
	const po = new PerformanceObserver(list => { for (const e of list.getEntries()) st.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); });
	po.observe({ type: 'longtask' });
	const check = () => {
		const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.dataset.sessionId === sessionId && e.offsetParent);
		if (!ed) return [false, ''];
		const scroll = ed.querySelector('.volt-agent-thread-scroll');
		const inner = ed.querySelector('.volt-agent-thread-inner');
		const exchanges = inner.querySelectorAll(':scope > .volt-agent-exchange');
		const ex = exchanges[exchanges.length - 1];
		let el = null;
		if (ex) {
			const ps = ex.querySelectorAll('p');
			for (let i = ps.length - 1; i >= Math.max(0, ps.length - 4); i--) { if (ps[i].textContent.includes(marker)) { el = ps[i]; break; } }
		}
		const vr = scroll.getBoundingClientRect();
		let visible = false, top = -1;
		if (el) { const r = el.getBoundingClientRect(); top = Math.round(r.top); visible = r.height > 0 && r.bottom > vr.top && r.top < vr.bottom - 20; }
		return [visible, inner.childElementCount + '|' + Math.round(inner.scrollTop) + '|' + inner.scrollHeight + '|' + top];
	};
	let stableSince = 0, lastSig = '';
	const tick = () => requestAnimationFrame(ts => {
		const [visible, sig] = check();
		st.frames.push([Math.round(ts * 10) / 10, visible, sig]);
		if (!visible || sig !== lastSig) { stableSince = ts; lastSig = sig; }
		if ((visible && ts - stableSince > 1000) || ts - st.t0 > 30000) { st.done = true; po.disconnect(); return; }
		tick();
	});
	const onDown = e => { st.t0 = e.timeStamp; document.removeEventListener('mousedown', onDown, true); tick(); };
	document.addEventListener('mousedown', onDown, true);
	return st;
};`;

function settle(state) {
	const frames = state.frames;
	let at = -1;
	for (let i = frames.length - 1; i >= 0; i--) {
		if (!frames[i][1] || (i < frames.length - 1 && frames[i][2] !== frames[i + 1][2])) {
			break;
		}
		at = i;
	}
	if (at < 0 || !frames[frames.length - 1][1]) {
		return undefined;
	}
	const firstVisible = frames.findIndex(f => f[1]);
	const blocked = state.longTasks.filter(([start]) => start >= state.t0).reduce((sum, [, d]) => sum + d, 0);
	return { settled: frames[at][0] - state.t0, firstVisible: frames[firstVisible][0] - state.t0, frames: frames.length, longTaskMs: blocked, maxGap: Math.round(Math.max(0, ...frames.slice(1).map((f, i) => f[0] - frames[i][0]))) };
}

async function waitRows(cdp) {
	for (let i = 0; i < 120; i++) {
		try {
			if (await rowCenter(cdp, chat)) {
				return;
			}
			// A CDP reload skips the shutdown save, so the sidebar can come back closed.
			const toggle = await cdp.evaluate(`(() => { const t = document.querySelector('[aria-label^="Toggle Primary Side Bar"]'); if (!t || document.querySelector('.monaco-list-row')) return null; const b = t.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
			if (toggle && i % 6 === 5) {
				await cdp.click(toggle.x, toggle.y);
			}
		} catch { }
		await sleep(500);
	}
	throw new Error('sidebar rows never showed');
}

let cdp = await connect(port);
const results = [];
for (let run = 0; run < runs; run++) {
	if (cold) {
		// Reload with the short chat shown, so the long one is not restored by the reload itself.
		const shortAt = await rowCenter(cdp, from);
		if (shortAt) {
			await cdp.click(shortAt.x, shortAt.y);
			await sleep(1500);
		}
		await cdp.send('Page.reload', { ignoreCache: false });
		cdp.close();
		await sleep(4000);
		cdp = await connect(port);
		await waitRows(cdp);
		await sleep(6000);
	}
	const fromAt = await rowCenter(cdp, from);
	await cdp.click(fromAt.x, fromAt.y);
	await sleep(2500);
	const t = target(run);
	await cdp.evaluate(PROBE);
	await cdp.evaluate(`window.__voltOpenState = window.__voltOpenProbe(${JSON.stringify(t.sessionId)}, ${JSON.stringify(t.marker)}), true`);
	const at = await rowCenter(cdp, t.chat);
	await cdp.click(at.x, at.y);
	// Off the row, so its hover card does not open over the thread mid-measurement.
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 60 });
	let state;
	for (let i = 0; i < 400; i++) {
		await sleep(100);
		state = await cdp.evaluate('window.__voltOpenState && window.__voltOpenState.done ? window.__voltOpenState : null');
		if (state) {
			break;
		}
	}
	const r = state && settle(state);
	console.log(`run ${run + 1}: ${r ? `settled ${r.settled.toFixed(1)} ms, first visible ${r.firstVisible.toFixed(1)} ms, long tasks ${r.longTaskMs} ms, max frame gap ${r.maxGap} ms` : 'end marker never settled on screen'}  (load ${load()})`);
	results.push(r ?? null);
}
const ok = results.filter(Boolean);
const summary = { chat: copies ? 'Cold 41k <run>' : chat, marker, cold, copies, runs, load: load(), settled: ok.length ? stats(ok.map(r => r.settled)) : null, firstVisible: ok.length ? stats(ok.map(r => r.firstVisible)) : null, results };
console.log(JSON.stringify({ settled: summary.settled, firstVisible: summary.firstVisible }));
if (out) {
	fs.writeFileSync(out, JSON.stringify(summary, null, 1));
}
cdp.close();
