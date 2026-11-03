/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawn } from 'child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentWorktreeError, GitRunner, IGitRunResult, IWorktreeFiles, branchNameFromTitle, createAgentWorktree, releaseWorktreeBranch } from '../../common/git/agentWorktree.js';

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

	test('uses the branch picked for the worktree, as VS Code\'s Create Worktree does', async () => {
		const root = await mkdtemp(join(tmpdir(), 'volt-pick-'));
		const origin = join(root, 'origin');
		const repo = join(root, 'repo');
		const worktreesRoot = join(root, 'wt');
		try {
			await mkdir(origin);
			await git(origin, ['init', '-b', 'main']);
			await git(origin, ['config', 'user.email', 'test@volt.local']);
			await git(origin, ['config', 'user.name', 'Volt Test']);
			await writeFile(join(origin, 'README'), 'hello\n');
			await git(origin, ['add', 'README']);
			await git(origin, ['commit', '-m', 'init']);
			await git(origin, ['branch', 'remote-only']);
			await git(root, ['clone', '-q', origin, repo]);
			await git(repo, ['branch', 'feature']);
			await git(repo, ['tag', 'v1']);
			const create = (target: Parameters<typeof createAgentWorktree>[0]['target']) => createAgentWorktree({ run: git, files: files(), repoRoot: repo, worktreesRoot, target });
			const branchIn = async (path: string) => (await git(path, ['branch', '--show-current'])).stdout.trim();

			const feature = await create({ kind: 'branch', name: 'feature' });
			assert.strictEqual(await branchIn(feature.path), 'feature', 'a free branch is checked out as it is');

			const main = await create({ kind: 'branch', name: 'main' });
			assert.match(await branchIn(main.path), /^volt\/[0-9a-f]{8}$/, 'the checked-out branch gets a fresh branch from it');

			const tracked = await create({ kind: 'remote', name: 'origin/remote-only' });
			assert.strictEqual(await branchIn(tracked.path), 'remote-only');
			assert.strictEqual((await git(repo, ['rev-parse', '--abbrev-ref', 'remote-only@{upstream}'])).stdout.trim(), 'origin/remote-only');

			const named = await create({ kind: 'new', name: 'feat/x', from: 'refs/tags/v1' });
			assert.strictEqual(await branchIn(named.path), 'feat/x');
			await assert.rejects(() => create({ kind: 'new', name: 'feat/x' }), (err: unknown) => err instanceof AgentWorktreeError && /already exists/.test(err.message));

			assert.strictEqual(await branchIn(repo), 'main', 'the user\'s checkout never moves');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('a branch a chat worktree holds is freed: the worktree moves to a branch named after the chat, changes unstaged', async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'volt-release-')));
		const repo = join(root, 'repo');
		const worktreesRoot = join(root, 'wt');
		try {
			await mkdir(repo);
			await git(repo, ['init', '-b', 'main']);
			await git(repo, ['config', 'user.email', 'test@volt.local']);
			await git(repo, ['config', 'user.name', 'Volt Test']);
			await writeFile(join(repo, 'README'), 'hello\n');
			await git(repo, ['add', 'README']);
			await git(repo, ['commit', '-m', 'init']);
			await git(repo, ['switch', '-c', 'other']);
			const created = await createAgentWorktree({ run: git, files: files(), repoRoot: repo, worktreesRoot, target: { kind: 'branch', name: 'main' } });
			assert.strictEqual(created.branch, 'main');
			await writeFile(join(created.path, 'README'), 'changed\n');
			await git(created.path, ['add', 'README']);
			assert.match((await git(repo, ['switch', 'main'])).stderr, /already used by worktree/);

			const released = await releaseWorktreeBranch({ run: git, repoRoot: repo, worktreesRoot, branch: 'main', nameHint: () => branchNameFromTitle('Fix the login bug!') });
			assert.deepStrictEqual(released, { path: created.path, branch: 'volt/fix-the-login-bug' });
			assert.strictEqual((await git(created.path, ['branch', '--show-current'])).stdout.trim(), 'volt/fix-the-login-bug');
			assert.strictEqual(await readFile(join(created.path, 'README'), 'utf8'), 'changed\n');
			assert.strictEqual((await git(created.path, ['diff', '--cached', '--name-only'])).stdout.trim(), '');
			assert.strictEqual((await git(created.path, ['diff', '--name-only'])).stdout.trim(), 'README');
			assert.strictEqual((await git(repo, ['switch', 'main'])).exitCode, 0);
			assert.strictEqual(await releaseWorktreeBranch({ run: git, repoRoot: repo, worktreesRoot, branch: 'main' }), undefined, 'the asking checkout already has it');

			// A worktree the user made is theirs to move.
			const own = join(root, 'own');
			await git(repo, ['worktree', 'add', own, 'other']);
			await assert.rejects(() => releaseWorktreeBranch({ run: git, repoRoot: repo, worktreesRoot, branch: 'other' }), (err: unknown) => err instanceof AgentWorktreeError);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('branch names from chat titles', () => {
		assert.strictEqual(branchNameFromTitle('Fix login bug'), 'volt/fix-login-bug');
		assert.strictEqual(branchNameFromTitle('Café: déjà vu?'), 'volt/cafe-deja-vu');
		assert.strictEqual(branchNameFromTitle('New chat'), undefined);
		assert.strictEqual(branchNameFromTitle('…'), undefined);
		assert.ok(branchNameFromTitle('a very long chat title that keeps going and going past the limit')!.length <= 'volt/'.length + 40);
	});

	test('says a repo with no commits needs one, not that it is not a repo', async () => {
		const repo = await mkdtemp(join(tmpdir(), 'volt-unborn-'));
		const worktreesRoot = await mkdtemp(join(tmpdir(), 'volt-wt-'));
		try {
			await git(repo, ['init', '-b', 'main']);
			const noCommits = (err: unknown) => err instanceof AgentWorktreeError && /no commits yet/.test(err.message);
			await assert.rejects(() => createAgentWorktree({ run: git, files: files(), repoRoot: repo, worktreesRoot }), noCommits);
			await assert.rejects(() => createAgentWorktree({ run: git, files: files(), repoRoot: repo, worktreesRoot, target: { kind: 'new', name: 'feat' } }), noCommits);
			assert.strictEqual((await git(repo, ['worktree', 'list', '--porcelain'])).stdout.split('\n').filter(line => line.startsWith('worktree ')).length, 1);
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
