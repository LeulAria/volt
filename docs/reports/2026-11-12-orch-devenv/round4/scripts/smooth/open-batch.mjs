// Chat open A/B: interleaved reps (ABBA), each a fresh launch of the arm (covered-window rendering kept on), then for
// each size one cold copy opened with a plain click and one after the pointer rested 300 ms on its row
// (open-bench.mjs --copies; a copy neither the window nor the agent server has read). Rep r uses copies 1+3r and
// 2+3r, the same numbers in both arm profiles (open-seed.mjs seeded both); odd reps open the hovered one first.
//   node open-batch.mjs [reps=3]     summaries in data/smooth/open/<arm>-<size>-h<hover>-c<copy>.json
import { execFileSync } from 'child_process';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DATA, launch, load1, sleep, stop, waitQuiet, waitWorkbench, writeSettings } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const reps = Number(process.argv[2] ?? 3);
const firstRep = Number(process.argv[3] ?? 0);
const dir = join(DATA, 'open');
mkdirSync(dir, { recursive: true });
const order = [];
for (let i = firstRep; i < firstRep + reps; i++) {
	order.push([i, i % 2 ? 'after' : 'before'], [i, i % 2 ? 'before' : 'after']);
}
for (const [rep, arm] of order) {
	const load = await waitQuiet(14);
	console.log(`== rep ${rep} ${arm} load ${load} ${new Date().toISOString()}`);
	writeSettings(arm);
	launch(arm, { keepRendering: true });
	await waitWorkbench();
	await sleep(15_000);
	for (const size of ['small', 'medium', 'large']) {
		// Odd reps open the hovered copy first: the first open of a size in a window pays first-use costs.
		const pair = [[0, 1 + 3 * rep], [300, 2 + 3 * rep]];
		for (const [hover, copy] of rep % 2 ? pair.reverse() : pair) {
			const l = await waitQuiet(14);
			const out = join(dir, `${arm}-${size}-h${hover}-c${copy}.json`);
			try {
				const text = execFileSync('node', [join(here, 'open-bench.mjs'), '--copies', size, '--first', String(copy), '--runs', '1', '--hover', String(hover), '--from', 'From thread', '--out', out], { encoding: 'utf8', timeout: 120_000 });
				console.log(`${arm} ${size} hover ${hover} copy ${copy} (load ${l}): ${text.trim().split('\n')[0]}`);
			} catch (e) {
				console.log(`${arm} ${size} hover ${hover} copy ${copy}: failed ${String(e).slice(0, 300)}`);
			}
		}
	}
	// The chat a window shows when it opens: reload (Cmd+R) with "Open medium" on screen (restore-bench.mjs).
	try {
		await waitQuiet(14);
		const out = join(dir, `${arm}-reload-medium-r${rep}.json`);
		const text = execFileSync('node', [join(here, 'restore-bench.mjs'), '--chat', 'Open medium', '--session', 'agent-bench-medium', '--marker', 'LONGTHREAD-END medium', '--runs', '2', '--out', out], { encoding: 'utf8', timeout: 400_000 });
		console.log(`${arm} reload medium: ${text.trim().split('\n').filter(l => l.startsWith('run') || l.startsWith('{')).join(' | ')}`);
	} catch (e) {
		console.log(`${arm} reload: failed ${String(e).slice(0, 300)}`);
	}
	await stop(arm);
	console.log(`stopped ${arm} load ${load1()}`);
	await sleep(10_000);
}
