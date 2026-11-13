// Interleaved A/B of a8work.mjs: per run, one arm alone (the other stopped), launched fresh, 20 s settle, the
// load gate (1-minute load <= 14, at most GATE_MAX_S, else the run is skipped), a8work, stop. The arm that goes
// first alternates by run.
//   node a8work-ab.mjs <runs> before=<checkout>,<profile>,<port> after=<checkout>,<profile>,<port>
import { execFileSync } from 'child_process';
import { join } from 'path';
import { load, sleep } from './lib.mjs';

const [runsArg = '3', ...armArgs] = process.argv.slice(2);
const arms = armArgs.map(a => {
	const [name, rest] = a.split('=');
	const [checkout, ud, port] = rest.split(',');
	return { name, env: { SPEED_CHECKOUT: checkout, SPEED_UD: ud, SPEED_CDP: port } };
});
const GATE_MAX_S = Number(process.env.GATE_MAX_S ?? 1800);
const here = new URL('.', import.meta.url).pathname;
const run = (script, args, arm) => {
	try {
		return execFileSync('node', [join(here, script), ...args], { env: { ...process.env, ...arm.env }, encoding: 'utf8', timeout: 600_000 }).trim().split('\n').at(-1);
	} catch (err) {
		return `failed: ${String(err.stdout ?? err.message).slice(-300)}`;
	}
};
async function gate() {
	const t0 = Date.now();
	while (Number(load().split(/\s+/)[0]) > 14) {
		if ((Date.now() - t0) / 1000 > GATE_MAX_S) {
			return false;
		}
		await sleep(10_000);
	}
	return true;
}
for (const arm of arms) {
	run('launch.mjs', ['stop'], arm);
}
for (let i = 0; i < Number(runsArg); i++) {
	for (const arm of i % 2 ? [...arms].reverse() : arms) {
		run('launch.mjs', [], arm);
		await sleep(20_000);
		console.log(await gate() ? run('a8work.mjs', [arm.name], arm) : JSON.stringify({ arm: arm.name, skipped: 'load', load: load() }));
		run('launch.mjs', ['stop'], arm);
	}
}
