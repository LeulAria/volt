// Headline table for 31-orchestration.md: per task and arm, timed runs only (1-minute load <= 14 at the run's start).
//   node headline.mjs <runs.jsonl> [arm=Label,arm=Label]     (default: cc, volt-r4-base, volt-r4)
import { readFileSync } from 'fs';
const file = process.argv[2];
const load1 = r => Number(String(r.load).split(' ')[0]);
const all = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const rows = all.filter(r => load1(r) <= 14);
const ARMS = process.argv[3] ? process.argv[3].split(',').map(a => a.split('=')) : [['cc', 'Claude Code'], ['volt-r4-base', 'Volt before'], ['volt-r4', 'Volt after']];
const med = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const tok = u => (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
const list = u => ((u.input ?? 0) * 0.10 + (u.output ?? 0) * 0.50 + (u.cacheRead ?? 0) * 0.01 + (u.cacheWrite ?? 0) * 0.20) / 1e6;
const ok = r => { const s = r.score ?? {}; return r.task === 't0' ? s.ok === true : r.task === 't1' ? s.q1 === 1 && s.q2 === 1 && s.q3 === 1 : r.task === 't2' ? s.green === true && !s.stray?.length : s.pass === s.total && s.plantedFixed && !s.stray?.length; };
const NAMES = { t0: 't0 "Reply OK"', t1: 't1 3 research subagents + synthesis', t2: 't2 3 parallel bug fixes + npm test', t3: 't3 writer + reviewer' };
const out = ['| Task | Measure | ' + ARMS.map(a => a[1]).join(' | ') + ' |', '|---|---|' + ARMS.map(() => '---|').join('')];
for (const t of ['t0', 't1', 't2', 't3']) {
	const cells = ARMS.map(([a]) => rows.filter(r => r.arm === a && r.task === t));
	if (cells.every(rs => !rs.length)) { continue; }
	const f = (fn, d = 1) => cells.map(rs => { if (!rs.length) { return '–'; } const v = rs.map(fn); return `${med(v).toFixed(d)} [${Math.min(...v).toFixed(d)}–${Math.max(...v).toFixed(d)}]`; });
	out.push(`| ${NAMES[t]} | wall s | ${f(r => r.wallMs / 1000).join(' | ')} |`);
	out.push(`| | n timed (+ under load, left out) | ${ARMS.map(([a], i) => `${cells[i].length} (+${all.filter(r => r.arm === a && r.task === t && load1(r) > 14).length})`).join(' | ')} |`);
	out.push(`| | load at start | ${f(load1).join(' | ')} |`);
	out.push(`| | first output s | ${f(r => r.ttftMs / 1000).join(' | ')} |`);
	out.push(`| | tokens k | ${f(r => tok(r.usage) / 1000, 0).join(' | ')} |`);
	out.push(`| | cost at Haiku list $ | ${cells.map(rs => rs.length ? med(rs.map(r => list(r.usage))).toFixed(4) : '–').join(' | ')} |`);
	out.push(`| | correct | ${cells.map(rs => `${rs.filter(ok).length}/${rs.length}`).join(' | ')} |`);
}
console.log(out.join('\n'));
