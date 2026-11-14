// Size of the first main-thread model request of each run window (input + cache write + cache read): what
// the agent is handed before it does anything. Same capture and windows as analyze.mjs; with
// TOK_FIRST_ONLY=1 runtok.mjs stops the turn right after it, so long tasks cost one request.
//   node firstreq.mjs <capture.jsonl> <windows.jsonl> [label filter regex]
import { existsSync, readFileSync } from 'fs';

const [capFile, winFile, filter] = process.argv.slice(2);
const read = f => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const captured = read(capFile).filter(r => typeof r.path === 'string' && /\/v1\/messages(\?|$)/.test(r.path) && r.usage);
const windows = read(winFile).filter(w => !w.invalid && (!filter || new RegExp(filter).test(w.label)));
const body = n => { const f = `${capFile}.bodies/${n}.json`; if (!existsSync(f)) { return null; } const b = JSON.parse(readFileSync(f, 'utf8')); return b.body ?? b; };
const userText = b => {
	const users = (b?.messages ?? []).filter(m => m.role === 'user');
	const task = users.find(m => !(Array.isArray(m.content) && m.content.some(x => x.type === 'tool_result')));
	if (!task) { return ''; }
	const blocks = typeof task.content === 'string' ? [{ type: 'text', text: task.content }] : task.content;
	return blocks.filter(x => x.type === 'text' && !x.text.startsWith('<system-reminder>')).map(x => x.text).join('\n').trim();
};
const rows = [];
for (const w of windows) {
	const prompt = w.prompt.trim();
	const first = captured.filter(r => r.t >= w.start && r.t <= w.end).sort((a, b) => a.n - b.n).find(r => {
		const b = body(r.n);
		return (b?.tools?.length ?? 0) >= 5 && userText(b).endsWith(prompt);
	});
	const b = first && body(first.n);
	const tools = b?.tools ?? [];
	rows.push({
		label: w.label, rep: w.rep, model: w.model.split(':').at(-1), n: first?.n,
		prompt: first ? first.usage.input + first.usage.cache_write + first.usage.cache_read : NaN,
		tools: tools.length, mcpTools: tools.filter(t => /^mcp__/.test(t.name ?? '')).length, deferred: tools.filter(t => t.defer_loading).length,
	});
}
const med = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const k = x => Number.isFinite(x) ? `${(x / 1000).toFixed(1)}K` : 'n/a';
console.log('| Label | Rep | Model | Request | First request | Tools sent |\n|---|---|---|---|---|---|');
for (const r of rows) { console.log(`| ${r.label} | ${r.rep} | ${r.model} | ${r.n ?? '-'} | ${k(r.prompt)} | ${r.tools} |`); }
const groups = {};
for (const r of rows) { (groups[r.label] ??= []).push(r.prompt); }
console.log('\n| Arm | N | Median first request (range) |\n|---|---|---|');
for (const [g, xs] of Object.entries(groups)) {
	const ok = xs.filter(Number.isFinite);
	console.log(`| ${g} | ${ok.length} | ${k(med(ok))}${ok.length ? ` (${k(Math.min(...ok))}-${k(Math.max(...ok))})` : ''} |`);
}
