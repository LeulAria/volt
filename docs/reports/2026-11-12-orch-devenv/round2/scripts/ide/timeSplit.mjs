// Where a Volt run's time goes: node timeSplit.mjs <arm2 dir> [tag]
// Per run: Volt's lead before the prompt (promptMs), time inside Volt tools, inside other tools
// (both as the union of their intervals, parallel calls counted once), and the rest (model time).
import fs from 'node:fs';
const [dir, tag = ''] = process.argv.slice(2);
const median = v => { const s = [...v].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const union = spans => { const s = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]); let total = 0, end = -Infinity; for (const [a, b] of s) { if (a > end) { total += b - a; end = b; } else if (b > end) { total += b - end; end = b; } } return total; };
const rows = [];
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.trace.jsonl') && f.includes(tag))) {
	const L = fs.readFileSync(`${dir}/${f}`, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	const m = L.find(x => x.kind === 'metrics')?.metrics; if (!m) continue;
	const start = new Map(); const volt = []; const other = []; const slowVolt = [];
	for (const x of L) {
		const e = x.event; if (!e) continue;
		if (e.type === 'tool.start') start.set(e.callId, [x.ts, e.name || '']);
		if (e.type === 'tool.end' && start.has(e.callId)) { const [t0, name] = start.get(e.callId); (/^mcp__volt__/.test(name) ? volt : other).push([t0, x.ts]); if (/^mcp__volt__/.test(name)) slowVolt.push(x.ts - t0); }
	}
	rows.push({ run: f.replace('.trace.jsonl', ''), totalS: m.totalMs / 1000, promptS: m.promptMs / 1000, voltToolS: union(volt) / 1000, otherToolS: union(other) / 1000, modelS: (m.totalMs - union([...volt, ...other])) / 1000, voltCalls: volt.length, voltMedianS: volt.length ? median(slowVolt) / 1000 : 0, voltMaxS: volt.length ? Math.max(...slowVolt) / 1000 : 0 });
}
const sum = k => rows.reduce((a, r) => a + r[k], 0);
for (const r of rows.sort((a, b) => a.run.localeCompare(b.run))) console.log(JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 10) / 10 : v]))));
console.log(JSON.stringify({ runs: rows.length, totalS: Math.round(sum('totalS')), promptS: Math.round(sum('promptS')), voltToolS: Math.round(sum('voltToolS')), otherToolS: Math.round(sum('otherToolS')), modelS: Math.round(sum('modelS')), voltCalls: sum('voltCalls'), voltCallMedianOfMediansS: Math.round(median(rows.filter(r => r.voltCalls).map(r => r.voltMedianS)) * 10) / 10, voltMaxS: Math.max(...rows.map(r => r.voltMaxS)) }));
