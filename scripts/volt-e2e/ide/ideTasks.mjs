/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt e2e review (package ide): five tasks a good engineer solves with IDE tools, run by headless
// Claude Code with the volt MCP server of a test instance. Records which tools it reached for.
//
//   node scripts/volt-e2e/ide/ideTasks.mjs --tag t-before --mcp /tmp/volt-e2e/ide/mcp-volt-full.json [--model claude-haiku-4-5] [--t T1,T2]
//
// Before each task: ideFixtures.mjs --reset, then ideFixtures.mjs (and the mock API for T3).
// Unlike the question A/B, the agent may edit files and use every volt tool (a Full access chat).

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { voltLead } from './lead.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : pairs, []));
const tag = args.tag ?? 't-before';
const model = args.model ?? 'claude-haiku-4-5';
const mcp = args.mcp ?? '/tmp/volt-e2e/ide/mcp-volt-full.json';
const repo = '/tmp/volt-e2e/ide/hotel';
const only = args.t ? new Set(args.t.split(',')) : undefined;
const outFile = resolve(here, `../../../docs/volt-e2e-review/data/ide/ide-tasks-${tag}.jsonl`);
mkdirSync('/tmp/volt-e2e/ide/runs', { recursive: true });

export const TASKS = [
	{ id: 'T1-profile', prompt: 'e2e-ide/occupancy-report.mjs is slow. Profile it to find where the time goes, fix the hot spot without changing its output, and tell me the time before and after.' },
	{ id: 'T2-debug', prompt: 'apps/api/src/modules/reservation/reservation-state-machine.spec.ts fails. Find out why (step through it in the debugger if that helps) and fix the code, not the test.' },
	{ id: 'T3-api', prompt: 'A mock of our reservations API runs at http://127.0.0.1:9987. Call GET /api/v1/reservations?propertyId=p1, then PATCH /api/v1/reservations/r1/check-in, and tell me whether the check-in response follows our reservation state machine.' },
	{ id: 'T4-db', prompt: 'e2e-ide/hotel.db is a SQLite copy of some tables. Which room type has the most checked_in reservations, and which reservations have more guests (adults + children) than their room type\'s max_occupancy?' },
	{ id: 'T5-diagram', prompt: 'Sketch the reservation status lifecycle from apps/api/src/modules/reservation/reservation-state-machine.ts as a diagram on my Scratch board.' },
];

function run(task) {
	execFileSync('node', [resolve(here, 'ideFixtures.mjs'), repo, '--reset']);
	execFileSync('node', [resolve(here, 'ideFixtures.mjs'), repo]);
	const mock = task.id === 'T3-api' ? spawn('node', [`${repo}/e2e-ide/mock-api.mjs`, '9987'], { stdio: 'ignore' }) : undefined;
	const lead = voltLead(task.prompt, { sandboxed: false }); // a Full access chat
	const cli = [
		'-p', `${lead.lead}\n\n${task.prompt}`, '--model', model, '--output-format', 'stream-json', '--verbose',
		'--setting-sources', 'project', '--no-session-persistence',
		'--tools', 'Read,Grep,Glob,Bash,Edit,Write,ToolSearch',
		'--disallowedTools', 'Task,Agent,WebFetch,WebSearch',
		'--allowedTools', 'Read,Grep,Glob,Bash,Edit,Write,mcp__volt',
		'--strict-mcp-config', '--mcp-config', mcp,
	];
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.CLAUDECODE;
	const started = Date.now();
	return new Promise(done => {
		const child = spawn('claude', cli, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		child.stdout.on('data', chunk => stdout += chunk);
		child.stderr.on('data', () => { });
		const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60_000);
		child.on('close', () => {
			clearTimeout(timer);
			mock?.kill();
			writeFileSync(`/tmp/volt-e2e/ide/runs/${tag}-${task.id}.jsonl`, stdout);
			const events = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean);
			const calls = [];
			const errors = [];
			const pending = new Map();
			for (const event of events) {
				for (const part of event.message?.content ?? []) {
					if (part.type === 'tool_use') {
						const op = part.input?.op ?? part.input?.capability ?? '';
						const name = `${part.name.replace('mcp__volt__', 'volt:')}${op ? ` ${typeof op === 'string' ? op : ''}` : ''}${part.input?.capability && part.input?.op ? `/${part.input.op}` : ''}`;
						calls.push(name);
						pending.set(part.id, name);
					} else if (part.type === 'tool_result' && part.is_error) {
						const text = typeof part.content === 'string' ? part.content : (part.content ?? []).map(c => c.text ?? '').join('');
						errors.push(`${pending.get(part.tool_use_id)}: ${text.slice(0, 160)}`);
					}
				}
			}
			const result = events.find(event => event.type === 'result') ?? {};
			const row = { tag, task: task.id, model, wallMs: Date.now() - started, costUsd: result.total_cost_usd, turns: result.num_turns, calls, errors, usedIde: calls.some(call => /^volt:(ide|tests|debug|tasks)/.test(call)), answer: (result.result ?? '').slice(0, 1500), lane: lead.lane };
			appendFileSync(outFile, JSON.stringify(row) + '\n');
			console.log(`${task.id}: ${(row.wallMs / 1000).toFixed(0)}s $${(row.costUsd ?? 0).toFixed(3)} ide=${row.usedIde} calls: ${calls.join(', ')}`);
			done(row);
		});
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	for (const task of TASKS) {
		if (!only || only.has(task.id) || only.has(task.id.split('-')[0])) {
			await run(task);
		}
	}
	execFileSync('node', [resolve(here, 'ideFixtures.mjs'), repo, '--reset']);
}
