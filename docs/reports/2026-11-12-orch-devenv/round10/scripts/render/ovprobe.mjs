// Per frame of the display compositor: quads in the root pass vs CALayer overlays (a quad that is not an overlay
// is drawn with Metal). Optional CSS applied for the probe only (id'd style, removed after).
//   node ovprobe.mjs [secs=1] ['css text']
import { cdp, sleep } from './lib.mjs';
const secs = Number(process.argv[2] ?? 1);
const css = process.argv[3];
const port = Number(process.env.SPEED_CDP ?? 9983);
const c = await cdp();
if (css) { await c.evaluate(`(() => { let s = document.getElementById('ovprobe'); if (!s) { s = document.createElement('style'); s.id = 'ovprobe'; document.head.appendChild(s); } s.textContent = ${JSON.stringify(css)}; })()`); await sleep(300); }
const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map(); const ev = []; let done; const fin = new Promise(r => done = r);
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method === 'Tracing.dataCollected') { ev.push(...m.params.value); } else if (m.method === 'Tracing.tracingComplete') { done(); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Tracing.start', { traceConfig: { includedCategories: ['viz'] }, transferMode: 'ReportEvents' });
await sleep(secs * 1000);
await send('Tracing.end'); await fin; ws.close();
if (css) { await c.evaluate(`document.getElementById('ovprobe')?.remove()`); }
c.close();
const q = ev.filter(e => e.name === 'DirectRenderer::DrawRenderPass').map(e => e.args.NumberOfQuads);
const o = ev.filter(e => e.name === 'SkiaOutputDevice->ScheduleOverlays()').map(e => e.args.num_overlays);
const swaps = ev.filter(e => e.name === 'Display::DrawAndSwap').length;
const hist = a => Object.entries(a.reduce((m, x) => (m[x] = (m[x] ?? 0) + 1, m), {})).map(([k, n]) => `${k}x${n}`).join(' ');
console.log(`${(css ?? 'none').slice(0, 90).padEnd(90)} swaps ${swaps} passes ${q.length} quads[${hist(q)}] overlays[${hist(o)}]`);
