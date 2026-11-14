// node shot.mjs <out.png> [port]
import { writeFileSync } from 'fs';
const port = process.argv[3] ?? 9944;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id === 1) { writeFileSync(process.argv[2], Buffer.from(m.result.data, 'base64')); process.exit(0); } });
ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
