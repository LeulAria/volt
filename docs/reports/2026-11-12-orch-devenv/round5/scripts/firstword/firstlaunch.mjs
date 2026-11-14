// First word of the first prompt after a launch (check for b98ab46593a: no agent starts for the restored chat until
// the user presses a key or a pointer, so the first prompt's agent starts on that press, not at launch).
// Per rep: launch the arm, rest `rest` s, then either
//   new:      click New Chat (a real pointer press), wait 1.5 s (ADEMark's settle), click the composer, paste
//             `replay:seed`, 0.5 s, Enter
//   restored: click the restored chat's composer, paste `replay:seed`, 0.5 s, Enter
// and time Enter -> the answer painted (two frames after its text lands), then stop the instance.
//   node firstlaunch.mjs <arm> <new|restored> [rest s=15]   (needs `source arm.sh <arm>`; rows -> data/firstword/firstlaunch.jsonl)
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { cdp, DATA, launchDev, load, mem, profileProcesses, sleep, stopInstance, UD, waitCalm, waitWorkbench, writeSettings } from './lib.mjs';

const [arm = 'after', variant = 'new', restArg = '15'] = process.argv.slice(2);
await stopInstance();
writeSettings();
launchDev();
const readyMs = await waitWorkbench();
await sleep(Number(restArg) * 1000);
const gate = await waitCalm();
const c = await cdp();
const agentsAtRest = profileProcesses().filter(p => /claude-agent-acp/.test(p.cmd) && /node/.test(p.cmd)).length;
const PROBE = `(() => {
	const s = window.__fl = { enter: 0, dom: 0, raf2: 0 };
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
const composer = () => c.evaluate(`(() => { const t = [...document.querySelectorAll('.volt-agent-input-box')].filter(e => e.offsetParent).at(-1); if (!t) { return null; } const r = t.getBoundingClientRect(); return [r.x + 60, r.y + r.height / 2]; })()`);
const loadAvg = load();
if (variant === 'new') {
	const pt = await c.center(`[...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^New (Chat|Agent)/.test(e.getAttribute('aria-label')))`);
	if (!pt) { throw new Error('no New Chat button'); }
	await c.click(pt[0], pt[1]);
	await sleep(1500);
}
const pt = await composer();
if (!pt) { throw new Error('no composer'); }
await c.evaluate(PROBE);
await c.click(pt[0], pt[1]);
await c.send('Input.insertText', { text: 'replay:seed' });
await sleep(500);
await c.key('Enter', 'Enter', 13, 0, '\r');
let s;
for (let i = 0; i < 300; i++) { s = await c.evaluate('window.__fl'); if (s?.raf2) { break; } await sleep(100); }
await sleep(1500);
const row = { arm, variant, human: process.env.HUMAN === '1', at: new Date().toISOString(), load: loadAvg, underLoad: !gate.calm, restS: Number(restArg), readyMs, agentAdaptersAtRest: agentsAtRest, mem: mem(), firstWordMs: s?.raf2 && s.enter ? s.raf2 - s.enter : null, trace: lastTrace(s?.enter ?? 0) };
appendFileSync(join(DATA, 'firstlaunch.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
c.close();
await stopInstance();
