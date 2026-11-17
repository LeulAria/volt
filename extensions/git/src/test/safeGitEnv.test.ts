/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withSafeBareRepository } from '../safeGitEnv';

suite('safeGitEnv', () => {
	test('adds safe.bareRepository=explicit as the first command-scope config', () => {
		const env = withSafeBareRepository({ PATH: '/usr/bin', GIT_PAGER: 'cat' });
		assert.deepStrictEqual(env, { PATH: '/usr/bin', GIT_PAGER: 'cat', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.bareRepository', GIT_CONFIG_VALUE_0: 'explicit' });
	});

	test('keeps config the environment already carries, and goes after it', () => {
		const env = withSafeBareRepository({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'a', GIT_CONFIG_KEY_1: 'safe.bareRepository', GIT_CONFIG_VALUE_1: 'all' });
		assert.strictEqual(env.GIT_CONFIG_COUNT, '3');
		assert.strictEqual(env.GIT_CONFIG_KEY_0, 'user.name');
		// The last value of a key wins in git: an inherited `all` does not undo it.
		assert.strictEqual(env.GIT_CONFIG_KEY_2, 'safe.bareRepository');
		assert.strictEqual(env.GIT_CONFIG_VALUE_2, 'explicit');
		assert.strictEqual(withSafeBareRepository({ GIT_CONFIG_COUNT: 'junk' }).GIT_CONFIG_COUNT, '1');
	});

	test('GIT-BARE-1: a bare repository planted in a project folder does not run its core.fsmonitor command', function () {
		this.timeout(60_000);
		const git = (() => { try { return cp.execFileSync('git', ['--version'], { encoding: 'utf8' }); } catch { return ''; } })();
		const version = /(\d+)\.(\d+)/.exec(git);
		if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 38)) {
			this.skip(); // no git, or one that predates safe.bareRepository
		}
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'volt-git-bare-')));
		try {
			for (const worktree of ['.', '..']) {
				const planted = path.join(root, `pkg-${worktree.length}`);
				const marker = path.join(root, `ran-${worktree.length}`);
				fs.mkdirSync(path.join(planted, 'objects'), { recursive: true });
				fs.mkdirSync(path.join(planted, 'refs', 'heads'), { recursive: true });
				fs.mkdirSync(path.join(planted, 'inner'));
				fs.writeFileSync(path.join(planted, 'HEAD'), 'ref: refs/heads/main\n');
				fs.writeFileSync(path.join(planted, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = "${worktree}"\n\tfsmonitor = "touch '${marker}'; false"\n`);
				const base = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' };
				// What the extension runs to find and read a repository, in the folder of an opened file.
				for (const cwd of [planted, path.join(planted, 'inner')]) {
					for (const args of [['rev-parse', '--show-toplevel'], ['status', '--porcelain']]) {
						cp.spawnSync('git', args, { cwd, env: withSafeBareRepository(base), stdio: 'ignore' });
					}
				}
				assert.ok(!fs.existsSync(marker), `worktree = ${worktree}: the planted command ran`);
				// The control: without it, the same git runs the command (so the check above means something).
				cp.spawnSync('git', ['status', '--porcelain'], { cwd: planted, env: base, stdio: 'ignore' });
				assert.ok(fs.existsSync(marker), `worktree = ${worktree}: the fixture is a working attack on this git`);
			}
			// An ordinary repository still works.
			const repo = path.join(root, 'repo');
			fs.mkdirSync(repo);
			const env = withSafeBareRepository({ PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' });
			assert.strictEqual(cp.spawnSync('git', ['init', '-q'], { cwd: repo, env }).status, 0);
			fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
			const status = cp.spawnSync('git', ['status', '--porcelain'], { cwd: repo, env, encoding: 'utf8' });
			assert.strictEqual(status.status, 0);
			assert.strictEqual(status.stdout.trim(), '?? a.txt');
			assert.strictEqual(fs.realpathSync(cp.spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, env, encoding: 'utf8' }).stdout.trim()), repo);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
