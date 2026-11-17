// Exploratory: what runs in a Node-side process at rest, over its inspector: (1) every live timer (repeat, ref, callback
// source), (2) a CPU profile of `secs` s at 100 us sampling, summed by function (idle and GC apart), (3) how many
// timer callbacks fired. No rows; analysis aid for A6.
//   node nodeprof.mjs <port> [secs=30] [--timers-only]
const [port, secsArg = '30'] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const timersOnly = process.argv.includes('--timers-only');
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, m => m.error || m.result?.exceptionDetails ? rej(new Error(JSON.stringify(m.error ?? m.result.exceptionDetails).slice(0, 300))) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
await call('Runtime.enable');
const proto = await call('Runtime.evaluate', { expression: '(() => { const t = setTimeout(() => {}, 1e9); clearTimeout(t); return Object.getPrototypeOf(t); })()' });
const objs = await call('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
const timers = await call('Runtime.callFunctionOn', { objectId: objs.objects.objectId, returnByValue: true, functionDeclaration: `function () { globalThis.__restFires = 0; return this.filter(t => !t._destroyed && t._idleTimeout > 0).map(t => { const f = t._onTimeout; if (typeof f === 'function' && !f.__rest) { const w = function () { globalThis.__restFires++; return f.apply(this, arguments); }; w.__rest = true; t._onTimeout = w; } return { repeat: t._repeat, idle: t._idleTimeout, ref: typeof t.hasRef === 'function' ? t.hasRef() : undefined, src: String(f).replace(/\\s+/g, ' ').slice(0, 160) }; }); }` });
for (const t of timers.result.value.filter(t => t.repeat || t.idle <= 60000)) { console.log(`  ${t.repeat ? `every ${t.repeat} ms` : `once in ${t.idle} ms`}${t.ref === false ? ' (unref)' : ''}  ${t.src}`); }
console.log(`${timers.result.value.length} live timers`);
if (!timersOnly) {
	await call('Profiler.enable'); await call('Profiler.setSamplingInterval', { interval: 100 }); await call('Profiler.start');
	await new Promise(r => setTimeout(r, Number(secsArg) * 1000));
	const { profile } = await call('Profiler.stop');
	const self = new Map(); const dt = profile.timeDeltas; const byId = new Map(profile.nodes.map(n => [n.id, n]));
	profile.samples.forEach((s, i) => { const n = byId.get(s); const k = `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.replace(/^.*\/(out|app)\//, '')}:${n.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0)); });
	const total = (profile.endTime - profile.startTime) / 1000;
	const rows = [...self].sort((a, b) => b[1] - a[1]);
	const busy = rows.filter(([k]) => !/^\(idle\)/.test(k)).reduce((s, [, v]) => s + v, 0) / 1000;
	console.log(`profile ${total.toFixed(0)} ms, not idle ${busy.toFixed(1)} ms = ${(busy / total * 100).toFixed(3)} % of a core`);
	for (const [k, v] of rows.slice(0, 25)) { console.log(`  ${(v / 1000).toFixed(2).padStart(9)} ms  ${k.slice(0, 150)}`); }
	const fires = await call('Runtime.evaluate', { expression: 'globalThis.__restFires', returnByValue: true });
	console.log(`timer callbacks fired (of the timers live at start): ${fires.result.value} = ${(fires.result.value / Number(secsArg)).toFixed(2)}/s`);
}
ws.close();
