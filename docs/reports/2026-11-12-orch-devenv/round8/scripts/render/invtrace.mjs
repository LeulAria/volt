// Exploratory: what invalidates paint and layout while a reply streams. Records a DevTools trace with invalidation
// tracking for a few seconds and counts the tracked invalidations by kind, reason and node. Prints only.
//   node invtrace.mjs [seconds=2]
import { cdp, sleep } from './lib.mjs';
const seconds = Number(process.argv[2] ?? 2);
const c = await cdp();
const events = [];
c.on('Tracing.dataCollected', p => events.push(...p.value));
const done = new Promise(r => c.on('Tracing.tracingComplete', r));
await c.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.invalidationTracking'] } });
await sleep(seconds * 1000);
await c.send('Tracing.end');
await done;
const count = new Map();
const add = (k, n = 1) => count.set(k, (count.get(k) ?? 0) + n);
let frames = 0;
for (const e of events) {
	const d = e.args?.data;
	if (e.name === 'Paint' && e.ph === 'X') { add(`Paint clip ~${Math.round(Math.abs((d?.clip?.[2] ?? 0) - (d?.clip?.[0] ?? 0)))}x${Math.round(Math.abs((d?.clip?.[5] ?? 0) - (d?.clip?.[1] ?? 0)) / 200) * 200} node ${d?.nodeName ?? ''}`); }
	if (e.name === 'BeginMainThreadFrame') { frames++; }
	if (/InvalidationTracking$/.test(e.name) && d) {
		add(`${e.name.replace('InvalidationTracking', '')} | ${d.reason ?? d.invalidationSet ?? ''} | ${d.nodeName ?? ''} ${(d.changedClass ?? d.changedAttribute ?? d.changedId ?? d.extraData ?? '')}`.slice(0, 170));
	}
	if (e.name === 'UpdateLayoutTree' && e.ph === 'X') { add('UpdateLayoutTree elements', e.args?.elementCount ?? 0); add('UpdateLayoutTree ms', (e.dur ?? 0) / 1000); }
	if (e.name === 'Layout' && e.ph === 'X') { add('Layout ms', (e.dur ?? 0) / 1000); add('Layout n'); }
	if ((e.name === 'Paint' || e.name === 'PrePaint') && e.ph === 'X') { add(`${e.name} ms`, (e.dur ?? 0) / 1000); }
}
console.log(`${seconds} s, ${frames} main frames, ${events.length} events`);
for (const [k, n] of [...count].sort((a, b) => b[1] - a[1]).slice(0, 45)) { console.log(`${String(Math.round(n)).padStart(7)}  ${k}`); }
c.close();
