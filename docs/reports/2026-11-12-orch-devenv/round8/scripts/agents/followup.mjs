// A follow-up in the chat in use (ADEMark A4 timing on a second message, unofficial, in-app): per rep, a new chat A gets
// `replay:seed`; the user stays on A for `idle` s; then clicks A's composer, types `replay:seed`, 0.4 s, Enter. Time:
// Enter -> the new answer painted (two frames after its text lands), plus the runtime's trace (where the agent came
// from: live / resumed / pool). With the chat in use's agent kept (before: 15 min), idle < keep-alive is a warm
// follow-up; past it the agent was stopped and the click/typing warms it again (session/resume).
// FOLLOWUP_READER=1: during the idle the pointer moves over the transcript every 4 s (someone reading the reply).
// FOLLOWUP_GAP_MS (default 400) is the time from the click to Enter: 0 leaves the click/focus warm-up no head start.
//   node followup.mjs <arm> [reps=3] [idle s=40]      rows -> ../../data/agents/followup.jsonl
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { cdp, DATA, load, median, newChat, sleep, UD } from './lib.mjs';

const [arm = 'after', repsArg = '3', idleArg = '40'] = process.argv.slice(2);
const MAX_LOAD = Number(process.env.FOLLOWUP_MAX_LOAD ?? 14);
const c = await cdp();

async function clickComposer() {
	const pt = await c.evaluate(`(() => { const t = [...document.querySelectorAll('.volt-agent-input-box')].filter(e => e.offsetParent).at(-1); if (!t) { return null; } const r = t.getBoundingClientRect(); return [r.x + 60, r.y + r.height / 2]; })()`);
	if (!pt) { throw new Error('no composer'); }
	await c.click(pt[0], pt[1]);
}
const answers = () => c.evaluate(`[...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).map(m => (m.textContent.match(/Seeded\\. This thread is open/g) || []).length).reduce((a, b) => a + b, 0)`);
const GAP_MS = Number(process.env.FOLLOWUP_GAP_MS ?? 400);
async function sendAndWait(text, gapMs = 400) {
	const n = await answers();
	await clickComposer();
	await c.send('Input.insertText', { text });
	await sleep(gapMs);
	await c.key('Enter', 'Enter', 13, 0, '\r');
	for (let i = 0; i < 300; i++) {
		await sleep(100);
		if (await answers() > n) { return true; }
	}
	return false;
}
const PROBE = `(() => {
	const s = window.__fu = { enter: 0, dom: 0, raf2: 0 };
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

const out = [];
for (let rep = 1; rep <= Number(repsArg); rep++) {
	await newChat(c);
	await sleep(1500);
	if (!await sendAndWait('replay:seed')) { throw new Error('A did not answer'); }
	if (process.env.FOLLOWUP_READER) {
		// Reading: the pointer drifts over the transcript, never to the composer.
		const box = await c.evaluate(`(() => { const m = [...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).at(-1); const r = m.getBoundingClientRect(); return [r.x, r.y, r.width, Math.min(r.height, 300)]; })()`);
		for (let t = 0; t < Number(idleArg); t += 4) {
			await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box[0] + box[2] * (0.3 + 0.1 * (t % 3)), y: box[1] + 40 + (t * 7) % box[3], button: 'none' });
			await sleep(Math.min(4, Number(idleArg) - t) * 1000);
		}
	} else {
		await sleep(Number(idleArg) * 1000);
	}
	const gateUntil = Date.now() + Number(process.env.FOLLOWUP_LOAD_WAIT_S ?? 300) * 1000;
	while (parseFloat(load()) > MAX_LOAD && Date.now() < gateUntil) { await sleep(5000); }
	await c.evaluate(PROBE);
	const loadAvg = load();
	const t0 = Date.now();
	const ok = await sendAndWait('replay:seed', GAP_MS);
	let s;
	for (let i = 0; i < 50; i++) { s = await c.evaluate('window.__fu'); if (s?.raf2) { break; } await sleep(50); }
	await sleep(1500);
	const row = { arm, rep, at: new Date(t0).toISOString(), load: loadAvg, underLoad: parseFloat(loadAvg) > MAX_LOAD, idleS: Number(idleArg), gapMs: GAP_MS, reader: !!process.env.FOLLOWUP_READER, ok, firstWordMs: s?.raf2 && s.enter ? s.raf2 - s.enter : null, trace: lastTrace(t0) };
	out.push(row);
	appendFileSync(join(DATA, 'followup.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify(row));
}
console.log('median firstWordMs', median(out.map(r => r.firstWordMs)));
c.close();
