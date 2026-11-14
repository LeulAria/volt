// Medians (n, range, loads) of run.ts rows or fp2.mjs rows.
//   node summarize.mjs launch <rows.jsonl>...   A1/A2 rows: window, Ready (first composer that takes keys), real composer
//   node summarize.mjs fp <fp.jsonl>...          first-paint rows: first frame, transcript, composer, real composer
// A row counts only when the 1-minute load was <= LOAD_MAX (default 14) both at its start (run.ts gate) and its end.
import { readFileSync } from 'fs';
const [mode, ...files] = process.argv.slice(2);
const MAX = Number(process.env.LOAD_MAX ?? 14);
const rows = files.flatMap(f => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
const load1 = u => Number(/load averages?: ([\d.]+)/.exec(u ?? '')?.[1]);
const med = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const fmt = (a) => a.length ? `${Math.round(med(a))} (n ${a.length}, ${Math.round(Math.min(...a))}-${Math.round(Math.max(...a))})` : 'n 0';
const groups = new Map();
for (const r of rows) {
	if (r.skipped || r.error) { continue; }
	const key = mode === 'fp' ? `${r.arm}${r.label ? ' ' + r.label : ''}` : `${r.app} ${r.test}`;
	const loads = mode === 'fp' ? [r.load] : [r.load_gate?.load1, load1(r.uptime)];
	const ok = loads.every(l => typeof l === 'number' && l <= MAX);
	if (!groups.has(key)) { groups.set(key, { ok: [], loaded: [] }); }
	groups.get(key)[ok ? 'ok' : 'loaded'].push({ r, loads });
}
const fields = mode === 'fp'
	? [['firstFrame', 'first frame'], ['transcript', 'chat visible'], ['composer', 'composer takes keys'], ['realComposer', 'real composer'], ['firstFrameToTranscript', 'first frame -> chat']]
	: [['window_ms', 'first window'], ['ready_ms', 'Ready'], ['ready_real_ms', 'real composer']];
for (const [key, g] of [...groups].sort()) {
	const loads = g.ok.flatMap(x => x.loads);
	console.log(`${key}: valid ${g.ok.length}, under load ${g.loaded.length}${loads.length ? `, loads ${Math.min(...loads).toFixed(1)}-${Math.max(...loads).toFixed(1)}` : ''}`);
	for (const [f, label] of fields) {
		const v = g.ok.map(x => x.r[f]).filter(x => typeof x === 'number');
		console.log(`  ${label}: ${fmt(v)}`);
	}
	if (mode !== 'fp') {
		// The app's own marks, ms after the launch (t0): main process start, window opened, renderer, workbench.
		const marks = ['main:didStartMain', 'main:willOpenNewWindow', 'didStartRenderer', 'voltDidPaintWindowSnapshot', 'didLoadWorkbenchMain', 'didStartWorkbench', 'voltDidHandOffWindowSnapshot'];
		console.log('  marks: ' + marks.map(k => { const v = g.ok.map(x => x.r.marks?.[k]).filter(x => typeof x === 'number'); return v.length ? `${k.replace('main:', 'main ')} ${Math.round(med(v))}${v.length < g.ok.length ? ` (n ${v.length})` : ''}` : ''; }).filter(Boolean).join(', '));
		const from = g.ok.map(x => x.r.ready_from); const snap = from.filter(x => x === 'snapshot').length;
		if (snap) { console.log(`  Ready from the snapshot's text area in ${snap} of ${from.length}`); }
	} else {
		const from = g.ok.map(x => x.r.transcriptFrom); const snap = from.filter(x => x === 'snapshot').length;
		console.log(`  chat first shown by the snapshot in ${snap} of ${from.length}`);
	}
}
