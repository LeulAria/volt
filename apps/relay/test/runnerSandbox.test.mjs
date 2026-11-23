/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A task's agent in Volt's real OS sandbox (05-limitations item 20), on macOS, from a Volt checkout
 * whose `out` folder holds the transpiled sandbox (`npm run transpile-client-oxc`). Skipped where
 * either is missing (the relay's own CI job checks out only apps/relay). The home folder is a fresh
 * one outside temp, as the sandbox bench makes it: temp is writable for agents, so a home below it
 * could not show that the home is out of reach.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'out');
const available = process.platform === 'darwin' && fs.existsSync(path.join(out, 'vs/platform/voltSandbox/node/sandboxLauncher.js')) && process.env.VOLT_RUNNER_SANDBOX !== 'off';

// Before the launcher reads it: its caches and the agent's config overlay live under the home folder.
const home = available ? fs.realpathSync(fs.mkdtempSync(path.join('/Users/Shared', 'volt-runner-sbx-'))) : '';
if (available) {
	process.env.HOME = home;
}

describe('a task\'s agent in Volt\'s sandbox (macOS, real Seatbelt)', { skip: available ? false : 'needs macOS and a Volt checkout with out/' }, () => {
	let runner;
	after(async () => {
		await runner?.stop();
		fs.rmSync(home, { recursive: true, force: true });
	});

	test('writes its checkout; never the runner\'s token, a credential, the home folder or a git hook; never sees the enrol key', async () => {
		const { Runner } = await import('../src/runner/runner.mjs');
		const { AGENTS } = await import('../src/runner/agents.mjs');
		const dataDir = path.join(home, '.volt-runner');
		const checkout = path.join(dataDir, 'work', 'task_sbx', 'repo');
		fs.mkdirSync(checkout, { recursive: true });
		execFileSync('git', ['init', '-q', checkout]);
		fs.mkdirSync(path.join(checkout, '.git', 'hooks'), { recursive: true });
		fs.writeFileSync(path.join(dataDir, 'token'), 'relay-runner-token');
		fs.mkdirSync(path.join(home, '.ssh'));
		fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\n');

		// The fake agent lives in temp (readable) and runs on the node that runs this test (on PATH).
		const agent = path.join(fs.realpathSync(os.tmpdir()), `volt-runner-probe-${process.pid}.mjs`);
		const at = name => JSON.stringify(name);
		fs.writeFileSync(agent, `#!${process.execPath}
const fs = process.getBuiltinModule('fs');
const read = p => { try { fs.readFileSync(p, 'utf8'); return 'read'; } catch (e) { return e.code; } };
const write = p => { try { fs.writeFileSync(p, 'x'); return 'wrote'; } catch (e) { return e.code; } };
let prompt = '';
process.stdin.on('data', d => prompt += d);
process.stdin.on('end', () => {
	const report = {
		checkout: write('ok.txt'),
		hook: write('.git/hooks/pre-commit'),
		token: read(${at(path.join(dataDir, 'token'))}),
		key: read(${at(path.join(home, '.ssh', 'id_ed25519'))}),
		home: write(${at(path.join(home, 'escape.txt'))}),
		secrets: Object.keys(process.env).filter(name => /RELAY|ENROLL/.test(name)),
	};
	console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(report) }));
});
`);
		fs.chmodSync(agent, 0o755);
		after(() => fs.rmSync(agent, { force: true }));
		process.env.VOLT_RUNNER_CLAUDE_BIN = agent;
		process.env.VOLT_RELAY_ENROLL_KEY = 'enrol-secret';
		process.env.ANTHROPIC_API_KEY = 'test-only';

		runner = new Runner({ relayUrl: 'http://127.0.0.1:9', dataDir, workDir: path.join(dataDir, 'work') });
		await runner.loadSandbox();
		assert.equal(runner.sandbox?.mechanism, 'seatbelt', runner.sandboxReason);
		const events = [];
		const state = {};
		const exit = await runner.runAgent({ id: 'task_sbx', agent: 'claude', prompt: 'probe' }, AGENTS.claude, checkout, new AbortController().signal, { push: event => events.push(event) }, state);
		assert.equal(exit, 0, `${state.error ?? ''} ${events.map(event => event.text).join('\n')}`);
		const report = JSON.parse(state.summary);
		assert.equal(report.checkout, 'wrote');
		assert.equal(fs.readFileSync(path.join(checkout, 'ok.txt'), 'utf8'), 'x');
		// Refused by the sandbox (EPERM), not missing: every path exists or its folder does.
		const refused = code => ['EPERM', 'EACCES'].includes(code);
		assert.ok(refused(report.hook), report.hook);
		assert.equal(fs.existsSync(path.join(checkout, '.git', 'hooks', 'pre-commit')), false);
		assert.ok(refused(report.token), report.token);
		assert.ok(refused(report.key), report.key);
		assert.ok(refused(report.home), report.home);
		assert.equal(fs.existsSync(path.join(home, 'escape.txt')), false);
		assert.deepEqual(report.secrets, []);
		assert.ok(events.some(event => /runs in Volt's sandbox/.test(event.text ?? '')));
	});
});
