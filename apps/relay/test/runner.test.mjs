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
import { AGENTS, codexSandboxArgs, parseAgentLine, runnerAgentEnv, runnerAgentEnvParts, toolSummary } from '../src/runner/agents.mjs';
import { LoadSampler } from '../src/runner/load.mjs';
import { Runner } from '../src/runner/runner.mjs';
import { loadRunnerSandbox, runnerSandboxMode } from '../src/runner/sandbox.mjs';
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

describe('agent launch (B-06)', () => {
	test('the agent gets an allow-listed environment: never the runner\'s secrets or another agent\'s key', () => {
		const host = {
			PATH: '/usr/bin', HOME: '/home/runner', LANG: 'C.UTF-8', LC_ALL: 'C', HTTPS_PROXY: 'http://proxy:3128',
			VOLT_RELAY_ENROLL_KEY: 'enrol-secret', VOLT_RELAY_TOKEN: 'relay-token', VOLT_RELAY_ADMIN_TOKEN: 'admin', VOLT_RUNNER_GIT_PUSH: '1',
			ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-openai', AWS_SECRET_ACCESS_KEY: 'aws', GITHUB_TOKEN: 'gh',
		};
		assert.deepEqual(runnerAgentEnv('claude', host), { PATH: '/usr/bin', HOME: '/home/runner', LANG: 'C.UTF-8', LC_ALL: 'C', HTTPS_PROXY: 'http://proxy:3128', ANTHROPIC_API_KEY: 'sk-ant' });
		assert.deepEqual(runnerAgentEnv('codex', host), { PATH: '/usr/bin', HOME: '/home/runner', LANG: 'C.UTF-8', LC_ALL: 'C', HTTPS_PROXY: 'http://proxy:3128', OPENAI_API_KEY: 'sk-openai' });
		assert.deepEqual(Object.keys(runnerAgentEnv('unknown', host)).filter(name => /KEY|TOKEN|SECRET/.test(name)), []);
	});

	test('Codex keeps its own sandbox on Linux and macOS; off only on Windows or by the operator\'s explicit choice', () => {
		for (const platform of ['linux', 'darwin']) {
			const args = codexSandboxArgs(platform, {});
			assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'), platform);
			assert.deepEqual(args.slice(0, 2), ['--sandbox', 'workspace-write']);
		}
		assert.deepEqual(codexSandboxArgs('linux', { VOLT_RUNNER_CODEX_SANDBOX: 'off' }), ['--dangerously-bypass-approvals-and-sandbox']);
		assert.deepEqual(codexSandboxArgs('win32', {}), ['--dangerously-bypass-approvals-and-sandbox']);
	});
});

