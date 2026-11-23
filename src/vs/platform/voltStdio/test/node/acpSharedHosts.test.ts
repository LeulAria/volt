/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChildProcess, ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IResolvedSandboxPolicy, resolvedPolicyAllows } from '../../../voltSandbox/common/sandboxResolved.js';
import { ACP_HOST_POLICY_CHECK_SOURCE } from '../../common/acpSharedHostSource.js';
import { IVoltStdioSpawnOptions } from '../../common/voltStdio.js';
import { AcpSharedHosts, IAcpSharedHostDelegate } from '../../node/acpSharedHosts.js';
import { writeFakeAcpAdapter } from './acpSharedHostFixture.js';

/** A CLI stand-in: says its marked environment once, then echoes its stdin in upper case. */
const FAKE_CLI = `process.stdout.write('env ' + (process.env.ADDED || '-') + ' ' + (process.env.GONE || '-') + ' ' + (process.env.FROM_LAUNCH || '-') + '\\n'); process.stdin.on('data', data => { const text = String(data); if (text.includes('die')) { process.exit(7); } process.stdout.write(text.toUpperCase()); });`;

/**
 * The adapter host and the CLI stand-in run on `process.execPath`: plain node under `npm run test-node`,
 * Electron (its renderer helper) under `scripts/test.sh`, where it only acts as node when told to.
 */
const AS_NODE: Record<string, string> = process.versions['electron'] ? { ELECTRON_RUN_AS_NODE: '1' } : {};

const policy = (over: Partial<IResolvedSandboxPolicy>): IResolvedSandboxPolicy => ({
	name: 't', platform: 'darwin', readAll: false, read: [], write: [], writeFiles: [], deny: [], protect: [], denyPatterns: [], protectPatterns: [],
	newRepositoryGuard: [], gitDirs: [], network: { mode: 'host', allow: [], loopbackPorts: [], listen: false }, unixSockets: [], systemServices: false,
	limits: {} as IResolvedSandboxPolicy['limits'], env: {}, cwd: '/', tmp: '/tmp', home: '/home/u', ...over,
});

