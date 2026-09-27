/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawn } from 'child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentWorktreeError, GitRunner, IGitRunResult, IWorktreeFiles, createAgentWorktree } from '../../common/git/agentWorktree.js';

suite('Agent worktrees on git', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('creates a worktree without moving the source branch, and a failed add leaves nothing behind', async () => {
		const repo = await mkdtemp(join(tmpdir(), 'volt-repo-'));
		const worktreesRoot = await mkdtemp(join(tmpdir(), 'volt-wt-'));
		try {
			await git(repo, ['init', '-b', 'main']);
			await git(repo, ['config', 'user.email', 'test@volt.local']);
			await git(repo, ['config', 'user.name', 'Volt Test']);
			await writeFile(join(repo, 'README'), 'hello\n');
			await git(repo, ['add', 'README']);
			await git(repo, ['commit', '-m', 'init']);

			const created = await createAgentWorktree({
				run: git,
				files: files(),
				repoRoot: repo,
				worktreesRoot,
			});
			assert.match(created.branch, /^volt\/[0-9a-f]{8}$/);
			assert.strictEqual((await readFile(join(created.path, 'README'), 'utf8')), 'hello\n');
			assert.strictEqual((await git(repo, ['branch', '--show-current'])).stdout.trim(), 'main');
			assert.strictEqual((await git(created.path, ['branch', '--show-current'])).stdout.trim(), created.branch);

			const failing: GitRunner = async (cwd, args) => {
				if (args[0] === 'worktree' && args[1] === 'add') {
					return { exitCode: 1, stdout: '', stderr: 'hook failed' };
				}
				return git(cwd, args);
			};
			await assert.rejects(
				() => createAgentWorktree({ run: failing, files: files(), repoRoot: repo, worktreesRoot }),
				(err: unknown) => err instanceof AgentWorktreeError,
			);
			const branches = (await git(repo, ['branch', '--list', 'volt/*'])).stdout.trim().split('\n').filter(line => line.trim());
			assert.strictEqual(branches.length, 1);
			assert.ok(branches[0].includes(created.branch));
			const trees = (await git(repo, ['worktree', 'list', '--porcelain'])).stdout.split('\n').filter(line => line.startsWith('worktree '));
			assert.strictEqual(trees.length, 2);
		} finally {
			await rm(worktreesRoot, { recursive: true, force: true });
			await rm(repo, { recursive: true, force: true });
		}
	});
});

function files(): IWorktreeFiles {
	return {
		exists: async path => {
			try {
				await access(path);
				return true;
			} catch {
				return false;
			}
		},
		ensureDir: path => mkdir(path, { recursive: true }).then(() => undefined),
		remove: path => rm(path, { recursive: true, force: true }),
	};
}

function git(cwd: string, args: readonly string[]): Promise<IGitRunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', [...args], { cwd });
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });
		child.on('error', reject);
		child.on('close', code => resolve({ exitCode: code, stdout, stderr }));
	});
}