describe('agent in Volt\'s sandbox (05-limitations item 20)', () => {
	const fakeAgent = (body) => {
		const file = path.join(tmp, `agent-${Math.random().toString(36).slice(2)}.mjs`);
		fs.writeFileSync(file, `const fs = process.getBuiltinModule('fs');\nlet prompt = '';\nprocess.stdin.on('data', d => prompt += d);\nprocess.stdin.on('end', () => {\n${body}\n});\n`);
		return file;
	};
	const withEnv = async (values, fn) => {
		const saved = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
		Object.assign(process.env, values);
		try {
			return await fn();
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) {
					delete process.env[name];
				} else {
					process.env[name] = value;
				}
			}
		}
	};

	test('the sandbox gets only the allow-listed environment; the agent\'s credentials and the task id are set on purpose', () => {
		const host = { PATH: '/usr/bin', HOME: '/home/runner', VOLT_RELAY_ENROLL_KEY: 'enrol-secret', VOLT_RELAY_TOKEN: 'relay-token', ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-openai', NPM_TOKEN: 'npm', DB_PASSWORD: 'pw' };
		assert.deepEqual(runnerAgentEnvParts('claude', host), { base: { PATH: '/usr/bin', HOME: '/home/runner' }, credentials: { ANTHROPIC_API_KEY: 'sk-ant' } });
		assert.deepEqual(runnerAgentEnvParts('codex', host).credentials, { OPENAI_API_KEY: 'sk-openai' });
		assert.deepEqual(runnerAgentEnv('claude', host), { PATH: '/usr/bin', HOME: '/home/runner', ANTHROPIC_API_KEY: 'sk-ant' });
	});

	test('Codex\'s own sandbox is off only inside Volt\'s, which encloses it', () => {
		assert.deepEqual(codexSandboxArgs('darwin', {}, true), ['--sandbox', 'danger-full-access', '-c', 'approval_policy="never"']);
		assert.ok(AGENTS.codex.command({}, { sandboxed: true }).args.includes('danger-full-access'));
		assert.ok(!AGENTS.codex.command({}, { sandboxed: false }).args.includes('danger-full-access'));
	});

	test('modes, and why there is no sandbox: off, Windows, no Volt build', async () => {
		assert.equal(runnerSandboxMode({}), 'auto');
		assert.equal(runnerSandboxMode({ VOLT_RUNNER_SANDBOX: 'required' }), 'required');
		assert.equal(runnerSandboxMode({ VOLT_RUNNER_SANDBOX: 'off' }), 'off');
		const dataDir = path.join(tmp, 'sbx-data');
		assert.equal((await loadRunnerSandbox({ env: { VOLT_RUNNER_SANDBOX: 'off' }, dataDir })).sandbox, undefined);
		assert.match((await loadRunnerSandbox({ env: {}, platform: 'win32', dataDir })).reason, /Windows/);
		assert.match((await loadRunnerSandbox({ env: { VOLT_RUNNER_SANDBOX_OUT: path.join(tmp, 'no-volt-build') }, platform: 'linux', dataDir })).reason, /no Volt build/);
		// Required and missing: the runner stops before it claims a task.
		await withEnv({ VOLT_RUNNER_SANDBOX: 'required', VOLT_RUNNER_SANDBOX_OUT: path.join(tmp, 'no-volt-build') }, async () => {
			const runner = new Runner({ relayUrl: 'http://127.0.0.1:9', dataDir, workDir: path.join(dataDir, 'work') });
			await assert.rejects(runner.loadSandbox(), /VOLT_RUNNER_SANDBOX=required/);
		});
	});

	test('the agent starts through the sandbox\'s launch, which gets the checkout as its only workspace, and is confirmed before it runs', async () => {
		const prepared = [];
		const disposed = [];
		const sandbox = {
			mechanism: 'seatbelt',
			detail: 'macOS test',
			prepare: async request => {
				prepared.push(request);
				return {
					command: process.execPath,
					args: [request.binary, ...request.args],
					cwd: request.checkout,
					env: { ...request.hostEnv, ...request.env },
					extraStdio: [],
					confirm: async () => ({ ok: true, detail: 'test' }),
					terminate: async child => { child.kill('SIGKILL'); },
					dispose: () => disposed.push(request.taskId),
				};
			},
		};
		const agent = fakeAgent(`console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify({ enrol: process.env.VOLT_RELAY_ENROLL_KEY ?? null, key: process.env.ANTHROPIC_API_KEY ?? null, task: process.env.VOLT_CLOUD_TASK }) }));`);
		const checkout = fs.mkdtempSync(path.join(tmp, 'checkout-'));
		await withEnv({ VOLT_RUNNER_CLAUDE_BIN: agent, VOLT_RELAY_ENROLL_KEY: 'enrol-secret', ANTHROPIC_API_KEY: 'sk-ant' }, async () => {
			const runner = new Runner({ relayUrl: 'http://127.0.0.1:9', dataDir: path.join(tmp, 'sbx-run'), workDir: path.join(tmp, 'sbx-run', 'work'), sandbox });
			await runner.loadSandbox();
			const events = [];
			const state = {};
			const exit = await runner.runAgent({ id: 'task_1', agent: 'claude', prompt: 'hi' }, AGENTS.claude, checkout, new AbortController().signal, { push: event => events.push(event) }, state);
			assert.equal(exit, 0);
			assert.deepEqual(JSON.parse(state.summary), { enrol: null, key: 'sk-ant', task: 'task_1' });
			assert.equal(prepared.length, 1);
			assert.equal(prepared[0].checkout, checkout);
			assert.equal(prepared[0].agent, 'claude');
			assert.equal(prepared[0].hostEnv.ANTHROPIC_API_KEY, undefined, 'credentials are not left to the profile\'s filter');
			assert.equal(prepared[0].hostEnv.VOLT_RELAY_ENROLL_KEY, undefined);
			assert.equal(prepared[0].env.ANTHROPIC_API_KEY, 'sk-ant');
			assert.ok(events.some(event => /runs in Volt's sandbox \(macOS test\)/.test(event.text ?? '')));
			assert.deepEqual(disposed, ['task_1']);
		});
	});

	test('a launch the sandbox cannot confirm is stopped, never run unconfined', async () => {
		const marker = path.join(tmp, `ran-${Date.now()}`);
		const agent = fakeAgent(`setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, 'ran'); console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ran' })); }, 1500);`);
		let terminated = 0;
		const sandbox = {
			mechanism: 'seatbelt',
			detail: 'macOS test',
			prepare: async request => ({
				command: process.execPath,
				args: [request.binary, ...request.args],
				cwd: request.checkout,
				env: { ...request.hostEnv, ...request.env },
				extraStdio: [],
				confirm: async () => ({ ok: false, error: 'no evidence the process is sandboxed' }),
				terminate: async child => { terminated++; child.kill('SIGKILL'); },
				dispose: () => undefined,
			}),
		};
		await withEnv({ VOLT_RUNNER_CLAUDE_BIN: agent }, async () => {
			const runner = new Runner({ relayUrl: 'http://127.0.0.1:9', dataDir: path.join(tmp, 'sbx-run2'), workDir: path.join(tmp, 'sbx-run2', 'work'), sandbox });
			await runner.loadSandbox();
			const state = {};
			const exit = await runner.runAgent({ id: 'task_2', agent: 'claude', prompt: 'hi' }, AGENTS.claude, fs.mkdtempSync(path.join(tmp, 'checkout-')), new AbortController().signal, { push: () => undefined }, state);
			assert.notEqual(exit, 0);
			assert.equal(state.failed, true);
			assert.match(state.error, /could not be confirmed.*no evidence/);
			assert.equal(terminated, 1);
			assert.equal(fs.existsSync(marker), false);
		});
	});

	test('a launch the sandbox refuses fails the task', async () => {
		const sandbox = { mechanism: 'seatbelt', detail: 'macOS test', prepare: async () => { throw new Error('Volt\'s sandbox policy refused this launch'); } };
		const runner = new Runner({ relayUrl: 'http://127.0.0.1:9', dataDir: path.join(tmp, 'sbx-run3'), workDir: path.join(tmp, 'sbx-run3', 'work'), sandbox });
		await runner.loadSandbox();
		await assert.rejects(runner.runAgent({ id: 'task_3', agent: 'claude', prompt: 'hi' }, AGENTS.claude, tmp, new AbortController().signal, { push: () => undefined }, {}), /refused this launch/);
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
