// Round 10 IDE bench: the first tool call after a window opens.
//   node cold.mjs <app> <arm> [--reps 3] [--langs ts,py,go]
// Per language and repetition: a fresh profile, launch, wait until the window's tools are listed
// (what an agent needs to see code_nav at all), open a chat on the fixture and call
// `code_nav references <symbol>` at once; then again every 250 ms until the answer is right.
// Reports the launch-to-tools time, the first call's time and verdict, and the time to a right answer.
import { execSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { cases } from './cases.mjs';
import { HOME, launch, load1, profile, server, sleep, stop, waitWindow, writeSettings } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [app, arm, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback;
const reps = Number(opt('--reps', 3));
const langs = opt('--langs', 'ts,py,go').split(',');
const fx = join(HOME, 'fx');
execSync(`${join(here, 'setup.sh')} ${HOME}`);
const rows = [];
for (let rep = 1; rep <= reps; rep++) {
	for (const lang of langs) {
		stop(arm);
		rmSync(profile(arm).ud, { recursive: true, force: true });
		rmSync(profile(arm).ext, { recursive: true, force: true });
		writeSettings(arm);
		const load = load1();
		const started = launch(app, arm);
		await waitWindow();
		const windowMs = Date.now() - started.started;
		const s = await server(arm);
		await s.toolsReady();
		const toolsMs = Date.now() - started.started;
		const set = cases(lang, fx);
		const item = set.list.find(entry => entry.id === 'references');
		const chat = await s.chat(set.root, { level: 'workspace-write', network: true });
		const t0 = Date.now();
		const first = await s.tool(chat, item.tool, item.args);
		const verdict = item.check(first);
		let rightMs = verdict.status === 'correct' ? Math.round(first.ms) : undefined;
		for (; rightMs === undefined && Date.now() - t0 < 30_000;) {
			await sleep(250);
			if (item.check(await s.tool(chat, item.tool, item.args)).status === 'correct') { rightMs = Date.now() - t0; }
		}
		const row = { rep, lang, load, windowMs, toolsMs, firstMs: Math.round(first.ms), first: verdict.status, firstText: first.text.split('\n')[0].slice(0, 160), rightMs: rightMs ?? null };
		rows.push(row);
		console.log(JSON.stringify(row));
		s.close();
	}
}
stop(arm);
mkdirSync(join(HOME, 'out'), { recursive: true });
writeFileSync(join(HOME, 'out', `cold-${arm}.json`), JSON.stringify({ arm, app, at: new Date().toISOString(), rows }, null, 1));
process.exit(0);
