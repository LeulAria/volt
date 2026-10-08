/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { hash } from '../../../../../../base/common/hash.js';
import { join, normalize } from '../../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	AGENT_RUN_ON_OPTIONS,
	ARCHIVED_WORKTREE_KEEP,
	AgentWorktreeError,
	GitRunner,
	IGitRunResult,
	IManagedWorktreeRef,
	IWorktreeFiles,
	agentRunOnStorageKey,
	archivedWorktreeCandidates,
	createAgentWorktree,
	isManagedWorktree,
	normalizeAgentRunOn,
	removeAgentWorktree,
	runOnForPrompt,
} from '../../../common/git/agentWorktree.js';

const REPO = '/repo';
const ROOT = '/wt';
const COMMIT = 'abc123def456';

suite('Agent worktrees', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('run target defaults to the same branch and offers that, a new worktree, or the cloud', () => {
		assert.deepStrictEqual([...AGENT_RUN_ON_OPTIONS], ['same-branch', 'worktree', 'cloud']);
		assert.strictEqual(normalizeAgentRunOn(undefined), 'same-branch');
		assert.strictEqual(normalizeAgentRunOn('cloud'), 'cloud');
		assert.strictEqual(normalizeAgentRunOn('nowhere'), 'same-branch');
		assert.strictEqual(normalizeAgentRunOn('worktree'), 'worktree');
		assert.strictEqual(agentRunOnStorageKey('project-1'), 'volt.agent.runOn.project-1');
		assert.strictEqual(agentRunOnStorageKey(undefined), 'volt.agent.runOn.default');
	});

	test('creates a branch and then the worktree', async () => {
		const { calls, run, files } = fakeGit();
		const created = await createAgentWorktree({
			run, files, repoRoot: REPO, worktreesRoot: ROOT,
			allocateId: () => 'abcd1234',
		});
		assert.strictEqual(created.branch, 'volt/abcd1234');
		assert.strictEqual(created.commit, COMMIT);
		assert.strictEqual(created.path, expectedPath('abcd1234'));
		assert.deepStrictEqual(calls.map(call => call.args[0]), [
			'rev-parse',
			'rev-parse',
			'branch',
			'worktree',
		]);
		assert.deepStrictEqual(calls[2].args, ['branch', 'volt/abcd1234', COMMIT]);
		assert.deepStrictEqual(calls[3].args, ['worktree', 'add', created.path, 'volt/abcd1234']);
	});

	test('keeps a checkout when a post-checkout hook fails after HEAD matches', async () => {
		const path = expectedPath('abcd1234');
		const { calls, run, files } = fakeGit({
			failAdd: true,
			porcelain: `worktree ${path}\nHEAD ${COMMIT}\nbranch refs/heads/volt/abcd1234\n`,
			head: COMMIT,
		});
		const created = await createAgentWorktree({
			run, files, repoRoot: REPO, worktreesRoot: ROOT,
			allocateId: () => 'abcd1234',
		});
		assert.strictEqual(created.path, path);
		assert.ok(!calls.some(call => call.args[1] === 'remove'));
		assert.ok(!calls.some(call => call.args[0] === 'branch' && call.args[1] === '-D'));
	});

	test('rolls back a failed add', async () => {
		const removed: string[] = [];
		const { calls, run, files } = fakeGit({ failAdd: true, porcelain: '', onRemove: path => removed.push(path) });
		await assert.rejects(
			() => createAgentWorktree({
				run, files, repoRoot: REPO, worktreesRoot: ROOT,
				allocateId: () => 'abcd1234',
			}),
			(err: unknown) => err instanceof AgentWorktreeError,
		);
		const path = expectedPath('abcd1234');
		assert.ok(calls.some(call => call.args[0] === 'worktree' && call.args[1] === 'remove' && call.args[2] === '--force' && call.args[3] === path));
		assert.ok(calls.some(call => call.args[0] === 'branch' && call.args[1] === '-D' && call.args[2] === 'volt/abcd1234'));
		assert.ok(calls.some(call => call.args[0] === 'worktree' && call.args[1] === 'prune'));
		assert.deepStrictEqual(removed, [path]);
	});

	test('refuses a folder that is not a git repository', async () => {
		const { calls, run, files } = fakeGit({ notGit: true });
		await assert.rejects(
			() => createAgentWorktree({ run, files, repoRoot: REPO, worktreesRoot: ROOT }),
			(err: unknown) => err instanceof AgentWorktreeError && /not a git repository/i.test(err.message),
		);
		assert.ok(!calls.some(call => call.args[0] === 'branch'));
		assert.ok(!calls.some(call => call.args[0] === 'worktree'));
	});

	test('picks another id when the path is already taken', async () => {
		const taken = expectedPath('aaaaaaaa');
		const { calls, run, files } = fakeGit({ exists: path => path === taken });
		const ids = ['aaaaaaaa', 'bbbbbbbb'];
		let index = 0;
		const created = await createAgentWorktree({
			run, files, repoRoot: REPO, worktreesRoot: ROOT,
			allocateId: () => ids[index++] ?? 'cccccccc',
		});
		assert.strictEqual(created.branch, 'volt/bbbbbbbb');
		assert.ok(!calls.some(call => call.args[1] === 'volt/aaaaaaaa'));
	});

	test('serializes creates for one repository', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>(resolve => { release = resolve; });
		let held = true;
		const calls: string[] = [];
		const { run: base, files } = fakeGit();
		const run: GitRunner = async (cwd, args) => {
			calls.push(args.join(' '));
			if (args[0] === 'worktree' && args[1] === 'add' && held) {
				await gate;
			}
			return base(cwd, args);
		};
		const ids = ['aaaaaaaa', 'bbbbbbbb'];
		let index = 0;
		const first = createAgentWorktree({
			run, files, repoRoot: REPO, worktreesRoot: ROOT,
			allocateId: () => ids[index++] ?? 'cccccccc',
		});
		const second = createAgentWorktree({
			run, files, repoRoot: REPO, worktreesRoot: ROOT,
			allocateId: () => ids[index++] ?? 'dddddddd',
		});
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.strictEqual(calls.filter(call => call.startsWith('branch ')).length, 1);
		held = false;
		release?.();
		const created = await Promise.all([first, second]);
		assert.deepStrictEqual(created.map(item => item.branch), ['volt/aaaaaaaa', 'volt/bbbbbbbb']);
	});

	test('archive keeps the newest checkouts and a dirty tree', async () => {
		const owners: IManagedWorktreeRef[] = [];
		for (let index = 0; index < ARCHIVED_WORKTREE_KEEP + 1; index++) {
			const id = index.toString(16).padStart(8, '0');
			owners.push({
				sessionId: `chat-${index}`,
				path: `${ROOT}/repo/volt-${id}`,
				branch: `volt/${id}`,
				archived: true,
				updatedAt: index,
			});
		}
		owners.push({
			sessionId: 'active',
			path: `${ROOT}/repo/volt-aaaaaaaa`,
			branch: 'volt/aaaaaaaa',
			archived: false,
			updatedAt: 100,
		});
		const candidates = archivedWorktreeCandidates(owners, ROOT);
		assert.strictEqual(candidates.length, 1);
		assert.strictEqual(candidates[0].sessionId, 'chat-0');

		const path = `${ROOT}/repo/volt-00000000`;
		const cleanGit = fakeGit({ exists: candidate => candidate === path });
		const clean = await removeAgentWorktree({
			run: cleanGit.run,
			files: cleanGit.files,
			repoRoot: REPO,
			worktreesRoot: ROOT,
			path,
			branch: 'volt/00000000',
			deleteBranch: false,
			force: false,
		});
		assert.strictEqual(clean, 'removed');
		assert.ok(cleanGit.calls.some(call => call.args[0] === 'worktree' && call.args[1] === 'remove' && !call.args.includes('--force')));
		assert.ok(!cleanGit.calls.some(call => call.args[1] === '-D'));

		const dirtyCalls: ICall[] = [];
		const dirty = await removeAgentWorktree({
			run: async (cwd, args) => {
				dirtyCalls.push({ cwd, args });
				if (args[0] === 'status') {
					return ok(' M file.ts\n');
				}
				return fakeGit().run(cwd, args);
			},
			files: { exists: async () => true, ensureDir: async () => undefined, remove: async () => undefined },
			repoRoot: REPO,
			worktreesRoot: ROOT,
			path: `${ROOT}/repo/volt-00000001`,
			branch: 'volt/00000001',
			deleteBranch: false,
			force: false,
		});
		assert.strictEqual(dirty, 'dirty');
		assert.ok(!dirtyCalls.some(call => call.args[1] === 'remove'));
	});

	test('delete removes the checkout and the volt branch, and refuses anything else', async () => {
		assert.strictEqual(isManagedWorktree('/somewhere/else', ROOT), false);
		assert.strictEqual(isManagedWorktree(`${ROOT}/repo/project`, ROOT), false);
		assert.strictEqual(isManagedWorktree(`${ROOT}/repo/volt-abcd1234`, ROOT), true);
		const outsideGit = fakeGit();
		const outside = await removeAgentWorktree({
			run: outsideGit.run,
			files: outsideGit.files,
			repoRoot: REPO,
			worktreesRoot: ROOT,
			path: '/somewhere/else',
			branch: 'volt/abcd1234',
			deleteBranch: true,
			force: true,
		});
		assert.strictEqual(outside, 'refused');
		assert.strictEqual(outsideGit.calls.length, 0);

		const path = `${ROOT}/repo/volt-abcd1234`;
		const deletedGit = fakeGit({ exists: candidate => candidate === path });
		const deleted = await removeAgentWorktree({
			run: deletedGit.run,
			files: deletedGit.files,
			repoRoot: REPO,
			worktreesRoot: ROOT,
			path,
			branch: 'volt/abcd1234',
			deleteBranch: true,
			force: true,
		});
		assert.strictEqual(deleted, 'removed');
		assert.ok(deletedGit.calls.some(call => call.args[0] === 'worktree' && call.args.includes('--force') && call.args.includes(path)));
		assert.ok(deletedGit.calls.some(call => call.args[0] === 'branch' && call.args[1] === '-D' && call.args[2] === 'volt/abcd1234'));

		const pickedGit = fakeGit({ exists: candidate => candidate === path });
		const picked = await removeAgentWorktree({
			run: pickedGit.run,
			files: pickedGit.files,
			repoRoot: REPO,
			worktreesRoot: ROOT,
			path,
			branch: 'feature',
			deleteBranch: true,
			force: true,
		});
		assert.strictEqual(picked, 'removed');
		assert.ok(!pickedGit.calls.some(call => call.args[1] === '-D'), 'a branch the user picked is never deleted');
	});

	test('checks out a picked branch that is free, as it is', async () => {
		const { calls, run, files } = fakeGit({ localBranches: ['feature'], porcelain: `worktree ${REPO}\nbranch refs/heads/main\n` });
		const created = await createAgentWorktree({
			run, files, repoRoot: REPO, worktreesRoot: ROOT,
			target: { kind: 'branch', name: 'feature' },
			allocateId: () => 'abcd1234',
		});
		assert.strictEqual(created.branch, 'feature');
		assert.ok(!calls.some(call => call.args[0] === 'branch'), 'no branch is made');
		assert.deepStrictEqual(calls.at(-1)?.args, ['worktree', 'add', expectedPath('abcd1234'), 'feature']);
	});

	test('a picked branch already checked out gets a fresh branch from it, like VS Code', async () => {
		const { calls, run, files } = fakeGit({ localBranches: ['main'], porcelain: `worktree ${REPO}\nbranch refs/heads/main\n` });
		const created = await createAgentWorktree({
			run, files, repoRoot: REPO, worktreesRoot: ROOT,
			target: { kind: 'branch', name: 'main' },
			allocateId: () => 'abcd1234',
		});
		assert.strictEqual(created.branch, 'volt/abcd1234');
		assert.ok(calls.some(call => call.args.join(' ') === `branch volt/abcd1234 ${COMMIT}`));
	});

	test('a remote branch becomes a local tracking branch; a new one is made from its ref', async () => {
		const remote = fakeGit();
		const tracked = await createAgentWorktree({
			run: remote.run, files: remote.files, repoRoot: REPO, worktreesRoot: ROOT,
			target: { kind: 'remote', name: 'origin/feature/login' },
			allocateId: () => 'abcd1234',
		});
		assert.strictEqual(tracked.branch, 'feature/login');
		assert.ok(remote.calls.some(call => call.args.join(' ') === 'branch --track feature/login origin/feature/login'));

		const named = fakeGit();
		const created = await createAgentWorktree({
			run: named.run, files: named.files, repoRoot: REPO, worktreesRoot: ROOT,
			target: { kind: 'new', name: 'feat/x', from: 'refs/tags/v1' },
			allocateId: () => 'abcd1234',
		});
		assert.strictEqual(created.branch, 'feat/x');
		assert.ok(named.calls.some(call => call.args.includes('refs/tags/v1^{commit}')));
		assert.ok(named.calls.some(call => call.args.join(' ') === `branch feat/x ${COMMIT}`));

		const taken = fakeGit({ localBranches: ['feat/x'] });
		await assert.rejects(
			() => createAgentWorktree({ run: taken.run, files: taken.files, repoRoot: REPO, worktreesRoot: ROOT, target: { kind: 'new', name: 'feat/x' } }),
			(err: unknown) => err instanceof AgentWorktreeError && /already exists/.test(err.message),
		);
		assert.ok(!taken.calls.some(call => call.args[0] === 'worktree' && call.args[1] === 'add'));
	});

	test('a failed add keeps a picked branch', async () => {
		const { calls, run, files } = fakeGit({ localBranches: ['feature'], failAdd: true });
		await assert.rejects(() => createAgentWorktree({
			run, files, repoRoot: REPO, worktreesRoot: ROOT,
			target: { kind: 'branch', name: 'feature' },
			allocateId: () => 'abcd1234',
		}));
		assert.ok(calls.some(call => call.args[0] === 'worktree' && call.args[1] === 'remove'));
		assert.ok(!calls.some(call => call.args[1] === '-D'));
	});
});

