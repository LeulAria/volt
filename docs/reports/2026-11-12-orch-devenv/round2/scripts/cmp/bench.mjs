// Interleaved driver: for each rep, for each task, every arm once (arm order rotates per rep).
// Usage: node bench.mjs <fromRep> <toRep> [task,task] [arm,arm]
import { spawnSync } from 'child_process';
import { appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
const [from = 1, to = 3, tasksArg, armsArg] = process.argv.slice(2);
const PLAN = {
	t0: ['cc', 'hermes', 'cursor-sonnet', 'cursor-grok', 'volt', 't3', 'volt-cursor-sonnet', 'volt-cursor-grok'],
	t1: ['cc', 'hermes', 'cursor-sonnet', 'cursor-grok', 'volt', 't3', 'volt-cursor-sonnet', 'volt-cursor-grok'],
	t2: ['cc', 'hermes', 'cursor-sonnet', 'cursor-grok', 'volt'],
	t3: ['cc', 'hermes', 'cursor-sonnet', 'cursor-grok', 'volt'],
};
const tasks = tasksArg ? tasksArg.split(',') : Object.keys(PLAN);
const only = armsArg ? new Set(armsArg.split(',')) : undefined;
const log = line => { console.log(line); appendFileSync('/tmp/vcmp/bench.log', line + '\n'); };
for (let rep = Number(from); rep <= Number(to); rep++) {
	for (const task of tasks) {
		let arms = PLAN[task].filter(a => !only || only.has(a));
		const k = (rep - 1) % arms.length;
		arms = [...arms.slice(k), ...arms.slice(0, k)];
		for (const arm of arms) {
			const [cmd, args] = arm === 't3' ? ['node', [join(here, 'runt3.mjs'), task, String(rep)]]
				: arm.startsWith('volt') ? ['node', [join(here, 'runvolt.mjs'), 'run', arm, task, String(rep)]]
					: ['node', [join(here, 'runcli.mjs'), arm, task, String(rep)]];
			const t = Date.now();
			log(`${new Date().toISOString()} start ${arm} ${task} ${rep}`);
			const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 12 * 60_000 });
			log(`${new Date().toISOString()} end ${arm} ${task} ${rep} ${Math.round((Date.now() - t) / 1000)}s status=${r.status} ${(r.stdout || '').trim().split('\n').at(-1)?.slice(0, 600)} ${r.status ? (r.stderr || '').slice(-600) : ''}`);
			if (r.status !== 0) {
				appendFileSync(join(here, '../../data/cmp/failures.jsonl'), JSON.stringify({ arm, task, rep, at: new Date(t).toISOString(), status: r.status, signal: r.signal, stderr: (r.stderr || '').slice(-2000) }) + '\n');
			}
		}
	}
}
log('bench done');
