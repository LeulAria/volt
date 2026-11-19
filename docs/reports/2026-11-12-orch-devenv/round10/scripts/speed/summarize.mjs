// Medians (n, range) of the A3 and A4 rows, per arm, mode (project / scratch) and rest before the new chat, with A4
// split into stages on one clock (the rig's Enter): the renderer's send, the agent server's run start, the prompt
// handed to the agent, the model request at the replay server, the first token back in the renderer, in the DOM,
// two frames later. Rows count only when the 1-minute load at the row's start was <= LOAD_MAX (default 14).
//   node summarize.mjs [a3.jsonl a4.jsonl ...]   (default: ../../data/speed/a3.jsonl and a4.jsonl)
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['a3.jsonl', 'a4.jsonl'].map(f => join(here, '../../data/speed', f));
const MAX = Number(process.env.LOAD_MAX ?? 14);
const rows = files.filter(existsSync).flatMap(f => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
const load1 = r => Number(String(r.load ?? '').trim().split(/\s+/)[0]);
const med = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const fmt = a => { const v = a.filter(x => typeof x === 'number' && !Number.isNaN(x)); return v.length ? `${Math.round(med(v))} (n ${v.length}, ${Math.round(Math.min(...v))}-${Math.round(Math.max(...v))})` : 'n 0'; };

const groups = new Map();
for (const r of rows) {
	const test = 'readyMs' in r ? 'A3' : 'A4';
	const key = `${test} ${r.arm} ${r.mode ?? 'scratch'}${r.idleS ? ` rest ${r.idleS} s` : ''}`;
	const g = groups.get(key) ?? { test, ok: [], loaded: 0 };
	if (load1(r) <= MAX) { g.ok.push(r); } else { g.loaded++; }
	groups.set(key, g);
}
for (const [key, g] of [...groups].sort()) {
	const loads = g.ok.map(load1);
	console.log(`${key}: valid ${g.ok.length}, over load ${MAX}: ${g.loaded}${loads.length ? `, loads ${Math.min(...loads).toFixed(1)}-${Math.max(...loads).toFixed(1)}` : ''}`);
	if (g.test === 'A3') {
		console.log(`  ready (two frames after the echo): ${fmt(g.ok.map(r => r.readyMs))}`);
		continue;
	}
	const d = (f) => g.ok.map(f);
	const sources = {};
	for (const r of g.ok) { const s = r.metrics?.agentSource ?? '?'; sources[s] = (sources[s] ?? 0) + 1; }
	console.log(`  agent: ${Object.entries(sources).map(([k, v]) => `${k} ${v}`).join(', ')}`);
	console.log(`  total (two frames after the DOM insert): ${fmt(d(r => r.totalMs))}`);
	console.log(`  total (DOM poll, round 3's runner):      ${fmt(d(r => r.pollMs))}`);
	console.log(`  before the request:                      ${fmt(d(r => r.beforeRequestMs))}`);
	console.log(`  on screen (total - before):              ${fmt(d(r => r.onScreenMs))}`);
	console.log('  stages:');
	console.log(`    Enter -> the renderer sends the run:        ${fmt(d(r => r.wsSendMs))}`);
	console.log(`    send -> the server starts the run:          ${fmt(d(r => r.serverAt?.runStart - r.wsSendMs))}`);
	console.log(`    run start -> the prompt is with the agent:  ${fmt(d(r => r.serverAt?.running - r.serverAt?.runStart))}`);
	console.log(`    prompt -> the model request (the CLI):      ${fmt(d(r => r.beforeRequestMs - r.serverAt?.running))}`);
	console.log(`    request -> first token in the renderer:     ${fmt(d(r => r.wsFrameMs - r.beforeRequestMs))}`);
	console.log(`    token -> in the DOM:                        ${fmt(d(r => r.domMs - r.wsFrameMs))}`);
	console.log(`    DOM -> two frames:                          ${fmt(d(r => r.totalMs - r.domMs))}`);
}
