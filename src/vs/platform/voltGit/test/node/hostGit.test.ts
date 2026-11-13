/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GIT-1..4 (B-03, INV-16): real repositories, real git. Each attack is first shown to work with
 * plain git (so the test would catch the guard being removed), then shown to do nothing through
 * HostGit. Runs against a fake HOME; never against the user's git config.
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BuildEntryGuard } from '../../node/buildEntryGuard.js';
import { runHostGit } from '../../node/hostGit.js';

(isWindows ? suite.skip : suite)('HostGit (GIT-1..4)', function () {

	this.timeout(60_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let guard: BuildEntryGuard;
	let baseEnv: Record<string, string>;

	setup(async () => {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-hostgit-')));
		home = join(root, 'home');
		await fs.mkdir(home);
		guard = new BuildEntryGuard(join(root, 'trust'), home);
		baseEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'C' };
	});

	teardown(() => fs.rm(root, { recursive: true, force: true }));

	/** Plain git, as an unguarded caller would run it (the attack's proof). */
	function plain(cwd: string, ...args: string[]): string {
		try {
			return execFileSync('git', args, { cwd, env: { ...baseEnv, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', stdio: 'pipe' });
		} catch (err) {
			return String((err as { stdout?: string }).stdout ?? '');
		}
	}

	function host(cwd: string, args: string[], extra: { hooks?: 'user'; input?: string } = {}) {
		return runHostGit({ cwd, args, ...extra }, { baseEnv, guard });
	}

	async function repo(name: string): Promise<string> {
		const dir = join(root, name);
		await fs.mkdir(dir);
		plain(dir, 'init', '-q');
		plain(dir, 'config', 'user.name', 't');
		plain(dir, 'config', 'user.email', 't@t');
		await fs.writeFile(join(dir, 'a.txt'), 'a\n');
		plain(dir, '-c', 'core.hooksPath=/dev/null', 'add', 'a.txt');
		plain(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'init');
		return dir;
	}

	/** An executable that leaves `marker` behind when anything runs it. */
	async function trap(path: string, marker: string): Promise<void> {
		await fs.writeFile(path, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
	}

	const exists = (path: string) => fs.lstat(path).then(() => true, () => false);

	test('GIT-1: a planted .git/commondir is refused, and its fsmonitor never runs', async () => {
		const dir = await repo('r1');
		const marker = join(root, 'marker-1');
		const evil = join(root, 'evil-common');
		await fs.cp(join(dir, '.git'), evil, { recursive: true });
		await trap(join(root, 'fsmon.sh'), marker);
		await fs.appendFile(join(evil, 'config'), `[core]\n\tfsmonitor = ${join(root, 'fsmon.sh')}\n`);
		await fs.writeFile(join(dir, '.git', 'commondir'), `${evil}\n`);

		plain(dir, 'status', '--porcelain');
		assert.ok(await exists(marker), 'proof: plain git status runs the planted fsmonitor');
		await fs.rm(marker);

		const result = await host(dir, ['status', '--porcelain']);
		assert.strictEqual(result.refused, true, result.stderr);
		assert.ok(/commondir|another folder/.test(result.error ?? ''), result.error);
		assert.ok(!await exists(marker), 'HostGit ran nothing');

		// The same through a linked worktree's own folder.
		const wt = join(root, 'r1-wt');
		await fs.rm(join(dir, '.git', 'commondir'));
		plain(dir, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', 'w', wt);
		assert.strictEqual((await host(wt, ['status', '--porcelain'])).exitCode, 0, 'a real linked worktree passes');
		await fs.writeFile(join(dir, '.git', 'worktrees', 'r1-wt', 'commondir'), `${evil}\n`);
		const linked = await host(wt, ['status', '--porcelain']);
		assert.strictEqual(linked.refused, true, linked.stderr);
		assert.ok(!await exists(marker));
	});

	test('GIT-2: core.fsmonitor in .git/config never runs through HostGit', async () => {
		const dir = await repo('r2');
		const marker = join(root, 'marker-2');
		await trap(join(root, 'fsmon.sh'), marker);
		plain(dir, 'config', 'core.fsmonitor', join(root, 'fsmon.sh'));

		plain(dir, 'status', '--porcelain');
		assert.ok(await exists(marker), 'proof: plain git status runs it');
		await fs.rm(marker);

		const result = await host(dir, ['status', '--porcelain']);
		assert.strictEqual(result.exitCode, 0, result.stderr);
		assert.ok(!await exists(marker), 'HostGit ran no fsmonitor');
		const caller = await runHostGit({ cwd: dir, args: ['-c', `core.fsmonitor=${join(root, 'fsmon.sh')}`, 'status'] }, { baseEnv, guard });
		assert.strictEqual(caller.refused, true, 'a caller cannot switch it back on');
		assert.ok(!await exists(marker));
	});

	test('GIT-3: core.hooksPath into a tracked folder: no hook runs implicitly; the user\'s own commit runs hooks only after review', async () => {
		const dir = await repo('r3');
		const marker = join(root, 'marker-3');
		await fs.writeFile(join(home, '.gitconfig'), '[core]\n\thooksPath = tools/hooks\n');
		await guard.snapshot(dir);
		// The agent writes a hook into a tracked, writable folder.
		await fs.mkdir(join(dir, 'tools', 'hooks'), { recursive: true });
		await trap(join(dir, 'tools', 'hooks', 'pre-commit'), marker);
		await trap(join(dir, 'tools', 'hooks', 'post-checkout'), marker);

		plain(dir, 'commit', '-q', '--allow-empty', '-m', 'proof');
		assert.ok(await exists(marker), 'proof: plain git commit runs the tracked hook');
		await fs.rm(marker);

		for (const args of [['commit', '-q', '--allow-empty', '-m', 'implicit'], ['checkout', '-q', '-b', 'other'], ['checkout', '-q', '-']]) {
			const result = await host(dir, args);
			assert.strictEqual(result.exitCode, 0, `${args.join(' ')}: ${result.stderr}`);
			assert.ok(!await exists(marker), `${args.join(' ')} ran no hook`);
		}

		const unreviewed = await host(dir, ['commit', '-q', '--allow-empty', '-m', 'user'], { hooks: 'user' });
		assert.strictEqual(unreviewed.refused, true, 'the user\'s commit waits for the review');
		assert.ok(!await exists(marker));
		const changes = await guard.changes(dir);
		assert.ok(changes.some(change => change.path.endsWith('tools/hooks/pre-commit') && change.kind === 'added' && change.group === 'git'), JSON.stringify(changes));

		await guard.accept(dir);
		const reviewed = await host(dir, ['commit', '-q', '--allow-empty', '-m', 'user'], { hooks: 'user' });
		assert.strictEqual(reviewed.exitCode, 0, reviewed.stderr);
		assert.ok(await exists(marker), 'after the review the user\'s own hooks run');
	});

	test('GIT-4: objects/info/alternates planted while a sandboxed writer worked is refused; the user\'s own alternates keep working', async () => {
		const other = await repo('r4-private');
		await fs.writeFile(join(other, 'secret.txt'), 'CANARY-PRIVATE\n');
		const blob = execFileSync('git', ['hash-object', '-w', 'secret.txt'], { cwd: other, env: { ...baseEnv, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim();
		const dir = await repo('r4');
		await guard.snapshot(dir);
		await fs.writeFile(join(dir, '.git', 'objects', 'info', 'alternates'), `${join(other, '.git', 'objects')}\n`);

		assert.ok(plain(dir, 'cat-file', '-p', blob).includes('CANARY-PRIVATE'), 'proof: plain git reads the other repository through it');
		const result = await host(dir, ['cat-file', '-p', blob]);
		assert.strictEqual(result.refused, true, result.stderr);
		assert.ok(!result.stdout.includes('CANARY-PRIVATE'));

		// No sandboxed writer ever ran here: the alternates are the user's own.
		const own = await repo('r4-own');
		await fs.writeFile(join(own, '.git', 'objects', 'info', 'alternates'), `${join(other, '.git', 'objects')}\n`);
		const allowed = await host(own, ['cat-file', '-p', blob]);
		assert.strictEqual(allowed.exitCode, 0, allowed.stderr);
	});

	test('ext:: remotes never run, even when the user\'s config allows them', async () => {
		const dir = await repo('r5');
		const marker = join(root, 'marker-5');
		await fs.writeFile(join(home, '.gitconfig'), '[protocol "ext"]\n\tallow = always\n');
		plain(dir, 'ls-remote', `ext::sh -c touch% ${marker}`);
		assert.ok(await exists(marker), 'proof: plain git runs the ext:: command');
		await fs.rm(marker);
		await host(dir, ['ls-remote', `ext::sh -c touch% ${marker}`]);
		assert.ok(!await exists(marker));
	});

	test('build-entry guard (I.6): package scripts, tasks and hook managers show as changes until the user accepts them', async () => {
		const dir = await repo('r7');
		await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' }, dependencies: { a: '1' } }));
		assert.deepStrictEqual(await guard.changes(dir), [], 'no sandboxed writer ran yet: nothing to review');
		await guard.snapshot(dir);
		await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' }, dependencies: { a: '2' } }));
		assert.deepStrictEqual(await guard.changes(dir), [], 'a dependency bump is not a script change');
		await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'touch ~/pwned' } }));
		await fs.mkdir(join(dir, '.vscode'));
		await fs.writeFile(join(dir, '.vscode', 'tasks.json'), '{}');
		await fs.mkdir(join(dir, '.husky'));
		await fs.writeFile(join(dir, '.husky', 'pre-commit'), 'evil');
		await guard.snapshot(dir);
		const changes = await guard.changes(dir);
		assert.deepStrictEqual(changes.map(change => [change.path.slice(dir.length + 1), change.kind, change.group]), [
			['.husky/pre-commit', 'added', 'build'],
			['.vscode/tasks.json', 'added', 'build'],
			['package.json', 'changed', 'build'],
		], 'a second sandboxed run never re-baselines the first one\'s changes');
		assert.ok(changes.find(change => change.path.endsWith('package.json'))?.after?.includes('touch ~/pwned'));
		await guard.accept(dir, [join(dir, 'package.json')]);
		assert.deepStrictEqual((await guard.changes(dir)).map(change => change.path.slice(dir.length + 1)), ['.husky/pre-commit', '.vscode/tasks.json']);
		await guard.accept(dir);
		assert.deepStrictEqual(await guard.changes(dir), []);
		const stat = await fs.stat(join(root, 'trust'));
		assert.strictEqual(stat.mode & 0o077, 0, 'records are private to the user');
	});

	test('-C, --git-dir and --work-tree are refused; a folder outside any repository still runs', async () => {
		const dir = await repo('r6');
		for (const args of [['-C', root, 'status'], ['--git-dir=/tmp/x', 'status'], ['--work-tree', root, 'status']]) {
			assert.strictEqual((await host(dir, args)).refused, true, args.join(' '));
		}
		const outside = join(root, 'plain-folder');
		await fs.mkdir(outside);
		const init = await host(outside, ['init', '-q']);
		assert.strictEqual(init.exitCode, 0, init.stderr);
	});
});
