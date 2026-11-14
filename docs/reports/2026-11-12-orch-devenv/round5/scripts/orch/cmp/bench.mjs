// Interleaved driver: for each rep, for each task, every arm once (arm order rotates per rep).
// Usage: node bench.mjs <fromRep> <toRep> [task,task] [arm,arm]
//        node bench.mjs --jobs arm:task:rep,arm:task:rep,...   (an explicit, already interleaved list)
// Round 5: each run is taken under the shared timing lock (~/.volt-r5/timing.lock, a directory made with
// mkdir), held at most 25 minutes at a time, and only at a 1-minute load of LOAD_MAX (14) or less.
import { execSync, spawnSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME;
const R5 = join(HOME, '.volt-r5/orch');
// Round 5 A/B: the round-4 merge (9bbb8818c60, worktree volt-e5-base, read-only) and e5/orch, side by side
// in their own dev test instances; each arm's runs go to its own instance.
const ARM_ENV = {
	'volt-r5-base': { VOLT_UD: join(R5, 'ud-base'), VOLT_EXT: join(R5, 'ext-base'), VOLT_CDP: '9978' },
	'volt-r5': { VOLT_UD: join(R5, 'ud'), VOLT_EXT: join(R5, 'ext'), VOLT_CDP: '9971' },
};
const ALL = ['cc', 'volt-r5-base', 'volt-r5'];
const LOAD_MAX = Number(process.env.LOAD_MAX ?? 14);
const LOAD_WAIT_MIN = Number(process.env.LOAD_WAIT_MIN ?? 240);
const LOCK = join(HOME, '.volt-r5/timing.lock');
const LOCK_MAX_MS = 25 * 60_000;
const JOB_MAX_MS = 4 * 60_000;
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
mkdirSync('/tmp/v5orch', { recursive: true });
const log = line => { console.log(line); appendFileSync('/tmp/v5orch/bench.log', line + '\n'); appendFileSync(join(R5, 'bench.log'), line + '\n'); };

let heldSince = 0;
function release() {
	if (heldSince) {
		rmSync(LOCK, { recursive: true, force: true });
		log(`${new Date().toISOString()} timing lock released after ${Math.round((Date.now() - heldSince) / 1000)}s`);
		heldSince = 0;
	}
}
function acquire() {
	for (; ;) {
		try {
			mkdirSync(LOCK);
			writeFileSync(join(LOCK, 'owner'), `orch pid ${process.pid} since ${new Date().toISOString()}\n`);
			heldSince = Date.now();
			log(`${new Date().toISOString()} timing lock taken`);
			return;
		} catch {
			try {
				const age = Date.now() - statSync(LOCK).mtimeMs;
				if (age > 40 * 60_000) {
					log(`${new Date().toISOString()} removing a stale timing lock (${Math.round(age / 60000)} min old)`);
					rmSync(LOCK, { recursive: true, force: true });
					continue;
				}
			} catch { }
			sleepSync(15_000);
		}
	}
}
for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => { release(); process.exit(1); });
}
process.on('exit', release);

for (const { arm, task, rep } of jobs) {
	const [cmd, args] = arm.startsWith('volt') ? ['node', [join(here, 'runvolt.mjs'), 'run', arm, task, String(rep)]]
		: ['node', [join(here, 'runcli.mjs'), arm, task, String(rep)]];
	if (heldSince && Date.now() - heldSince + JOB_MAX_MS > LOCK_MAX_MS) {
		release();
		sleepSync(90_000); // let others in
	}
	const waitFrom = Date.now();
	for (; ;) {
		while (load1() > LOAD_MAX && Date.now() - waitFrom < LOAD_WAIT_MIN * 60_000) {
			release();
			sleepSync(20_000);
		}
		if (!heldSince) {
			acquire();
		}
		if (load1() <= LOAD_MAX || Date.now() - waitFrom >= LOAD_WAIT_MIN * 60_000) {
			break;
		}
	}
	const t = Date.now();
	log(`${new Date().toISOString()} load ${load1()} after ${Math.round((t - waitFrom) / 1000)}s wait`);
	log(`${new Date().toISOString()} start ${arm} ${task} ${rep}`);
	const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 12 * 60_000, env: { ...process.env, ...ARM_ENV[arm] } });
	log(`${new Date().toISOString()} end ${arm} ${task} ${rep} ${Math.round((Date.now() - t) / 1000)}s status=${r.status} ${(r.stdout || '').trim().split('\n').at(-1)?.slice(0, 600)} ${r.status ? (r.stderr || '').slice(-600) : ''}`);
	if (r.status !== 0) {
		appendFileSync(join(here, '../../../data/orch/cmp/failures.jsonl'), JSON.stringify({ arm, task, rep, at: new Date(t).toISOString(), status: r.status, signal: r.signal, stderr: (r.stderr || '').slice(-2000) }) + '\n');
	}
	if (existsSync(join(R5, 'STOP'))) {
		log('STOP file found');
		break;
	}
}
release();
log('bench done');
