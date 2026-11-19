// Every run, one row: load at its start, wall time, tokens, cost and the grade of its answer.
//   node grades.mjs <data dir> [arm,arm]
// Correct: t0 the reply is OK; t1 Q1-Q3 right (q1 discount bug, q2 the three import edges, q3 A1/C3 and
// true/false; score.mjs scoreT1). Q4 is shown apart: it asks for checkout's result "using only the answers
// to Q1-Q3 (no file reads)", which those answers cannot settle, so nearly every answer hedges and the
// score only says whether the hedge names -9720 (1), -9000 (0.5) or neither (0); t2 `npm test` 7/7 with
// only the three source files changed; t3 the checker's 7/7 with the planted bug fixed and no stray file.
// "Timed" is the brief's gate: 1-minute load at the start at most 14.
import { readFileSync } from 'fs';
import { join } from 'path';

const [dir, armsArg] = process.argv.slice(2);
const arms = armsArg ? new Set(armsArg.split(',')) : undefined;
const rows = readFileSync(join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
	.filter(r => !arms || arms.has(r.arm));
const tok = u => u ? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : undefined;
function grade(r) {
	const s = r.score ?? {};
	switch (r.task) {
		case 't0': return [s.ok === true, s.ok ? 'OK' : `reply: ${String(r.finalText).slice(0, 40)}`];
		case 't1': return [s.q1 === 1 && s.q2 === 1 && s.q3 === 1, `q1 ${s.q1} · q2 ${s.q2} · q3 ${s.q3} · (q4 ${s.q4})`];
		case 't2': return [s.green === true && !s.stray?.length, `${s.pass}/${s.pass + s.fail} tests${s.stray?.length ? `, stray ${s.stray.join(' ')}` : ''}`];
		case 't3': return [s.pass === s.total && s.plantedFixed && !s.stray?.length, `${s.pass}/${s.total}, planted bug ${s.plantedFixed ? 'fixed' : 'not fixed'}${s.stray?.length ? `, stray ${s.stray.join(' ')}` : ''}`];
	}
	return [false, '?'];
}
console.log('| Run | Load (1 min) | Timed | Wall s | Tokens k | Cost $ | Subagents | Correct | Grade detail |');
console.log('|---|---|---|---|---|---|---|---|---|');
const order = ['t0', 't1', 't2', 't3'];
rows.sort((a, b) => order.indexOf(a.task) - order.indexOf(b.task) || a.arm.localeCompare(b.arm) || a.rep - b.rep);
const tally = new Map();
for (const r of rows) {
	const load = Number(String(r.load).split(' ')[0]);
	const [ok, detail] = grade(r);
	const key = `${r.arm} ${r.task}`;
	const t = tally.get(key) ?? [0, 0];
	t[0] += ok ? 1 : 0;
	t[1]++;
	tally.set(key, t);
	console.log(`| ${r.id} | ${load.toFixed(1)} | ${load <= 14 ? 'yes' : 'no'} | ${(r.wallMs / 1000).toFixed(1)} | ${Math.round(tok(r.usage) / 1000)} | ${r.costUsd?.toFixed(4) ?? '–'} | ${r.subagents ?? 0} | ${ok ? 'correct' : 'incorrect'} | ${detail} |`);
}
console.log('\n| Arm, task | Correct / runs |\n|---|---|');
for (const [k, [ok, n]] of tally) {
	console.log(`| ${k} | ${ok} / ${n} |`);
}
