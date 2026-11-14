// Launch an arm, type into the window as soon as anything takes keys, then check where the text ended up.
//   node typecheck.mjs <arm> [enter]
import { spawnSync } from 'child_process';
const [arm, enter] = process.argv.slice(2);
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
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true })).result?.result?.value;
const key = async ch => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }); };
let state;
for (;;) { state = await ev(`(()=>{const a=document.activeElement; return a?.id==='volt-window-snapshot-input'?'snapshot':a?.closest?.('.volt-agent-composer .monaco-editor')?'composer':'none'})()`); if (state !== 'none' && state !== undefined) break; await new Promise(r => setTimeout(r, 5)); }
const firstTarget = { state, ms: Date.now() - t0 };
for (const ch of 'hello') { await key(ch); }
if (enter) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); }
const afterTyping = await ev(`(()=>({snapshot: document.getElementById('volt-window-snapshot-input')?.value ?? null}))()`);
await new Promise(r => setTimeout(r, 8000));
const end = await ev(`(()=>({snapshotShown: !!document.getElementById('volt-window-snapshot'), composer: [...document.querySelectorAll('.volt-agent-composer .view-lines')].map(e=>e.textContent).join('|'), focused: !!document.activeElement?.closest?.('.volt-agent-composer .monaco-editor'), replies: document.querySelectorAll('.volt-agent-editor .volt-agent-reply').length, users: document.querySelectorAll('.volt-agent-editor .volt-agent-user, .volt-agent-editor [class*=user-message]').length}))()`);
console.log(JSON.stringify({ firstTarget, afterTyping, end }));
process.exit(0);
