/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// The same task in headless Claude Code (its own Task subagents), for comparison with Volt.
// Resets the fixture repo, runs `claude -p` with stream-json, timestamps every line, and prints
// wall time, time to the first subagent, time from the last subagent result to the end, tool
// calls, tokens and cost. Only temp config is passed: no MCP servers, project settings only.
// Usage: node scripts/volt-e2e/orch/runClaudeCode.mjs <repo> <prompt-file> <label> [model]
import { execSync, spawn } from 'child_process';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

const [repo, promptFile, label, model = 'claude-sonnet-5-5'] = process.argv.slice(2);
const dir = '/tmp/volt-e2e/orch/cc';
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/mcp.json`, JSON.stringify({ mcpServers: {} }));
writeFileSync(`${dir}/settings.json`, JSON.stringify({}));
execSync('git checkout -q . && git clean -fdq', { cwd: repo });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CLAUDECODE;
const t0 = Date.now();
const child = spawn('claude', ['-p', readFileSync(promptFile, 'utf8').trim(), '--model', model, '--output-format', 'stream-json', '--verbose',
	'--permission-mode', 'bypassPermissions', '--strict-mcp-config', '--mcp-config', `${dir}/mcp.json`, '--settings', `${dir}/settings.json`, '--setting-sources', 'project'],
	{ cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
const lines = [];
let buffer = '';
child.stdout.on('data', chunk => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		try {
			lines.push({ at: Date.now() - t0, message: JSON.parse(line) });
		} catch { /* not JSON */ }
	}
});
let stderr = '';
child.stderr.on('data', chunk => stderr += chunk);
await new Promise(resolve => child.on('close', resolve));
const wall = Date.now() - t0;
writeFileSync(`${dir}/${label}.jsonl`, lines.map(line => JSON.stringify(line)).join('\n'));
const toolUses = [];
const results = [];
let firstAssistant;
for (const { at, message } of lines) {
	if (message.type === 'assistant') {
		firstAssistant ??= at;
		for (const part of message.message?.content ?? []) {
			if (part.type === 'tool_use') {
				toolUses.push({ at, name: part.name, parent: message.parent_tool_use_id ?? null, id: part.id });
			}
		}
	}
	if (message.type === 'user') {
		for (const part of message.message?.content ?? []) {
			if (part.type === 'tool_result') {
				results.push({ at, id: part.tool_use_id });
			}
		}
	}
}
const spawns = toolUses.filter(use => !use.parent && /^(Task|Agent)$/.test(use.name));
const spawnIds = new Set(spawns.map(use => use.id));
const spawnResults = results.filter(result => spawnIds.has(result.id));
const final = lines.find(line => line.message.type === 'result')?.message;
let tests = '';
try {
	tests = execSync('npm test 2>&1', { cwd: repo, encoding: 'utf8' });
} catch (err) {
	tests = String(err.stdout ?? err);
}
const usage = final?.usage ?? {};
const row = {
	label, harness: 'claude-code', model, wallS: Math.round(wall / 100) / 10,
	firstModelOutputS: firstAssistant !== undefined ? Math.round(firstAssistant / 100) / 10 : null,
	firstSubagentS: spawns.length ? Math.round(spawns[0].at / 100) / 10 : null,
	lastChildDoneToEndS: spawnResults.length ? Math.round((wall - Math.max(...spawnResults.map(result => result.at))) / 100) / 10 : null,
	subagents: spawns.length,
	parentToolCalls: toolUses.filter(use => !use.parent).length,
	subagentToolCalls: toolUses.filter(use => use.parent).length,
	costUsd: final?.total_cost_usd ?? null,
	numTurns: final?.num_turns ?? null,
	billedTokens: { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens },
	modelUsage: final?.modelUsage ? Object.fromEntries(Object.entries(final.modelUsage).map(([name, value]) => [name, { in: value.inputTokens, out: value.outputTokens, cacheRead: value.cacheReadInputTokens, cacheWrite: value.cacheCreationInputTokens, costUsd: value.costUSD }])) : undefined,
	isError: final?.is_error ?? true,
	testsPass: Number(/\u2139 pass (\d+)/.exec(tests)?.[1] ?? 0),
	testsFail: Number(/\u2139 fail (\d+)/.exec(tests)?.[1] ?? 0),
	changed: execSync('git status --short', { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
	...(stderr.trim() ? { stderr: stderr.trim().slice(0, 300) } : {}),
};
console.log(JSON.stringify(row));
appendFileSync('/tmp/volt-e2e/orch/live/cc-runs.jsonl', JSON.stringify(row) + '\n');
