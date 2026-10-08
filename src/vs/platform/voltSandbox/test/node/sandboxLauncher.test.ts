/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import * as http from 'http';
import { homedir, tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ISandboxViolationEvent, VoltSandboxLauncher } from '../../node/sandboxLauncher.js';
import { SandboxNetworkProxy, splitHostPort } from '../../node/sandboxProxy.js';

const logger = { info: () => undefined, warn: () => undefined };

function run(command: string, args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number | null; output: string }> {
	return new Promise(resolve => {
		const child = spawn(command, args, { cwd, env: { ...process.env, ...env } });
		let output = '';
		child.stdout.on('data', d => output += d);
		child.stderr.on('data', d => output += d);
		child.on('close', code => resolve({ code, output }));
	});
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

suite('Volt sandbox launcher (real processes)', function () {

	this.timeout(60_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	const sandboxed = process.platform === 'darwin' || (process.platform === 'linux' && !!process.env.VOLT_SANDBOX_LINUX_TEST);
	let root: string;
	let outside: string;
	let state: string;

	setup(async () => {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-sbx-ws-')));
		// Outside every writable root: not temp, not an agent state folder.
		outside = await fs.mkdtemp(join(homedir(), '.volt-sbx-outside-'));
		state = await fs.mkdtemp(join(tmpdir(), 'volt-sbx-state-'));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
		await fs.rm(state, { recursive: true, force: true });
	});

	test('a write inside the workspace works, outside it fails, and the kernel reports the denial', async function () {
		if (!sandboxed) {
			this.skip();
		}
		const launcher = new VoltSandboxLauncher(state, logger);
		const events: ISandboxViolationEvent[] = [];
		const listener = launcher.onViolation(e => events.push(e));
		try {
			const support = await launcher.getSupport();
			assert.ok(support.filesystem, support.detail);
			const script = `echo in > "${root}/in.txt"; echo out > "${outside}/out.txt"; mkdir "${root}/.git"; mkdir -p "${root}/.git/hooks" 2>/dev/null; echo done`;
			const launch = await launcher.prepare('/bin/sh', ['-c', script], { level: 'workspace-write', network: true, providerId: 'claude-code', workspaceRoots: [root] });
			// The log stream needs a moment before it sees anything.
			await delay(1500);
			const result = await run(launch.command, launch.args, launch.env, root);
			assert.ok(result.output.includes('done'), result.output);
			assert.ok(existsSync(join(root, 'in.txt')), 'inside the workspace');
			assert.ok(!existsSync(join(outside, 'out.txt')), 'outside the workspace');
			assert.match(result.output, /Operation not permitted|Permission denied/);
			assert.ok(!existsSync(join(root, '.git', 'hooks')), 'git hooks are never writable');
			if (process.platform === 'darwin') {
				for (let i = 0; i < 40 && !events.some(e => e.denial.target.startsWith(outside)); i++) {
					await delay(250);
				}
				const denial = events.find(e => e.denial.target === join(outside, 'out.txt'));
				assert.ok(denial, `kernel denial reported: ${JSON.stringify(events)}`);
				assert.strictEqual(denial.tag, launch.tag);
				assert.strictEqual(denial.denial.kind, 'write');
				assert.strictEqual(denial.denial.source, 'os');
			}
			launch.dispose();
		} finally {
			listener.dispose();
			launcher.dispose();
		}
	});

	test('read-only: the workspace cannot be written, temp can', async function () {
		if (!sandboxed) {
			this.skip();
		}
		const launcher = new VoltSandboxLauncher(state, logger);
		try {
			const scratch = await fs.mkdtemp(join(tmpdir(), 'volt-sbx-tmp-'));
			const launch = await launcher.prepare('/bin/sh', ['-c', `echo a > "${root}/a.txt"; echo b > "${scratch}/b.txt"; echo done`], { level: 'read-only', network: true, providerId: 'claude-code', workspaceRoots: [root] });
			const result = await run(launch.command, launch.args, launch.env, root);
			assert.ok(result.output.includes('done'), result.output);
			assert.ok(!existsSync(join(root, 'a.txt')));
			assert.ok(existsSync(join(scratch, 'b.txt')));
			launch.dispose();
			await fs.rm(scratch, { recursive: true, force: true });
		} finally {
			launcher.dispose();
		}
	});

	test('network off: loopback works, other hosts are refused by the proxy, and a bypass is blocked by the OS', async function () {
		if (process.platform !== 'darwin') {
			this.skip();
		}
		const server = http.createServer((_req, res) => res.end('local-ok'));
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
		const port = (server.address() as { port: number }).port;
		const launcher = new VoltSandboxLauncher(state, logger);
		const events: ISandboxViolationEvent[] = [];
		const listener = launcher.onViolation(e => events.push(e));
		try {
			const launch = await launcher.prepare('/bin/sh', ['-c', [
				`curl -s http://127.0.0.1:${port}/`,
				'echo',
				'curl -s -o /dev/null -w "proxied=%{http_code}\\n" https://blocked.example.invalid/',
				'curl -s -m 5 --noproxy "*" -o /dev/null -w "direct=%{http_code}\\n" https://93.184.215.14/ || echo direct-failed',
			].join('; ')], { level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: [root] });
			const result = await run(launch.command, launch.args, launch.env, root);
			assert.ok(result.output.includes('local-ok'), result.output);
			assert.ok(/proxied=(403|000)/.test(result.output), result.output);
			assert.ok(/direct=000|direct-failed/.test(result.output), result.output);
			assert.ok(events.some(e => e.denial.kind === 'network' && e.denial.target === 'blocked.example.invalid' && e.denial.source === 'proxy'), JSON.stringify(events));
			launch.dispose();
		} finally {
			listener.dispose();
			launcher.dispose();
			server.close();
		}
	});

	test('proxy: allowed hosts tunnel, blocked hosts get a 403 naming the host', async () => {
		const target = http.createServer((_req, res) => res.end('target-ok'));
		await new Promise<void>(resolve => target.listen(0, '127.0.0.1', () => resolve()));
		const targetPort = (target.address() as { port: number }).port;
		const blocked: string[] = [];
		const proxy = await SandboxNetworkProxy.start([], host => blocked.push(host));
		try {
			const viaProxy = (url: string) => new Promise<{ status: number; body: string }>(resolve => {
				const req = http.request({ host: '127.0.0.1', port: proxy.port, path: url, method: 'GET' }, res => {
					let body = '';
					res.on('data', d => body += d);
					res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
				});
				req.end();
			});
			const ok = await viaProxy(`http://localhost:${targetPort}/`);
			assert.strictEqual(ok.body, 'target-ok', 'loopback is always allowed');
			const no = await viaProxy('http://evil.example/');
			assert.strictEqual(no.status, 403);
			assert.ok(no.body.includes('evil.example'));
			assert.deepStrictEqual(blocked, ['evil.example']);
			proxy.allow(['evil.example']);
			assert.ok(proxy.isAllowed('evil.example'));
			assert.deepStrictEqual(splitHostPort('[::1]:8080', 443), { host: '::1', port: 8080 });
			assert.deepStrictEqual(splitHostPort('api.x.ai', 443), { host: 'api.x.ai', port: 443 });
		} finally {
			proxy.dispose();
			target.close();
		}
	});
});
