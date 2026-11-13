#!/usr/bin/env node
// Test 3: send into a 75,000-item thread. Opens the chat, types a prompt into its composer and
// presses Enter; measured in the renderer from the Enter keydown: the sent message on screen
// (Volt alone), the reply's first word on screen (Volt + the model), and the main thread's long
// tasks meanwhile. Waits for the reply to finish before the next run.
//
//   node send-bench.mjs --chat "Long thread 75k" [--runs 3] [--out f.json]
import fs from 'node:fs';
import { connect, rowCenter, sleep, load, stats, waitLoad, withLoad } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const port = Number(opt('port', '9953'));
const chat = opt('chat', 'Long thread 75k|Turn 1: keep reading the modules');
const from = opt('from', 'Short thread');
const runs = Number(opt('runs', '3'));
const out = opt('out');

const PROBE = `window.__voltSendProbe = (mark) => {
	const st = { t0: 0, echo: 0, firstWord: 0, done: false, longTasks: [], frames: 0, maxGap: 0 };
	const po = new PerformanceObserver(list => { for (const e of list.getEntries()) st.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); });
	po.observe({ type: 'longtask' });
	const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent);
	const inner = ed.querySelector('.volt-agent-thread-inner');
	let last = 0;
	const tick = () => requestAnimationFrame(ts => {
		st.frames++;
		if (last) st.maxGap = Math.max(st.maxGap, ts - last);
		last = ts;
		const users = inner.querySelectorAll('.volt-agent-turn.user');
		const mine = [...users].slice(-3).find(u => u.textContent.includes(mark));
		if (mine && !st.echo) st.echo = ts - st.t0;
		if (mine && !st.firstWord) {
			const ex = mine.closest('.volt-agent-exchange');
			const reply = ex && [...ex.querySelectorAll('.volt-agent-turn.agent p, .volt-agent-turn.agent li')].find(p => p.textContent.trim().length > 0);
			if (reply) { st.firstWord = ts - st.t0; st.firstText = reply.textContent.trim().slice(0, 40); }
		}
		if ((st.echo && st.firstWord) || ts - st.t0 > 120000) { st.done = true; po.disconnect(); return; }
		tick();
	});
	const onKey = e => { if (e.key === 'Enter' && !st.t0) { st.t0 = e.timeStamp; tick(); document.removeEventListener('keydown', onKey, true); } };
	document.addEventListener('keydown', onKey, true);
	return st;
};`;

const cdp = await connect(port);
const results = [];
for (let run = 0; run < runs; run++) {
	const fromAt = await rowCenter(cdp, from);
	await cdp.click(fromAt.x, fromAt.y);
	await sleep(1500);
	// The first send names the chat after its first prompt: `--chat` takes either name ("a|b").
	let at;
	for (const name of chat.split('|')) {
		at ??= await rowCenter(cdp, name);
	}
	await cdp.click(at.x, at.y);
	// Off the row, so its hover card (which opens over the composer) closes.
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1200, y: 300 });
	await sleep(4000);
	const composer = await cdp.evaluate(`(() => { const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent); const c = ed.querySelector('.volt-agent-monaco .monaco-editor'); const b = c.getBoundingClientRect(); return { x: Math.round(b.x + 40), y: Math.round(b.y + b.height / 2) }; })()`);
	await cdp.click(composer.x, composer.y);
	await sleep(300);
	const mark = `SENDMARK-${Date.now().toString(36)}`;
	await cdp.send('Input.insertText', { text: `Reply with the single word OK. (${mark})` });
	await sleep(500);
	const before = await waitLoad();
	await cdp.evaluate(PROBE);
	await cdp.evaluate(`window.__voltSendState = window.__voltSendProbe(${JSON.stringify(mark)}), true`);
	await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
	await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
	await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
	let state;
	for (let i = 0; i < 1300 && !state; i++) {
		await sleep(100);
		state = await cdp.evaluate('window.__voltSendState.done ? window.__voltSendState : null');
	}
	const blocked = (state?.longTasks ?? []).filter(([s]) => s >= state.t0 && s <= state.t0 + (state.echo || 0) + 50);
	const result = state ? { echoMs: Math.round(state.echo) || null, firstWordMs: Math.round(state.firstWord) || null, firstText: state.firstText, longTasksToEcho: blocked.map(([, d]) => d), longTaskMs: state.longTasks.filter(([s]) => s >= state.t0).reduce((a, [, d]) => a + d, 0), maxGap: Math.round(state.maxGap) } : null;
	console.log(`run ${run + 1}: ${result ? `sent message on screen ${result.echoMs} ms, first word ${result.firstWordMs} ms ("${result.firstText ?? ''}"), long tasks ${result.longTaskMs} ms, max frame gap ${result.maxGap} ms` : 'no result'}  (load ${load()})`);
	results.push(withLoad(result, before));
	// Let the reply finish: the stop button goes back to send.
	for (let i = 0; i < 600; i++) {
		const busy = await cdp.evaluate(`(() => { const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent); const stop = ed?.querySelector('.volt-agent-user-stop'); return !!stop && !!stop.offsetParent && getComputedStyle(stop).visibility !== 'hidden'; })()`);
		if (!busy) {
			break;
		}
		await sleep(200);
	}
	await sleep(2000);
}
const ok = results.filter(Boolean);
const summary = { chat, runs, load: load(), echoMs: stats(ok.map(r => r.echoMs).filter(Boolean)), firstWordMs: stats(ok.map(r => r.firstWordMs).filter(Boolean)), results };
console.log(JSON.stringify({ echoMs: summary.echoMs, firstWordMs: summary.firstWordMs }));
if (out) {
	fs.writeFileSync(out, JSON.stringify(summary, null, 1));
}
cdp.close();
