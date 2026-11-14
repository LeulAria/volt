// Per run of bench.mjs: wall time (Enter to the answer), model requests, tokens and cost (all requests in the
// run's window, ADEMark prices), and the tool calls of the main thread (from its last request's history),
// with code_nav ops and grep-like calls counted.
//   node codebench.mjs <label regex> [--json]
import { existsSync, readFileSync } from 'fs';
const H = process.env.HOME + '/.volt-r5/codeintel/run';
const read = f => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
const prices = JSON.parse(readFileSync(process.env.HOME + '/.volt-r4/ademark/prices/2026-10.json', 'utf8')).models;
const captured = read(H + '/capture.jsonl').filter(r => typeof r.path === 'string' && /\/v1\/messages(\?|$)/.test(r.path) && r.usage);
const windows = read(H + '/windows.jsonl').filter(w => new RegExp(process.argv[2] ?? '.').test(w.label));
const body = n => { const f = `${H}/capture.jsonl.bodies/${n}.json`; return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
function price(row) {
	const p = prices[row.model]; if (!p) { return 0; }
	const u = row.usage; const w1h = u.cache_write_1h ?? 0;
	return (u.input * p.input + u.output * p.output + u.cache_read * p.cache_read + (u.cache_write - w1h) * p.cache_write_5m + w1h * p.cache_write_1h) / 1e6;
}
const out = [];
for (const w of windows) {
	const rows = captured.filter(r => r.t >= w.start && r.t <= w.end).sort((a, b) => a.n - b.n);
	const tok = { input: 0, cache_write: 0, cache_read: 0, output: 0 };
	let usd = 0;
	let main = [];
	for (const r of rows) {
		for (const k of Object.keys(tok)) { tok[k] += r.usage[k]; }
		usd += price(r);
		const b = body(r.n);
		const firstUser = (b?.messages ?? []).find(m => m.role === 'user');
		const text = JSON.stringify(firstUser?.content ?? '');
		if ((b?.tools?.length ?? 0) >= 5 && text.includes(w.prompt.slice(0, 60).replace(/"/g, '\\"'))) { main.push({ r, b }); }
	}
	const last = main.at(-1)?.b;
	const calls = [];
	for (const m of last?.messages ?? []) {
		if (m.role !== 'assistant' || !Array.isArray(m.content)) { continue; }
		for (const c of m.content) {
			if (c.type !== 'tool_use') { continue; }
			const name = c.name.replace(/^mcp__volt__/, 'volt:');
			calls.push(name === 'volt:code_nav' ? `code_nav:${c.input?.op}` : name === 'ToolSearch' ? 'ToolSearch' : name === 'Bash' ? `Bash:${String(c.input?.command ?? '').split(/\s+/)[0]}` : name);
		}
	}
	const grepLike = calls.filter(c => /^(Grep|Glob|volt:instant_grep|volt:find_symbol|volt:find_files|Bash:(rg|grep|git|find|ag))/.test(c)).length;
	const reads = calls.filter(c => c === 'Read').length;
	const newOps = calls.filter(c => /^code_nav:(impact|body|structural)$/.test(c)).length;
	const ide = calls.filter(c => /^(code_nav:|volt:diagnostics|volt:code_action)/.test(c)).length;
	out.push({ label: w.label, rep: w.rep, chat: w.chat, ended: w.ended, ms: w.answeredAt - w.sent, load: w.load.split(' ')[0], requests: main.length, total: tok.input + tok.cache_write + tok.cache_read + tok.output, fresh: tok.input + tok.cache_write, output: tok.output, usd: +usd.toFixed(4), toolCalls: calls.length, grepLike, reads, ide, newOps, calls, answer: w.answer });
}
if (process.argv.includes('--json')) { for (const o of out) { console.log(JSON.stringify(o)); } } else {
	for (const o of out) { console.log(`${o.label} r${o.rep} ${o.ended ? '' : 'NOT-ENDED '}${(o.ms / 1000).toFixed(1)}s load ${o.load} req ${o.requests} tok ${o.total} fresh ${o.fresh} out ${o.output} $${o.usd} tools ${o.toolCalls} (grep ${o.grepLike}, read ${o.reads}, ide ${o.ide}, new ${o.newOps}) ${o.calls.join(' ')}`); }
}
