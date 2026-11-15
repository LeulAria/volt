// Exploration: launch an arm, wait for the workbench, print every perf mark (main + renderer) in ms after the main
// process's time origin and after t0 (the `open` call). Not a timing rig (no load gate, no first-window watcher).
//   node marks.mjs <arm> [--keep] [--env K=V ...]      arm = dir under ~/.volt-r6/launch/apps (VOLT.app), profile ud/<arm>, HOME h/<arm>
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';

const R = `${process.env.HOME}/.volt-r6/launch`;
const [arm, ...rest] = process.argv.slice(2);
const keep = rest.includes('--keep');
const extraEnv = rest.flatMap((a, i) => a === '--env' ? [rest[i + 1]] : []);
// --dev <tree>: a dev build of that tree (its .build/electron/VOLT.app) instead of a packaged arm
const devTree = rest.includes('--dev') ? rest[rest.indexOf('--dev') + 1] : undefined;
const app = devTree ? `${devTree}/.build/electron/VOLT.app` : `${R}/apps/${arm}/VOLT.app`, ud = `${R}/ud/${arm}`, home = `${R}/h/${arm}`;
const port = Number(process.env.PORT ?? 9974);
if (!existsSync(app)) { console.error(`no app at ${app}`); process.exit(2); }
const devEnv = devTree ? ['NODE_ENV=development', 'VSCODE_DEV=1', 'VSCODE_CLI=1', 'VSCODE_SKIP_PRELAUNCH=1', 'VOLT_AGENT_SERVER_LAUNCHD=0'] : [];
const devArgs = devTree ? [devTree, '--disable-extension=vscode.vscode-api-tests'] : [];
mkdirSync(ud, { recursive: true }); mkdirSync(home, { recursive: true });
delete process.env.ELECTRON_RUN_AS_NODE;
const envs = [`HOME=${home}`, `PATH=${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, 'DISABLE_AUTOUPDATER=1', ...devEnv, ...extraEnv].flatMap(e => ['--env', e]);
const load = () => /averages?: ([\d.]+)/.exec(spawnSync('uptime', { encoding: 'utf8' }).stdout)?.[1];
const t0 = Date.now();
spawnSync('open', ['-n', '-a', app, ...envs, '--args', ...devArgs, '--use-mock-keychain', '--user-data-dir', ud, '--extensions-dir', `${home}/.volt/extensions`, `--remote-debugging-port=${port}`]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function page() {
	for (let i = 0; i < 2000; i++) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(300) })).json();
			const t = list.find(x => x.type === 'page' && /workbench(-dev)?\.html/.test(x.url));
			if (t) { return t; }
		} catch { }
		await sleep(10);
	}
	throw new Error('no page');
}
const t = await page();
const tPage = Date.now() - t0;
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const d = JSON.parse(e.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const evaluate = expr => new Promise(r => { const i = ++id; pending.set(i, d => r(d.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
const MARKS = `(()=>{const c=globalThis.vscode?.context?.configuration?.(); const main={}; for(const m of (c?.perfMarks??[])) main[m.name]=m.startTime;
  const r={}; for(const m of performance.getEntriesByType('mark')) r[m.name]=performance.timeOrigin+m.startTime;
  const a=document.activeElement; return {main, r, cached: c?.isCodeCaching ?? null, snapInput: a?.id==='volt-window-snapshot-input', realComposer: !!document.querySelector('.volt-agent-composer .monaco-editor'), rendererOrigin: performance.timeOrigin}})()`;
let m;
for (let i = 0; i < 1500; i++) {
	m = await evaluate(MARKS);
	if (m?.r?.['code/didStartWorkbench'] && m.main?.['code/didStartMain']) { break; }
	await sleep(20);
}
// Composer controls: when do the real send and attach controls exist?
const CONTROLS = `(()=>{const c=document.querySelector('.volt-agent-composer'); if(!c) return null; return {send: !!c.querySelector('[class*="send"],[aria-label*="Send" i]'), attach: !!c.querySelector('[aria-label*="ttach" i],[class*="attach"]'), snapshotShown: !!document.getElementById('volt-window-snapshot')}})()`;
const controls = await evaluate(CONTROLS);
const origin = m.main['code/willLoadMainBundle'] ?? m.main['code/didStartMain'];
const rows = [];
for (const [k, v] of Object.entries(m.main)) { if (typeof v === 'number' && k !== 'code/timeOrigin') { rows.push([`main ${k.replace('code/', '')}`, v]); } }
for (const [k, v] of Object.entries(m.r)) { if (typeof v === 'number') { rows.push([`rend ${k.replace('code/', '')}`, v]); } }
rows.sort((a, b) => a[1] - b[1]);
const out = [`# ${arm} load ${load()} t0->origin ${Math.round(origin - t0)} ms, page target at ${tPage} ms after t0, codeCache ${m.cached}, ${JSON.stringify(controls)}`];
for (const [k, v] of rows) { out.push(`${String(Math.round(v - origin)).padStart(6)}  ${String(Math.round(v - t0)).padStart(6)}  ${k}`); }
console.log(out.join('\n'));
appendFileSync(`${R}/exp-marks.log`, `\n${new Date().toISOString()} ${out.join('\n')}\n`);
if (!keep) {
	ws.send(JSON.stringify({ id: ++id, method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: 4 } }));
	ws.send(JSON.stringify({ id: ++id, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: 4 } }));
	await sleep(500);
}
ws.close();
