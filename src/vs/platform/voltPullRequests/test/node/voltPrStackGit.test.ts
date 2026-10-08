/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFile, execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getRandomTestPath } from '../../../../base/test/node/testUtils.js';
import { IStackContext, readStack, recordParent, restackStack, retargetChildren, StackGit } from '../../node/voltPrStackGit.js';

/** Real git, in the same way the service runs it (no shell, exit code instead of a throw). */
const runGit: StackGit = (args, cwd) => new Promise(resolve => {
	execFile('git', [...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }, (err, stdout, stderr) => {
		resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
	});
});

suite('Volt pull requests: stacked branches (local git)', function () {

	this.timeout(60_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let work: string;
	let bare: string;
	let context: IStackContext;

	const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
	const commitFile = (name: string, text: string, message: string) => {
		writeFileSync(join(work, name), text);
		git(work, 'add', '-A');
		git(work, 'commit', '-q', '-m', message);
	};
	const headOf = (branch: string) => git(work, 'rev-parse', branch);
	/** Makes `name` on top of the current branch and records it as a layer, the way the service does. */
	const layer = async (name: string, file: string, text: string) => {
		const parent = git(work, 'rev-parse', '--abbrev-ref', 'HEAD');
		const parentOid = headOf('HEAD');
		git(work, 'checkout', '-q', '-b', name);
		await recordParent(context, name, parent, parentOid);
		commitFile(file, text, `Add ${file}`);
		git(work, 'push', '-q', '-u', 'origin', name);
	};

	setup(async () => {
		root = getRandomTestPath(tmpdir(), 'volt-stack-git');
		work = join(root, 'work');
		bare = join(root, 'remote.git');
		mkdirSync(work, { recursive: true });
		git(root, 'init', '-q', '--bare', '-b', 'main', bare);
		git(work, 'init', '-q', '-b', 'main');
		git(work, 'config', 'user.email', 'volt@example.com');
		git(work, 'config', 'user.name', 'Volt Test');
		git(work, 'config', 'commit.gpgsign', 'false');
		git(work, 'remote', 'add', 'origin', bare);
		commitFile('README.md', '# Notes\n', 'Initial commit');
		git(work, 'push', '-q', '-u', 'origin', 'main');
		context = { git: runGit, root: work, trunk: 'main', remote: 'origin' };
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('reads the layers bottom first, with what each one needs', async () => {
		await layer('feat/one', 'one.txt', 'one\n');
		await layer('feat/two', 'two.txt', 'two\n');
		const stack = await readStack(context, 'feat/two');
		assert.deepStrictEqual(stack.layers.map(l => [l.branch, l.parent, l.ahead, l.needsRestack, l.unpushed]), [
			['feat/one', 'main', 1, false, false],
			['feat/two', 'feat/one', 1, false, false],
		]);
		assert.strictEqual(stack.layers[1].dirty, false, 'the checked out layer reports a clean checkout');
		assert.strictEqual(stack.layers[1].worktree, realpathSync(work));
	});

	test('a branch outside any stack reads as no layers', async () => {
		git(work, 'checkout', '-q', '-b', 'loose');
		commitFile('loose.txt', 'loose\n', 'Loose');
		const stack = await readStack(context, 'loose');
		assert.deepStrictEqual(stack.layers, []);
	});

	test('amending the parent restacks only the child\'s own commits and pushes them with a lease', async () => {
		await layer('feat/one', 'one.txt', 'one\n');
		await layer('feat/two', 'two.txt', 'two\n');
		git(work, 'checkout', '-q', 'feat/one');
		commitFile('one.txt', 'one, amended\n', 'Amend one');
		git(work, 'commit', '-q', '--amend', '--no-edit', '-a');
		const amended = headOf('feat/one');

		const before = await readStack(context, 'feat/two');
		assert.strictEqual(before.layers[1].needsRestack, true);

		const result = await restackStack(context, 'feat/two');
		assert.strictEqual(result.stopped, undefined);
		assert.deepStrictEqual(result.restacked.map(l => [l.branch, l.pushed]), [['feat/two', true]]);
		assert.strictEqual(git(work, 'rev-parse', 'feat/one'), amended, 'the parent is not moved by a restack');
		assert.strictEqual(git(work, 'rev-list', '--count', 'feat/one..feat/two'), '1');
		assert.strictEqual(git(work, 'show', 'feat/two:one.txt'), 'one, amended');
		assert.strictEqual(git(bare, 'rev-parse', 'refs/heads/feat/two'), headOf('feat/two'));

		const after = await readStack(context, 'feat/two');
		assert.strictEqual(after.layers[1].needsRestack, false);
	});

	test('after the parent is squash-merged, the child moves onto the trunk without replaying the parent', async () => {
		await layer('feat/one', 'one.txt', 'one\n');
		await layer('feat/two', 'two.txt', 'two\n');
		git(work, 'checkout', '-q', 'main');
		git(work, 'merge', '--squash', '-q', 'feat/one');
		git(work, 'commit', '-q', '-m', 'Add one (squash)');
		git(work, 'push', '-q', 'origin', 'main');
		git(work, 'fetch', '-q', 'origin');

		const moves = await retargetChildren(context, 'feat/one');
		assert.deepStrictEqual(moves.map(m => [m.branch, m.to]), [['feat/two', 'main']]);

		const result = await restackStack(context, 'feat/two', { only: ['feat/two'], syncTrunk: true });
		assert.strictEqual(result.stopped, undefined);
		assert.strictEqual(git(work, 'rev-list', '--count', 'origin/main..feat/two'), '1', 'only the child\'s own commit is replayed');
		assert.strictEqual(git(work, 'show', 'feat/two:two.txt'), 'two');
		assert.strictEqual(git(work, 'show', 'feat/two:one.txt'), 'one', 'the squashed parent is already on the trunk');
	});

	test('a conflict in a checkout leaves the rebase waiting there, for the agent or the user to finish', async () => {
		await layer('feat/one', 'one.txt', 'one\n');
		await layer('feat/two', 'shared.txt', 'from two\n');
		git(work, 'checkout', '-q', 'feat/one');
		commitFile('shared.txt', 'from one\n', 'Also add shared');
		git(work, 'commit', '-q', '--amend', '--no-edit', '-a');
		git(work, 'checkout', '-q', 'feat/two');

		const result = await restackStack(context, 'feat/two');
		assert.ok(result.stopped, 'the restack stops on the conflict');
		assert.strictEqual(result.stopped.reason, 'conflict');
		assert.strictEqual(result.stopped.branch, 'feat/two');
		assert.deepStrictEqual(result.stopped.files, ['shared.txt']);
		assert.strictEqual(result.stopped.worktree, realpathSync(work));
		assert.ok(result.stopped.command.startsWith('git rebase --onto'));
		assert.ok(existsSync(join(work, '.git', 'rebase-merge')), 'the rebase is left in progress in the checkout');
		git(work, 'rebase', '--abort');
	});

	test('a conflict in a branch with no checkout is aborted, and the branch stays where it was', async () => {
		await layer('feat/one', 'one.txt', 'one\n');
		await layer('feat/two', 'shared.txt', 'from two\n');
		git(work, 'checkout', '-q', 'feat/one');
		commitFile('shared.txt', 'from one\n', 'Also add shared');
		git(work, 'commit', '-q', '--amend', '--no-edit', '-a');
		git(work, 'checkout', '-q', 'main');
		const before = headOf('feat/two');

		const result = await restackStack(context, 'feat/two');
		assert.ok(result.stopped);
		assert.strictEqual(result.stopped.reason, 'conflict');
		assert.strictEqual(result.stopped.worktree, undefined);
		assert.strictEqual(headOf('feat/two'), before);
		assert.strictEqual(git(work, 'worktree', 'list').split('\n').length, 1, 'the scratch worktree is removed');
	});

	test('uncommitted changes in the layer\'s checkout stop the restack before anything moves', async () => {
		await layer('feat/one', 'one.txt', 'one\n');
		await layer('feat/two', 'two.txt', 'two\n');
		git(work, 'checkout', '-q', 'feat/one');
		commitFile('one.txt', 'one, amended\n', 'Amend one');
		git(work, 'commit', '-q', '--amend', '--no-edit', '-a');
		git(work, 'checkout', '-q', 'feat/two');
		writeFileSync(join(work, 'two.txt'), 'typing\n');
		const before = headOf('feat/two');

		const result = await restackStack(context, 'feat/two');
		assert.strictEqual(result.stopped?.reason, 'dirty');
		assert.strictEqual(result.stopped?.worktree, realpathSync(work));
		assert.strictEqual(headOf('feat/two'), before);
		assert.strictEqual(readFileSync(join(work, 'two.txt'), 'utf8'), 'typing\n');
	});

	test('a push the remote refuses (someone else pushed) keeps the local restack and says so', async () => {
		await layer('feat/one', 'one.txt', 'one\n');
		await layer('feat/two', 'two.txt', 'two\n');
		git(work, 'checkout', '-q', 'feat/one');
		commitFile('one.txt', 'one, amended\n', 'Amend one');
		git(work, 'commit', '-q', '--amend', '--no-edit', '-a');

		// Someone else pushes to the child; this clone's remote-tracking ref still names the old commit.
		const other = join(root, 'other');
		git(root, 'clone', '-q', '-b', 'feat/two', bare, other);
		git(other, 'config', 'user.email', 'volt@example.com');
		git(other, 'config', 'user.name', 'Volt Test');
		writeFileSync(join(other, 'two.txt'), 'two, from elsewhere\n');
		git(other, 'commit', '-q', '-am', 'Elsewhere');
		git(other, 'push', '-q', 'origin', 'feat/two');

		const result = await restackStack(context, 'feat/two');
		assert.strictEqual(result.stopped, undefined, 'the local restack still happens');
		assert.deepStrictEqual(result.restacked.map(l => [l.branch, l.pushed]), [['feat/two', false]]);
		assert.strictEqual(result.pushFailures.length, 1);
		assert.strictEqual(result.pushFailures[0].branch, 'feat/two');
		assert.strictEqual(git(work, 'rev-list', '--count', 'feat/one..feat/two'), '1');
	});
});
