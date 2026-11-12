// Prompt size per model request, parent vs subagents, per arm and task (median over all requests of
// all runs). Claude Code: per-message usage in the stream (parent_tool_use_id marks a subagent's);
// Volt: the context (`used`) its traces report per request; Hermes: each session's tokens / its API
// calls; T3: the Claude transcripts of the run (requests counted once per request id).
//   node reqsize.mjs [data dir]
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = process.argv[2] ?? join(here, '../../data/cmp');
const rows = readFileSync(join(DATA, 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const med = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : undefined; };
const k = x => x === undefined ? '–' : `${(x / 1000).toFixed(1)}k`;
const out = {};
const add = (arm, task, who, size) => { ((out[`${arm} ${task}`] ??= { parent: [], sub: [] })[who]).push(size); };
for (const r of rows) {
	const raw = join(DATA, 'raw', r.id);
	if (r.arm === 'cc' && existsSync(`${raw}.jsonl`)) {
		const seen = new Set();
		for (const line of readFileSync(`${raw}.jsonl`, 'utf8').trim().split('\n')) {
			const { m } = JSON.parse(line);
			const u = m.type === 'assistant' && m.message?.usage;
			if (!u || seen.has(m.message.id)) { continue; }
			seen.add(m.message.id);
			add(r.arm, r.task, m.parent_tool_use_id ? 'sub' : 'parent', (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
		}
	} else if (r.arm.startsWith('volt') && existsSync(`${raw}.traces.json`)) {
		const { traces } = JSON.parse(readFileSync(`${raw}.traces.json`, 'utf8'));
		traces.forEach((t, i) => {
			let last;
			for (const l of t.lines) {
				const used = l.event?.type === 'usage' ? l.event.used : undefined;
				if (used !== undefined && used !== last) { add(r.arm, r.task, i === 0 ? 'parent' : 'sub', used); }
				if (used !== undefined) { last = used; }
			}
		});
	} else if (r.arm === 'hermes' && r.sessions) {
		for (const s of r.sessions) {
			const calls = s.api_call_count || 1;
			add(r.arm, r.task, s.parent_session_id ? 'sub' : 'parent', ((s.input_tokens ?? 0) + (s.cache_read_tokens ?? 0) + (s.cache_write_tokens ?? 0)) / calls);
		}
	} else if (r.arm === 't3' && r.transcript && existsSync(r.transcript)) {
		const scan = (file, who) => {
			const seen = new Set();
			for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
				try {
					const x = JSON.parse(line);
					const u = x.type === 'assistant' && x.message?.usage;
					if (u && !seen.has(x.requestId)) { seen.add(x.requestId); add(r.arm, r.task, who, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)); }
				} catch { }
			}
		};
		scan(r.transcript, 'parent');
		const sub = r.transcript.replace(/\.jsonl$/, '/subagents');
		if (existsSync(sub)) { for (const f of readdirSync(sub).filter(f => f.endsWith('.jsonl'))) { scan(join(sub, f), 'sub'); } }
	}
}
console.log('| Arm, task | Parent prompt per request (median) | Subagent prompt per request (median) | Requests counted |');
console.log('|---|---|---|---|');
for (const [key, v] of Object.entries(out).sort()) {
	console.log(`| ${key} | ${k(med(v.parent))} | ${k(med(v.sub))} | ${v.parent.length} / ${v.sub.length} |`);
}
