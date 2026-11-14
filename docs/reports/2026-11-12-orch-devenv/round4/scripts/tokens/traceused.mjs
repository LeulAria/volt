// Prompt size for providers the capture proxy does not see (Codex, Grok...): the first `usage` event's
// `used` (the context after the first model request, as the agent reports it over ACP) in each run's
// Volt trace. Labels with "base" read the base instance's traces, the others the after instance's.
//   node traceused.mjs <windows.jsonl> <label filter regex>
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const [winFile, filter] = process.argv.slice(2);
const UD = { base: process.env.BASE_UD ?? '/tmp/v3-tokens-ud-base', after: process.env.AFTER_UD ?? '/tmp/v3-tokens-ud' };
const windows = readFileSync(winFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(w => new RegExp(filter).test(w.label));
const groups = {};
console.log('| Label | Rep | Model | First `used` | Answer |\n|---|---|---|---|---|');
for (const w of windows) {
	const file = join(UD[/base/.test(w.label) ? 'base' : 'after'], 'User', 'voltTraces', `${w.chat}.jsonl`);
	const used = existsSync(file) ? readFileSync(file, 'utf8').split('\n').map(l => { try { return JSON.parse(l); } catch { return undefined; } })
		.find(l => l?.kind === 'event' && l.event?.type === 'usage' && l.event.used > 0)?.event.used : undefined;
	(groups[w.label] ??= []).push(used);
	console.log(`| ${w.label} | ${w.rep} | ${w.model.split(':').at(-1)} | ${used ?? 'n/a'} | ${(w.answer ?? '').replace(/\s+/g, ' ').slice(0, 50)} |`);
}
const med = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
console.log('\n| Arm | N | Median (range) |\n|---|---|---|');
for (const [g, xs] of Object.entries(groups)) {
	const ok = xs.filter(Number.isFinite);
	console.log(`| ${g} | ${ok.length} | ${(med(ok) / 1000).toFixed(1)}K${ok.length ? ` (${(Math.min(...ok) / 1000).toFixed(1)}K-${(Math.max(...ok) / 1000).toFixed(1)}K)` : ''} |`);
}
