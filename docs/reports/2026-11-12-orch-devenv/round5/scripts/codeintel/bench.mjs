// Round 5 codeintel: 8 code tasks on the openclaw fixture, Volt before (base tree, CDP 9985) vs after (this tree, CDP 9975),
// interleaved per task and rep. Each run is runtok.mjs run (new chat, Full access, sandbox Off, Haiku 5.5); the fixture is reset after edits.
//   node bench.mjs <tag> <reps> [task ids comma-separated] [arms comma-separated: before,after]
import { execFileSync, execSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
const H = process.env.HOME + '/.volt-r5/codeintel';
const FX = H + '/fx/openclaw';
const MODEL = process.env.BENCH_MODEL ?? 'agent:seed-claude-code:claude-haiku-5-5';
const [tag, repsArg, only, armsArg] = process.argv.slice(2);
const tasks = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8')).filter(t => !only || only === 'all' || only.split(',').includes(t.id));
const arms = { before: { VOLT_UD: H + '/ud-base', VOLT_EXT: H + '/ext-base', VOLT_CDP: '9985' }, after: { VOLT_UD: H + '/ud', VOLT_EXT: H + '/ext', VOLT_CDP: '9975' } };
const armNames = (armsArg ?? 'before,after').split(',');
const SUFFIX = ' Answer concisely with file:line references. This is a read-only question: do not modify any files.';
const reset = () => execSync(`git -C ${FX} checkout -q -- . && git -C ${FX} clean -qfd -- src extensions`);
for (let rep = 1; rep <= Number(repsArg ?? 1); rep++) {
	for (const task of tasks) {
		// Alternate which arm goes first, so neither always gets the warmer machine.
		const order = (rep + tasks.indexOf(task)) % 2 ? armNames : [...armNames].reverse();
		for (const arm of order) {
			reset();
			const prompt = task.prompt + (task.kind === 'read' ? SUFFIX : '');
			const label = `${tag}-${arm}-${task.id}`;
			try {
				const out = execFileSync('node', [join(here, 'runtok.mjs'), 'run', label, MODEL, prompt, String(rep)], { env: { ...process.env, ...arms[arm], TOK_ACCESS: 'full', TOK_SIDE_WAIT_MS: '3000' }, encoding: 'utf8', timeout: 8 * 60_000 });
				console.log(out.trim().split('\n').at(-1).slice(0, 220));
			} catch (err) {
				console.log(JSON.stringify({ label, rep, error: String(err).slice(0, 300) }));
			}
			if (task.kind === 'edit') {
				// Keep the diff for grading, then reset.
				const diff = execSync(`git -C ${FX} diff`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
				execFileSync('node', ['-e', `require('fs').writeFileSync(process.argv[1], process.argv[2])`, `${H}/run/diffs/${label}-r${rep}.diff`, diff]);
			}
		}
	}
}
reset();
