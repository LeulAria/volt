// Launch an arm and record, over CDP, from the earliest attach: screencast frames (with their timestamps),
// the snapshot/handoff marks, and when the real composer accepts keys. Untimed exploration helper.
//   node firstpaint.mjs <arm> <outdir>
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
const [arm, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const RUN = '/Users/leularia/Desktop/VOLT/volt-e4-coldstart/docs/reports/2026-11-12-orch-devenv/round4/scripts/coldstart/run.ts';
const t0 = Date.now();
spawnSync('bun', [RUN, '--app', arm, '--launch'], { env: { ...process.env, ADE_KEEP_RENDERING: '1' } });
let ws;
for (;;) {
	try {
		const targets = await (await fetch('http://127.0.0.1:9944/json/list')).json();
		const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url));
		if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r, { once: true })); break; }
	} catch { }
	await new Promise(r => setTimeout(r, 10));
}
const attached = Date.now() - t0;
let id = 0; const pending = new Map(); const frames = [];
ws.addEventListener('message', e => {
	const m = JSON.parse(e.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
	if (m.method === 'Page.screencastFrame') {
		const n = frames.length;
		frames.push({ n, ts: m.params.metadata.timestamp });
		writeFileSync(`${out}/f${String(n).padStart(3, '0')}.jpg`, Buffer.from(m.params.data, 'base64'));
		send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
	}
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
await send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1, maxWidth: 1440, maxHeight: 900 });
await new Promise(r => setTimeout(r, Number(process.env.FP_MS ?? 12000)));
await send('Page.stopScreencast');
const marks = (await send('Runtime.evaluate', { expression: `JSON.stringify(Object.fromEntries(performance.getEntriesByType('mark').filter(m=>/Splash|WindowSnapshot|didLoadWorkbench|didStartWorkbench|didStartRenderer/.test(m.name)).map(m=>[m.name, Math.round(performance.timeOrigin+m.startTime)])))`, returnByValue: true })).result.result.value;
const m = JSON.parse(marks);
const rel = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v - t0]));
writeFileSync(`${out}/meta.json`, JSON.stringify({ arm, t0, attached, marks: rel, frames: frames.map(f => ({ ...f, ms: Math.round(f.ts * 1000 - t0) })) }, null, 1));
console.log(JSON.stringify({ attached, marks: rel, frames: frames.length }));
process.exit(0);
