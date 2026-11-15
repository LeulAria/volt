// A5 Weigh-in + A6 Idle Burn (ADEMark method, unofficial) on built or dev arms, interleaved (ABBA): each rep seeds
// the arm's profile once (5 new chats answered `replay:seed` by ADEMark's replay server), quits, relaunches it with
// the composer focused (ADEMark's "ready" state), then a6.mjs samples front (settle 90 s, 60 s) and covered (60 s).
// A5 is the `app` group's median RAM over the front sample (appMedianMiB in the a6.jsonl row; ADEMark settles on the
// RAM slope first, here a fixed 90 s). Gated on the 1-minute load (<= 14) before each rep; the load is in every row.
//   node a5a6-batch.mjs [reps=3] [arms=minbase,minafter] [--no-seed]
import { execFileSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ARMS, cdp, focusComposer, launch, load1, newChat, send, sleep, stop, ud, waitQuiet, waitWorkbench, writeSettings } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const reps = Number(args[0] ?? 3);
const arms = (args[1] ?? 'minbase,minafter').split(',');
const seed = !process.argv.includes('--no-seed');
for (const arm of arms) {
	if (!ARMS[arm] || (ARMS[arm].endsWith('.app') && !existsSync(ARMS[arm]))) {
		throw new Error(`arm ${arm} has no build at ${ARMS[arm]}`);
	}
}
const order = [];
for (let i = 0; i < reps; i++) {
	order.push(...(i % 2 ? [...arms].reverse() : arms));
}
const a6 = (...a) => process.stdout.write(execFileSync('node', [join(here, 'a6.mjs'), ...a], { encoding: 'utf8' }));
const SEEDED = new Set();

async function seedArm(arm) {
	// A fresh profile per arm, seeded once per batch (ADEMark seeds once per run too).
	rmSync(ud(arm), { recursive: true, force: true });
	writeSettings(arm);
	// A built app runs its agent server as a launchd job whose environment has no ANTHROPIC_BASE_URL: its seed turns
	// went to the real API and failed (session-minbase-1, 02:49, every seed "no reply"). Seeding alone spawns the server
	// from the app (weight's rig does the same); the measured relaunches below keep the shipped launchd job.
	launch(arm, { env: ARMS[arm].endsWith('.app') ? { VOLT_AGENT_SERVER_LAUNCHD: '0' } : {} });
	await waitWorkbench();
	await sleep(8000);
	const c = await cdp();
	await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
	const marker = `[...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).some(m => m.textContent.includes('unchanged'))`;
	let answered = 0;
	for (let i = 0; i < 5; i++) {
		await newChat(c);
		await sleep(1500);
		await send(c, 'replay:seed');
		let ok = false;
		for (let t = 0; t < 150 && !ok; t++) {
			await sleep(200);
			ok = await c.evaluate(marker);
			// A built app may ask before the seed's command runs (Supervised): approve it, as a user seeding would.
			if (!ok && t % 5 === 4) {
				await c.evaluate(`[...document.querySelectorAll('.volt-agent-editor-main button, .volt-agent-editor-main .monaco-button, .volt-agent-editor-main [role=button]')].find(b => b.offsetParent && /^Run\\b/.test((b.textContent || '').trim()))?.click()`);
			}
		}
		console.log(`${arm} seed ${i + 1}: ${ok ? 'answered' : 'no reply in 30 s'}`);
		answered += ok ? 1 : 0;
		await sleep(1500);
	}
	await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
	c.close();
	await stop(arm);
	await sleep(5000);
	if (answered < 5) {
		// A failed seed leaves error rows (and agents the window counts as working): its A5/A6 rows would be invalid.
		throw new Error(`${arm}: ${5 - answered} seed turn(s) not answered; no rows taken`);
	}
	SEEDED.add(arm);
}

for (const arm of order) {
	if (seed && !SEEDED.has(arm)) {
		console.log(`== seeding ${arm} ${new Date().toISOString()}`);
		await seedArm(arm);
	}
	const load = await waitQuiet(14);
	console.log(`== ${arm} load ${load} ${new Date().toISOString()}`);
	writeSettings(arm);
	launch(arm);
	await waitWorkbench();
	await sleep(5000);
	const c = await cdp();
	console.log(`composer focused: ${await focusComposer(c)}`);
	c.close();
	try {
		a6(arm, 'front', '90', '60');
		a6(arm, 'covered', '2', '60');
	} catch (e) {
		console.log(`run failed: ${e}`);
	}
	await stop(arm);
	console.log(`stopped ${arm} load ${load1()}`);
	await sleep(10_000);
}
