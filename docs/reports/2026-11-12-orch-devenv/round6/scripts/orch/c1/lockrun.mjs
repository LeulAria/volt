// Runs one command under the shared timing lock (~/.volt-r6/timing.lock) at a 1-minute load of 14 or less.
// Waits (without the lock) while the load is above 14, takes the lock, checks the load again, runs, releases.
// A C1 run (up to ~15 min with its 5 quiet minutes) fits the 25-minute hold.
//   node lockrun.mjs <cmd> [args...]
import { execSync, spawnSync } from 'child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
const LOCK = join(process.env.HOME, '.volt-r6/timing.lock');
const LOG = join(process.env.HOME, '.volt-r6/orch/c1/lockrun.log');
const LOAD_MAX = Number(process.env.LOAD_MAX ?? 14);
const load1 = () => Number(execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim().split(/[\s,]+/)[0]);
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const log = line => { console.log(line); appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); };
// The C1 rig's clean config dir holds the live login's access token only: copy it fresh once the lock is held (a wait
// for the lock can outlast the token) and run only with 20 minutes or more left on it.
const CFG = join(process.env.HOME, '.volt-r6/orch/c1/cfg-clean');
const tokenOk = () => {
	try {
		execSync(`CLEAN=1 sh ${JSON.stringify(join(import.meta.dirname, 'mkcfg.sh'))} ${JSON.stringify(CFG)}`);
		const left = (JSON.parse(readFileSync(join(CFG, '.credentials.json'), 'utf8')).claudeAiOauth.expiresAt - Date.now()) / 60_000;
		if (left < 20) { log(`access token has ${left.toFixed(0)} min left: waiting`); }
		return left >= 20;
	} catch (err) { log(`token check failed: ${err}`); return false; }
};
let held = false;
const release = () => { if (held) { rmSync(LOCK, { recursive: true, force: true }); held = false; log('lock released'); } };
process.on('exit', release);
for (const sig of ['SIGINT', 'SIGTERM']) { process.on(sig, () => { release(); process.exit(1); }); }
for (; ;) {
	while (load1() > LOAD_MAX) { sleepSync(20_000); }
	try {
		mkdirSync(LOCK);
		writeFileSync(join(LOCK, 'owner'), `orch c1 pid ${process.pid} since ${new Date().toISOString()}\n`);
		held = true;
	} catch {
		try {
			if (Date.now() - statSync(LOCK).mtimeMs > 40 * 60_000) { log('removing a stale timing lock'); rmSync(LOCK, { recursive: true, force: true }); }
		} catch { }
		sleepSync(15_000);
		continue;
	}
	if (load1() <= LOAD_MAX && tokenOk()) { break; }
	release();
	sleepSync(30_000);
}
log(`lock taken at load ${load1()}: ${process.argv.slice(2).join(' ')}`);
const r = spawnSync(process.argv[2], process.argv.slice(3), { stdio: 'inherit' });
log(`done status=${r.status}`);
release();
process.exit(r.status ?? 1);
