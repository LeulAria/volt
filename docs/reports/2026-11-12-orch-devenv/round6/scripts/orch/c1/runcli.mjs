// ADEMark C1-solo (or C1) on the Bare CLI: Claude Code alone, headless, in a fresh arena clone, ADEMark method,
// unofficial. Same clean config dir and capture proxy as runvolt.mjs, Opus 5.5 at high effort, full access.
//   node runcli.mjs <id> [solo|orchestrated] [--model claude-opus-5-5] [--effort high]
// The end: the result message is the first end of turn; the run ends at the last tool answer after it, if any
// (TESTS.md 4). Each stdout line is kept with its time in ~/.volt-r6/orch/c1/runs/<id>.stream.jsonl.
import { spawn, execSync } from 'child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { grade } from './grade.mjs';
import { agentsSeen, ARENA_BASE, CAP_MS, CFG, DATA, fanOut, loadAvg, PROXY, rowsBetween, RUNS, seedFor, sessionIntervals, sleep, taskPrompt, tokensOf, usdOf } from './common.mjs';

const [id, kind = 'solo'] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const model = opt('--model', 'claude-opus-5-5');
const effort = opt('--effort', 'high');
const repo = join(RUNS, id);
if (existsSync(repo)) { throw new Error(`${repo} exists`); }
mkdirSync(DATA, { recursive: true });
execSync(`git clone -q ${ARENA_BASE} ${repo} && git -C ${repo} remote remove origin`);
const seed = seedFor(id);
const prompt = taskPrompt(kind, seed);
writeFileSync(join(DATA, `${id}.prompt.txt`), prompt);
const env = {
	HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.USER, SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR,
	PATH: process.env.PATH, CLAUDE_CONFIG_DIR: CFG, ANTHROPIC_BASE_URL: PROXY,
};
const load = loadAvg();
const t0 = Date.now();
const out = createWriteStream(join(RUNS, `${id}.stream.jsonl`));
// CLAUDE_BIN: the binary to run (round 6 compares at 2.1.322, the SDK's bundled build that Volt's adapter runs).
const bin = process.env.CLAUDE_BIN ?? 'claude';
const version = execSync(`${JSON.stringify(bin)} --version`).toString().trim();
const child = spawn(bin, ['-p', prompt, '--model', model, '--effort', effort, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
let buffer = '';
let result;
child.stdout.on('data', chunk => {
	buffer += chunk;
	let nl;
	while ((nl = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, nl);
		buffer = buffer.slice(nl + 1);
		if (!line.trim()) { continue; }
		let m;
		try { m = JSON.parse(line); } catch { continue; }
		out.write(JSON.stringify({ at: Date.now() - t0, m }) + '\n');
		if (m.type === 'result') { result = { at: Date.now(), m }; }
	}
});
child.stderr.on('data', chunk => appendFileSync(join(RUNS, `${id}.stderr.txt`), chunk));
const capTimer = setTimeout(() => child.kill('SIGTERM'), CAP_MS);
await new Promise(resolve => child.on('exit', resolve));
clearTimeout(capTimer);
out.end();
const first = result?.at ?? Date.now();
// A headless run has no agent left after its result; wait a little for late rows, not the 5 quiet minutes.
await sleep(5000);
const last = Math.max(first, agentsSeen(rowsBetween(t0)).lastWorkMs ?? 0);
const timedOut = last > t0 + CAP_MS || !result;
const end = Math.min(last, t0 + CAP_MS);
const rows = rowsBetween(t0, end);
const tokens = tokensOf(rows);
const usd = usdOf(rows);
const seen = agentsSeen(rows);
const intervals = sessionIntervals(CFG, t0, cwd => cwd.startsWith(repo));
const graded = grade(repo, seed);
const minutes = +((end - t0) / 60_000).toFixed(2);
const efforts = [...new Set(rows.filter(r => r.meta).map(r => `${r.model}:${r.meta.effort ?? '-'}:${r.meta.thinking ?? '-'}`))];
const row = {
	id, arm: `cli-${kind}`, model, effort, version, at: new Date(t0).toISOString(), load, timedOut, minutes,
	timeToGreen: graded.shipped === 5 && !timedOut ? minutes : null,
	shipped: graded.shipped, groups: graded.groups, handoff: graded.handoff, codesPlaced: graded.codesPlaced, npmTest: graded.npmTest,
	tokensTotal: tokens.total, usd: usd?.usd ?? null, tokens, requests: rows.length, agents: seen, fanOut: fanOut(intervals.filter(s => s.cwd !== repo)),
	efforts, cliTokens: Object.entries(result?.m.modelUsage ?? {}).reduce((n, [, u]) => n + (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0), 0),
	cliCostUsd: result?.m.total_cost_usd, numTurns: result?.m.num_turns, isError: result?.m.is_error, finalText: String(result?.m.result ?? '').slice(-800),
	invalid: [!rows.length && 'no model request captured', tokens.noUsage && 'a call has no usage (tokens-total invalid)'].filter(Boolean),
};
writeFileSync(join(DATA, `${id}.grade.json`), JSON.stringify(graded, null, 1));
writeFileSync(join(DATA, `${id}.capture.jsonl`), rowsBetween(t0 - 5000, end + 60_000).map(r => JSON.stringify(r)).join('\n') + '\n');
execSync(`gzip -f ${JSON.stringify(join(DATA, `${id}.capture.jsonl`))}`);
execSync(`gzip -c ${JSON.stringify(join(RUNS, `${id}.stream.jsonl`))} > ${JSON.stringify(join(DATA, `${id}.stream.jsonl.gz`))}`);
appendFileSync(join(DATA, 'c1-runs.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify({ id, minutes, timeToGreen: row.timeToGreen, tokensTotal: tokens.total, cliTokens: row.cliTokens, usd: row.usd, shipped: `${graded.shipped}/5`, handoff: `${graded.handoff}/4`, groups: graded.groups, efforts }));
