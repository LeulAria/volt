/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getRandomTestPath } from '../../../../base/test/node/testUtils.js';
import { voltPrErrorMessage } from '../../common/voltPullRequests.js';
import { VoltPullRequestService } from '../../node/voltPullRequestService.js';

/**
 * Local git only: a work tree whose GitHub-looking remote is rewritten (insteadOf) to a bare
 * repository on disk, so pushes land somewhere real without the network.
 */
suite('Volt pull requests: local git', function () {

	this.timeout(60_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let work: string;
	let bare: string;
	let service: VoltPullRequestService;

	const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();

	setup(() => {
		root = getRandomTestPath(tmpdir(), 'volt-pr-git');
		work = join(root, 'work');
		bare = join(root, 'remote.git');
		mkdirSync(work, { recursive: true });
		git(root, 'init', '-q', '--bare', '-b', 'main', bare);
		git(work, 'init', '-q', '-b', 'main');
		git(work, 'config', 'user.email', 'volt@example.com');
		git(work, 'config', 'user.name', 'Volt Test');
		git(work, 'config', 'commit.gpgsign', 'false');
		git(work, 'config', `url.${bare}.insteadOf`, 'https://github.com/volt-test/notes.git');
		git(work, 'remote', 'add', 'origin', 'https://github.com/volt-test/notes.git');
		writeFileSync(join(work, 'README.md'), '# Notes\n');
		git(work, 'add', '-A');
		git(work, 'commit', '-q', '-m', 'Initial commit');
		git(work, 'push', '-q', '-u', 'origin', 'main');
		git(work, 'remote', 'set-head', 'origin', 'main');
		// No GitHub CLI: only git runs.
		service = store.add(new VoltPullRequestService(async () => process.env, undefined, join(root, 'no-gh')));
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('status reads the default branch, changes with line counts, and untracked files', async () => {
		writeFileSync(join(work, 'README.md'), '# Notes\n\nMore.\n');
		writeFileSync(join(work, 'new file.txt'), 'hello\n');
		const status = await service.gitStatus(work);
		assert.ok(status);
		assert.strictEqual(status.branch, 'main');
		assert.strictEqual(status.upstream, 'main');
		assert.strictEqual(status.defaultBranch, 'main');
		assert.strictEqual(status.isDefaultBranch, true);
		assert.strictEqual(status.aheadOfDefault, 0);
		assert.deepStrictEqual(status.files.map(file => [file.path, file.status]).sort(), [['README.md', 'modified'], ['new file.txt', 'untracked']]);
		assert.strictEqual(status.insertions, 2);
		assert.strictEqual(await service.gitStatus(root), undefined, 'not a repository');
	});

	test('a branch made from origin/main is not treated as pushed, and pushing it never touches main', async () => {
		git(work, 'checkout', '-q', '-b', 'feature/tips', 'origin/main');
		assert.strictEqual(git(work, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/main');
		writeFileSync(join(work, 'tips.md'), 'tip\n');
		const before = await service.gitStatus(work);
		assert.strictEqual(before?.upstream, undefined);
		assert.strictEqual(before?.isDefaultBranch, false);

		const commit = await service.commit({ folder: work, message: 'Add tips\n\nWith a body.' });
		assert.strictEqual(commit.branch, 'feature/tips');
		assert.strictEqual(commit.subject, 'Add tips');
		assert.strictEqual(git(work, 'log', '-1', '--format=%B'), 'Add tips\n\nWith a body.');

		const mainBefore = git(bare, 'rev-parse', 'main');
		const pushed = await service.push({ folder: work });
		assert.deepStrictEqual(pushed, { branch: 'feature/tips', remote: 'origin', setUpstream: true });
		assert.strictEqual(git(bare, 'rev-parse', 'main'), mainBefore, 'main is untouched');
		assert.strictEqual(git(bare, 'rev-parse', 'feature/tips'), commit.sha);
		assert.strictEqual(git(work, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature/tips');

		const after = await service.gitStatus(work);
		assert.strictEqual(after?.upstream, 'feature/tips');
		assert.strictEqual(after?.ahead, 0);
		assert.strictEqual(after?.aheadOfDefault, 1);
	});

	test('commit takes only the chosen paths, can move to a new branch, and refuses empty work', async () => {
		writeFileSync(join(work, 'a.txt'), 'a\n');
		writeFileSync(join(work, 'b.txt'), 'b\n');
		const commit = await service.commit({ folder: work, message: 'Add a', paths: ['a.txt'], newBranch: 'volt/add-a' });
		assert.strictEqual(commit.branch, 'volt/add-a');
		assert.strictEqual(git(work, 'show', '--name-only', '--format=', 'HEAD'), 'a.txt');
		const status = await service.gitStatus(work);
		assert.deepStrictEqual(status?.files.map(file => file.path), ['b.txt']);

		await assert.rejects(service.commit({ folder: work, message: '   ' }), /empty/);
		git(work, 'add', '-A');
		git(work, 'commit', '-q', '-m', 'Add b');
		await assert.rejects(service.commit({ folder: work, message: 'Nothing' }), (err: unknown) => /nothing to commit/i.test(voltPrErrorMessage(err)));
		await assert.rejects(service.commit({ folder: work, message: 'x', newBranch: '-bad' }), /Not a valid branch name/);
	});

	test('pull fast-forwards from the upstream and says when there is nothing new', async () => {
		const other = join(root, 'other');
		git(root, 'clone', '-q', bare, other);
		git(other, 'config', 'user.email', 'volt@example.com');
		git(other, 'config', 'user.name', 'Volt Test');
		git(other, 'config', 'commit.gpgsign', 'false');
		writeFileSync(join(other, 'remote.txt'), 'r\n');
		git(other, 'add', '-A');
		git(other, 'commit', '-q', '-m', 'Remote change');
		git(other, 'push', '-q', 'origin', 'main');
		git(work, 'fetch', '-q');
		assert.strictEqual((await service.gitStatus(work))?.behind, 1);
		const pulled = await service.pull(work);
		assert.strictEqual(pulled.updated, true);
		assert.strictEqual((await service.pull(work)).updated, false);
	});

	test('push names its remote and branch, so push.default=matching never pushes main along', async () => {
		git(work, 'config', 'push.default', 'matching');
		git(work, 'checkout', '-q', '-b', 'feature/one');
		writeFileSync(join(work, 'one.txt'), '1\n');
		await service.commit({ folder: work, message: 'One' });
		await service.push({ folder: work });
		// main gets a local commit nobody asked to push; the feature branch gets another.
		git(work, 'checkout', '-q', 'main');
		writeFileSync(join(work, 'main-only.txt'), 'm\n');
		git(work, 'add', '-A');
		git(work, 'commit', '-q', '-m', 'Local main work');
		git(work, 'checkout', '-q', 'feature/one');
		writeFileSync(join(work, 'two.txt'), '2\n');
		await service.commit({ folder: work, message: 'Two' });
		const mainBefore = git(bare, 'rev-parse', 'main');
		const pushed = await service.push({ folder: work });
		assert.strictEqual(pushed.setUpstream, false);
		assert.strictEqual(git(bare, 'rev-parse', 'main'), mainBefore, 'main stayed where it was');
		assert.strictEqual(git(bare, 'rev-parse', 'feature/one'), git(work, 'rev-parse', 'HEAD'));
	});

	test('commit refuses conflict markers and treats paths literally', async () => {
		writeFileSync(join(work, '[slug].txt'), 'literal\n');
		writeFileSync(join(work, 's.txt'), 'pattern match\n');
		await service.commit({ folder: work, message: 'Only the bracket file', paths: ['[slug].txt'] });
		assert.strictEqual(git(work, 'show', '--name-only', '--format=', 'HEAD'), '[slug].txt');
		await assert.rejects(service.commit({ folder: work, message: 'Nothing chosen', paths: [] }), /No files/);

		// A merge that stops on a conflict.
		git(work, 'add', '-A');
		git(work, 'commit', '-q', '-m', 'Add s');
		git(work, 'checkout', '-q', '-b', 'other');
		writeFileSync(join(work, 'README.md'), '# Other\n');
		git(work, 'commit', '-q', '-am', 'Other title');
		git(work, 'checkout', '-q', 'main');
		writeFileSync(join(work, 'README.md'), '# Main\n');
		git(work, 'commit', '-q', '-am', 'Main title');
		assert.throws(() => git(work, 'merge', 'other'));
		const status = await service.gitStatus(work);
		assert.ok(status?.files.some(file => file.status === 'conflicted'));
		await assert.rejects(service.commit({ folder: work, message: 'Resolve' }), (err: unknown) => /conflicts/i.test(voltPrErrorMessage(err)));
		git(work, 'merge', '--abort');
	});

	test('a commit that fails on a new branch goes back and removes the branch', async () => {
		writeFileSync(join(work, 'a.txt'), 'a\n');
		mkdirSync(join(work, '.git', 'hooks'), { recursive: true });
		writeFileSync(join(work, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
		await assert.rejects(service.commit({ folder: work, message: 'Blocked', newBranch: 'volt/blocked' }), /git commit failed/);
		assert.strictEqual(git(work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
		assert.strictEqual(git(work, 'branch', '--list', 'volt/blocked'), '');
		assert.ok(git(work, 'status', '--porcelain').includes('a.txt'), 'the change is still there');
	});

	test('an empty remote: a new branch counts its commits as ahead', async () => {
		const empty = join(root, 'empty.git');
		git(root, 'init', '-q', '--bare', '-b', 'main', empty);
		git(work, 'remote', 'remove', 'origin');
		git(work, 'config', `url.${empty}.insteadOf`, 'https://github.com/volt-test/empty.git');
		git(work, 'remote', 'add', 'origin', 'https://github.com/volt-test/empty.git');
		const status = await service.gitStatus(work);
		assert.strictEqual(status?.defaultBranch, undefined);
		assert.strictEqual(status?.upstream, undefined);
		assert.strictEqual(status?.aheadOfDefault, 1);
	});

	test('describing chosen paths leaves the other changes out', async () => {
		writeFileSync(join(work, 'README.md'), '# Notes\n\nChanged.\n');
		writeFileSync(join(work, 'new.txt'), 'n\n');
		writeFileSync(join(work, 'other.txt'), 'o\n');
		const summary = await service.describeChanges({ folder: work, paths: ['README.md', 'new.txt'] });
		assert.ok(summary.files.includes('README.md'));
		assert.ok(summary.files.includes('new.txt'));
		assert.ok(!summary.files.includes('other.txt'));
		assert.ok(summary.patch.includes('Changed.'));
	});
});
