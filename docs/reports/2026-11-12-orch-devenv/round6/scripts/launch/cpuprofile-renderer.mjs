// Exploration: CPU profile of the workbench renderer from as early as CDP can attach (the launch window's page) to
// didStartWorkbench + 1 s. Prints self time by function and what each 100 ms slice mostly did.
//   node cpuprofile-renderer.mjs <arm>
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const R = `${process.env.HOME}/.volt-r6/launch`;
const [arm] = process.argv.slice(2);
const app = `${R}/apps/${arm}/VOLT.app`, ud = `${R}/ud/${arm}`, home = `${R}/h/${arm}`;
mkdirSync(`${R}/out/prof`, { recursive: true });
delete process.env.ELECTRON_RUN_AS_NODE;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = 9974;
const t0 = Date.now();
spawnSync('open', ['-n', '-a', app, '--env', `HOME=${home}`, '--env', `PATH=${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, '--env', 'DISABLE_AUTOUPDATER=1', '--args', '--use-mock-keychain', '--user-data-dir', ud, '--extensions-dir', `${home}/.volt/extensions`, `--remote-debugging-port=${port}`]);
let target;
for (let i = 0; i < 6000 && !target; i++) {
	try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(100) })).json()).find(x => x.type === 'page' && /workbench(-dev)?\.html/.test(x.url)); } catch { }
	if (!target) { await sleep(3); }
}
const tAttach = Date.now() - t0;
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const d = JSON.parse(e.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 100 });
await send('Profiler.start');
const tStart = Date.now() - t0;
const evaluate = expr => send('Runtime.evaluate', { expression: expr, returnByValue: true }).then(d => d.result?.result?.value);
let marks;
for (let i = 0; i < 1500; i++) {
	marks = await evaluate(`(()=>{const r={}; for(const x of performance.getEntriesByType('mark')) r[x.name]=Math.round(performance.timeOrigin+x.startTime); return r})()`);
	if (marks?.['code/didStartWorkbench']) { break; }
	await sleep(25);
}
await sleep(1000);
const { result } = await send('Profiler.stop');
const file = `${R}/out/prof/${arm}-renderer-${Date.now()}.cpuprofile`;
writeFileSync(file, JSON.stringify(result.profile));
const p = result.profile; const byId = new Map(p.nodes.map(n => [n.id, n]));
const parent = new Map(); for (const n of p.nodes) { for (const c of n.children ?? []) { parent.set(c, n.id); } }
const self = new Map(); let total = 0; let busy = 0;
const startUs = p.startTime; let tUs = startUs;
const slices = new Map();
const label = n => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-1)[0]}:${n.callFrame.lineNumber}`;
for (let i = 0; i < p.samples.length; i++) {
	const n = byId.get(p.samples[i]); const d = (p.timeDeltas[i] ?? 0) / 1000; tUs += (p.timeDeltas[i] ?? 0); total += d;
	const fn = n.callFrame.functionName;
	if (/^\((idle|program|garbage collector|root)\)$/.test(fn)) { if (fn !== '(idle)') { busy += d; } continue; }
	busy += d;
	self.set(label(n), (self.get(label(n)) ?? 0) + d);
	// the slice's heaviest *named ancestor two levels up* gives a coarse "what was going on"
	const slice = Math.floor((tUs - startUs) / 1000 / 100) * 100;
	let a = n; let hops = 0; while (a && (!a.callFrame.functionName || hops < 2) && parent.has(a.id)) { a = byId.get(parent.get(a.id)); hops++; }
	const s = slices.get(slice) ?? new Map(); s.set(label(a ?? n), (s.get(label(a ?? n)) ?? 0) + d); slices.set(slice, s);
}
const rel = ms => ms - (marks?.['code/didStartRenderer'] ?? 0);
console.log(`# ${arm} renderer profile: attached ${tAttach} ms after t0, profiling from ${tStart} ms; ${total.toFixed(0)} ms sampled, ${busy.toFixed(0)} ms busy -> ${file}`);
console.log('marks (ms after didStartRenderer): ' + ['code/didWaitForWindowConfig', 'code/voltDidPaintWindowSnapshot', 'code/didLoadWorkbenchMain', 'code/willStartWorkbench', 'code/didStartWorkbench', 'code/voltDidHandOffWindowSnapshot'].map(k => `${k.replace('code/', '')} ${rel(marks?.[k])}`).join(', '));
console.log('self time, top 45:'); for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 45)) { console.log(`  ${v.toFixed(1).padStart(8)}  ${k}`); }
console.log('per 100 ms slice (ms after profile start): busy ms, top 3 ancestors');
for (const [k, s] of [...slices].sort((a, b) => a[0] - b[0])) { const b = [...s.values()].reduce((x, y) => x + y, 0); if (b < 5) { continue; } console.log(`  ${String(k).padStart(5)}: ${b.toFixed(0).padStart(3)} ms  ${[...s].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([n, v]) => `${n} ${v.toFixed(0)}`).join(' | ')}`); }
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: 4 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: 4 });
await sleep(1500);
ws.close();
spawnSync('pkill', ['-9', '-f', ud]);
