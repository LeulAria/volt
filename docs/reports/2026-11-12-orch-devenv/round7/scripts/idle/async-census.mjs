// libuv callback census of a Node/Electron process over its inspector (round 7): an async_hooks hook records every
// async resource's type and creating stack, then counts, for `secs` s, the callbacks that run (`before`) per type and
// creating stack. Shows what wakes a process's main thread when no JS timer does (node_bindings WakeupMainThread in
// main: fs requests, pipes, sockets, fs events, child processes). Analysis aid; the hook adds overhead.
//   node async-census.mjs <ws://inspector url> [secs=30] [--install-only | --read]
import { connect, sleep } from './lib.mjs';

const [ws, secsArg = '30'] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const c = await connect(ws);
await c.send('Runtime.enable');
const evaluate = async expr => {
	const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, includeCommandLineAPI: true });
	if (r.result?.exceptionDetails || r.error) {
		throw new Error(JSON.stringify(r.result?.exceptionDetails ?? r.error).slice(0, 400));
	}
	return r.result?.result?.value;
};
const install = `(() => {
	const g = globalThis;
	const req = g.require ?? process.mainModule?.require ?? (typeof require === 'function' ? require : undefined);
	const ah = req ? req('async_hooks') : process.binding('async_wrap');
	if (g.__voltAsync) { g.__voltAsync.hook.disable(); }
	const info = new Map();
	const state = g.__voltAsync = { counts: new Map(), t0: Date.now() };
	const fmt = () => (new Error().stack || '').split('\\n').slice(3).map(l => l.trim().replace(/^at /, '').replace(/\\(?(file|vscode-file):\\/\\/[^)]*\\/(out|node_modules)\\//, '(').replace(/^node:internal\\//, 'n:')).filter(l => !/async_hooks|AsyncHook|emitInit/.test(l)).slice(0, Number(process.env.ASYNC_DEPTH ?? 8)).join(' < ');
	const hook = ah.createHook({
		init(id, type) { if (type === 'PROMISE' || type === 'TickObject') { return; } info.set(id, type + '  ' + fmt()); },
		before(id) { const k = info.get(id); if (k) { state.counts.set(k, (state.counts.get(k) || 0) + 1); } },
		destroy(id) { info.delete(id); },
	});
	hook.enable();
	state.hook = hook;
	return 'installed';
})()`;
if (!process.argv.includes('--read')) {
	console.log(await evaluate(install));
}
if (process.argv.includes('--install-only')) {
	c.close();
	process.exit(0);
}
if (!process.argv.includes('--read')) {
	await sleep(Number(secsArg) * 1000);
}
const result = await evaluate(`(() => { const s = globalThis.__voltAsync; const secs = (Date.now() - s.t0) / 1000; return { secs, rows: [...s.counts].sort((a, b) => b[1] - a[1]).slice(0, 30) }; })()`);
const total = result.rows.reduce((a, [, n]) => a + n, 0);
console.log(`callbacks: ${total} in ${result.secs.toFixed(1)} s (${(total / result.secs).toFixed(2)}/s; top 30 keys)`);
for (const [k, n] of result.rows) {
	console.log(`${String(n).padStart(6)} ${(n / result.secs).toFixed(2).padStart(6)}/s  ${k.slice(0, 260)}`);
}
c.close();
