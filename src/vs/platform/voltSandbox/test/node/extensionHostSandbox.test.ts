/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P2: T3 extension hosts in a real sandbox (H.1, H.7, H.8). The host here is a stand-in for
 * `bootstrap-fork` that does what extensions do (read its folder, write its storage, start a
 * language server, use the network) and reports what the sandbox let through; the real extension
 * host process runs in `extensionHostSandboxProcess.test.ts`.
 *
 * Like the other real-sandbox suites: a machine without a working backend skips loudly, and with
 * `VOLT_SANDBOX_REQUIRED` set it fails instead. Linux: run in the rig (scripts/volt-sandbox-linux-test.sh suite).
 */

import assert from 'assert';
import { promises as fs } from 'fs';
import * as net from 'net';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { handOffWhenReady, SandboxedExtensionHosts } from '../../node/extensionHostSandbox.js';
import { PrincipalRegistry } from '../../node/principalRegistry.js';
import { SandboxManager } from '../../node/sandboxManager.js';
import { ISandboxHostFacts, sandboxHostFacts } from '../../node/sandboxResolver.js';
import { ISandboxedHost, SandboxSupervisor } from '../../node/supervisor.js';
import { realSandboxAvailable } from './sandboxSuiteGate.js';

/**
 * The stand-in host: says READY like VS Code's extension host, takes its connection from the
 * channel, and runs the probes it is asked for, answering on the channel.
 */
const HOST_SCRIPT = `
const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawnSync } = require('child_process');
const tryRead = p => { try { fs.readFileSync(p); return 'read'; } catch (e) { return e.code || 'error'; } };
const tryWrite = p => { try { fs.writeFileSync(p, 'x'); return 'wrote'; } catch (e) { return e.code || 'error'; } };
process.on('message', (m, handle) => {
	if (m && m.type === 'VSCODE_EXTHOST_IPC_SOCKET' && handle) { handle.write('hello from the host'); handle.end(); return; }
	if (!m || m.op !== 'probe') { return; }
	const out = {
		env: { ESM: process.env.VSCODE_ESM_ENTRYPOINT, SOCKET: process.env.VSCODE_EXTHOST_WILL_SEND_SOCKET, RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE, SECRET: process.env.VOLT_TEST_SECRET_TOKEN === undefined ? 'absent' : 'present', NODE_OPTIONS: process.env.NODE_OPTIONS === undefined ? 'absent' : 'present' },
		ownFolder: tryRead(m.ownFile),
		homeSecret: tryRead(m.homeSecret),
		otherExtension: tryRead(m.otherExtensionFile),
		otherStorage: tryRead(m.otherStorageFile),
		toolchain: tryRead(m.toolchainFile),
		workspaceRead: tryRead(m.workspaceFile),
		workspaceWrite: tryWrite(m.workspaceFile + '.new'),
		storageWrite: tryWrite(m.storageFile),
		homeWrite: tryWrite(m.homeWriteFile),
	};
	// A language-server-style child: started, answers, and is confined like its parent.
	const child = spawnSync('/bin/sh', ['-c', 'echo server-up; cat "$1" >/dev/null 2>&1 && echo child-read-home || echo child-denied', 'sh', m.homeSecret], { encoding: 'utf8' });
	out.child = (child.stdout || '').trim().split('\\n');
	const direct = net.connect({ host: '1.1.1.1', port: 443 });
	const finish = (directResult) => {
		const proxy = new URL(process.env.HTTPS_PROXY || 'http://127.0.0.1:9');
		const req = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: 'example.com:443', headers: { 'proxy-authorization': 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') } });
		req.on('connect', res => { out.direct = directResult; out.proxy = res.statusCode; process.send(out); });
		req.on('response', res => { out.direct = directResult; out.proxy = res.statusCode; process.send(out); });
		req.on('error', e => { out.direct = directResult; out.proxy = e.code; process.send(out); });
		req.end();
	};
	direct.once('connect', () => { direct.destroy(); finish('connected'); });
	direct.once('error', e => finish(e.code || 'error'));
	setTimeout(() => finish('timeout'), 5000).unref();
});
process.send({ type: 'VSCODE_EXTHOST_IPC_READY' });
setInterval(() => {}, 1 << 30);
`;

