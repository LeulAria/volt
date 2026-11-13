// C1-style run of the Bare CLI (Claude Code headless) in a fresh copy of the arena, then the own-tests grade.
//   node runcli.mjs <id> [solo|orchestrated] [--model claude-opus-5-5] [--effort high]
// The copy is /tmp/v3orch/c1/<id> (a git repo on main, from arena-base). Every stdout line is timestamped
// in data/orch/c1/<id>.jsonl; the row (time, tokens per model incl. subagents, grade) goes to c1-runs.jsonl.
import { spawn, execSync } from 'child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { grade } from './grade.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '../../../data/orch/c1');
const [id, kind = 'solo'] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const model = opt('--model', 'claude-opus-5-5');
const effort = opt('--effort', 'high');
const repo = `/tmp/v3orch/c1/${id}`;
if (existsSync(repo)) {
	throw new Error(`${repo} exists`);
}
mkdirSync(DATA, { recursive: true });
execSync(`git clone -q /tmp/v3orch/c1/arena-base ${repo} && git -C ${repo} remote remove origin`);
const prompt = readFileSync(join(here, 'prompts', kind === 'solo' ? 'C1-solo.md' : 'C1-orchestrated-build.md'), 'utf8').trim();
const t0 = Date.now();
const load = execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();
const out = createWriteStream(join(DATA, `${id}.jsonl`));
const child = spawn('claude', ['-p', prompt, '--model', model, '--effort', effort, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let buffer = '';
let result;
const toolAnswers = [];
child.stdout.on('data', chunk => {
	buffer += chunk;
	let nl;
	while ((nl = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, nl);
		buffer = buffer.slice(nl + 1);
		if (!line.trim()) {
			continue;
		}
		const at = Date.now() - t0;
		out.write(JSON.stringify({ at, m: JSON.parse(line) }) + '\n');
		const m = JSON.parse(line);
		if (m.type === 'user' && Array.isArray(m.message?.content) && m.message.content.some(part => part.type === 'tool_result')) {
			toolAnswers.push(at);
		}
		if (m.type === 'result') {
			result = { at, m };
		}
	}
});
child.stderr.on('data', chunk => appendFileSync(join(DATA, `${id}.stderr.txt`), chunk));
const cap = setTimeout(() => child.kill('SIGTERM'), 45 * 60_000);
await new Promise(resolve => child.on('exit', resolve));
clearTimeout(cap);
out.end();
const end = result?.at ?? Date.now() - t0;
const usage = {};
let tokens = 0;
for (const [name, u] of Object.entries(result?.m.modelUsage ?? {})) {
	usage[name] = { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens, costUsd: u.costUSD };
	tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
}
const graded = grade(repo);
const row = { id, arm: `cli-${kind}`, model, effort, at: new Date(t0).toISOString(), load, endMs: end, minutes: +(end / 60_000).toFixed(2), lastToolAnswerMs: toolAnswers.at(-1), tokens, costUsd: result?.m.total_cost_usd, usage, numTurns: result?.m.num_turns, isError: result?.m.is_error, finalText: String(result?.m.result ?? '').slice(-600), shipped: graded.shipped, groups: graded.groups, handoff: graded.handoff, npmTest: graded.npmTest };
writeFileSync(join(DATA, `${id}.grade.json`), JSON.stringify(graded, null, 1));
appendFileSync(join(DATA, 'c1-runs.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify({ id, minutes: row.minutes, tokens, costUsd: row.costUsd, shipped: `${graded.shipped}/5`, handoff: `${graded.handoff}/4`, groups: graded.groups }));
