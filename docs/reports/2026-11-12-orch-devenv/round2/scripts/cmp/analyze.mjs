// Tables for the report from runs.jsonl: per task and arm, median [min-max] of wall time, time to
// first output, tokens and cost, plus tool calls, subagents and correctness.
//   node analyze.mjs [runs.jsonl] [--arms a,b] [--json]
// Rows listed in data/cmp/excluded.json (runs that failed for a reason outside every harness, e.g.
// the Claude subscription refusing sign-ins) are left out; their re-runs carry the same id.
// Cost columns: "reported" is what the harness itself says; "Haiku list" reprices every Claude Haiku 5.5
// arm from its tokens at one rate card (derived from Claude Code 2.1.322's own list-price report and
// Hermes' estimate, which agree): input $0.10/M, output $0.50/M, cache read $0.01/M, cache write $0.20/M.
// Tool calls: every tool call of the parent and its subagents where the harness exposes them (Claude
// Code's stream, Volt's traces, Hermes' state.db, T3's Claude transcripts); Cursor's stream shows
// the parent's calls only (its subagents' calls are not in --print output), marked with *.
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args[0] && !args[0].startsWith('--') ? args[0] : join(here, '../../data/cmp/runs.jsonl');
const DATA = dirname(file);
const armsOpt = args.includes('--arms') ? new Set(args[args.indexOf('--arms') + 1].split(',')) : undefined;
const excludedFile = join(DATA, 'excluded.json');
const excluded = new Set(existsSync(excludedFile) ? JSON.parse(readFileSync(excludedFile, 'utf8')).rows.map(r => `${r.id}@${r.at}`) : []);
const rows = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => !excluded.has(`${r.id}@${r.at.slice(0, 19)}`));
const HAIKU = { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.20 };
const haikuArm = arm => ['cc', 'hermes', 't3'].includes(arm) || arm === 'volt' || arm.startsWith('volt-after') || arm.startsWith('volt-final');
const listCost = u => u ? ((u.input ?? 0) * HAIKU.input + (u.output ?? 0) * HAIKU.output + (u.cacheRead ?? 0) * HAIKU.cacheRead + (u.cacheWrite ?? 0) * HAIKU.cacheWrite) / 1e6 : undefined;
const tokens = u => u ? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0;
export const med = xs => { const s = xs.filter(x => typeof x === 'number' && !isNaN(x)).sort((a, b) => a - b); if (!s.length) { return undefined; } const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const range = xs => { const s = xs.filter(x => typeof x === 'number' && !isNaN(x)); return s.length ? [Math.min(...s), Math.max(...s)] : undefined; };
const sec = ms => ms === undefined ? '–' : (ms / 1000).toFixed(1);
const fmt = (xs, f) => { const m = med(xs); const r = range(xs); return m === undefined ? '–' : `${f(m)} [${f(r[0])}–${f(r[1])}]`; };
export const ok = r => {
	if (r.timedOut || r.exit) { return 0; }
	const s = r.score ?? {};
	if (r.task === 't0') { return s.ok ? 1 : 0; }
	if (r.task === 't1') { return s.score / 4; }
	if (r.task === 't2') { return s.green && !s.stray?.length ? 1 : 0; }
	return s.plantedFixed && s.pass === s.total && !s.stray?.length ? 1 : 0;
};

function toolCalls(r) {
	if (r.arm.startsWith('volt')) {
		const raw = join(DATA, 'raw', `${r.id}.traces.json`);
		if (!existsSync(raw)) { return undefined; }
		const { traces } = JSON.parse(readFileSync(raw, 'utf8'));
		if (traces[0]?.chat !== r.chat) { return undefined; }
		return traces.reduce((n, t) => n + t.lines.filter(l => l.kind === 'event' && l.event.type === 'tool.start').length, 0);
	}
	if (r.arm === 'hermes') {
		return r.sessions ? r.sessions.reduce((n, s) => n + (s.tool_call_count ?? 0), 0) : r.toolCalls;
	}
	if (r.arm === 't3') {
		if (!r.transcript || !existsSync(r.transcript)) { return undefined; }
		const ids = new Set();
		const scan = f => {
			for (const line of readFileSync(f, 'utf8').split('\n')) {
				try {
					const x = JSON.parse(line);
					for (const part of x.type === 'assistant' ? x.message?.content ?? [] : []) {
						if (part.type === 'tool_use') { ids.add(part.id); }
					}
				} catch { }
			}
		};
		scan(r.transcript);
		const sub = r.transcript.replace(/\.jsonl$/, '/subagents');
		if (existsSync(sub)) {
			for (const f of readdirSync(sub).filter(n => n.endsWith('.jsonl'))) { scan(join(sub, f)); }
		}
		return ids.size;
	}
	return r.toolCalls;
}

export function summarize(rs) {
	return {
		n: rs.length,
		wall: rs.map(r => r.wallMs),
		ttft: rs.map(r => r.ttftMs ?? undefined),
		tokens: rs.map(r => tokens(r.usage)),
		cost: rs.map(r => r.costUsd ?? undefined),
		list: rs.map(r => listCost(r.usage)),
		tools: rs.map(toolCalls),
		subagents: rs.map(r => r.subagents ?? 0),
		score: rs.map(ok),
	};
}

const order = ['cc', 't3', 'hermes', 'volt', 'volt-after', 'volt-after-cold', 'volt-after2', 'volt-final', 'volt-final-fix', 'cursor-sonnet', 'volt-cursor-sonnet', 'volt-cursor-sonnet-after', 'cursor-grok', 'volt-cursor-grok', 'volt-cursor-grok-after'];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const out = [];
	const json = {};
	for (const task of ['t0', 't1', 't2', 't3']) {
		out.push(`\n### ${task}\n`);
		out.push('| Arm | n | Wall s | First output s | Tokens (all, k) | Cost reported $ | Cost at Haiku list $ | Tool calls | Subagents | Score |');
		out.push('|---|---|---|---|---|---|---|---|---|---|');
		for (const arm of [...order, ...new Set(rows.map(r => r.arm).filter(a => !order.includes(a)))]) {
			if (armsOpt && !armsOpt.has(arm)) { continue; }
			const rs = rows.filter(r => r.task === task && r.arm === arm);
			if (!rs.length) { continue; }
			const s = summarize(rs);
			json[`${arm} ${task}`] = s;
			const star = arm.startsWith('cursor') ? '*' : '';
			out.push(`| ${arm} | ${s.n} | ${fmt(s.wall, sec)} | ${fmt(s.ttft, sec)} | ${fmt(s.tokens, x => (x / 1000).toFixed(0))} | ${fmt(s.cost, x => x.toFixed(4))} | ${haikuArm(arm) ? fmt(s.list, x => x.toFixed(4)) : 'n/a'} | ${fmt(s.tools, x => String(Math.round(x)))}${star} | ${s.subagents.join(' / ')} | ${s.score.map(x => +x.toFixed(2)).join(' / ')} |`);
		}
	}
	console.log(args.includes('--json') ? JSON.stringify(json) : out.join('\n'));
}
