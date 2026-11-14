// node paintlive.mjs <snapshot.json> [remove]   paints a stored snapshot over the live dev page (debugging)
import { readFileSync } from 'fs';
const snap = readFileSync(process.argv[2], 'utf8');
const base = 'vscode-file://vscode-app/Users/leularia/Desktop/VOLT/volt-e4-coldstart/out/vs/platform/voltWindowSnapshot/browser/windowSnapshotPaint.js';
const expr = process.argv[3] === 'remove' ? `import('${base}').then(m=>m.removeWindowSnapshot(document))`
  : `import('${base}').then(m=>m.paintWindowSnapshot(document, ${snap}))`;
const targets = await (await fetch('http://127.0.0.1:9944/json/list')).json();
const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id === 1) { console.log(JSON.stringify(m.result).slice(0, 300)); process.exit(0); } });
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
