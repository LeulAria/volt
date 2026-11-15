// Exploration: launch an arm with a Chromium trace from the browser target (CDP Tracing) and report what the renderer's
// main thread did while the workbench bundle loaded: compile vs evaluate, code cache consumed or produced.
//   node trace.mjs <arm> [--keep] [--env K=V ...]   (same layout as marks.mjs)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const R = `${process.env.HOME}/.volt-r6/launch`;
const [arm, ...rest] = process.argv.slice(2);
const keep = rest.includes('--keep');
const extraEnv = rest.flatMap((a, i) => a === '--env' ? [rest[i + 1]] : []);
const app = `${R}/apps/${arm}/VOLT.app`, ud = `${R}/ud/${arm}`, home = `${R}/h/${arm}`;
const port = Number(process.env.PORT ?? 9974);
if (!existsSync(app)) { console.error(`no app at ${app}`); process.exit(2); }
mkdirSync(ud, { recursive: true }); mkdirSync(home, { recursive: true }); mkdirSync(`${R}/out/trace`, { recursive: true });
delete process.env.ELECTRON_RUN_AS_NODE;
const envs = [`HOME=${home}`, `PATH=${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, 'DISABLE_AUTOUPDATER=1', ...extraEnv].flatMap(e => ['--env', e]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
spawnSync('open', ['-n', '-a', app, ...envs, '--args', '--use-mock-keychain', '--user-data-dir', ud, '--extensions-dir', `${home}/.volt/extensions`, `--remote-debugging-port=${port}`]);
let browserWs;
for (let i = 0; i < 6000 && !browserWs; i++) {
	try { browserWs = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(200) })).json()).webSocketDebuggerUrl; } catch { await sleep(5); }
}
const tBrowser = Date.now() - t0;
const ws = new WebSocket(browserWs);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const events = [];
ws.addEventListener('message', e => {
	const d = JSON.parse(e.data);
	if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
	else if (d.method === 'Tracing.dataCollected') { events.push(...d.params.value); }
	else if (d.method === 'Tracing.tracingComplete') { pending.get('complete')?.(); }
});
const send = (method, params = {}, sessionId) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
await send('Tracing.start', { traceConfig: { recordMode: 'recordContinuously', includedCategories: ['v8', 'v8.execute', 'devtools.timeline', 'disabled-by-default-v8.compile', 'disabled-by-default-devtools.timeline', 'blink', 'blink.user_timing', 'loading', 'toplevel', 'disabled-by-default-v8.runtime_stats_sampling'] }, transferMode: 'ReportEvents' });
const tTrace = Date.now() - t0;
// Wait for the workbench page and its didStartWorkbench mark
let pageTarget;
for (let i = 0; i < 2000 && !pageTarget; i++) {
	try { pageTarget = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(200) })).json()).find(x => x.type === 'page' && /workbench(-dev)?\.html/.test(x.url)); } catch { }
	if (!pageTarget) { await sleep(10); }
}
const attached = await send('Target.attachToTarget', { targetId: pageTarget.id, flatten: true });
if (!attached.result) { console.error('attach failed', JSON.stringify(attached)); process.exit(1); }
const { sessionId } = attached.result;
const evaluate = expr => send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId).then(d => d.result?.result?.value);
let m;
for (let i = 0; i < 1000; i++) {
	m = await evaluate(`(()=>{const r={}; for(const x of performance.getEntriesByType('mark')) r[x.name]=Math.round(performance.timeOrigin+x.startTime); r.origin=performance.timeOrigin; return r})()`);
	if (m?.['code/didStartWorkbench']) { break; }
	await sleep(25);
}
await sleep(300);
const complete = new Promise(r => pending.set('complete', r));
await send('Tracing.end');
await complete;
const file = `${R}/out/trace/${arm}-${Date.now()}.json`;
writeFileSync(file, JSON.stringify(events));

// Analysis: the renderer pid of the workbench page = the pid with the blink.user_timing mark code/didStartRenderer
const rendererPid = events.find(e => e.cat?.includes('blink.user_timing') && e.name === 'code/didStartRenderer')?.pid;
const main = events.filter(e => e.pid === rendererPid && e.ph === 'X' && e.tid === events.find(x => x.pid === rendererPid && x.name === 'code/didStartRenderer')?.tid);
const sumBy = new Map();
for (const e of main) { sumBy.set(e.name, (sumBy.get(e.name) ?? 0) + e.dur / 1000); }
const top = [...sumBy].sort((a, b) => b[1] - a[1]).slice(0, 25);
const compiles = events.filter(e => e.pid === rendererPid && /^v8\.(compile|compileModule|deserializeOnBackground|produceCache|parseOnBackground)$/.test(e.name) && (e.dur ?? 0) > 2000)
	.map(e => `${e.name} ${(e.dur / 1000).toFixed(1)} ms tid ${e.tid} ${JSON.stringify(e.args?.data ?? e.args).slice(0, 260)}`);
const evaluates = events.filter(e => e.pid === rendererPid && /EvaluateScript|v8\.evaluateModule|v8\.run|V8\.Execute/.test(e.name) && (e.dur ?? 0) > 5000)
	.map(e => `${e.name} ${(e.dur / 1000).toFixed(1)} ms ${JSON.stringify(e.args?.data ?? e.args).slice(0, 200)}`);
const marks = events.filter(e => e.pid === rendererPid && e.cat?.includes('blink.user_timing') && e.name.startsWith('code/')).map(e => [e.name, e.ts]).sort((a, b) => a[1] - b[1]);
const origin = marks[0]?.[1];
console.log(`# ${arm}: browser CDP at ${tBrowser} ms, tracing from ${tTrace} ms after t0; renderer pid ${rendererPid}; ${events.length} events -> ${file}`);
console.log('marks (ms after first renderer mark): ' + marks.filter(([n]) => /didStartRenderer|didWaitForWindowConfig|voltDidPaintWindowSnapshot|willLoadWorkbenchMain|didLoadWorkbenchMain|willStartWorkbench|didStartWorkbench|voltDidHandOff/.test(n)).map(([n, ts]) => `${n.replace('code/', '')} ${Math.round((ts - origin) / 1000)}`).join(', '));
console.log('renderer main thread, top event totals (ms):'); for (const [n, d] of top) { console.log(`  ${d.toFixed(1).padStart(8)}  ${n}`); }
console.log('compile events > 2 ms:'); for (const c of compiles) { console.log('  ' + c); }
console.log('evaluate events > 5 ms:'); for (const c of evaluates) { console.log('  ' + c); }
// Long tasks on the renderer main thread between the snapshot paint and didLoadWorkbenchMain
const a = marks.find(([n]) => n === 'code/voltDidPaintWindowSnapshot' || n === 'code/didWaitForWindowConfig')?.[1], b = marks.find(([n]) => n === 'code/didLoadWorkbenchMain')?.[1];
if (a && b) {
	const tasks = main.filter(e => e.name === 'ThreadControllerImpl::RunTask' || e.name === 'MessageLoop::RunTask' || e.name === 'ThreadControllerImpl::RunTask1').filter(e => e.ts >= a - 5000 && e.ts <= b + 5000 && e.dur > 10000);
	console.log(`long main-thread tasks (> 10 ms) between the snapshot paint and didLoadWorkbenchMain (${Math.round((b - a) / 1000)} ms window):`);
	for (const e of tasks) { console.log(`  at +${Math.round((e.ts - origin) / 1000)} ms, ${(e.dur / 1000).toFixed(1)} ms`); }
}
if (!keep) {
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: 4 }, sessionId);
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: 4 }, sessionId);
	await sleep(500);
}
ws.close();
