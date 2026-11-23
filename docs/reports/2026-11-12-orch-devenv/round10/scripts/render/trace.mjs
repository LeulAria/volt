// Whole-browser trace (all processes, incl. GPU) of the running arm for N s; prints top event names per process.
//   node trace.mjs <out.json> <secs> [categories=viz,gpu,cc,benchmark] [--send]  (--send: new chat + replay:stream-1 first)
import { writeFileSync } from 'fs';
import { cdp, newChat, focusComposer, paste, sleep } from './lib.mjs';
const [out, secs = '3', cats = 'viz,gpu,cc,benchmark'] = process.argv.slice(2);
const port = Number(process.env.SPEED_CDP ?? 9983);
if (process.argv.includes('--send')) {
	const c = await cdp();
	await newChat(c); await sleep(1500); await focusComposer(c);
	await paste(c, 'replay:stream-1'); await sleep(400); await c.key('Enter', 'Enter', 13, 0, '\r');
	c.close(); await sleep(4000);
}
const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map(); const events = [];
let done;
const finished = new Promise(r => done = r);
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method === 'Tracing.dataCollected') { events.push(...m.params.value); } else if (m.method === 'Tracing.tracingComplete') { done(); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
console.log(JSON.stringify((await send('Tracing.start', { traceConfig: { includedCategories: cats.split(',') }, transferMode: 'ReportEvents' })).error ?? 'started'));
await sleep(Number(secs) * 1000);
await send('Tracing.end');
await finished;
ws.close();
writeFileSync(out, JSON.stringify({ traceEvents: events }));
const pname = new Map(events.filter(e => e.name === 'process_name').map(e => [e.pid, e.args.name]));
const counts = new Map();
for (const e of events) { if (e.ph === 'M') { continue; } const k = `${pname.get(e.pid) ?? e.pid} | ${e.name}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOP ?? 60))) { console.log(n, k); }
