// Interleaved driver: for each rep, for each task, every arm once (arm order rotates per rep).
// Usage: node bench.mjs <fromRep> <toRep> [task,task] [arm,arm]
//        node bench.mjs --jobs arm:task:rep,arm:task:rep,...   (an explicit, already interleaved list)
import { execSync, spawnSync } from 'child_process';
import { appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
const ALL = ['cc', 'hermes', 'cursor-sonnet', 'cursor-grok', 'volt', 't3', 'volt-cursor-sonnet', 'volt-cursor-grok', 'volt-r3-base', 'volt-r3'];
// Round 3 A/B: the base build (82ae771c1d9, worktree volt-e3-orch-base) and the fixed build run side by
// side in their own test instances; each arm's runs go to its own instance.
const ARM_ENV = {
	'volt-r3-base': { VOLT_UD: '/tmp/v3-orch-base-ud', VOLT_EXT: '/tmp/v3-orch-base-ext', VOLT_CDP: '9981' },
	'volt-r3': { VOLT_UD: '/tmp/v3-orch-ud', VOLT_EXT: '/tmp/v3-orch-ext', VOLT_CDP: '9955' },
};
// The brief: no timing while the 1-minute load is above LOAD_MAX (14 cores). Wait up to LOAD_WAIT_MIN,
// then run anyway; every row carries the load at its start, so such a run is marked as under load.
const LOAD_MAX = Number(process.env.LOAD_MAX ?? 14);
const LOAD_WAIT_MIN = Number(process.env.LOAD_WAIT_MIN ?? 20);
const load1 = () => Number(execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim().split(/[\s,]+/)[0]);
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const PLAN = { t0: ALL, t1: ALL, t2: ALL, t3: ALL };
const jobs = [];
if (process.argv[2] === '--jobs') {
	for (const job of process.argv[3].split(',')) {
		const [arm, task, rep] = job.split(':');
		jobs.push({ arm, task, rep: Number(rep) });
	}
} else {
	const [from = 1, to = 3, tasksArg, armsArg] = process.argv.slice(2);
	const tasks = tasksArg ? tasksArg.split(',') : Object.keys(PLAN);
	const only = armsArg ? new Set(armsArg.split(',')) : undefined;
	for (let rep = Number(from); rep <= Number(to); rep++) {
		for (const task of tasks) {
			let arms = PLAN[task].filter(a => !only || only.has(a));
			const k = (rep - 1) % arms.length;
			arms = [...arms.slice(k), ...arms.slice(0, k)];
			jobs.push(...arms.map(arm => ({ arm, task, rep })));
		}
	}
}
const log = line => { console.log(line); appendFileSync('/tmp/v3orch/bench.log', line + '\n'); appendFileSync(join(process.env.HOME, '.volt-r3/orch/bench.log'), line + '\n'); };
for (const { arm, task, rep } of jobs) {
	const [cmd, args] = arm === 't3' ? ['node', [join(here, 'runt3.mjs'), task, String(rep)]]
		: arm.startsWith('volt') ? ['node', [join(here, 'runvolt.mjs'), 'run', arm, task, String(rep)]]
			: ['node', [join(here, 'runcli.mjs'), arm, task, String(rep)]];
	const waitFrom = Date.now();
	while (load1() > LOAD_MAX && Date.now() - waitFrom < LOAD_WAIT_MIN * 60_000) {
		sleepSync(20_000);
	}
	const t = Date.now();
	log(`${new Date().toISOString()} load ${load1()} after ${Math.round((t - waitFrom) / 1000)}s wait`);
	log(`${new Date().toISOString()} start ${arm} ${task} ${rep}`);
	const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 12 * 60_000, env: { ...process.env, ...ARM_ENV[arm] } });
	log(`${new Date().toISOString()} end ${arm} ${task} ${rep} ${Math.round((Date.now() - t) / 1000)}s status=${r.status} ${(r.stdout || '').trim().split('\n').at(-1)?.slice(0, 600)} ${r.status ? (r.stderr || '').slice(-600) : ''}`);
	if (r.status !== 0) {
		appendFileSync(join(here, '../../../data/orch/cmp/failures.jsonl'), JSON.stringify({ arm, task, rep, at: new Date(t).toISOString(), status: r.status, signal: r.signal, stderr: (r.stderr || '').slice(-2000) }) + '\n');
	}
}
log('bench done');
