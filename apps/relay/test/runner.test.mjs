/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { parseAgentLine, toolSummary } from '../src/runner/agents.mjs';
import { LoadSampler } from '../src/runner/load.mjs';
import { Runner } from '../src/runner/runner.mjs';
import { startRelayServer } from '../src/server.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'volt-runner-test-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

describe('agent stream parsing', () => {
	test('claude stream-json', () => {
		const state = {};
		assert.deepEqual(parseAgentLine('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', name: 'Write', input: { file_path: '/w/a.txt' } }] } }), state).map(event => event.t), ['message', 'tool']);
		const usage = parseAgentLine('claude', JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.', total_cost_usd: 0.02, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 }, num_turns: 2 }), state);
		assert.equal(state.summary, 'Done.');
		assert.equal(state.failed, false);
		assert.deepEqual(usage[0], { t: 'usage', inputTokens: 15, outputTokens: 3, costUsd: 0.02, turns: 2 });
		assert.deepEqual(parseAgentLine('claude', 'plain text', state), [{ t: 'log', stream: 'stdout', text: 'plain text' }]);
	});
	test('codex exec --json', () => {
		const state = {};
		assert.equal(parseAgentLine('codex', JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }), state)[0].name, 'Shell');
		parseAgentLine('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'All set' } }), state);
		assert.equal(state.summary, 'All set');
	});
	test('tool summary picks the meaningful field', () => {
		assert.equal(toolSummary({ command: 'npm   test' }), 'npm test');
		assert.equal(toolSummary(undefined), '');
	});
});

describe('load sampler', () => {
	test('uses the cgroup counter and quota inside a container', () => {
		const root = fs.mkdtempSync(path.join(tmp, 'cg-'));
		fs.writeFileSync(path.join(root, 'cpu.max'), '200000 100000\n');
		fs.writeFileSync(path.join(root, 'cpu.stat'), 'usage_usec 1000000\n');
		fs.writeFileSync(path.join(root, 'memory.current'), String(512 * 1024 * 1024));
		fs.writeFileSync(path.join(root, 'memory.max'), String(2048 * 1024 * 1024));
		const sampler = new LoadSampler(root);
		const first = sampler.sample();
		assert.equal(first.cpus, 2);
		assert.equal(first.container, true);
		assert.equal(first.memTotal, 2048 * 1024 * 1024);
		assert.equal(first.cpu, undefined);
		// Pretend a full core was busy for the whole interval: 50% of a 2-CPU quota.
		sampler.previous.at -= 1000;
		fs.writeFileSync(path.join(root, 'cpu.stat'), 'usage_usec 2000000\n');
		const second = sampler.sample();
		assert.ok(second.cpu > 0.45 && second.cpu <= 0.5, String(second.cpu));
	});
});

