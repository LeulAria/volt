// A8 Typing Lag (ADEMark method, unofficial, over CDP): keystroke-to-frame time while 5 agents stream.
// Per rep: a fresh launch of the arm (covered-window rendering kept on: the user works at this Mac), 5 new chats each
// sent `replay:stream-<n>` 2 s apart (the replay server streams 3 min at 80 tokens/s), then 60 probe characters into
// the composer on screen (chat 5, streaming), one every 250 ms +-20 %.
// Latency per key, in the renderer: from the keydown event's timeStamp to the end of the first frame after the
// composer took the character (rAF after the input event, then a message task: the frame's main-thread work done).
// Event Timing's duration (to the frame's presentation, entries of 16 ms and more only) is kept beside it.
// A key with no input event within 2 s is missed. Differences from ADEMark: no screen recording or pixel diff (the
// frame is the renderer's, not the screen's), and the composer is chat 5's (on screen) rather than chat 1's.
//   node a8.mjs [reps=3]     rows appended to data/smooth/a8.jsonl
import { appendFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { cdp, DATA, focusComposer, launch, load1, newChat, pct, profileProcesses, role, send, sleep, stop, waitQuiet, waitWorkbench, writeSettings, median } from './lib.mjs';

/** CPU seconds used so far per process role of the arm (ps cputime), to split the typing window's CPU by role. */
function cpuByRole(arm) {
	const out = {};
	for (const p of profileProcesses(arm)) {
		let secs = 0;
		try {
			const t = execSync(`ps -o time= -p ${p.pid}`).toString().trim();
			const parts = t.split(':').map(Number);
			secs = parts.reduce((acc, v) => acc * 60 + v, 0);
		} catch { }
		const r = role(p.cmd);
		out[r] = (out[r] ?? 0) + secs;
	}
	return out;
}

const reps = Number(process.argv[2] ?? 3);
const armsArg = process.argv[3];
const delayS = Number(process.env.A8_DELAY_S ?? 0);
mkdirSync(DATA, { recursive: true });
const order = [];
for (let i = 0; i < reps; i++) {
	order.push(...(armsArg ? armsArg.split(',') : (i % 2 ? ['after', 'before'] : ['before', 'after'])));
}

const PROBE = `(() => {
	const t = document.activeElement;
	if (!t || t.tagName !== 'TEXTAREA') { return false; }
	const st = window.__a8 = { keys: [], events: [] };
	let pending = [];
	t.addEventListener('keydown', e => { if (e.key.length === 1) { const k = { key: e.key, t0: e.timeStamp, t1: null }; st.keys.push(k); pending.push(k); } }, true);
	t.addEventListener('input', () => {
		const ks = pending; pending = [];
		requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => { const now = performance.now(); for (const k of ks) { k.t1 = now; } }; ch.port2.postMessage(0); });
	});
	new PerformanceObserver(list => { for (const e of list.getEntries()) { if (e.name === 'keydown') { st.events.push([e.startTime, e.duration]); } } }).observe({ type: 'event', durationThreshold: 16, buffered: false });
	return true;
})()`;

const PROBE_CHARS = 'abcdefghijklmnopqrstuvwxyz';

for (const arm of order) {
	const loadStart = await waitQuiet(14);
	console.log(`== ${arm} load ${loadStart} ${new Date().toISOString()}`);
	try { execSync(`git -C ${process.env.HOME}/.volt-r4/smooth/arena checkout -q -- . && git -C ${process.env.HOME}/.volt-r4/smooth/arena clean -qfd`); } catch { }
	writeSettings(arm);
	launch(arm, { keepRendering: true });
	await waitWorkbench();
	await sleep(8000);
	// A8_DELAY_S: start the streams that long after launch (ADEMark runs A8 right after A7, minutes into the run;
	// 0 = 8 s after the workbench is up). The streams start only at a load of 14 or less.
	if (delayS) {
		await sleep(delayS * 1000);
		await waitQuiet(14);
	}
	const c = await cdp();
	await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
	const sentAt = Date.now();
	for (let n = 1; n <= 5; n++) {
		await newChat(c);
		await sleep(1500);
		await send(c, `replay:stream-${n}`);
		await sleep(2000);
	}
	// The streams are under way in all five chats.
	await sleep(8000);
	const loadTyping = load1();
	// Validity: the chat on screen streams while the keys go in (its transcript grows), and five chats run.
	const STREAM = `(() => { const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent); const inner = ed && ed.querySelector('.volt-agent-thread-inner'); return inner ? inner.textContent.length : -1; })()`;
	const textBefore = await c.evaluate(STREAM);
	const cpu0 = cpuByRole(arm);
	const typingStart = Date.now();
	await focusComposer(c);
	const ok = await c.evaluate(PROBE);
	if (!ok) {
		console.log('no focused composer');
	}
	for (let i = 0; i < 60; i++) {
		const ch = PROBE_CHARS[i % PROBE_CHARS.length];
		const code = ch.toUpperCase().charCodeAt(0);
		await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: ch });
		await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
		await sleep(250 * (0.8 + Math.random() * 0.4));
	}
	await sleep(2000);
	const st = await c.evaluate('JSON.stringify(window.__a8)');
	const textAfter = await c.evaluate(STREAM);
	const cpu1 = cpuByRole(arm);
	const typingS = (Date.now() - typingStart) / 1000;
	const cpuTypingPct = Object.fromEntries(Object.keys(cpu1).map(k => [k, Math.round((cpu1[k] - (cpu0[k] ?? 0)) / typingS * 1000) / 10]));
	const loadEnd = load1();
	const streamingS = Math.round((Date.now() - sentAt) / 1000);
	// Clear the composer (select all, delete).
	await c.key('a', 'KeyA', 65, 4);
	await c.key('Backspace', 'Backspace', 8);
	await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
	c.close();
	const { keys, events } = JSON.parse(st ?? '{"keys":[],"events":[]}');
	const lat = keys.filter(k => k.t1 !== null && k.t1 - k.t0 <= 2000).map(k => Math.round((k.t1 - k.t0) * 10) / 10);
	const missed = 60 - lat.length;
	const row = {
		arm, at: new Date().toISOString(), delayS, loadStart, loadTyping, loadEnd, streamingS, textBefore, textAfter, streamed: textAfter > textBefore, keys: keys.length, missed, cpuTypingPct,
		p50: median(lat), p95: pct(lat, 0.95), max: lat.length ? Math.max(...lat) : null,
		eventTimingOver16: events.length, eventTimingP95: events.length ? pct(events.map(e => e[1]), 0.95) : null, eventTimingMax: events.length ? Math.max(...events.map(e => e[1])) : null,
		lat,
	};
	appendFileSync(join(DATA, 'a8.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify({ ...row, lat: undefined }));
	await stop(arm);
	await sleep(10_000);
}
