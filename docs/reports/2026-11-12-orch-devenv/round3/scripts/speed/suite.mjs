// The whole Track A A/B, interleaved: per round, each arm (order alternates by round) is relaunched (A2,
// timed), then runs A3, A4, A5/A6 parked on a finished chat, A5/A6 parked on a new chat's landing page, and
// A8 (5 streams) last; the instance is stopped before the other arm starts. Before each arm the Mac must be
// quiet (1-minute load <= 14, the brief's limit); the wait is capped (GATE_MAX_S) and a run taken after the
// cap is marked `gate: "timed out"` in suite.jsonl (its rows carry the load they ran under).
//   node suite.mjs <rounds> before=<checkout> after=<checkout>
import { execFileSync } from 'child_process';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { cdp, DATA, load, newChat, sleep } from './lib.mjs';

const [roundsArg = '3', ...armArgs] = process.argv.slice(2);
const arms = armArgs.map(a => { const [name, checkout] = a.split('='); return { name, checkout }; });
const GATE = 14;
const GATE_MAX_S = Number(process.env.GATE_MAX_S ?? 900);
const here = new URL('.', import.meta.url).pathname;
const log = row => { appendFileSync(join(DATA, 'suite.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); console.log(JSON.stringify(row)); };

async function gate() {
	const t0 = Date.now();
	while (Number(load().split(/\s+/)[0]) > GATE) {
		if ((Date.now() - t0) / 1000 > GATE_MAX_S) {
			return { gate: 'timed out', waitedS: Math.round((Date.now() - t0) / 1000), load: load() };
		}
		await sleep(15_000);
	}
	return { gate: 'passed', waitedS: Math.round((Date.now() - t0) / 1000), load: load() };
}

function run(script, args, checkout, env = {}) {
	try {
		const out = execFileSync('node', [join(here, script), ...args], { env: { ...process.env, SPEED_CHECKOUT: checkout, ...env }, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 << 20 });
		return out.trim().split('\n').at(-1);
	} catch (err) {
		return `failed: ${String(err.message).slice(0, 300)}`;
	}
}

for (let r = 0; r < Number(roundsArg); r++) {
	const order = r % 2 ? [...arms].reverse() : arms;
	for (const arm of order) {
		const g = await gate();
		log({ round: r, arm: arm.name, step: 'gate', ...g });
		// A2: two relaunches; the second leaves the instance running for the rest.
		log({ round: r, arm: arm.name, step: 'a1', result: run('a1.mjs', [arm.name, '2'], arm.checkout) });
		await sleep(20_000);
		run('seed.mjs', ['1'], arm.checkout);
		log({ round: r, arm: arm.name, step: 'a3', result: run('a3.mjs', [arm.name, '6'], arm.checkout) });
		log({ round: r, arm: arm.name, step: 'a4', result: run('a4.mjs', [arm.name, '6'], arm.checkout) });
		log({ round: r, arm: arm.name, step: 'a5-chat', result: run('a5.mjs', [arm.name, '60', '60'], arm.checkout, { SPEED_VARIANT: 'chat' }) });
		const c = await cdp();
		await newChat(c);
		c.close();
		log({ round: r, arm: arm.name, step: 'a5-landing', result: run('a5.mjs', [arm.name, '60', '60'], arm.checkout, { SPEED_VARIANT: 'landing' }) });
		log({ round: r, arm: arm.name, step: 'a8', result: run('a8.mjs', [arm.name, '--sample'], arm.checkout) });
		run('launch.mjs', ['stop'], arm.checkout);
	}
}
log({ step: 'done' });