describe('runner end to end (fake agent)', () => {
	let relay;
	let runner;
	after(async () => {
		await runner?.stop();
		await relay?.close();
	});

	test('claims a task, runs the agent on a bundle, returns a bundle that applies locally', async () => {
		relay = await startRelayServer({ dataDir: path.join(tmp, 'relay'), port: 0, host: '127.0.0.1', enrollKey: 'k' });
		const base = `http://127.0.0.1:${relay.port}`;
		const pairing = await relay.relay.createPairing('client');
		const client = (await (await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code }) })).json()).token;
		const api = async (method, route, body, raw) => {
			const response = await fetch(`${base}/api${route}`, { method, headers: { authorization: `Bearer ${client}`, ...(raw ? {} : { 'content-type': 'application/json' }) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
			return response.json();
		};

		// A local repo with an unpushed commit and an uncommitted change.
		const repo = path.join(tmp, 'local');
		fs.mkdirSync(repo);
		git(repo, 'init', '-q', '-b', 'main');
		fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
		git(repo, 'add', '.');
		git(repo, 'commit', '-q', '-m', 'init');
		const head = git(repo, 'rev-parse', 'HEAD');
		git(repo, 'bundle', 'create', path.join(tmp, 'src.bundle'), 'HEAD', 'main');
		fs.writeFileSync(path.join(repo, 'README.md'), '# demo\nlocal edit\n');
		fs.writeFileSync(path.join(tmp, 'src.patch'), git(repo, 'diff', '--binary', 'HEAD') + '\n');
		git(repo, 'checkout', '-q', '--', 'README.md');
		const bundle = await api('PUT', '/blobs?kind=source-bundle', undefined, fs.readFileSync(path.join(tmp, 'src.bundle')));
		const patch = await api('PUT', '/blobs?kind=source-patch', undefined, fs.readFileSync(path.join(tmp, 'src.patch')));

		// The fake agent writes a file and reports in Claude's stream-json shape.
		const fake = path.join(tmp, 'fake-claude.mjs');
		fs.writeFileSync(fake, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('9.9.9 (Fake Claude)'); process.exit(0); }
let prompt = '';
process.stdin.on('data', d => prompt += d);
process.stdin.on('end', () => {
	require('fs').writeFileSync('hello.txt', 'hello from the cloud\\n');
	console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake' }));
	console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'hello.txt' } }] } }));
	console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'Wrote hello.txt for: ' + prompt.trim(), total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1 }));
});
`.replace('require(\'fs\')', 'process.getBuiltinModule(\'fs\')'));
		fs.chmodSync(fake, 0o755);
		process.env.VOLT_RUNNER_CLAUDE_BIN = fake;
		process.env.ANTHROPIC_API_KEY = 'test-only';

		runner = new Runner({ relayUrl: base, enrollKey: 'k', name: 'fake-runner', dataDir: path.join(tmp, 'runner'), workDir: path.join(tmp, 'runner', 'work'), heartbeatMs: 200 });
		await runner.start();
		const machines = await api('GET', '/machines');
		const machine = machines.machines.find(candidate => candidate.name === 'fake-runner');
		assert.equal(machine.caps.agents.claude.installed, true);

		const task = await api('POST', '/tasks', { title: 'Say hello', prompt: 'write hello.txt', agent: 'claude', source: { bundleBlob: bundle.id, patchBlob: patch.id, baseCommit: head, baseBranch: 'main' }, target: { machineId: machine.id } });
		let done;
		for (let i = 0; i < 100 && !done; i++) {
			await new Promise(resolve => setTimeout(resolve, 100));
			const current = await api('GET', `/tasks/${task.id}`);
			done = ['succeeded', 'failed', 'cancelled'].includes(current.status) ? current : undefined;
		}
		assert.equal(done?.status, 'succeeded', JSON.stringify(done));
		assert.match(done.result.summary, /Wrote hello.txt for: write hello.txt/);
		assert.equal(done.result.stats.files, 1);
		assert.equal(done.result.files[0].path, 'hello.txt');
		const log = await api('GET', `/tasks/${task.id}/log`);
		assert.ok(log.lines.some(line => line.t === 'tool' && line.name === 'Write'));

		// "Apply locally": fetch the result bundle into the original repo and check the branch out.
		const resultBundle = path.join(tmp, 'result.bundle');
		fs.writeFileSync(resultBundle, Buffer.from(await (await fetch(`${base}/api/blobs/${done.result.bundleBlob}`, { headers: { authorization: `Bearer ${client}` } })).arrayBuffer()));
		git(repo, 'fetch', '-q', resultBundle, `${done.result.branch}:${done.result.branch}`);
		const worktree = path.join(tmp, 'applied');
		git(repo, 'worktree', 'add', '-q', worktree, done.result.branch);
		assert.equal(fs.readFileSync(path.join(worktree, 'hello.txt'), 'utf8'), 'hello from the cloud\n');
		// The uncommitted local edit travelled too, as its own commit before the agent's.
		assert.equal(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8'), '# demo\nlocal edit\n');
		assert.equal(git(worktree, 'diff', '--name-only', done.result.baseCommit, 'HEAD'), 'hello.txt');
	});
});
