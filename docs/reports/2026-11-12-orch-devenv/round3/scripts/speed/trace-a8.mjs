// Timeline trace of the renderer for <s> s while streams run and a probe letter is typed every 250 ms; prints
// layout / style recalc counts and time, who forced them (JS stack top), and long tasks.
//   node trace-a8.mjs <out.json> [seconds=5]
import { writeFileSync } from 'fs';
import { cdp, focusComposer, sleep } from './lib.mjs';
const out = process.argv[2] ?? '/tmp/v3-speed/a8trace.json';
const secs = Number(process.argv[3] ?? 5);
const c = await cdp();
await focusComposer(c);
const events = [];
c.on('Tracing.dataCollected', p => events.push(...p.value));
const done = new Promise(r => c.on('Tracing.tracingComplete', r));
await c.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack', transferMode: 'ReportEvents' });
for (let i = 0; i < secs * 4; i++) {
	const ch = 'ademarkqz'[i % 9];
	const kc = ch.toUpperCase().charCodeAt(0);
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
	await sleep(250);
}
await c.send('Tracing.end');
await done;
writeFileSync(out, JSON.stringify(events));
await c.key('a', 'KeyA', 65, 4);
await c.key('Backspace', 'Backspace', 8);
c.close();
const main = events.find(e => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
const tid = main?.tid;
const mine = events.filter(e => e.tid === tid);
const sum = name => { const xs = mine.filter(e => e.name === name && e.ph === 'X'); return { n: xs.length, ms: Math.round(xs.reduce((s, e) => s + (e.dur ?? 0), 0) / 1000) }; };
const forced = new Map();
for (const e of mine.filter(e => (e.name === 'Layout' || e.name === 'UpdateLayoutTree') && e.ph === 'X')) {
	const st = e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace;
	const k = `${e.name} <- ${st?.[0] ? `${st[0].functionName}@${st[0].url.split('/').pop()}:${st[0].lineNumber}` : '(frame)'}`;
	const v = forced.get(k) ?? { n: 0, ms: 0 };
	v.n++; v.ms += (e.dur ?? 0) / 1000;
	forced.set(k, v);
}
const frames = mine.filter(e => e.name === 'BeginMainThreadFrame' || e.name === 'BeginFrame').length;
const longTasks = mine.filter(e => e.name === 'RunTask' && e.ph === 'X' && e.dur > 50_000).map(e => Math.round(e.dur / 1000));
console.log(JSON.stringify({ secs, frames, layout: sum('Layout'), style: sum('UpdateLayoutTree'), paint: sum('Paint'), longTasks }));
for (const [k, v] of [...forced].sort((a, b) => b[1].ms - a[1].ms).slice(0, 20)) { console.log(String(v.n).padStart(5), v.ms.toFixed(1).padStart(8), k); }
