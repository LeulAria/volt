// The agent server's heap at a moment (dev build only: VOLT_AGENT_SERVER_INSPECT=1 keeps SIGUSR1 = inspector on 9229):
// footprint, process.memoryUsage, V8 heap spaces, and optionally a heap snapshot.
//   node srvheap.mjs <pid> [snapshot.heapsnapshot] [eval-expression]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [pid, snap, expr] = process.argv.slice(2);
process.kill(Number(pid), 'SIGUSR1');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list;
for (let i = 0; i < 40 && !list; i++) { await sleep(250); try { list = await (await fetch('http://127.0.0.1:9229/json/list')).json(); } catch { } }
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const waits = new Map(); let chunks = [];
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.method === 'HeapProfiler.addHeapSnapshotChunk') { chunks.push(d.params.chunk); } if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
const fp = () => { try { return execFileSync('footprint', ['-p', pid], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().match(/Footprint:\s+([\d.]+ \w+)/)?.[1]; } catch { return undefined; } };
const out = {
	footprint: fp(),
	mem: await ev(`(() => { const m = process.memoryUsage(); return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v / 1048576)])); })()`),
	spaces: await ev(`process.getBuiltinModule('v8').getHeapSpaceStatistics().map(s => [s.space_name, Math.round(s.space_size / 1048576), Math.round(s.space_used_size / 1048576)])`),
	extra: expr ? await ev(expr) : undefined,
};
console.log(JSON.stringify(out));
if (snap) {
	await send('HeapProfiler.enable');
	await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
	writeFileSync(snap, chunks.join(''));
	console.log('snapshot', snap);
}
await ev('process._debugEnd()');
ws.close();
