// First word on a thread the user comes back to (A4 method on an existing thread, unofficial, in-app timing).
// Per rep: send in thread A, then in a new thread B, wait `idle` s (after: A's agent is past its 30 s grace and
// stopped; before: A's agent stays warm), open A from the sidebar, wait `openWait` s, click the composer, type
// `replay:seed`, Enter; time Enter -> the new answer painted (two frames after its text lands).
//   node resume.mjs <arm> [reps=3] [openWait s=3] [idle s=40]   (rows appended to data/procs/resume.jsonl)
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { cdp, DATA, load, mem, newChat, sleep, UD, median } from './lib.mjs';

const [arm = 'after', repsArg = '3', openWaitArg = '3', idleArg = '40'] = process.argv.slice(2);
const MAX_LOAD = Number(process.env.RESUME_MAX_LOAD ?? 14);
const c = await cdp();

const rows = () => c.evaluate(`[...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && /Replay/.test(e.getAttribute('aria-label') || '')).length`);
async function ensureSidebar() {
	// Under load the sidebar's rows can take seconds to appear after launch: wait before toggling it.
	for (let i = 0; i < 30 && await rows() === 0; i++) { await sleep(500); }
	if (await rows() === 0) {
		await c.evaluate(`[...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^Toggle Primary Side Bar/.test(e.getAttribute('aria-label'))).click()`);
		await sleep(1500);
	}
}
async function clickRow(index) {
	let pt;
	for (let i = 0; i < 40 && !pt; i++) {
		pt = await c.evaluate(`(() => { const e = [...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && /Replay/.test(e.getAttribute('aria-label') || ''))[${index}]; if (!e) { return null; } const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
		if (!pt) { await sleep(500); }
	}
	if (!pt) { throw new Error('no row ' + index); }
	await c.click(pt[0], pt[1]);
}
async function clickComposer() {
	const pt = await c.evaluate(`(() => { const t = [...document.querySelectorAll('.volt-agent-input-box')].filter(e => e.offsetParent).at(-1); if (!t) { return null; } const r = t.getBoundingClientRect(); return [r.x + 60, r.y + r.height / 2]; })()`);
	if (!pt) { throw new Error('no composer'); }
	await c.click(pt[0], pt[1]);
}
const answers = () => c.evaluate(`[...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).map(m => (m.textContent.match(/Seeded\\. This thread is open/g) || []).length).reduce((a, b) => a + b, 0)`);
async function sendAndWait(text) {
	const n = await answers();
	await clickComposer();
	await c.send('Input.insertText', { text });
	await sleep(400);
	await c.key('Enter', 'Enter', 13, 0, '\r');
	for (let i = 0; i < 300; i++) {
		await sleep(100);
		if (await answers() > n) { return true; }
	}
	return false;
}
const PROBE = `(() => {
	const s = window.__rs = { enter: 0, dom: 0, raf2: 0 };
	window.addEventListener('keydown', e => { if (e.key === 'Enter' && !s.enter) { s.enter = Date.now(); } }, { capture: true, once: true });
	const hit = n => (n.nodeType === 3 ? n.data : n.textContent || '').includes('Seeded. This thread');
	const mo = new MutationObserver(list => {
		if (s.dom || !s.enter) { return; }
		for (const m of list) {
			if ((m.type === 'characterData' && hit(m.target)) || [...m.addedNodes].some(hit)) {
				s.dom = Date.now(); mo.disconnect();
				requestAnimationFrame(() => requestAnimationFrame(() => { s.raf2 = Date.now(); }));
				return;
			}
		}
	});
	mo.observe(document.body, { subtree: true, childList: true, characterData: true });
	return true;
})()`;
function lastTrace(after) {
	const dir = join(UD, 'User', 'voltTraces');
	if (!existsSync(dir)) { return undefined; }
	for (const f of readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
		const lines = readFileSync(join(dir, f), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
		const m = lines.filter(l => l.kind === 'metrics' && l.ts > after).map(l => l.metrics).at(-1);
		if (m) { return { agentSource: m.agentSource, agentReadyMs: m.agentReadyMs, promptMs: m.promptMs, firstTextMs: m.firstTextMs }; }
	}
	return undefined;
}

await ensureSidebar();
const out = [];
for (let rep = 1; rep <= Number(repsArg); rep++) {
	// Thread A: the second row (an older seeded thread), used now.
	await clickRow(1);
	await sleep(2000);
	if (!await sendAndWait('replay:seed')) { throw new Error('A did not answer'); }
	// Thread B: a new thread, the most recent one.
	await newChat(c);
	await sleep(1500);
	if (!await sendAndWait('replay:seed')) { throw new Error('B did not answer'); }
	await sleep(Number(idleArg) * 1000);
	// Timed only at a 1-minute load of at most MAX_LOAD: wait for it (at most RESUME_LOAD_WAIT_S), else record the load.
	const gateUntil = Date.now() + Number(process.env.RESUME_LOAD_WAIT_S ?? 600) * 1000;
	while (parseFloat(load()) > MAX_LOAD && Date.now() < gateUntil) { await sleep(5000); }
	// Back to A (now the second row again: B is first).
	await clickRow(1);
	await sleep(Number(openWaitArg) * 1000);
	await c.evaluate(PROBE);
	const loadAvg = load();
	const t0 = Date.now();
	const ok = await sendAndWait('replay:seed');
	let s;
	for (let i = 0; i < 50; i++) { s = await c.evaluate('window.__rs'); if (s?.raf2) { break; } await sleep(50); }
	await sleep(1500);
	const row = { arm, rep, at: new Date(t0).toISOString(), load: loadAvg, underLoad: parseFloat(loadAvg) > MAX_LOAD,openWaitS: Number(openWaitArg), idleS: Number(idleArg), mem: mem(), ok, firstWordMs: s?.raf2 && s.enter ? s.raf2 - s.enter : null, trace: lastTrace(t0) };
	out.push(row);
	appendFileSync(join(DATA, 'resume.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify(row));
}
console.log('median firstWordMs', median(out.map(r => r.firstWordMs)));
c.close();
