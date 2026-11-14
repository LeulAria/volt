// ADEMark Track B split (TESTS.md §3) of a proxy.mjs capture by run windows (runtok.mjs windows.jsonl or
// a bare-CLI windows file): every /v1/messages completion in [start, end] of a window, split into the
// main thread (the request whose first user message ends with the prompt, and its continuations) and side
// calls (titles, predictions, subagents, anything else), each priced with its own model from ADEMark's
// price file. count_tokens and other endpoints spend nothing and are left out, as ADEMark does.
//   node analyze.mjs <capture.jsonl> <windows.jsonl> [label filter regex] [--rows]
import { existsSync, readFileSync } from 'fs';

const [capFile, winFile, filter] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const showRows = process.argv.includes('--rows');
const prices = JSON.parse(readFileSync(process.env.ADEMARK_PRICES ?? '/tmp/ademark/prices/2026-10.json', 'utf8')).models;
const read = f => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const captured = read(capFile).filter(r => typeof r.path === 'string' && /\/v1\/messages(\?|$)/.test(r.path) && r.usage);
const windows = read(winFile).filter(w => !w.invalid && (!filter || new RegExp(filter).test(w.label)));

function body(n) {
	const f = `${capFile}.bodies/${n}.json`;
	return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}
// The request's task, as ADEMark's threadShape takes it: the last user message that is not a tool answer.
// A fork (Claude Code's next-prompt suggestion, a subagent) has a task of its own even with the prompt in
// its history, so it is a side call.
const lastUserTask = b => {
	const users = (b?.messages ?? []).filter(m => m.role === 'user');
	const hasToolResult = m => Array.isArray(m.content) && m.content.some(x => x.type === 'tool_result');
	const task = [...users].reverse().find(m => !hasToolResult(m));
	if (!task) { return ''; }
	const blocks = typeof task.content === 'string' ? [{ type: 'text', text: task.content }] : task.content;
	return blocks.filter(x => x.type === 'text' && !x.text.startsWith('<system-reminder>')).map(x => x.text).join('\n').trim();
};

function price(row) {
	const p = prices[row.model];
	if (!p) { return null; }
	const u = row.usage;
	const prompt = u.input + u.cache_write + u.cache_read;
	const rate = p.long_context && prompt > p.long_context.above ? p.long_context : p;
	const w1h = u.cache_write_1h ?? 0;
	return (u.input * rate.input + u.output * rate.output + u.cache_read * rate.cache_read + (u.cache_write - w1h) * rate.cache_write_5m + w1h * rate.cache_write_1h) / 1e6;
}

const results = [];
for (const w of windows) {
	const rows = captured.filter(r => r.t >= w.start && r.t <= w.end);
	const prompt = w.prompt.trim();
	const comp = { main: { input: 0, cache_write: 0, cache_read: 0, output: 0, calls: 0 }, side: { input: 0, cache_write: 0, cache_read: 0, output: 0, calls: 0 } };
	let usd = 0;
	let first = null;
	const sideKinds = {};
	for (const r of rows.sort((a, b) => a.n - b.n)) {
		const b = body(r.n);
		const task = lastUserTask(b);
		const isMain = (b?.tools?.length ?? 0) >= 5 && task.endsWith(prompt) && !task.includes('<session>');
		const into = isMain ? comp.main : comp.side;
		for (const k of ['input', 'cache_write', 'cache_read', 'output']) { into[k] += r.usage[k]; }
		into.calls++;
		usd += price(r) ?? NaN;
		if (isMain && !first) { first = r.n; }
		if (!isMain) {
			const sys = Array.isArray(b?.system) ? b.system.slice(1).map(x => x.text).join(' ') : String(b?.system ?? '');
			const kind = /\[SUGGESTION MODE/.test(task) ? 'cc-prompt-suggestion' : /naming a coding session/.test(sys) ? 'cc-session-title' : /short titles for coding chats/.test(sys) ? 'volt-title' : /predictor/.test(sys) ? 'volt-predictor' : (b?.tools?.length ?? 0) >= 5 ? 'subagent/fork' : 'other';
			sideKinds[kind] = (sideKinds[kind] ?? 0) + r.usage.input + r.usage.cache_write + r.usage.cache_read + r.usage.output;
		}
		if (showRows) { console.error(w.label, w.rep, r.n, isMain ? 'MAIN' : 'side', r.model, JSON.stringify(r.usage), b?.tools?.length ?? 0); }
	}
	const sideTokens = comp.side.input + comp.side.cache_write + comp.side.cache_read + comp.side.output;
	const mainTokens = comp.main.input + comp.main.cache_write + comp.main.cache_read + comp.main.output;
	results.push({
		label: w.label, rep: w.rep, model: w.model, load: w.load,
		fresh: comp.main.input, cacheWrite: comp.main.cache_write, cacheRead: comp.main.cache_read, output: comp.main.output,
		mainCalls: comp.main.calls, sideTokens, sideCalls: comp.side.calls, sideKinds, total: mainTokens + sideTokens, usd,
		firstMain: first, tools: w.tools?.length ?? null, canary: /ledger-ok\s*$/.test(w.answer ?? ''), answerTail: (w.answer ?? '').slice(-60),
	});
}
const med = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const k = x => `${(x / 1000).toFixed(1)}K`;
console.log('| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
	console.log(`| ${r.label} | ${r.rep} | ${r.model.split(':').at(-1)} | ${r.fresh} | ${r.cacheWrite} | ${r.cacheRead} | ${r.output} | ${r.mainCalls} | ${r.sideTokens} (${r.sideCalls}) | ${k(r.total)} | ${r.usd.toFixed(4)} | ${r.canary ? 'yes' : 'no'} | ${Object.entries(r.sideKinds).map(([a, b]) => `${a} ${b}`).join(', ')} |`);
}
const groups = {};
for (const r of results) { (groups[`${r.label} ${r.model.split(':').at(-1)}`] ??= []).push(r); }
console.log('\n| Arm | N | Median total (range) | Median main | Median side | Median $ |\n|---|---|---|---|---|---|');
for (const [g, rs] of Object.entries(groups)) {
	const tot = rs.map(r => r.total);
	console.log(`| ${g} | ${rs.length} | ${k(med(tot))} (${k(Math.min(...tot))}-${k(Math.max(...tot))}) | ${k(med(rs.map(r => r.total - r.sideTokens)))} | ${k(med(rs.map(r => r.sideTokens)))} | ${med(rs.map(r => r.usd)).toFixed(4)} |`);
}
if (process.argv.includes('--json')) { console.log(JSON.stringify(results)); }
