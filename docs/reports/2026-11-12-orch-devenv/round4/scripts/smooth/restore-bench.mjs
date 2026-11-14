// A chat shown by a window that just opened, here by a reload (Cmd+R: the window saves its state and loads again).
// A probe added for new documents records each frame from the document's start: whether the agent pane is up, still
// `restoring` (hidden), and whether the chat's last message is on screen.
// Values per run: when the pane first painted and when the last message did (ms from the document's time origin), and
// the frames between in which the pane was up with no transcript.
//   node restore-bench.mjs --chat "Open medium" --session agent-bench-medium --marker "LONGTHREAD-END medium" [--runs 3]
import fs from 'node:fs';
import { connect, rowCenter, sleep, load, stats, waitLoad, withLoad } from './thread-lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const port = Number(opt('port', '9949'));
const chat = opt('chat', 'Open medium');
const sessionId = opt('session', 'agent-bench-medium');
const marker = opt('marker', 'LONGTHREAD-END medium');
const runs = Number(opt('runs', '3'));
const out = opt('out');

const PROBE = `(() => {
	if (window.__voltRestore) { return; }
	const st = window.__voltRestore = { frames: [], startedAt: performance.now() };
	const tick = () => requestAnimationFrame(ts => {
		const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent);
		let what = 'none';
		if (ed) {
			const restoring = ed.classList.contains('restoring');
			const mine = ed.dataset.sessionId === ${JSON.stringify(sessionId)};
			const scroll = ed.querySelector('.volt-agent-thread-scroll');
			let end = false, rows = false;
			if (mine && scroll && !restoring) {
				const vr = scroll.getBoundingClientRect();
				for (const x of ed.querySelectorAll('.volt-agent-thread-inner > .volt-agent-exchange')) {
					const r = x.getBoundingClientRect();
					if (r.height > 0 && r.bottom > vr.top && r.top < vr.bottom) { rows = true; }
				}
				const ps = [...ed.querySelectorAll('.volt-agent-thread-inner > .volt-agent-exchange:last-child p')].slice(-4);
				end = ps.some(p => { const r = p.getBoundingClientRect(); return p.textContent.includes(${JSON.stringify(marker)}) && r.height > 0 && r.bottom > vr.top && r.top < vr.bottom - 20; });
			}
			what = end ? 'end' : rows ? 'rows' : restoring ? 'restoring' : mine ? 'blank' : 'other';
		}
		const last = st.frames.at(-1);
		if (!last || last[1] !== what) { st.frames.push([Math.round(ts), what, 1]); } else { last[2]++; }
		if (!(what === 'end' && last && last[1] === 'end' && last[2] > 30)) { tick(); }
	});
	tick();
})();`;

// Page-level CDP: Cmd+R reloads the same page target, and a script added for new documents runs before the
// workbench's own (the connection stays open across the reload; Page must be enabled).
let page = await connect(port);
await page.send('Page.enable');
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
const results = [];
for (let run = 0; run < runs; run++) {
	const at = await rowCenter(page, chat);
	await page.click(at.x, at.y);
	await sleep(4000);
	const before = await waitLoad();
	for (const type of ['rawKeyDown', 'keyUp']) {
		await page.send('Input.dispatchKeyEvent', { type, key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, modifiers: 4 });
	}
	await sleep(2000);
	let st;
	for (let i = 0; i < 120 && !st; i++) {
		await sleep(1000);
		st = await Promise.race([page.evaluate('window.__voltRestore && window.__voltRestore.frames.some(f => f[1] === "end") ? JSON.stringify(window.__voltRestore) : null').catch(() => null), sleep(3000).then(() => null)]);
	}
	if (!st) { console.log(`run ${run + 1}: chat never drawn`); results.push(null); continue; }
	const f = JSON.parse(st).frames;
	const pane = f.find(x => x[1] !== 'none');
	const end = f.find(x => x[1] === 'end');
	const without = f.filter(x => x[0] >= pane[0] && x[0] < end[0]).reduce((n, x) => n + x[2], 0);
	const r = { paneAt: pane[0], endAt: end[0], paneToEnd: end[0] - pane[0], framesWithoutTranscript: without, states: f.map(x => `${x[1]}@${x[0]}x${x[2]}`).join(' ') };
	console.log(`run ${run + 1}: pane at ${r.paneAt} ms, last message at ${r.endAt} ms; ${r.paneToEnd} ms and ${without} frames with the pane up and no transcript (load ${load()})\n   ${r.states}`);
	results.push(withLoad(r, before));
	await sleep(8000);
}
page.close();
const ok = results.filter(Boolean);
const summary = { chat, runs, paneToEnd: ok.length ? stats(ok.map(r => r.paneToEnd)) : null, framesWithoutTranscript: ok.length ? stats(ok.map(r => r.framesWithoutTranscript)) : null, results };
console.log(JSON.stringify({ paneToEnd: summary.paneToEnd, framesWithoutTranscript: summary.framesWithoutTranscript }));
if (out) { fs.writeFileSync(out, JSON.stringify(summary, null, 1)); }