function expectedPath(id: string): string {
	const common = normalize(join(REPO, '.git'));
	return join(ROOT, hash(common).toString(36), `volt-${id}`);
}

interface ICall { cwd: string; args: readonly string[] }

function fakeGit(options?: {
	notGit?: boolean;
	failAdd?: boolean;
	porcelain?: string;
	head?: string;
	exists?: (path: string) => boolean;
	onRemove?: (path: string) => void;
	/** Local branches that `show-ref` finds. */
	localBranches?: readonly string[];
}): { calls: ICall[]; run: GitRunner; files: IWorktreeFiles } {
	const calls: ICall[] = [];
	const run: GitRunner = async (cwd, args) => {
		calls.push({ cwd, args });
		if (options?.notGit && args.includes('--git-common-dir')) {
			return fail('not a git repository');
		}
		if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
			return ok('.git\n');
		}
		if (args[0] === 'rev-parse' && args.includes('--verify')) {
			return ok(`${COMMIT}\n`);
		}
		if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
			return ok(`${options?.head ?? COMMIT}\n`);
		}
		if (args[0] === 'worktree' && args[1] === 'add') {
			return options?.failAdd ? fail('hook failed') : ok('');
		}
		if (args[0] === 'worktree' && args[1] === 'list') {
			return ok(options?.porcelain ?? '');
		}
		if (args[0] === 'status') {
			return ok('');
		}
		if (args[0] === 'show-ref') {
			const name = String(args.at(-1)).replace(/^refs\/heads\//, '');
			return options?.localBranches?.includes(name) ? ok('') : fail('');
		}
		return ok('');
	};
	const files: IWorktreeFiles = {
		exists: async path => options?.exists?.(path) ?? false,
		ensureDir: async () => undefined,
		remove: async path => { options?.onRemove?.(path); },
	};
	return { calls, run, files };
}

function ok(stdout: string): IGitRunResult {
	return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr: string): IGitRunResult {
	return { exitCode: 1, stdout: '', stderr };
}

suite('Agent run location per prompt', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a new chat starts where the project location says', () => {
		assert.strictEqual(runOnForPrompt('cloud', false), 'cloud');
		assert.strictEqual(runOnForPrompt('worktree', false), 'worktree');
		assert.strictEqual(runOnForPrompt('same-branch', false), 'same-branch');
	});

	test('a follow-up in a chat with turns never goes to the cloud', () => {
		assert.strictEqual(runOnForPrompt('cloud', true), 'same-branch');
	});

	test('a follow-up keeps a local location as it is', () => {
		assert.strictEqual(runOnForPrompt('worktree', true), 'worktree');
		assert.strictEqual(runOnForPrompt('same-branch', true), 'same-branch');
	});
});