suite('Shared ACP adapter host', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let entry: string;
	let hosts: AcpSharedHosts;
	let output: Map<string, string[]>;
	let exits: Map<string, number | null>;
	let started: { id: string; options: IVoltStdioSpawnOptions; unset: readonly string[]; helper: boolean }[];
	let views: Map<string, { env: Record<string, string>; policy: IResolvedSandboxPolicy }>;
	let waiters: (() => void)[];
	const children = new Set<ChildProcess>();

	const stop = (child: ChildProcess) => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGKILL');
		}
	};
	const delegate = (): IAcpSharedHostDelegate => ({
		hostEnv: async () => ({ PATH: process.env['PATH'], HOME: process.env['HOME'], SHARED: 'host', ...AS_NODE }),
		sandboxView: async options => options.sandbox ? views.get(options.cwd ?? '') : undefined,
		startChild: async (id, options, unset, helper) => {
			started.push({ id, options, unset, helper });
			// A sandbox launch takes a moment (prepare, attest): what the adapter wrote meanwhile must not be lost.
			await new Promise(resolve => setTimeout(resolve, 40));
			const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], ...AS_NODE, ...options.env, ...(options.sandbox ? { FROM_LAUNCH: 'sandbox' } : {}) };
			for (const key of unset) {
				delete env[key];
			}
			const child = spawn(options.command, options.args ?? [], { env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
			children.add(child);
			return { child, ...(options.sandbox ? { policy: views.get(options.cwd ?? '')!.policy } : {}) };
		},
		stopChild: (_id, child) => stop(child),
		data: (id, text) => {
			output.set(id, [...output.get(id) ?? [], ...text.split('\n').filter(Boolean)]);
			waiters.splice(0).forEach(wake => wake());
		},
		exited: (id, code) => {
			exits.set(id, code);
			waiters.splice(0).forEach(wake => wake());
		},
		track: (child) => children.add(child),
		stopTree: stop,
		log: () => undefined,
	});

	/** Waits until `test` holds for what arrived. */
	const until = async <T>(test: () => T | undefined | false, what: string): Promise<T> => {
		const deadline = Date.now() + 15_000;
		for (; ;) {
			const value = test();
			if (value) {
				return value;
			}
			if (Date.now() > deadline) {
				throw new Error(`timed out waiting for ${what}`);
			}
			await new Promise<void>(resolve => {
				waiters.push(resolve);
				setTimeout(resolve, 50);
			});
		}
	};
	let nextRequest = 0;
	const ask = async (id: string, request: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const n = ++nextRequest;
		hosts.write(id, `${JSON.stringify({ id: n, ...request })}\n`);
		return until(() => (output.get(id) ?? []).map(line => JSON.parse(line)).find(reply => reply.id === n), `reply ${n} (${String(request.do)})`);
	};
	const events = (id: string) => (output.get(id) ?? []).map(line => JSON.parse(line)).filter(line => line.event);
	const options = (over: Partial<IVoltStdioSpawnOptions> = {}): IVoltStdioSpawnOptions => ({ command: process.execPath, args: [entry], context: { principal: 'volt', reason: 'agent', sandboxed: false }, ...over });

	setup(async () => {
		dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-acp-host-')));
		entry = await writeFakeAcpAdapter(dir);
		await fs.writeFile(join(dir, 'cli.js'), FAKE_CLI);
		output = new Map();
		exits = new Map();
		started = [];
		views = new Map();
		waiters = [];
		hosts = new AcpSharedHosts(delegate());
	});

	teardown(async () => {
		hosts.dispose();
		children.forEach(stop);
		children.clear();
		await fs.rm(dir, { recursive: true, force: true });
	});

	test('two chats share one host; each has its own environment, CLI and file rules', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		this.timeout(60_000);
		const secret = join(dir, 'secret.txt');
		const open = join(dir, 'open.txt');
		await fs.writeFile(secret, 'secret');
		await fs.writeFile(open, 'open');
		views.set('/chat-a', { env: { PATH: process.env['PATH']!, CLAUDE_CONFIG_DIR: '/overlay/a', GONE: 'in-launch' }, policy: policy({ readAll: true, deny: [secret], write: [join(dir, 'w')] }) });
		const a = await hosts.open(options({ cwd: '/chat-a', sandbox: { level: 'workspace-write', network: true, providerId: 'claude-code', workspaceRoots: [dir] }, context: { principal: 'chat:a', reason: 'agent', sandboxed: true } }), entry);
		const b = await hosts.open(options({ cwd: '/chat-b' }), entry);
		assert.ok(a && b && a !== b);
		assert.strictEqual(hosts.hostCount, 1, 'one host for both chats');
		assert.strictEqual(hosts.isUnconfined(a), false);
		assert.strictEqual(hosts.isUnconfined(b), true);

		// Environment: the sandboxed chat sees its launch's, the other the host's.
		assert.deepStrictEqual(await ask(a, { do: 'env', name: 'CLAUDE_CONFIG_DIR' }), { id: nextRequest, value: '/overlay/a', keys: true });
		assert.strictEqual((await ask(b, { do: 'env', name: 'CLAUDE_CONFIG_DIR' })).value, undefined);
		assert.strictEqual((await ask(a, { do: 'env', name: 'SHARED' })).value, undefined, 'a sandboxed chat does not see the host\'s environment');
		assert.strictEqual((await ask(b, { do: 'env', name: 'SHARED' })).value, 'host');

		assert.deepStrictEqual([(await ask(a, { do: 'cwd' })).cwd, (await ask(b, { do: 'cwd' })).cwd], ['/chat-a', '/chat-b'], 'each chat\'s adapter code runs in its own folder');

		// Files: the sandboxed chat's policy holds the host's own reads and writes; the other chat is unconfined.
		assert.deepStrictEqual([(await ask(a, { do: 'read', path: secret })).error, (await ask(a, { do: 'readSync', path: secret })).error], ['EACCES', 'EACCES']);
		assert.strictEqual((await ask(a, { do: 'read', path: open })).text, 'open');
		assert.strictEqual((await ask(b, { do: 'read', path: secret })).text, 'secret');
		assert.strictEqual((await ask(a, { do: 'write', path: join(dir, 'planted.txt') })).error, 'EACCES');
		assert.strictEqual((await ask(b, { do: 'write', path: join(dir, 'b.txt') })).ok, true);

		// Processes: never started in the host; each chat's goes to the service with the chat's own launch.
		assert.strictEqual((await ask(a, { do: 'spawnSync' })).error, 'EPERM');
		await ask(a, { do: 'start', command: process.execPath, args: [join(dir, 'cli.js')], first: 'early\n' });
		await ask(b, { do: 'start', command: process.execPath, args: [join(dir, 'cli.js')] });
		await until(() => events(a).some(e => e.event === 'out') && events(b).some(e => e.event === 'out'), 'both CLIs');
		await until(() => events(a).some(e => e.data?.includes('EARLY\n')), 'what a\'s adapter wrote before its CLI was up');
		assert.strictEqual(started.length, 2);
		const [forA, forB] = [started.find(s => s.id === a)!, started.find(s => s.id === b)!];
		assert.ok(forA.options.sandbox && !forB.options.sandbox, 'each CLI starts with its own chat\'s sandbox request');
		assert.strictEqual(forA.options.context.principal, 'chat:a');
		assert.strictEqual(forA.helper, false);
		assert.deepStrictEqual(forA.options.env, { ADDED: 'by-adapter' }, 'only what the adapter added: the launch\'s environment is not sent back');
		assert.ok(events(a).find(e => e.event === 'out').data.startsWith('env by-adapter - sandbox\n'));
		assert.strictEqual(events(b).find(e => e.event === 'out').data, 'env by-adapter - -\n');

		// Each chat talks to its own CLI.
		await ask(a, { do: 'say', text: 'from a\n' });
		await ask(b, { do: 'say', text: 'from b\n' });
		await until(() => events(a).some(e => e.data === 'FROM A\n') && events(b).some(e => e.data === 'FROM B\n'), 'echoes');
		assert.ok(!events(a).some(e => e.data === 'FROM B\n') && !events(b).some(e => e.data === 'FROM A\n'));

		// One chat's CLI dies: its chat hears it, the other chat and its CLI carry on.
		await ask(a, { do: 'say', text: 'die\n' });
		await until(() => events(a).find(e => e.event === 'exit'), 'exit of a\'s CLI');
		assert.strictEqual(events(a).find(e => e.event === 'exit').code, 7);
		await ask(b, { do: 'say', text: 'still here\n' });
		await until(() => events(b).some(e => e.data === 'STILL HERE\n'), 'b after a\'s CLI died');

		// A stopped chat ends alone, with its CLI.
		hosts.kill(b);
		await until(() => exits.has(b), 'exit of b');
		assert.strictEqual(exits.has(a), false);
		assert.strictEqual(hosts.has(b), false);
		assert.strictEqual((await ask(a, { do: 'env', name: 'CLAUDE_CONFIG_DIR' })).value, '/overlay/a');
	});

	test('execFile is relayed; another environment is another host; an adapter that cannot be shared is not', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		this.timeout(60_000);
		const a = (await hosts.open(options(), entry))!;
		const out = await ask(a, { do: 'execFile', command: process.execPath, args: ['-e', 'process.stdout.write("hi " + process.env.EXTRA)'] });
		assert.strictEqual(out.stdout, 'hi e');
		assert.deepStrictEqual(started[0].options.env, { EXTRA: 'e' });
		assert.strictEqual(started[0].helper, true, 'an execFile is a helper, not the chat\'s CLI');

		const other = (await hosts.open(options({ env: { CLAUDE_CONFIG_DIR: '/accounts/two' } }), entry))!;
		assert.strictEqual(hosts.hostCount, 2, 'a chat with another config folder never shares a process');
		assert.strictEqual((await ask(other, { do: 'env', name: 'CLAUDE_CONFIG_DIR' })).value, '/accounts/two');
		assert.strictEqual((await ask(a, { do: 'env', name: 'CLAUDE_CONFIG_DIR' })).value, undefined);

		// An exception nobody caught, in one chat's code: that chat's connection ends, the host and the other chat stay.
		await ask(other, { do: 'throw' });
		await until(() => exits.has(other), 'the end of the chat that threw');
		assert.strictEqual((await ask(a, { do: 'env', name: 'SHARED' })).value, 'host');
		assert.strictEqual(exits.has(a), false);

		const broken = join(dir, 'broken', 'index.js');
		await fs.mkdir(join(dir, 'broken'));
		await fs.writeFile(broken, '');
		assert.strictEqual(await hosts.open(options({ args: [broken] }), broken), undefined);
		assert.strictEqual(await hosts.open(options({ args: [broken] }), broken), undefined);
	});

	test('the host\'s file check allows nothing the sandbox policy refuses', () => {
		const voltAllows = new Function(`${ACP_HOST_POLICY_CHECK_SOURCE}; return voltAllows;`)() as (policy: IResolvedSandboxPolicy, path: string, access: 'read' | 'write' | 'meta' | 'list') => boolean;
		const policies = [
			policy({ readAll: true, write: ['/w', '/Users/u/proj'], deny: ['/Users/u/.ssh', '/w/Denied'], denyPatterns: [{ root: '/Users/u/proj', names: ['.env'] }], protect: ['/Users/u/proj/.volt'], protectPatterns: [{ root: '/', names: ['.claude', 'settings.json'] }], gitDirs: [{ root: '/Users/u/proj', anyDepth: true }, { root: '/Users/u/bare.git', anyDepth: false }], newRepositoryGuard: ['/w'], writeFiles: ['/Users/u/.claude.json'], isolated: [{ root: '/cache', keep: '/cache/one' }] }),
			policy({ platform: 'linux', read: ['/usr', '/Users/u/proj'], write: ['/tmp/x'], deny: ['/usr/Secret'], writeFiles: ['/etc/one'], list: ['/Users', '/Users/u'] }),
			policy({}),
		];
		const paths = ['/', '/w', '/w/a', '/w/a/../b', 'relative', '/w/denied/x', '/w/Denied', '/Users/u/.ssh/id', '/users/U/.SSH/id', '/Users/u/proj/src/a.ts', '/Users/u/proj/.env', '/Users/u/proj/sub/.ENV',
			'/Users/u/proj/.git/config', '/Users/u/proj/.git/index.lock', '/Users/u/proj/sub/.git/objects/ab', '/Users/u/bare.git/HEAD', '/Users/u/bare.git/objects/x', '/w/.git', '/w/new/.git/HEAD',
			'/Users/u/proj/.volt/sandbox.json', '/Users/u/proj/.claude/settings.json', '/Users/u/.claude.json', '/Users/u/.claude.json.lock', '/cache/one/a', '/cache/two/a', '/usr/bin/env', '/usr/Secret/a', '/usr/secret/a', '/tmp/x/y', '/etc/one', '/etc/two', '/w/', '/Users', '/Users/u', '/Users/other'];
		let allowed = 0;
		for (const p of policies) {
			for (const path of paths) {
				assert.strictEqual(voltAllows(p, path, 'read'), resolvedPolicyAllows(p, path, 'read'), `read ${path} (${p.platform})`);
				// Metadata: any path the policy does not deny (a readable one included); a listing: readable, or named in `list`.
				assert.ok(!resolvedPolicyAllows(p, path, 'read') || (voltAllows(p, path, 'meta') && voltAllows(p, path, 'list')), `meta of readable ${path}`);
				assert.strictEqual(voltAllows(p, path, 'meta'), resolvedPolicyAllows({ ...p, readAll: true }, path, 'read'), `meta ${path} (${p.platform})`);
				assert.strictEqual(voltAllows(p, path, 'list'), resolvedPolicyAllows(p, path, 'read') || (p.list ?? []).includes(path.length > 1 ? path.replace(/\/+$/, '') : path) && voltAllows(p, path, 'meta'), `list ${path} (${p.platform})`);
				if (voltAllows(p, path, 'write')) {
					allowed++;
					assert.ok(resolvedPolicyAllows(p, path, 'write'), `write ${path} (${p.platform})`);
				}
			}
		}
		assert.ok(allowed > 5, 'the write check is not empty');
		assert.ok(voltAllows(policies[0], '/Users/u/proj/src/a.ts', 'write'), 'a workspace file outside its git folder is writable');
	});
});
