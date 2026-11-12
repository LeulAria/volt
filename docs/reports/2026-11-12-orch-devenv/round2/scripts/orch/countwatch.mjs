// Samples the three subagent counts a parent chat shows (transcript group card, composer pill,
// side panel heading) once a second over CDP: node countwatch.mjs <port> <seconds> > samples.jsonl
const [port, seconds] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title) ?? targets.find(t => t.type === 'page' && /workbench/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const expr = `(() => { const t = document.body.innerText; const m = re => (t.match(re) || [])[0] || null;
	return { card: m(/\\d+ (working|done)[^\\n]*/), pill: m(/\\d+ subagents? running/), side: m(/SUBAGENTS[^\\n]*RUNNING|Subagents[^\\n]*running/i) }; })()`;
const end = Date.now() + seconds * 1000;
while (Date.now() < end) {
	const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
	console.log(JSON.stringify({ t: Date.now(), ...r.result?.result?.value }));
	await new Promise(r => setTimeout(r, 1000));
}
ws.close();
