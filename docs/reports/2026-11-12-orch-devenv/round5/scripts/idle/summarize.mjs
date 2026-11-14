// Medians, n and ranges of the round-4 smoothness data (a6.jsonl, a8.jsonl, open/*.json), before and after.
// Rows whose 1-minute load was over 14 when the sample started (the brief's gate) are left out of the medians.
//   node summarize.mjs [--since ISO]   (markdown to stdout)
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { DATA, median } from './lib.mjs';

const args = process.argv.slice(2);
const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : '';
const MAX = 14;
const rows = file => existsSync(join(DATA, file)) ? readFileSync(join(DATA, file), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.at >= since) : [];
const fmt = v => v === null || v === undefined ? '-' : Math.round(v * 100) / 100;
const line = (label, values, loads) => {
	const ok = values.filter((v, i) => loads[i] <= MAX && v !== null && v !== undefined);
	const out = values.filter((v, i) => loads[i] > MAX).length;
	return `${label}: median ${fmt(median(ok))}, n=${ok.length}, range ${fmt(Math.min(...ok))}-${fmt(Math.max(...ok))}, load ${fmt(Math.min(...loads.filter(l => l <= MAX)))}-${fmt(Math.max(...loads.filter(l => l <= MAX)))}${out ? ` (${out} over load ${MAX} left out)` : ''}`;
};

console.log('## A6');
for (const variant of ['front', 'covered']) {
	for (const arm of ['minbase', 'before', 'after']) {
		// A covered row counts only when ADEMark's cover panel stayed up for the whole sample.
		const r = rows('a6.jsonl').filter(x => x.arm === arm && x.variant === variant && (variant !== 'covered' || (x.cover && !x.cover.error)));
		const loads = r.map(x => x.loadStart);
		console.log(line(`${variant} ${arm} cpu % (app)`, r.map(x => x.cpuAppPct), loads));
		console.log(line(`${variant} ${arm} wakeups/s (app)`, r.map(x => x.wakeupsApp), loads));
		for (const role of ['gpu', 'renderer', 'main', 'agent server', 'node utility', 'sandbox helper', 'plugin host', 'log stream', 'claude CLI']) {
			console.log('   ' + line(`${role} cpu %`, r.map(x => x.byRole?.[role]?.cpuPct ?? 0), loads) + ' | ' + line('wakeups', r.map(x => x.byRole?.[role]?.wakeups ?? 0), loads).replace(/^.*?: /, ''));
		}
	}
}

console.log('## A8');
for (const delay of [...new Set(rows('a8.jsonl').map(x => x.delayS ?? 0))].sort((a, b) => a - b)) {
	console.log(`### streams started ${delay} s after the workbench was up (+8 s)`);
	for (const arm of ['before', 'after']) {
		// Valid only when the chat on screen was seen streaming while the keys went in.
		const r = rows('a8.jsonl').filter(x => x.arm === arm && x.streamed === true && (x.delayS ?? 0) === delay);
		const loads = r.map(x => x.loadStart); // the gate is before launch: 5 streams raise the load themselves
		// Headline: key to presented frame (EventLatency KEY_PRESSED); then round 4's in-renderer measure.
		console.log(line(`${arm} key to pixels p95 ms`, r.map(x => x.k2pP95), loads));
		console.log(line(`${arm} key to pixels p50 ms`, r.map(x => x.k2pP50), loads));
		console.log(line(`${arm} key to pixels max ms`, r.map(x => x.k2pMax), loads));
		console.log(line(`${arm} p95 ms`, r.map(x => x.p95), loads));
		console.log(line(`${arm} p50 ms`, r.map(x => x.p50), loads));
		console.log(line(`${arm} max ms`, r.map(x => x.max), loads));
		console.log(line(`${arm} missed`, r.map(x => x.missed), loads));
		console.log(`   loads during typing/end: ${r.map(x => `${x.loadTyping}/${x.loadEnd}`).join(', ')}`);
	}
}

console.log('## Chat open (cold copies) and reload');
const dir = join(DATA, 'open');
if (existsSync(dir)) {
	const files = readdirSync(dir).filter(f => f.endsWith('.json'));
	const groups = new Map();
	for (const f of files) {
		const m = /^(before|after)-(small|medium|large)-h(\d+)-c\d+\.json$/.exec(f);
		const m2 = /^(before|after)-reload-medium-r\d+\.json$/.exec(f);
		const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
		if (m) {
			const k = `${m[2]} hover ${m[3]} ${m[1]}`;
			for (const r of s.results.filter(Boolean)) {
				(groups.get(k) ?? groups.set(k, []).get(k)).push([r.settled, r.firstVisible, r.load ?? r.loadBefore ?? 0]);
			}
		} else if (m2) {
			const k = `reload medium ${m2[1]}`;
			for (const r of s.results.filter(Boolean)) {
				(groups.get(k) ?? groups.set(k, []).get(k)).push([r.endAt, r.paneToEnd, r.load ?? r.loadBefore ?? 0, r.framesWithoutTranscript]);
			}
		}
	}
	for (const k of [...groups.keys()].sort()) {
		const g = groups.get(k);
		const loads = g.map(x => x[2]);
		if (k.startsWith('reload')) {
			console.log(line(`${k} last message at (ms from document start)`, g.map(x => x[0]), loads));
			console.log('   ' + line('pane up to last message ms', g.map(x => x[1]), loads) + ' | ' + line('frames with pane up and no transcript', g.map(x => x[3]), loads).replace(/^.*?: /, ''));
		} else {
			console.log(line(`${k} settled ms`, g.map(x => x[0]), loads) + ' | ' + line('first visible', g.map(x => x[1]), loads).replace(/^.*?: /, ''));
		}
	}
}
