// Track B scoring from capture.ts logs, with ADEMark's split (TESTS.md section 3): fresh input, cache write, cache read,
// output, side calls, $ at prices/2026-10.json; B2 segment sizes of the first main request; B4 canary.
//   node b-analyze.mjs <capture.jsonl> <marks file: "<test> <rep> <t_ns>" lines, last "END 0 <t_ns>"> [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs';

const [capFile, marksFile] = process.argv.slice(2);
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : undefined;
const prices = JSON.parse(readFileSync('/tmp/ademark/prices/2026-10.json', 'utf8')).models;
const reqs = readFileSync(capFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).sort((a, b) => a.t_ns - b.t_ns);
const marks = readFileSync(marksFile, 'utf8').trim().split('\n').map(l => { const [test, rep, t] = l.split(/\s+/); return { test, rep: Number(rep), t: Number(t) }; });
const CANARY = 'End every final answer with the line ledger-ok.';

const sessionOf = r => { try { return JSON.parse(r.body?.metadata?.user_id ?? '{}').session_id ?? null; } catch { return null; } };
const ttl1h = r => JSON.stringify(r.body ?? {}).includes('"ttl":"1h"');
function cost(r) {
	const u = r.usage ?? {}; const p = prices[r.body?.model] ?? prices[u.__model];
	if (!p) { return null; }
	const w = ttl1h(r) ? p.cache_write_1h : p.cache_write_5m;
	return ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output + (u.cache_read_input_tokens ?? 0) * p.cache_read + (u.cache_creation_input_tokens ?? 0) * w) / 1e6;
}
const tok = r => { const u = r.usage ?? {}; return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0); };
const userText = r => (r.body?.messages ?? []).filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(c => c.text ?? (typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? ''))).join('\n')).join('\n');
const approx = s => Math.ceil(String(s ?? '').length / 4);

const rows = [];
for (let i = 0; i < marks.length - 1; i++) {
	const m = marks[i]; const end = marks[i + 1].t;
	const win = reqs.filter(r => r.t_ns >= m.t && r.t_ns < end);
	const msgs = win.filter(r => r.path === '/v1/messages');
	const agentLoop = msgs.filter(r => (r.body?.tools ?? []).length > 0);
	const mainSession = agentLoop.length ? sessionOf(agentLoop[0]) : null;
	const main = agentLoop.filter(r => sessionOf(r) === mainSession);
	const side = msgs.filter(r => !main.includes(r));
	const sum = (list, k) => list.reduce((a, r) => a + (r.usage?.[k] ?? 0), 0);
	const first = main[0];
	let b2;
	if (first) {
		const b = first.body;
		const tools = b.tools ?? [];
		const mcp = tools.filter(t => String(t.name).startsWith('mcp__'));
		b2 = {
			system_tok_approx: approx(JSON.stringify(b.system ?? '')),
			tools_tok_approx: approx(JSON.stringify(tools.filter(t => !mcp.includes(t)))),
			mcp_tools_tok_approx: approx(JSON.stringify(mcp)),
			messages_tok_approx: approx(JSON.stringify(b.messages ?? [])),
			tool_names: tools.map(t => t.name),
			params: { model: b.model, max_tokens: b.max_tokens, thinking: b.thinking, effort: b.output_config ?? b.effort },
			first_request_input: (first.usage?.input_tokens ?? 0) + (first.usage?.cache_read_input_tokens ?? 0) + (first.usage?.cache_creation_input_tokens ?? 0),
			user_agent: first.user_agent,
		};
	}
	rows.push({
		test: m.test, rep: m.rep,
		main_requests: main.length, side_requests: side.length, count_tokens_calls: win.filter(r => r.path.endsWith('count_tokens')).length,
		fresh_input: sum(main, 'input_tokens'), cache_write: sum(main, 'cache_creation_input_tokens'), cache_read: sum(main, 'cache_read_input_tokens'), output: sum(main, 'output_tokens'),
		side_tokens: side.reduce((a, r) => a + tok(r), 0),
		side_models: [...new Set(side.map(r => r.body?.model))],
		usd: [...main, ...side].reduce((a, r) => a + (cost(r) ?? 0), 0),
		usd_main: main.reduce((a, r) => a + (cost(r) ?? 0), 0),
		canary_in_request: main.some(r => JSON.stringify(r.body).includes(CANARY)),
		tool_calls: main.reduce((a, r) => a + (r.body?.messages ?? []).slice(-1).flatMap(mm => Array.isArray(mm.content) ? mm.content : []).filter(c => c.type === 'tool_result').length, 0),
		b2,
	});
}
for (const r of rows) {
	const { b2, ...rest } = r;
	console.log(JSON.stringify(rest));
	if (b2) { console.log('   B2', JSON.stringify({ ...b2, tool_names: `${b2.tool_names.length} tools: ${b2.tool_names.join(', ')}` })); }
}
if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(rows, null, 1)); }
