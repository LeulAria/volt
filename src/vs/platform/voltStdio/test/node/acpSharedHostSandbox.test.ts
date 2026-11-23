/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../log/common/log.js';
import { IVoltSandboxRequest } from '../../../voltSandbox/common/sandboxPolicy.js';
import { IResolvedSandboxPolicy } from '../../../voltSandbox/common/sandboxResolved.js';
import { VoltSandboxLauncher } from '../../../voltSandbox/node/sandboxLauncher.js';
import { realSandboxAvailable } from '../../../voltSandbox/test/node/sandboxSuiteGate.js';
import { ACP_SHARED_HOST_SETTING, IVoltExecContext } from '../../common/voltStdio.js';
import { VoltStdioService } from '../../node/voltStdioService.js';
import { writeFakeAcpAdapter } from './acpSharedHostFixture.js';

/**
 * The shared ACP adapter host against the real OS sandbox: several chats on one adapter process, each
 * chat's own process (its CLI; here a shell) held by that chat's sandbox and nobody else's.
 */
suite('Shared ACP adapter host against real sandboxes', function () {

	this.timeout(180_000);
	teardown(() => new Promise(resolve => setTimeout(resolve, available ? 1_500 : 0)));
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let entry: string;
	let stdio: VoltStdioService;
	let config: TestConfigurationService;
	let available = false;
	const markers: string[] = [];
	const output = new Map<string, string[]>();
	const exits = new Map<string, number | null>();
	let nextRequest = 0;

	const exists = (path: string) => fs.lstat(path).then(() => true, () => false);
	const until = async <T>(test: () => T | undefined | false | Promise<T | undefined | false>, what: string): Promise<T> => {
		const deadline = Date.now() + 30_000;
		for (; ;) {
			const value = await test();
			if (value) {
				return value;
			}
			if (Date.now() > deadline) {
				throw new Error(`timed out waiting for ${what}`);
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	};
	const lines = (id: string) => (output.get(id) ?? []).join('').split('\n').filter(Boolean).map(line => JSON.parse(line));
	const ask = async (id: string, request: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const n = ++nextRequest;
		await stdio.write(id, `${JSON.stringify({ id: n, ...request })}\n`);
		return until(() => lines(id).find(reply => reply.id === n), `reply ${n} (${String(request.do)}) of ${id}`);
	};
	/** The text the chat's shell printed so far. */
	const said = (id: string) => lines(id).filter(line => line.event === 'out').map(line => line.data).join('');
	const hostCount = () => (stdio as unknown as { acpHosts: { hostCount: number } }).acpHosts.hostCount;
	const policyOf = (id: string) => (stdio as unknown as { sandboxes: Map<string, { policy: IResolvedSandboxPolicy }> }).sandboxes.get(id)?.policy;
	const context = (chat: string, sandboxed: boolean): IVoltExecContext => ({ principal: `chat:${chat}`, reason: 'agent', sandboxed });
	const sandbox = (ws: string): IVoltSandboxRequest => ({ level: 'workspace-write', network: false, providerId: '', workspaceRoots: [ws] });
	// The adapter host runs on `process.execPath`: Electron under `scripts/test.sh`, which acts as node only when told to.
	const asNode = process.versions['electron'] ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {};
	const open = (chat: string, ws: string, sandboxed = true) => stdio.spawn({ command: process.execPath, args: [entry], cwd: ws, ...asNode, context: context(chat, sandboxed), ...(sandboxed ? { sandbox: sandbox(ws) } : {}), acpHost: { entry } });

	suiteSetup(async function () {
		if (process.platform === 'win32') {
			return;
		}
		// In the home folder: the temp folder is writable in every sandbox, so two workspaces there would not be apart.
		root = await fs.realpath(await fs.mkdtemp(join(homedir(), '.volt-acp-host-')));
		for (const name of ['user-data', 'a', 'b', 'c']) {
			await fs.mkdir(join(root, name), { recursive: true });
		}
		entry = await writeFakeAcpAdapter(root);
		config = new TestConfigurationService();
		stdio = new VoltStdioService(new NullLogService(), config, join(root, 'user-data'));
		stdio.onData(e => output.set(e.id, [...output.get(e.id) ?? [], e.data]));
		stdio.onExit(e => exits.set(e.id, e.code));
		await stdio.which('sh');
		const probe = new VoltSandboxLauncher(join(root, 'user-data'), new NullLogService());
		try {
			available = realSandboxAvailable(await probe.capabilities(), 'shared ACP host suite');
		} finally {
			probe.dispose();
		}
	});

	suiteTeardown(async () => {
		stdio?.dispose();
		for (const marker of markers) {
			await fs.rm(marker, { force: true });
		}
		if (root) {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('ISOLATION-1: chats on one host each run their process in their own sandbox: write-denied, read-denied, crash, stop and resume', async function () {
		if (!available) {
			this.skip();
		}
		const [wsA, wsB, wsC] = ['a', 'b', 'c'].map(name => join(root, name));
		const homeMarker = join(homedir(), `.volt-acp-host-${process.pid}`);
		markers.push(homeMarker);
		const a = await open('a', wsA);
		const b = await open('b', wsB);
		const c = await open('c', wsC, false);
		assert.strictEqual(new Set([a, b, c]).size, 3);
		assert.strictEqual(hostCount(), 1, 'three chats, one adapter process');

		// Before a chat's process runs, a sandboxed chat's file requests are refused (no launch to judge by); an unconfined chat's are not.
		assert.strictEqual(await stdio.sandboxAllows(a, join(wsA, 'x'), 'write'), false);
		assert.strictEqual(await stdio.sandboxAllows(c, join(wsA, 'x'), 'write'), true);

		// Each chat's shell, started by the adapter in the host, runs through the service in the chat's own sandbox.
		for (const id of [a, b, c]) {
			await ask(id, { do: 'start', command: '/bin/sh', args: [] });
		}
		const policy = await until(() => policyOf(a), 'the launch of a\'s process');
		const sentinel = policy.sentinel!;
		assert.ok(sentinel, 'the policy names a path no sandbox may read');
		assert.ok(await until(() => policyOf(b), 'the launch of b\'s process'));
		assert.strictEqual(policyOf(c), undefined, 'an unconfined chat\'s process has no sandbox');
		const script = (own: string, other: string, tag: string) => [
			`echo in > '${own}/own-${tag}.txt'`,
			`echo out > '${other}/from-${tag}.txt' 2>/dev/null`,
			`echo home > '${homeMarker}' 2>/dev/null`,
			`cat '${sentinel}' >/dev/null 2>&1 && echo READ-OK-${tag} || echo READ-DENIED-${tag}`,
			`echo DONE-${tag}`,
			'',
		].join('\n');
		await ask(a, { do: 'say', text: script(wsA, wsB, 'a') });
		await ask(b, { do: 'say', text: script(wsB, wsA, 'b') });
		await until(() => said(a).includes('DONE-a') && said(b).includes('DONE-b'), 'both shells');
		assert.ok(await exists(join(wsA, 'own-a.txt')) && await exists(join(wsB, 'own-b.txt')), 'each chat writes its own workspace');
		assert.ok(!await exists(join(wsB, 'from-a.txt')) && !await exists(join(wsA, 'from-b.txt')), 'WRITE-DENIED: neither chat writes the other\'s workspace');
		assert.ok(!await exists(homeMarker), 'WRITE-DENIED: neither chat writes the home folder');
		assert.ok(said(a).includes('READ-DENIED-a') && said(b).includes('READ-DENIED-b'), `READ-DENIED: ${said(a)} ${said(b)}`);

		// Volt's own checks by the chat's id (ACP fs requests) judge by that chat's launch.
		assert.deepStrictEqual([await stdio.sandboxAllows(a, join(wsA, 'x'), 'write'), await stdio.sandboxAllows(a, join(wsB, 'x'), 'write')], [true, false]);
		assert.deepStrictEqual([await stdio.sandboxAllows(b, join(wsB, 'x'), 'write'), await stdio.sandboxAllows(b, join(wsA, 'x'), 'write')], [true, false]);
		assert.strictEqual((await stdio.sandboxReadFile(a, sentinel)).ok, false);
		assert.strictEqual((await stdio.sandboxWriteFile(a, join(wsB, 'brokered.txt'), 'x')).ok, false);

		// The adapter's own file access in the host, in a chat's context, follows that chat's policy.
		assert.strictEqual((await ask(a, { do: 'read', path: sentinel })).error, 'EACCES');
		assert.strictEqual((await ask(a, { do: 'write', path: join(wsB, 'host-from-a.txt') })).error, 'EACCES');
		assert.strictEqual((await ask(a, { do: 'write', path: join(wsA, 'host-own.txt') })).ok, true);
		assert.strictEqual((await ask(a, { do: 'spawnSync' })).error, 'EPERM');

		// CRASH: one chat's process dies; the others carry on, on the same host.
		await ask(a, { do: 'say', text: 'kill -9 $$\n' });
		await until(() => lines(a).find(line => line.event === 'exit'), 'the end of a\'s process');
		await ask(b, { do: 'say', text: 'echo STILL-b\n' });
		await until(() => said(b).includes('STILL-b'), 'b after a\'s process died');
		assert.strictEqual(exits.has(a), false, 'the chat\'s connection outlives its process');

		// STOP and RESUME: a stopped chat ends alone; a new connection for it runs sandboxed again.
		await stdio.kill(a);
		await until(() => exits.has(a), 'a\'s exit');
		assert.strictEqual(await stdio.sandboxAllows(a, join(wsA, 'x'), 'write'), false, 'a gone chat is unknown again');
		const again = await open('a', wsA);
		await ask(again, { do: 'start', command: '/bin/sh', args: [] });
		await ask(again, { do: 'say', text: `echo out > '${wsB}/from-a-again.txt' 2>/dev/null; echo in > '${wsA}/again.txt'; echo DONE-again\n` });
		await until(() => said(again).includes('DONE-again'), 'the resumed chat');
		assert.ok(await exists(join(wsA, 'again.txt')) && !await exists(join(wsB, 'from-a-again.txt')));
		assert.strictEqual(hostCount(), 1);

		// The last chat's end is the host's.
		for (const id of [again, b, c]) {
			await stdio.kill(id);
		}
		await until(() => hostCount() === 0, 'the idle host to stop');
		await new Promise(resolve => setTimeout(resolve, 3_300));
	});

	test('the setting off starts a process per chat, in the chat\'s sandbox as before', async function () {
		if (!available) {
			this.skip();
		}
		await config.setUserConfiguration(ACP_SHARED_HOST_SETTING, false);
		try {
			const marker = join(root, 'a', 'dedicated.txt');
			const id = await stdio.spawn({ command: '/usr/bin/touch', args: [marker], cwd: join(root, 'a'), context: context('a', true), sandbox: sandbox(join(root, 'a')), acpHost: { entry } });
			await until(() => exits.has(id), 'the dedicated process');
			assert.strictEqual(hostCount(), 0);
			assert.ok(await exists(marker));
			// An ended spawn's sandbox goes after the kernel log's grace (3 s).
			await new Promise(resolve => setTimeout(resolve, 3_300));
		} finally {
			await config.setUserConfiguration(ACP_SHARED_HOST_SETTING, undefined);
		}
	});
});
