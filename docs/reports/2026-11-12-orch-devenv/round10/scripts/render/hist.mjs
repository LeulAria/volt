// Chromium histograms from the running arm (CDP Browser.getHistograms on the browser target).
//   node hist.mjs <query> [delta]   e.g. node hist.mjs CALayer
const port = Number(process.env.SPEED_CDP ?? 9983);
const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
const r = await new Promise(res => { ws.addEventListener('message', e => res(JSON.parse(e.data))); ws.send(JSON.stringify({ id: 1, method: 'Browser.getHistograms', params: { query: process.argv[2] ?? '', delta: process.argv[3] === 'delta' } })); });
ws.close();
for (const h of r.result?.histograms ?? []) {
	console.log(`${h.name} n=${h.count} sum=${h.sum}: ${h.buckets.map(b => `${b.low}${b.high - b.low > 1 ? '-' + (b.high - 1) : ''}:${b.count}`).join(' ')}`);
}
if (r.error) { console.log(JSON.stringify(r.error)); }
