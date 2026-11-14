// node cdp.mjs <port> eval '<expr>' | shot <file.png>
import { writeFileSync } from 'fs';
const [port, cmd, arg] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
if (cmd === 'eval') {
	const r = await send('Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true });
	console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 1));
} else if (cmd === 'shot') {
	const r = await send('Page.captureScreenshot', { format: 'png' });
	writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
	console.log('wrote', arg, page.title);
}
ws.close();
