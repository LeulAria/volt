// Paired A/B: both builds run at once, each with its own profile and CDP port, and every test alternates
// between them run by run (the order flips each time), so a load burst from the other agents on this Mac falls
// on both arms alike. A5/A6 sample both trees over the same 60 s. The measured window is brought to the front
// first (Page.bringToFront). Before each pair of runs the suite waits for a 1-minute load of 14 or less, at most
// GATE_MAX_S (default 1800 s); a step whose wait times out is skipped, not run (`pair.jsonl` records each wait).
//   node pair.mjs <rounds> before=<checkout>,<profile>,<port> after=<checkout>,<profile>,<port>
// Per round: A2 x1 per arm, A3 x3, A4 x3, A5/A6 on a chat and on a new chat's page, A8 x1 (each A8 arm is
// restarted afterwards so its five streams stop). A8 runs with the other arm stopped, so neither arm's typing
// shares the Mac with the other window (the "before" build's chat background animates at rest).
// Never run two rigs on the same profile or port at once: their launch/stop steps kill each other's instance.
import { execFileSync, spawn } from 'child_process';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { DATA, load, sleep } from './lib.mjs';

const [roundsArg = '3', ...armArgs] = process.argv.slice(2);
const arms = armArgs.map(a => {
	const [name, rest] = a.split('=');
	const [checkout, ud, port] = rest.split(',');
	return { name, env: { SPEED_CHECKOUT: checkout, SPEED_UD: ud, SPEED_CDP: port } };
});
const GATE_MAX_S = Number(process.env.GATE_MAX_S ?? 1800);
const here = new URL('.', import.meta.url).pathname;
const log = row => { appendFileSync(join(DATA, 'pair.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); console.log(JSON.stringify(row)); };

async function gate(step) {
	const t0 = Date.now();
	let timedOut = false;
	while (Number(load().split(/\s+/)[0]) > 14) {
		if ((Date.now() - t0) / 1000 > GATE_MAX_S) {
			timedOut = true;
			break;
		}
		await sleep(10_000);
	}
	log({ step, gate: timedOut ? 'timed out, skipped' : 'passed', waitedS: Math.round((Date.now() - t0) / 1000), load: load() });
	return !timedOut;
}

function run(script, args, arm, extraEnv = {}) {
	try {
		return execFileSync('node', [join(here, script), ...args], { env: { ...process.env, ...arm.env, ...extraEnv }, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 << 20 }).trim().split('\n').at(-1);
	} catch (err) {
		return `failed: ${String(err.stdout ?? err.message).slice(-300)}`;
	}
}

function runAsync(script, args, arm, extraEnv = {}) {
	return new Promise(resolve => {
		const child = spawn('node', [join(here, script), ...args], { env: { ...process.env, ...arm.env, ...extraEnv } });
		let out = '';
		child.stdout.on('data', d => out += d);
		child.stderr.on('data', d => out += d);
		child.on('exit', () => resolve(out.trim().split('\n')[0]));
	});
}

async function front(arm) {
	run('front.mjs', [], arm);
}

const orderFor = i => (i % 2 ? [...arms].reverse() : arms);
let flip = 0;
for (const arm of arms) {
	run('launch.mjs', [], arm);
}
await sleep(20_000);
for (let r = 0; r < Number(roundsArg); r++) {
	if (await gate(`round ${r} A2`)) {
		for (const arm of orderFor(flip++)) {
			log({ round: r, arm: arm.name, step: 'a1', result: run('a1.mjs', [arm.name, '1'], arm) });
		}
		await sleep(15_000);
	}
	for (const arm of arms) {
		await front(arm);
		run('seed.mjs', ['1'], arm);
	}
	for (let i = 0; i < 3; i++) {
		if (!await gate(`round ${r} A3 ${i}`)) {
			continue;
		}
		for (const arm of orderFor(flip++)) {
			await front(arm);
			log({ round: r, arm: arm.name, step: 'a3', result: run('a3.mjs', [arm.name, '1'], arm) });
		}
	}
	for (let i = 0; i < 3; i++) {
		if (!await gate(`round ${r} A4 ${i}`)) {
			continue;
		}
		for (const arm of orderFor(flip++)) {
			await front(arm);
			log({ round: r, arm: arm.name, step: 'a4', result: run('a4.mjs', [arm.name, '1'], arm) });
		}
	}
	if (await gate(`round ${r} A5 chat`)) {
		for (const [arm, result] of await Promise.all(arms.map(async arm => [arm, await runAsync('a5.mjs', [arm.name, '60', '60'], arm, { SPEED_VARIANT: 'chat' })]))) {
			log({ round: r, arm: arm.name, step: 'a5-chat', result });
		}
	}
	for (const arm of arms) {
		run('newchat.mjs', [], arm);
	}
	if (await gate(`round ${r} A5 landing`)) {
		for (const [arm, result] of await Promise.all(arms.map(async arm => [arm, await runAsync('a5.mjs', [arm.name, '60', '60'], arm, { SPEED_VARIANT: 'landing' })]))) {
			log({ round: r, arm: arm.name, step: 'a5-landing', result });
		}
	}
	// A8 alone: the other arm is stopped, and each arm is stopped afterwards so its five streams end.
	for (const arm of arms) {
		run('launch.mjs', ['stop'], arm);
	}
	for (const arm of orderFor(flip++)) {
		run('launch.mjs', [], arm);
		await sleep(20_000);
		if (await gate(`round ${r} A8 ${arm.name}`)) {
			await front(arm);
			log({ round: r, arm: arm.name, step: 'a8', result: run('a8.mjs', [arm.name, '--sample'], arm) });
		}
		run('launch.mjs', ['stop'], arm);
	}
	for (const arm of arms) {
		run('launch.mjs', [], arm);
	}
	await sleep(20_000);
	// A round has an even number of flips: one more, so A2 (and every step) leads with the other arm next round.
	flip++;
}
for (const arm of arms) {
	run('launch.mjs', ['stop'], arm);
}
log({ step: 'done' });
