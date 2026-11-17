// Round 10 IDE bench: correctness, warm latency and tokens per result for every tool, per language.
//   node bench.mjs <app> <arm> [--langs ts,py,go] [--n 12] [--sandbox off] [--keep]
// <app>: a dev checkout (scripts/code.sh) or a built VOLT.app. <arm>: a label; the profile is
// <home>/ud-<arm> (wiped first), results go to <home>/out/<arm>.json. One instance at a time.
// Calls are made as a chat's agent makes them (lib.mjs `tool`), in a chat with the default sandbox
// (Supervised: workspace-write) unless --sandbox off.
import { execSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { cases, ideCases, reset } from './cases.mjs';
import { HOME, launch, load1, profile, server, sleep, stats, stop, waitWindow, writeSettings } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [app, arm, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback;
const langs = opt('--langs', 'ts,py,go').split(',');
const N = Number(opt('--n', 12));
const sandbox = opt('--sandbox', 'on') === 'off' ? undefined : { level: 'workspace-write', network: true };
const only = opt('--only', '');
const fx = join(HOME, 'fx');

execSync(`${join(here, 'setup.sh')} ${HOME}`);
stop(arm);
await sleep(500);
rmSync(profile(arm).ud, { recursive: true, force: true });
rmSync(profile(arm).ext, { recursive: true, force: true });
writeSettings(arm);
const started = launch(app, arm);
await waitWindow();
const windowMs = Date.now() - started.started;
const s = await server(arm);
await s.toolsReady();
// From launch until an agent could list code_nav: the window is up and its tools are on the server.
const toolsMs = Date.now() - started.started;
const out = { arm, app, at: new Date().toISOString(), n: N, sandbox: sandbox?.level ?? 'off', windowMs, toolsMs, loadStart: load1(), langs: {} };

const termId = text => /\[(term-[\w-]+)/.exec(text)?.[1];

async function runCase(chat, root, item) {
	const reps = item.kind === 'edit' ? Math.min(N, 10) : item.reps ?? N;
	const times = [];
	let first;
	for (let rep = 0; rep < reps; rep++) {
		let id;
		if (item.kind === 'edit' || item.prepare) {
			reset(root);
			item.prepare?.();
		}
		for (const step of item.before ?? []) {
			const r = await s.tool(chat, step.tool, { ...step.args, ...(step.useId ? { id } : {}) });
			if (step.keep === 'id') { id = termId(r.text); }
		}
		const args = item.argsFrom ? item.argsFrom(id) : item.args;
		const result = await s.tool(chat, item.tool, args);
		const verdict = item.check(result);
		for (const step of item.after ?? []) {
			await s.tool(chat, step.tool, { ...step.args, ...(step.useId ? { id } : {}) });
		}
		item.restore?.();
		if (rep === 0) {
			first = { ...verdict, ms: Math.round(result.ms), tokens: result.tokens, chars: result.text.length, isError: result.isError, text: result.text.slice(0, 6000) };
		} else {
			times.push(result.ms);
			// A later repetition that answers differently is a finding of its own.
			if (verdict.status !== first.status) { first.flaky = `${first.flaky ? first.flaky + ', ' : ''}rep ${rep + 1}: ${verdict.status}`; }
		}
	}
	if (item.kind === 'edit' || item.prepare) { reset(root); }
	const warm = stats(times);
	return { id: item.id, tool: item.tool, args: item.args, ...first, firstMs: first.ms, warm: warm.n ? { n: warm.n, p50: +warm.p50.toFixed(1), p95: +warm.p95.toFixed(1), min: +warm.min.toFixed(1), max: +warm.max.toFixed(1) } : { n: 0 } };
}

for (const lang of langs) {
	const set = cases(lang, fx);
	const ide = ideCases(lang, fx);
	const chat = await s.chat(set.root, sandbox);
	const open = sandbox ? await s.chat(set.root, undefined) : chat;
	const rows = [];
	// Warm state first (cold.mjs measures the cold one): until the index and, where there is one, the
	// language server answer the first case right, at most 45 s.
	const warmStart = Date.now();
	for (; Date.now() - warmStart < 45_000;) {
		const probe = set.list[0];
		if (probe.check(await s.tool(chat, probe.tool, probe.args)).status === 'correct') { break; }
		await sleep(500);
	}
	out.warmupMs = { ...out.warmupMs, [lang]: Date.now() - warmStart };
	for (const item of [...set.list, ...ide.list]) {
		if (only && !only.split(',').includes(item.id)) { continue; }
		let row = await runCase(chat, set.root, item);
		// Tools that act outside a sandbox are refused in a Supervised chat by design: measured in a Full access chat, and marked.
		if (sandbox && /runs in Volt's sandbox/.test(row.text ?? '')) {
			const refusal = row.text.split('\n')[0].slice(0, 200);
			row = { ...await runCase(open, set.root, item), supervised: `refused: ${refusal}` };
		}
		rows.push(row);
		console.log(`${lang}\t${row.id}\t${row.status}${row.flaky ? ' (flaky: ' + row.flaky + ')' : ''}\tfirst ${row.firstMs} ms\twarm p50 ${row.warm.p50 ?? '-'} p95 ${row.warm.p95 ?? '-'} (n ${row.warm.n})\t${row.tokens} tok\t${row.detail ?? ''}`);
	}
	out.langs[lang] = rows;
	reset(set.root);
}
out.loadEnd = load1();
mkdirSync(join(HOME, 'out'), { recursive: true });
writeFileSync(join(HOME, 'out', `${arm}.json`), JSON.stringify(out, null, 1));
console.log(`wrote ${join(HOME, 'out', `${arm}.json`)} (load ${out.loadStart} -> ${out.loadEnd})`);
s.close();
if (!rest.includes('--keep')) { stop(arm); }
process.exit(0);
