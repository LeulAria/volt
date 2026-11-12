/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt e2e review (package ide): agent A/B on the hotel question set with headless Claude Code.
//
//   node scripts/volt-e2e/ide/abRun.mjs --arm own|volt --tag before [--model claude-haiku-4-5] [--n 3] [--q Q1,Q2] [--jobs 4]
//
// own:  Claude Code with only Read/Grep/Glob/Bash (no MCP servers).
// volt: the same, plus the volt MCP server of a running test instance (config in /tmp/volt-e2e/ide/mcp-volt.json,
//       a real chat's session token) and the [Volt] lead Volt would prepend to the prompt (lead.mjs, from out/).
// Both: --setting-sources project (no user hooks), no subagents (Task), no web, no edits, fresh session.
// Writes one JSON line per run to docs/volt-e2e-review/data/ide/ab-<tag>.jsonl and the raw stream to /tmp/volt-e2e/ide/runs/.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUESTIONS, score } from './questions.mjs';
import { voltLead } from './lead.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : pairs, []));
const arm = args.arm ?? 'own';
const tag = args.tag ?? 'before';
const model = args.model ?? 'claude-haiku-4-5';
const n = Number(args.n ?? 3);
const jobs = Number(args.jobs ?? 4);
const only = args.q ? new Set(args.q.split(',')) : undefined;
const repo = args.repo ?? '/tmp/volt-e2e/ide/hotel';
const mcpConfig = args.mcp ?? '/tmp/volt-e2e/ide/mcp-volt.json';
const runsDir = '/tmp/volt-e2e/ide/runs';
const outFile = resolve(here, `../../../docs/volt-e2e-review/data/ide/ab-${tag}.jsonl`);
mkdirSync(runsDir, { recursive: true });
mkdirSync(dirname(outFile), { recursive: true });

const VOLT_READ_TOOLS = ['instant_grep', 'find_symbol', 'find_files', 'code_nav', 'diagnostics', 'ide', 'workspace_status'].map(name => `mcp__volt__${name}`);
const emptyMcp = resolve(runsDir, 'empty-mcp.json');
writeFileSync(emptyMcp, JSON.stringify({ mcpServers: {} }));

function runOne(question, rep) {
	const lead = arm === 'volt' ? voltLead(question.prompt) : undefined;
	const prompt = lead?.lead ? `${lead.lead}\n\n${question.prompt}` : question.prompt;
	const cli = [
		'-p', prompt,
		'--model', model,
		'--output-format', 'stream-json', '--verbose',
		'--setting-sources', 'project',
		'--no-session-persistence',
		'--tools', 'Read,Grep,Glob,Bash,ToolSearch',
		'--disallowedTools', 'Task,Agent,WebFetch,WebSearch,Edit,Write,NotebookEdit',
		'--allowedTools', ['Read', 'Grep', 'Glob', 'Bash', ...(arm === 'volt' ? VOLT_READ_TOOLS : [])].join(','),
		'--strict-mcp-config', '--mcp-config', arm === 'volt' ? mcpConfig : emptyMcp,
	];
	const started = Date.now();
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.CLAUDECODE;
	return new Promise(resolveRun => {
		const child = spawn('claude', cli, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', chunk => stdout += chunk);
		child.stderr.on('data', chunk => stderr += chunk);
		const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60_000);
		child.on('close', code => {
			clearTimeout(timer);
			const wall = Date.now() - started;
			const file = `${runsDir}/${tag}-${arm}-${question.id}-${rep}.jsonl`;
			writeFileSync(file, stdout + (stderr ? `\n#stderr ${stderr}` : ''));
			const events = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean);
			const tools = {};
			let toolResultChars = 0;
			let toolErrors = 0;
			for (const event of events) {
				if (event.type === 'assistant') {
					for (const part of event.message?.content ?? []) {
						if (part.type === 'tool_use') {
							tools[part.name] = (tools[part.name] ?? 0) + 1;
						}
					}
				} else if (event.type === 'user') {
					for (const part of event.message?.content ?? []) {
						if (part.type === 'tool_result') {
							const text = typeof part.content === 'string' ? part.content : (part.content ?? []).map(c => c.text ?? '').join('');
							toolResultChars += text.length;
							if (part.is_error) {
								toolErrors++;
							}
						}
					}
				}
			}
			const result = events.find(event => event.type === 'result') ?? {};
			const answer = result.result ?? '';
			const graded = score(question, answer);
			const usage = result.usage ?? {};
			const row = {
				tag, arm, model, q: question.id, rep, exit: code, wallMs: wall, durationMs: result.duration_ms, turns: result.num_turns,
				costUsd: result.total_cost_usd, input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens,
				toolCalls: Object.values(tools).reduce((a, b) => a + b, 0), tools, toolErrors, toolResultChars,
				voltCalls: Object.entries(tools).filter(([name]) => name.startsWith('mcp__volt__')).reduce((a, [, c]) => a + c, 0),
				score: graded.score, missing: graded.missing, lane: lead?.lane, leadChars: lead?.lead.length ?? 0, answerChars: answer.length,
			};
			appendFileSync(outFile, JSON.stringify(row) + '\n');
			console.log(`${question.id} #${rep} ${arm}: score ${graded.score.toFixed(2)} ${(wall / 1000).toFixed(0)}s $${(result.total_cost_usd ?? 0).toFixed(3)} tools ${row.toolCalls} (volt ${row.voltCalls})${code ? ` exit ${code}` : ''}`);
			resolveRun(row);
		});
	});
}

const queue = [];
for (let rep = 1; rep <= n; rep++) {
	for (const question of QUESTIONS) {
		if (!only || only.has(question.id) || only.has(question.id.split('-')[0])) {
			queue.push([question, rep]);
		}
	}
}
let next = 0;
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
	while (next < queue.length) {
		const [question, rep] = queue[next++];
		await runOne(question, rep);
	}
}));
