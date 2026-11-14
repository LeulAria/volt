// Tables for report 42 from round5/data/firstword (rows at a 1-minute load above LOAD_MAX, 14, are left out and
// counted). Medians with n and range.
//   node summarize.mjs [since=<ISO time>]
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '../../data/firstword');
const MAX = Number(process.env.LOAD_MAX ?? 14);
const since = process.argv.find(a => a.startsWith('since='))?.slice(6) ?? '2026-11-14T00:00:00Z';
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

const init = rows('initbench.jsonl').filter(r => r.label === 'r5-init');
table('Spawn to initialize (initbench, adapter alone)', [
	{ name: 'before (no compile cache)', rows: init.filter(r => r.variant === 'plain') },
	{ name: 'after (compile cache)', rows: init.filter(r => r.variant === 'ccvolt') },
], [['spawn -> initialize, ms', r => r.initMs], ['adapter CPU at initialize, ms', r => r.cpuMs]]);

const cold = rows('resumebench.jsonl').filter(r => r.label === 'r5-cold');
const kind = (r, resume, warm) => r.flags.includes('resume') === resume && (r.warmMs ?? 0) === warm;
table('Cold start phases (resumebench, adapter alone, after build\'s preload)', [
	{ name: 'new, prompt at once', rows: cold.filter(r => kind(r, false, 0)) },
	{ name: 'new, prompt 2 s after ready', rows: cold.filter(r => kind(r, false, 2000)) },
	{ name: 'resume, prompt at once', rows: cold.filter(r => kind(r, true, 0)) },
	{ name: 'resume, prompt 2 s after ready', rows: cold.filter(r => kind(r, true, 2000)) },
], [['spawn -> initialize', r => r.initMs], ['initialize -> session ready', r => r.sessionMs], ['spawn -> ready (incl. setup)', r => r.readyMs], ['prompt -> model request', r => r.mainReqMs], ['prompt -> first text', r => r.firstTextMs], ['spawn -> first text', r => r.spawnToFirstTextMs]]);

const fl = rows('firstlaunch.jsonl').filter(r => r.variant === 'restored' && r.restS === 45);
table('Restored chat, first message 45 s after launch (firstlaunch.mjs)', [
	{ name: 'before, click', rows: fl.filter(r => r.arm === 'before' && !r.human) },
	{ name: 'after, click', rows: fl.filter(r => r.arm === 'after' && !r.human) },
	{ name: 'before, pointer first', rows: fl.filter(r => r.arm === 'before' && r.human) },
	{ name: 'after, pointer first', rows: fl.filter(r => r.arm === 'after' && r.human) },
], [['Enter -> first word painted, ms', r => r.firstWordMs], ['agent ready (from run start), ms', r => r.trace?.agentReadyMs], ['first text (from run start), ms', r => r.trace?.firstTextMs], ['agents at rest before the click', r => r.agentAdaptersAtRest]]);

const re = rows('resume.jsonl');
table('Reopened chat after 40 s idle, open 1 s before the click (resume.mjs)', [
	{ name: 'before, click', rows: re.filter(r => r.arm === 'before' && !r.human) },
	{ name: 'after, click', rows: re.filter(r => r.arm === 'after' && !r.human) },
	{ name: 'before, pointer first', rows: re.filter(r => r.arm === 'before' && r.human) },
	{ name: 'after, pointer first', rows: re.filter(r => r.arm === 'after' && r.human) },
], [['Enter -> first word painted, ms', r => r.firstWordMs], ['agent ready (from run start), ms', r => r.trace?.agentReadyMs], ['first text (from run start), ms', r => r.trace?.firstTextMs]]);

const a4 = rows('a4.jsonl');
const bare = rows('a4-bare.jsonl').filter(r => r.label === 'r5-bare');
table('A4 First Word (ADEMark sequence, Opus 5.5, replay)', [
	{ name: 'Volt before', rows: a4.filter(r => r.arm === 'before') },
	{ name: 'Volt after', rows: a4.filter(r => r.arm === 'after') },
	{ name: 'Bare CLI (pty)', rows: bare },
], [['total: DOM poll (round 3 runner), ms', r => r.pollMs], ['total: two frames after the DOM insert, ms', r => r.method === 'pty bytes' ? undefined : r.totalMs], ['total: Bare CLI, the TUI writes it, ms', r => r.method === 'pty bytes' ? r.totalMs : undefined], ['before the request, ms', r => r.beforeRequestMs], ['on screen (total - before), ms', r => r.method === 'pty bytes' ? r.onScreenMs : (typeof r.pollMs === 'number' && typeof r.beforeRequestMs === 'number' ? r.pollMs - r.beforeRequestMs : undefined)]]);

const direct = rows('resumebench.jsonl').filter(r => r.label === 'r5-direct');
const sdk = rows('sdkbench.jsonl').filter(r => r.label === 'r5-direct-sdk');
table('Direct path: the ACP adapter vs Claude Code through the Agent SDK with no adapter', [
	{ name: 'adapter, warm 5 s', rows: direct.filter(r => r.warmMs === 5000) },
	{ name: 'SDK, warm 5 s', rows: sdk.filter(r => r.warmMs === 5000) },
	{ name: 'adapter, prompt at once', rows: direct.filter(r => (r.warmMs ?? 0) === 0) },
	{ name: 'SDK, prompt at once', rows: sdk.filter(r => r.warmMs === 0) },
], [['start -> ready, ms', r => r.readyMs], ['prompt -> model request, ms', r => r.mainReqMs], ['prompt -> first text, ms', r => r.firstTextMs], ['start -> first text, ms', r => r.spawnToFirstTextMs]]);
