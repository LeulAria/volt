// Round 10: V8 heap by space of Node-side processes over their inspectors (dev build: main with --inspect=<port> in
// WEIGHT_EXTRA_ARGS, extension host and shared process on the ports `ps` shows, agent server with arm dev-yg-insp),
// before and after a full collection (HeapProfiler.collectGarbage): what is live against what is committed.
//   node nodespaces.mjs [--gc] <port> [<port> ...]
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2); const doGc = args.includes('--gc');
for (const port of args.filter(a => a !== '--gc')) {
	try {
		const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
		const ws = new WebSocket(list[0].webSocketDebuggerUrl);
		await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
		let id = 0; const waits = new Map();
		ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); } };
		const send = (method, params = {}) => new Promise(r => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
		const ev = async e => { const r = (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result; return r?.result?.value ?? JSON.stringify(r?.exceptionDetails?.exception?.description ?? r); };
		const state = `(() => { const v8 = process.getBuiltinModule ? process.getBuiltinModule('v8') : require('v8'); const m = process.memoryUsage(); return 'pid ' + process.pid + ' rss ' + Math.round(m.rss / 1048576) + ' heapTotal ' + Math.round(m.heapTotal / 1048576) + ' used ' + Math.round(m.heapUsed / 1048576) + ' ext ' + Math.round(m.external / 1048576) + ' | ' + v8.getHeapSpaceStatistics().filter(s => s.space_size).map(s => s.space_name.replace('_space', '') + ' ' + (s.space_used_size / 1048576).toFixed(1) + '/' + (s.space_size / 1048576).toFixed(1)).join(', '); })()`;
		const s = await ev(state);
		const pid = /pid (\d+)/.exec(s)?.[1];
		const fp = () => { try { return execFileSync('footprint', ['-p', pid], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().match(/Footprint:\s+([\d.]+ \w+)/)?.[1]; } catch { return '?'; } };
		console.log(`${port} ${list[0].title?.slice(0, 40)} fp ${fp()} ${s}`);
		if (doGc) { await send('HeapProfiler.enable'); await send('HeapProfiler.collectGarbage'); console.log(`${port}   after gc: fp ${fp()} ${await ev(state)}`); }
		ws.close();
	} catch (e) { console.log(`${port} failed: ${e.message}`); }
}
