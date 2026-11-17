// Exploratory: what a "give everything back" collection (V8 `gc({ type: 'major', flavor: 'last-resort' })`) frees in
// each Node-side process of a running test instance at rest. The instance must be launched with inspectors:
//   WEIGHT_EXTRA_ARGS="--inspect=9968 --inspect-extensions=9969 --inspect-sharedprocess=9970" node launch.mjs
//   node gcprobe.mjs [flavor=last-resort|regular]        (prints footprint per role before / after; no rows)
import { execSync } from 'child_process';
import { profileProcesses, sleep } from './lib.mjs';
import { role } from './roles.mjs';
const flavor = process.argv[2] ?? 'last-resort';
const PORTS = { main: 9968, 'extension host': 9969, 'shared process': 9970 };
const fp = pid => { try { const m = /Footprint: ([\d.]+) ([KMG])B/.exec(execSync(`footprint ${pid} 2>/dev/null`).toString()); return m ? Number(m[1]) * { K: 1 / 1024, M: 1, G: 1024 }[m[2]] : 0; } catch { return 0; } };
function snap() {
	const by = {};
	for (const p of profileProcesses()) { const r = role(p.cmd); const v = fp(p.pid); if (v >= 5) { by[`${r.split(' (')[0]} ${p.pid}`] = Math.round(v * 10) / 10; } }
	return by;
}
async function evalIn(port, expression) {
	const list = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })).json();
	const ws = new WebSocket(list[0].webSocketDebuggerUrl, { perMessageDeflate: false });
	await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
	const reply = new Promise(r => ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id === 1) { r(m); } }));
	ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true } }));
	const m = await reply; ws.close();
	return m.result?.exceptionDetails ? 'ERR ' + JSON.stringify(m.result.exceptionDetails).slice(0, 300) : m.result?.result?.value;
}
const GC = `(() => { const req = typeof require === 'function' ? require : process.mainModule?.require ?? globalThis.require; const v8 = req('v8'), vm = req('vm'); const before = process.memoryUsage(); v8.setFlagsFromString('--expose-gc'); const gc = vm.runInNewContext('gc'); v8.setFlagsFromString('--no-expose-gc'); const t = Date.now(); ${flavor === 'regular' ? 'gc()' : `gc({ type: 'major', execution: 'sync', flavor: 'last-resort' })`}; const after = process.memoryUsage(); const mb = v => Math.round(v / 1048576); return JSON.stringify({ ms: Date.now() - t, rss: [mb(before.rss), mb(after.rss)], heapTotal: [mb(before.heapTotal), mb(after.heapTotal)], heapUsed: [mb(before.heapUsed), mb(after.heapUsed)], external: [mb(before.external), mb(after.external)] }); })()`;
const before = snap();
console.log('before', JSON.stringify(before));
for (const [name, port] of Object.entries(PORTS)) {
	try { console.log(name, await evalIn(port, GC)); } catch (e) { console.log(name, 'no inspector:', String(e).slice(0, 120)); }
}
await sleep(3000);
const after = snap();
console.log('after ', JSON.stringify(after));
for (const k of Object.keys(before)) { const d = (after[k] ?? 0) - before[k]; if (Math.abs(d) >= 0.5) { console.log(`  ${k.padEnd(40)} ${before[k]} -> ${after[k]}  (${d > 0 ? '+' : ''}${d.toFixed(1)})`); } }
