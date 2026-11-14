// node /tmp/v4cold-eval.mjs '<expr>'  evaluates in the CDP 9944 workbench page
const expr = process.argv[2];
const targets = await (await fetch('http://127.0.0.1:9944/json/list')).json();
const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id === 1) { console.log(JSON.stringify(m.result?.result?.value ?? m.result, null, 1)); process.exit(0); } });
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
