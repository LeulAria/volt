// A6 batch: interleaved before/after reps (ABBA order), each a fresh launch of the arm's dev build, the composer
// focused (ADEMark's "ready" window), then a6.mjs front (settle 90 s, sample 60 s) and covered (sample 60 s).
// Gated on the 1-minute load (<= 14) before each rep; the load is in every row.
//   node a6-batch.mjs [reps=3] [arms=before,after]   (arms rotate each rep: A B, B A, ...)
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { cdp, focusComposer, launch, load1, sleep, stop, waitQuiet, waitWorkbench, writeSettings } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const reps = Number(process.argv[2] ?? 3);
const arms = (process.argv[3] ?? 'before,after').split(',');
const order = [];
for (let i = 0; i < reps; i++) {
	order.push(...(i % 2 ? [...arms].reverse() : arms));
}
const a6 = (...args) => process.stdout.write(execFileSync('node', [join(here, 'a6.mjs'), ...args], { encoding: 'utf8' }));
for (const arm of order) {
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
