// Diagnostic: relaunch an arm, type a probe key every 50 ms over CDP (as run.ts does) and log, every 100 ms, which
// element has focus and whether the agent window's composer exists, until the real composer holds typed text.
//   node focuslog.mjs <arm> <out.jsonl>
import { spawnSync } from 'child_process';
import { appendFileSync } from 'fs';
const [arm, outFile] = process.argv.slice(2);
const RUN = new URL('./run.ts', import.meta.url).pathname;
const sleep = ms => new Promise(r => setTimeout(r, ms));
spawnSync('bun', [RUN, '--app', arm, '--quit']);
await sleep(2000);
const t0 = Date.now();
spawnSync('bun', [RUN, '--app', arm, '--launch']);
let ws;
for (; Date.now() - t0 < 30000;) {
	try {
		const list = await (await fetch('http://127.0.0.1:9944/json/list')).json();
		const p = list.find(x => x.type === 'page' && /workbench/.test(x.url));
		if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); break; }
	} catch { /* */ }
	await sleep(20);
}
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); r({}); } }, 3000); });
let done = false;
(async () => { const P = 'ademarkqz'; let i = 0; while (!done) { const ch = P[i++ % P.length]; await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), text: ch }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }); await sleep(50); } })();
const EXPR = `(()=>{const a=document.activeElement; const d=e=>e?(e.tagName+(e.id?'#'+e.id:'')+'.'+String(e.className||'').split(' ').slice(0,3).join('.')).slice(0,90):null;
 const anc=[]; for(let e=a;e&&anc.length<6;e=e.parentElement){ if(e.className&&/volt|monaco-list|quick-input|pane|part/.test(String(e.className))) anc.push(String(e.className).split(' ')[0]); }
 const comp=document.querySelector('.volt-agent-composer .monaco-editor'); const txt=comp?.querySelector('.view-lines')?.textContent??null;
 return {active:d(a), anc:anc.join('<'), composer:!!comp, composerText:txt?.slice(0,30), quick: !!document.querySelector('.quick-input-widget:not([style*="display: none"])'), snapshot: !!document.getElementById('volt-window-snapshot')}})()`;
let last = '';
for (; Date.now() - t0 < 20000;) {
	const r = (await send('Runtime.evaluate', { expression: EXPR, returnByValue: true })).result?.result?.value;
	const s = JSON.stringify(r);
	if (s !== last) { const row = { arm, t: Date.now() - t0, ...r }; appendFileSync(outFile, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)); last = s; }
	if (r?.composerText && /[a-z]{2}/.test(r.composerText)) { break; }
	await sleep(100);
}
done = true;
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
await sleep(300);
process.exit(0);
