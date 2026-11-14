// Timeline trace of one New Agent click (200 ms before to 600 ms after) with probe letters typed every 50 ms;
// prints the main thread's top-level work in order (task, its biggest children) and the style/layout totals.
//   node trace-a3.mjs <out.json>
import { writeFileSync } from 'fs';
import { cdp, sleep } from './lib.mjs';
const out = process.argv[2] ?? '/tmp/v3-speed/a3trace.json';
const c = await cdp();
const button = await c.center(`[...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^New (Chat|Agent)/.test(e.getAttribute('aria-label')))`);
const events = [];
c.on('Tracing.dataCollected', p => events.push(...p.value));
const done = new Promise(r => c.on('Tracing.tracingComplete', r));
await c.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,blink,cc', transferMode: 'ReportEvents' });
await sleep(200);
await c.click(...button);
for (let i = 0; i < 12; i++) {
	const ch = 'ademarkqz'[i % 9];
	const kc = ch.toUpperCase().charCodeAt(0);
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
	await sleep(50);
}
await c.send('Tracing.end');
await done;
writeFileSync(out, JSON.stringify(events));
await c.key('a', 'KeyA', 65, 4);
await c.key('Backspace', 'Backspace', 8);
c.close();
const tid = events.find(e => e.name === 'thread_name' && e.args?.name === 'CrRendererMain').tid;
const mine = events.filter(e => e.tid === tid && e.ph === 'X' && e.dur);
const tasks = mine.filter(e => e.name === 'RunTask' && e.dur > 3000).sort((a, b) => a.ts - b.ts);
const t0 = tasks[0]?.ts ?? 0;
for (const t of tasks) {
	const kids = mine.filter(e => e !== t && e.ts >= t.ts && e.ts + e.dur <= t.ts + t.dur && e.name !== 'RunTask' && e.name !== 'ThreadControllerImpl::RunTask');
	const by = new Map();
	for (const k of kids) { if (['FunctionCall', 'UpdateLayoutTree', 'Layout', 'Paint', 'PrePaint', 'Layerize', 'Commit', 'EventDispatch', 'FireAnimationFrame', 'ParseHTML', 'TimerFire', 'HitTest', 'ScrollLayer', 'UpdateLayer', 'MajorGC', 'MinorGC', 'V8.GC_SCAVENGER'].includes(k.name)) { by.set(k.name, (by.get(k.name) ?? 0) + k.dur / 1000); } }
	console.log(`${((t.ts - t0) / 1000).toFixed(0).padStart(5)} +${(t.dur / 1000).toFixed(1).padStart(6)}  ${[...by].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' | ')}`);
}
