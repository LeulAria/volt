// Tables for report 52 from round6/data/firstword (rows at a 1-minute load above LOAD_MAX, 14, are left out and
// counted). Medians with n and range.
//   node summarize.mjs [since=<ISO time>]
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '../../data/firstword');
const MAX = Number(process.env.LOAD_MAX ?? 14);
const since = process.argv.find(a => a.startsWith('since='))?.slice(6) ?? '2026-11-14T20:00:00Z';
const rows = f => existsSync(join(DATA, f)) ? readFileSync(join(DATA, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => (r.at ?? '') >= since) : [];
const load1 = r => parseFloat(String(r.load ?? '').trim().split(/\s+/)[0]);
const quiet = r => load1(r) <= MAX;
const med = a => { const s = a.filter(x => typeof x === 'number' && !Number.isNaN(x)).sort((x, y) => x - y); if (!s.length) { return null; } const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function cell(values) {
	const v = values.filter(x => typeof x === 'number' && !Number.isNaN(x));
	if (!v.length) { return 'n/a'; }
	return `${Math.round(med(v))} (${v.length}, ${Math.round(Math.min(...v))}-${Math.round(Math.max(...v))})`;
}
function table(title, groups, metrics) {
	console.log(`\n### ${title}\n`);
	console.log(`| metric | ${groups.map(g => g.name).join(' | ')} |`);
	console.log(`|---|${groups.map(() => '---').join('|')}|`);
	for (const [label, pick] of metrics) {
		console.log(`| ${label} | ${groups.map(g => cell(g.rows.filter(quiet).map(pick))).join(' | ')} |`);
	}
	const loads = groups.map(g => { const q = g.rows.filter(quiet).map(load1); return q.length ? `${Math.min(...q).toFixed(1)}-${Math.max(...q).toFixed(1)}` : 'n/a'; });
	console.log(`| load (kept) | ${loads.join(' | ')} |`);
	console.log(`| left out (load > ${MAX}) | ${groups.map(g => g.rows.filter(r => !quiet(r)).length).join(' | ')} |`);
}

// Chain 7: the adapter alone, default vs the fix (CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0 + allow=mcp__volt).
const rb = rows('resumebench.jsonl');
const fix = r => r.flags.some(f => f.startsWith('env:CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0'));
const phases = [['spawn -> initialize', r => r.initMs], ['initialize -> session ready', r => r.sessionMs], ['prompt -> the turn\'s request', r => r.mainReqMs], ['prompt -> first text', r => r.firstTextMs], ['ready -> the turn\'s request', r => typeof r.mainReqMs === 'number' ? r.mainReqMs + (r.warmMs ?? 0) : undefined]];
const c7w = rb.filter(r => r.label === 'r6-c7-window');
table('Adapter alone, prompt 400 ms after ready (chain 7)', [
	{ name: 'default (as 7f07f73d677)', rows: c7w.filter(r => !fix(r)) },
	{ name: 'fix (wait 0 + volt required)', rows: c7w.filter(fix) },
], phases);
const c7a = rb.filter(r => r.label === 'r6-c7-atonce');
table('Adapter alone, prompt at once (chain 7)', [
	{ name: 'default', rows: c7a.filter(r => !fix(r)) },
	{ name: 'fix', rows: c7a.filter(fix) },
], phases);

const fl = rows('firstlaunch.jsonl').filter(r => r.variant === 'restored' && r.restS === 45);
table('Restored chat, first message 45 s after launch (firstlaunch.mjs, chain 8 A)', [
	{ name: 'before, click', rows: fl.filter(r => r.arm === 'before' && !r.human) },
	{ name: 'after, click', rows: fl.filter(r => r.arm === 'after' && !r.human) },
	{ name: 'before, pointer first', rows: fl.filter(r => r.arm === 'before' && r.human) },
	{ name: 'after, pointer first', rows: fl.filter(r => r.arm === 'after' && r.human) },
], [['Enter -> first word painted, ms', r => r.firstWordMs], ['agent ready (from the send), ms', r => r.trace?.agentReadyMs], ['first text (from the send), ms', r => r.trace?.firstTextMs], ['agents at rest before the click', r => r.agentAdaptersAtRest]]);

const re = rows('resume.jsonl');
table('Reopened chat after 40 s idle, open 1 s before the click (resume.mjs, chain 8 B)', [
	{ name: 'before, click', rows: re.filter(r => r.arm === 'before' && !r.human) },
	{ name: 'after, click', rows: re.filter(r => r.arm === 'after' && !r.human) },
	{ name: 'before, pointer first', rows: re.filter(r => r.arm === 'before' && r.human) },
	{ name: 'after, pointer first', rows: re.filter(r => r.arm === 'after' && r.human) },
], [['Enter -> first word painted, ms', r => r.firstWordMs], ['agent ready (from the send), ms', r => r.trace?.agentReadyMs], ['first text (from the send), ms', r => r.trace?.firstTextMs]]);

const a4 = rows('a4.jsonl');
table('A4 First Word (ADEMark sequence, Opus 5.5, replay, chain 8 C)', [
	{ name: 'Volt before', rows: a4.filter(r => r.arm === 'before') },
	{ name: 'Volt after', rows: a4.filter(r => r.arm === 'after') },
], [['total: DOM poll (round 3 runner), ms', r => r.pollMs], ['total: two frames after the DOM insert, ms', r => r.totalMs], ['before the request, ms', r => r.beforeRequestMs], ['on screen (poll - before), ms', r => (typeof r.pollMs === 'number' && typeof r.beforeRequestMs === 'number' ? r.pollMs - r.beforeRequestMs : undefined)]]);