suite('Volt T3 extension hosts (P2, real sandbox)', function () {

	this.timeout(120_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let ws: string;
	let ext: string;
	let otherExt: string;
	let storage: string;
	let otherStorage: string;
	let script: string;
	let host: ISandboxHostFacts;
	let available = false;
	const managers: SandboxManager[] = [];

	suiteSetup(async function () {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-sbx-t3-')));
		home = join(root, 'home');
		ws = join(root, 'ws');
		ext = join(home, '.volt', 'extensions', 'pub.lint-1.0.0');
		otherExt = join(home, '.volt', 'extensions', 'pub.other-1.0.0');
		storage = join(root, 'data', 'User', 'globalStorage', 'pub.lint');
		otherStorage = join(root, 'data', 'User', 'globalStorage', 'pub.other');
		for (const dir of [home, ws, ext, otherExt, storage, otherStorage, join(home, '.cargo'), join(home, '.volt', 'sandbox', 'runs')]) {
			await fs.mkdir(dir, { recursive: true });
		}
		script = join(ext, 'host.js');
		await fs.writeFile(script, HOST_SCRIPT);
		await fs.writeFile(join(ext, 'package.json'), '{"name":"lint","publisher":"pub"}');
		await fs.writeFile(join(otherExt, 'package.json'), '{"name":"other","publisher":"pub"}');
		await fs.writeFile(join(otherStorage, 'state.json'), '{"secret":1}');
		await fs.writeFile(join(home, 'notes.txt'), 'private');
		await fs.writeFile(join(home, '.cargo', 'env'), 'toolchain');
		await fs.writeFile(join(ws, 'main.rs'), 'fn main() {}');
		host = { ...await sandboxHostFacts(), home };
		const probe = new SandboxManager(undefined, { runRoot: join(home, '.volt', 'sandbox', 'runs'), host });
		managers.push(probe);
		available = realSandboxAvailable(await probe.capabilities(), 'T3 extension host suite');
	});

	suiteTeardown(async () => {
		await Promise.all(managers.map(m => m.dispose()));
		if (root) {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	setup(function () {
		if (!available) {
			this.skip();
		}
	});

	function hosts(): SandboxedExtensionHosts {
		const manager = new SandboxManager(undefined, { runRoot: join(home, '.volt', 'sandbox', 'runs'), host });
		managers.push(manager);
		const registry = new PrincipalRegistry('t3-test');
		const supervisor = new SandboxSupervisor(manager, undefined, { sampleMs: 0, registry });
		store.add({ dispose: () => { supervisor.dispose(); registry.dispose(); } });
		return new SandboxedExtensionHosts(supervisor, registry);
	}

	async function startLint(trusted: boolean): Promise<{ host: ISandboxedHost; readyHandOff: Promise<string> }> {
		const server = net.createServer();
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as net.AddressInfo).port;
		const client = net.connect({ host: '127.0.0.1', port });
		const accepted = await new Promise<net.Socket>(resolve => server.once('connection', resolve));
		let received = '';
		client.on('data', data => { received += data.toString(); });
		const ended = new Promise<string>(resolve => client.once('end', () => { server.close(); resolve(received); }));
		const result = await hosts().start({
			extension: { id: 'pub.lint', builtin: false, main: true, browser: false, extensionKind: ['workspace'], location: ext },
			workspaceRoots: [ws],
			workspaceTrusted: trusted,
			storageDir: storage,
			bootstrapFork: script,
			appRoots: [],
			args: ['--type=extensionHost'],
			hostEnv: { PATH: '/usr/bin:/bin', HOME: home, VOLT_TEST_SECRET_TOKEN: 'sk-should-not-pass', NODE_OPTIONS: '--require /tmp/evil.js' },
			home,
		});
		assert.ok(result.ok, result.ok ? '' : `${result.code}: ${result.reason}`);
		// Attached late on purpose: the host said READY at once, and the supervisor kept it for the first listener.
		await new Promise(resolve => setTimeout(resolve, 200));
		const handed = handOffWhenReady(result, () => ({ message: { type: 'VSCODE_EXTHOST_IPC_SOCKET', initialDataChunk: '', skipWebSocketFrames: true, permessageDeflate: false, inflateBytes: '' }, socket: accepted }));
		return { host: result.host, readyHandOff: handed.then(ok => { assert.ok(ok, 'handed off'); return ended; }) };
	}

	function probe(h: ISandboxedHost): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { listener.dispose(); reject(new Error(`no probe answer: ${h.stderrTail()}`)); }, 30_000);
			const listener = h.onMessage(m => {
				const value = m as Record<string, unknown>;
				if (value && 'ownFolder' in value) {
					clearTimeout(timer);
					listener.dispose();
					resolve(value);
				}
			});
			assert.ok(h.send({
				op: 'probe', ownFile: join(ext, 'package.json'), homeSecret: join(home, 'notes.txt'), otherExtensionFile: join(otherExt, 'package.json'),
				otherStorageFile: join(otherStorage, 'state.json'), toolchainFile: join(home, '.cargo', 'env'), workspaceFile: join(ws, 'main.rs'),
				storageFile: join(storage, 'cache.json'), homeWriteFile: join(home, 'planted.txt'),
			}));
		});
	}

	test('T3-HOST-1: one extension alone in an attested host; its connection is handed over on the channel; H.7 reads, writes, exec and network', async () => {
		const { host: h, readyHandOff } = await startLint(true);
		try {
			assert.strictEqual(h.state, 'running');
			assert.ok(h.attestation, 'attested before it ran');
			assert.strictEqual(h.principal.subject, 'plugin:pub.lint@local');
			assert.strictEqual(h.principal.kind, 't3');
			assert.strictEqual(await readyHandOff, 'hello from the host', 'the socket reached the host and only it');
			const out = await probe(h);
			assert.deepStrictEqual(out.env, { ESM: 'vs/workbench/api/node/extensionHostProcess', SOCKET: '1', RUN_AS_NODE: '1', SECRET: 'absent', NODE_OPTIONS: 'absent' }, 'the fixed env (F.7), launcher names last, no secrets');
			assert.strictEqual(out.ownFolder, 'read');
			assert.strictEqual(out.toolchain, 'read');
			assert.strictEqual(out.workspaceRead, 'read', 'a trusted workspace is readable');
			assert.notStrictEqual(out.homeSecret, 'read', 'home is not readable');
			assert.notStrictEqual(out.otherExtension, 'read', 'another extension\'s folder is not readable');
			assert.notStrictEqual(out.otherStorage, 'read', 'another extension\'s storage is not readable');
			assert.notStrictEqual(out.workspaceWrite, 'wrote', 'no raw workspace write');
			assert.strictEqual(out.storageWrite, 'wrote', 'its own storage');
			assert.notStrictEqual(out.homeWrite, 'wrote');
			assert.deepStrictEqual(out.child, ['server-up', 'child-denied'], 'a language server starts and is confined like its parent');
			assert.notStrictEqual(out.direct, 'connected', 'no direct network');
			assert.strictEqual(out.proxy, 403, 'the broker refuses an undeclared host');
			await assert.rejects(fs.stat(join(home, 'planted.txt')));
		} finally {
			await h.terminate();
		}
	});

	test('T3-HOST-2: an untrusted workspace is not readable; "Allow host" opens one destination live', async () => {
		const { host: h, readyHandOff } = await startLint(false);
		try {
			await readyHandOff;
			const out = await probe(h);
			assert.notStrictEqual(out.workspaceRead, 'read', 'an untrusted workspace is not readable');
			assert.ok(h.networkRoute(), 'the host has its own broker route');
			assert.strictEqual(h.networkRoute()!.principal.subject, 'plugin:pub.lint@local');
		} finally {
			await h.terminate();
		}
	});

	test('T3-HOST-3: an extension that can\'t be sandboxed is refused before anything starts', async () => {
		const result = await hosts().start({
			extension: { id: 'pub.ui', builtin: false, main: true, browser: false, extensionKind: ['ui'], location: ext },
			workspaceRoots: [ws], workspaceTrusted: true, storageDir: storage, bootstrapFork: script, appRoots: [], args: [], hostEnv: {}, home,
		});
		assert.ok(!result.ok && result.code === 'ui-full-access', 'needs "Run with full access"');
	});
});
