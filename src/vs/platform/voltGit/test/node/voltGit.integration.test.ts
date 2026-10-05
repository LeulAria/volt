/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawnSync } from 'child_process';
import { mkdtemp, readFile, rm, unlink, writeFile, rename, mkdir, stat } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltGitCloneProgress, isVoltGitError, VOLT_SNAPSHOT_REF_PREFIX } from '../../common/voltGit.js';
import { isSafeCloneUrl, parseCloneProgress, parseDiffSummary, VoltGitService } from '../../node/voltGitService.js';

suite('VoltGitService on real repos', function () {

	this.timeout(30_000);
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let repo: string;
	let privateIndex: string;
	let service: VoltGitService;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'volt-git-'));
		repo = join(root, 'repo');
		await mkdir(repo);
		privateIndex = join(root, 'index', 'session.idx');
		service = disposables.add(new VoltGitService(async () => process.env));
		git(repo, 'init', '-q', '-b', 'main');
		git(repo, 'config', 'user.email', 'test@volt.local');
		git(repo, 'config', 'user.name', 'Volt Test');
		git(repo, 'config', 'commit.gpgsign', 'false');
		await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
		await writeFile(join(repo, 'b.txt'), 'bee\n');
		await writeFile(join(repo, 'move.txt'), 'line 1\nline 2\nline 3\nline 4\nline 5\n');
		await writeFile(join(repo, '.gitignore'), 'ignored/\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'init');
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function snap(name: string, parent?: string) {
		return service.snapshot({ repoRoot: repo, indexFile: privateIndex, parent, ref: `${VOLT_SNAPSHOT_REF_PREFIX}s1/1/${name}`, message: `volt s1 t1 ${name}` });
	}

	test('captures a dirty, untracked tree without touching the user index', async () => {
		// The user has something staged and something unstaged before the turn.
		await writeFile(join(repo, 'a.txt'), 'one\ntwo (staged)\nthree\n');
		git(repo, 'add', 'a.txt');
		await writeFile(join(repo, 'b.txt'), 'bee (unstaged)\n');
		await mkdir(join(repo, 'ignored'));
		await writeFile(join(repo, 'ignored', 'junk.txt'), 'junk\n');
		const indexBefore = await readFile(join(repo, '.git', 'index'));
		const statusBefore = git(repo, 'status', '--porcelain=v1');

		const indexTree = await service.writeIndexTree({ repoRoot: repo });
		const pre = await snap('pre');

		// The agent edits, creates, deletes and renames.
		await writeFile(join(repo, 'a.txt'), 'one\ntwo (staged)\nthree\nfour\n');
		await writeFile(join(repo, 'new.txt'), 'fresh\n');
		await unlink(join(repo, 'b.txt'));
		await rename(join(repo, 'move.txt'), join(repo, 'moved.txt'));
		await writeFile(join(repo, 'ignored', 'junk.txt'), 'more junk\n');
		const post = await snap('post', pre.commit);

		assert.deepStrictEqual(await readFile(join(repo, '.git', 'index')), indexBefore, 'user index is byte-identical');
		assert.notStrictEqual(git(repo, 'status', '--porcelain=v1'), statusBefore);
		assert.strictEqual(git(repo, 'rev-parse', `${pre.commit}^`).trim(), git(repo, 'rev-parse', 'HEAD').trim(), 'pre hangs off HEAD');
		assert.strictEqual(git(repo, 'rev-parse', `${post.commit}^`).trim(), pre.commit);
		assert.strictEqual(git(repo, 'rev-parse', `${VOLT_SNAPSHOT_REF_PREFIX}s1/1/post`).trim(), post.commit);
		assert.strictEqual(git(repo, 'branch', '--list').trim(), '* main', 'no branch created');
		assert.strictEqual(git(repo, 'show', `${indexTree}:a.txt`), 'one\ntwo (staged)\nthree\n', 'indexTree is the staged state');
		assert.strictEqual(git(repo, 'show', `${pre.commit}:b.txt`), 'bee (unstaged)\n', 'pre holds unstaged edits');

		const diff = await service.diffSummary({ repoRoot: repo, from: pre.commit, to: post.commit });
		const byPath = new Map(diff.map(entry => [entry.path, entry]));
		assert.deepStrictEqual([...byPath.keys()].sort(), ['a.txt', 'b.txt', 'moved.txt', 'new.txt']);
		assert.deepStrictEqual(pick(byPath.get('a.txt')), { kind: 'modified', additions: 1, deletions: 0, binary: false });
		assert.deepStrictEqual(pick(byPath.get('new.txt')), { kind: 'added', additions: 1, deletions: 0, binary: false });
		assert.deepStrictEqual(pick(byPath.get('b.txt')), { kind: 'deleted', additions: 0, deletions: 1, binary: false });
		assert.strictEqual(byPath.get('moved.txt')?.kind, 'renamed');
		assert.strictEqual(byPath.get('moved.txt')?.oldPath, 'move.txt');
		assert.strictEqual(byPath.get('new.txt')?.oldBlob, undefined);
		assert.strictEqual(byPath.get('b.txt')?.newBlob, undefined);
		assert.strictEqual((await service.readBlob({ repoRoot: repo, sha: byPath.get('a.txt')!.oldBlob! })).toString(), 'one\ntwo (staged)\nthree\n');
	});

	test('reports binary files and edits the user makes between turns stay out of the next turn', async () => {
		const pre1 = await snap('pre');
		await writeFile(join(repo, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
		const post1 = await snap('post', pre1.commit);
		const binary = await service.diffSummary({ repoRoot: repo, from: pre1.commit, to: post1.commit });
		assert.deepStrictEqual(binary.map(pick), [{ kind: 'added', additions: 0, deletions: 0, binary: true }]);

		// The user types between messages; the second pre catches it.
		await writeFile(join(repo, 'b.txt'), 'bee by user\n');
		const pre2 = await service.snapshot({ repoRoot: repo, indexFile: privateIndex, parent: post1.commit, ref: `${VOLT_SNAPSHOT_REF_PREFIX}s1/2/pre`, message: 'pre 2' });
		await writeFile(join(repo, 'a.txt'), 'agent 2\n');
		const post2 = await service.snapshot({ repoRoot: repo, indexFile: privateIndex, parent: pre2.commit, ref: `${VOLT_SNAPSHOT_REF_PREFIX}s1/2/post`, message: 'post 2' });
		const turn2 = await service.diffSummary({ repoRoot: repo, from: pre2.commit, to: post2.commit });
		assert.deepStrictEqual(turn2.map(entry => entry.path), ['a.txt']);
	});

	test('path hints re-scan only those paths and fall back when a hint is gone', async () => {
		await snap('warm');
		await writeFile(join(repo, 'a.txt'), 'hinted\n');
		await writeFile(join(repo, 'b.txt'), 'not hinted\n');
		const hinted = await service.snapshot({ repoRoot: repo, indexFile: privateIndex, ref: `${VOLT_SNAPSHOT_REF_PREFIX}s1/h/1`, message: 'hinted', paths: ['a.txt'] });
		assert.strictEqual(git(repo, 'show', `${hinted.commit}:a.txt`), 'hinted\n');
		assert.strictEqual(git(repo, 'show', `${hinted.commit}:b.txt`), 'bee\n');

		const fallback = await service.snapshot({ repoRoot: repo, indexFile: privateIndex, ref: `${VOLT_SNAPSHOT_REF_PREFIX}s1/h/2`, message: 'fallback', paths: ['never-existed.txt'] });
		assert.strictEqual(git(repo, 'show', `${fallback.commit}:b.txt`), 'not hinted\n');
	});

	test('keep stages exact content; reset restores the index from indexTree', async () => {
		const indexTree = await service.writeIndexTree({ repoRoot: repo });
		await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n');
		await writeFile(join(repo, 'new.txt'), 'created\n');

		// Keep only the first hunk of a.txt: the index gets that content, the file is untouched.
		const kept = await service.writeBlob({ repoRoot: repo, content: VSBuffer.fromString('one\nTWO\nthree\n'), path: 'a.txt' });
		await service.setIndexEntry({ repoRoot: repo, path: 'a.txt', blob: kept });
		const created = await service.writeBlob({ repoRoot: repo, content: VSBuffer.fromString('created\n'), path: 'new.txt' });
		await service.setIndexEntry({ repoRoot: repo, path: 'new.txt', blob: created });
		assert.strictEqual(git(repo, 'show', ':a.txt'), 'one\nTWO\nthree\n');
		assert.strictEqual(await readFile(join(repo, 'a.txt'), 'utf8'), 'one\nTWO\nthree\nfour\n');
		assert.deepStrictEqual(git(repo, 'diff', '--cached', '--name-only').trim().split('\n'), ['a.txt', 'new.txt']);

		// Staging a deletion.
		await service.setIndexEntry({ repoRoot: repo, path: 'b.txt', blob: null });
		assert.match(git(repo, 'diff', '--cached', '--name-status'), /D\tb\.txt/);

		// Undo after Keep: everything goes back to the index before the turn, including the new file.
		await service.resetIndexPaths({ repoRoot: repo, treeish: indexTree, paths: ['a.txt', 'new.txt', 'b.txt', 'never-existed.txt'] });
		assert.strictEqual(git(repo, 'diff', '--cached', '--name-only').trim(), '');
		assert.strictEqual(git(repo, 'ls-files', 'new.txt').trim(), '');
	});

	test('keeps the executable bit when staging over an existing entry', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		git(repo, 'update-index', '--chmod=+x', 'b.txt');
		const blob = await service.writeBlob({ repoRoot: repo, content: VSBuffer.fromString('bee 2\n'), path: 'b.txt' });
		await service.setIndexEntry({ repoRoot: repo, path: 'b.txt', blob });
		assert.match(git(repo, 'ls-files', '--stage', 'b.txt'), /^100755 /);
	});

	test('applies forward, reverse, and reports three-way conflicts', async () => {
		const pre = await snap('pre');
		await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\nagent\n');
		const post = await snap('post', pre.commit);
		// Put the file back, as if the change happened in a worktree.
		await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n');

		const forward = await service.applyPatch({ repoRoot: repo, from: pre.commit, to: post.commit, index: true });
		assert.strictEqual(forward.ok, true);
		assert.strictEqual(await readFile(join(repo, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nagent\n');
		assert.strictEqual(git(repo, 'show', ':a.txt'), 'one\ntwo\nthree\nagent\n', 'kept change is staged');

		const reverse = await service.applyPatch({ repoRoot: repo, from: pre.commit, to: post.commit, index: true, reverse: true });
		assert.strictEqual(reverse.ok, true);
		assert.strictEqual(await readFile(join(repo, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n');

		// The user changed the same line meanwhile.
		await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\nuser\n');
		git(repo, 'add', 'a.txt');
		const conflict = await service.applyPatch({ repoRoot: repo, from: pre.commit, to: post.commit, index: true });
		assert.strictEqual(conflict.ok, false);
		assert.deepStrictEqual(conflict.conflicts, ['a.txt']);

		const empty = await service.applyPatch({ repoRoot: repo, from: pre.commit, to: pre.commit, index: true });
		assert.deepStrictEqual(empty, { ok: true, conflicts: [], stderr: '' });
	});

	test('lists and deletes a session\'s refs', async () => {
		await snap('pre');
		await snap('post');
		await service.updateRef({ repoRoot: repo, ref: `${VOLT_SNAPSHOT_REF_PREFIX}other/1/pre`, commit: git(repo, 'rev-parse', 'HEAD').trim() });
		assert.deepStrictEqual((await service.listRefs({ repoRoot: repo, prefix: `${VOLT_SNAPSHOT_REF_PREFIX}s1/` })).map(ref => ref.ref).sort(),
			[`${VOLT_SNAPSHOT_REF_PREFIX}s1/1/post`, `${VOLT_SNAPSHOT_REF_PREFIX}s1/1/pre`]);
		await service.deleteRefs({ repoRoot: repo, prefix: `${VOLT_SNAPSHOT_REF_PREFIX}s1/` });
		assert.deepStrictEqual(await service.listRefs({ repoRoot: repo, prefix: `${VOLT_SNAPSHOT_REF_PREFIX}s1/` }), []);
		assert.strictEqual((await service.listRefs({ repoRoot: repo, prefix: VOLT_SNAPSHOT_REF_PREFIX })).length, 1);
		await service.updateRef({ repoRoot: repo, ref: `${VOLT_SNAPSHOT_REF_PREFIX}other/1/pre` });
		assert.deepStrictEqual(await service.listRefs({ repoRoot: repo, prefix: VOLT_SNAPSHOT_REF_PREFIX }), []);
		await service.deleteRefs({ repoRoot: repo, prefix: VOLT_SNAPSHOT_REF_PREFIX });
	});

	test('resolves repos, snapshots an unborn HEAD, and fails loudly', async () => {
		const resolved = await service.resolveRepo(join(repo));
		assert.ok(resolved);
		assert.strictEqual(await service.resolveRepo(root), undefined);

		const fresh = join(root, 'fresh');
		await mkdir(fresh);
		git(fresh, 'init', '-q');
		await writeFile(join(fresh, 'x.txt'), 'x\n');
		const tree = await service.writeIndexTree({ repoRoot: fresh });
		assert.strictEqual(tree, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
		const first = await service.snapshot({ repoRoot: fresh, indexFile: join(root, 'index', 'fresh.idx'), ref: `${VOLT_SNAPSHOT_REF_PREFIX}f/1/pre`, message: 'pre' });
		assert.strictEqual(git(fresh, 'show', `${first.commit}:x.txt`), 'x\n');
		assert.strictEqual(git(fresh, 'rev-list', '--parents', '-n', '1', first.commit).trim(), first.commit, 'no parent');

		await assert.rejects(() => service.readBlob({ repoRoot: repo, sha: '0123456789012345678901234567890123456789' }), isVoltGitError);
		await assert.rejects(() => service.diffSummary({ repoRoot: repo, from: 'nope', to: 'HEAD' }), (err: Error) => isVoltGitError(err) && /exit 128/.test(err.message));
	});
});

suite('VoltGitService checkpoints: limits, restore, private repos', function () {

	this.timeout(30_000);
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let repo: string;
	let privateIndex: string;
	let service: VoltGitService;
	let n = 0;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'volt-ckpt-'));
		repo = join(root, 'repo');
		await mkdir(repo);
		privateIndex = join(root, 'index', 'snap.idx');
		service = disposables.add(new VoltGitService(async () => process.env, undefined, { shadowRoot: join(root, 'shadows') }));
		git(repo, 'init', '-q', '-b', 'main');
		git(repo, 'config', 'user.email', 'test@volt.local');
		git(repo, 'config', 'user.name', 'Volt Test');
		git(repo, 'config', 'commit.gpgsign', 'false');
		await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
		await writeFile(join(repo, 'b.txt'), 'bee\n');
		await writeFile(join(repo, '.gitignore'), 'ignored/\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'init');
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function snap(options: { workTree?: string; repoRoot?: string; indexFile?: string; maxFileBytes?: number; maxNewFiles?: number } = {}) {
		return service.snapshot({ repoRoot: options.repoRoot ?? repo, workTree: options.workTree, indexFile: options.indexFile ?? privateIndex, ref: `${VOLT_SNAPSHOT_REF_PREFIX}t/${++n}`, message: `snap ${n}`, maxFileBytes: options.maxFileBytes, maxNewFiles: options.maxNewFiles });
	}

	test('restores modified, created, deleted and shell-changed files, leaving ignored files and the user index alone', async () => {
		await mkdir(join(repo, 'ignored'));
		await writeFile(join(repo, 'ignored', 'cache.txt'), 'before\n');
		await writeFile(join(repo, 'untracked.txt'), 'mine\n');
		const pre = await snap();
		const indexBefore = await readFile(join(repo, '.git', 'index'));

		// The agent edits, creates (in a new folder), deletes; a "shell" command rewrites another file.
		await writeFile(join(repo, 'a.txt'), 'one\ntwo\nTHREE\nfour\nfive\nsix\n');
		await mkdir(join(repo, 'src', 'deep'), { recursive: true });
		await writeFile(join(repo, 'src', 'deep', 'new.txt'), 'fresh\n');
		await unlink(join(repo, 'b.txt'));
		await writeFile(join(repo, 'untracked.txt'), 'sed rewrote this\n');
		await writeFile(join(repo, 'ignored', 'cache.txt'), 'after\n');
		const post = await snap();

		const preview = await service.restore({ repoRoot: repo, steps: [{ before: pre.commit, after: post.commit }], dryRun: true });
		assert.strictEqual(preview.applied, false);
		assert.deepStrictEqual(preview.entries.map(e => [e.path, e.action, e.outcome]).sort(), [
			['a.txt', 'write', 'restored'],
			['b.txt', 'create', 'restored'],
			['src/deep/new.txt', 'delete', 'restored'],
			['untracked.txt', 'write', 'restored'],
		]);
		assert.strictEqual(await readFile(join(repo, 'a.txt'), 'utf8'), 'one\ntwo\nTHREE\nfour\nfive\nsix\n', 'a dry run writes nothing');

		const result = await service.restore({ repoRoot: repo, steps: [{ before: pre.commit, after: post.commit }] });
		assert.strictEqual(result.applied, true);
		assert.deepStrictEqual(result.conflicts, []);
		assert.strictEqual(await readFile(join(repo, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
		assert.strictEqual(await readFile(join(repo, 'b.txt'), 'utf8'), 'bee\n');
		assert.strictEqual(await readFile(join(repo, 'untracked.txt'), 'utf8'), 'mine\n');
		await assert.rejects(() => stat(join(repo, 'src')), 'the folder the agent created goes too');
		assert.strictEqual(await readFile(join(repo, 'ignored', 'cache.txt'), 'utf8'), 'after\n', 'ignored files are never touched');
		assert.deepStrictEqual(await readFile(join(repo, '.git', 'index')), indexBefore, 'user index is byte-identical');
	});

	test('keeps edits made after the agent when they merge, and reports overlapping ones as conflicts', async () => {
		const pre = await snap();
		await writeFile(join(repo, 'a.txt'), 'one\nAGENT\nthree\nfour\nfive\nsix\n');
		await writeFile(join(repo, 'b.txt'), 'bee agent\n');
		const post = await snap();
		// The user edits far from the agent's change in a.txt, and on top of it in b.txt.
		await writeFile(join(repo, 'a.txt'), 'one\nAGENT\nthree\nfour\nfive\nsix (user)\n');
		await writeFile(join(repo, 'b.txt'), 'bee agent and user\n');

		const result = await service.restore({ repoRoot: repo, steps: [{ before: pre.commit, after: post.commit }] });
		const byPath = new Map(result.entries.map(e => [e.path, e]));
		assert.deepStrictEqual([byPath.get('a.txt')?.outcome, byPath.get('a.txt')?.editedSince], ['merged', true]);
		assert.strictEqual(await readFile(join(repo, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nfour\nfive\nsix (user)\n', 'the agent change is gone, the user edit stays');
		assert.deepStrictEqual(result.conflicts, ['b.txt']);
		assert.strictEqual(await readFile(join(repo, 'b.txt'), 'utf8'), 'bee agent and user\n', 'a conflicted file is left alone');

		const forced = await service.restore({ repoRoot: repo, steps: [{ before: pre.commit, after: post.commit }], paths: ['b.txt'], overwrite: true });
		assert.deepStrictEqual(forced.entries.map(e => [e.path, e.outcome]), [['b.txt', 'restored']]);
		assert.strictEqual(await readFile(join(repo, 'b.txt'), 'utf8'), 'bee\n');
	});

	test('walks back several turns, keeping a user edit made between them, and undoes the restore', async () => {
		const pre1 = await snap();
		await writeFile(join(repo, 'a.txt'), 'one (agent 1)\ntwo\nthree\nfour\nfive\nsix\n');
		await writeFile(join(repo, 'made.txt'), 'turn 1\n');
		const post1 = await snap();
		await writeFile(join(repo, 'a.txt'), 'one (agent 1)\ntwo\nthree\nfour\nfive\nsix (user between turns)\n');
		const pre2 = await snap();
		await writeFile(join(repo, 'a.txt'), 'one (agent 1)\ntwo\nthree (agent 2)\nfour\nfive\nsix (user between turns)\n');
		const post2 = await snap();

		const steps = [{ before: pre2.commit, after: post2.commit }, { before: pre1.commit, after: post1.commit }];
		const restoreBefore = await snap();
		const result = await service.restore({ repoRoot: repo, steps });
		assert.deepStrictEqual(result.conflicts, []);
		assert.strictEqual(await readFile(join(repo, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nfour\nfive\nsix (user between turns)\n');
		await assert.rejects(() => stat(join(repo, 'made.txt')));

		const restoreAfter = await snap();
		const redo = await service.restore({ repoRoot: repo, steps: [{ before: restoreBefore.commit, after: restoreAfter.commit }] });
		assert.deepStrictEqual(redo.conflicts, []);
		assert.strictEqual(await readFile(join(repo, 'a.txt'), 'utf8'), 'one (agent 1)\ntwo\nthree (agent 2)\nfour\nfive\nsix (user between turns)\n');
		assert.strictEqual(await readFile(join(repo, 'made.txt'), 'utf8'), 'turn 1\n');
	});

	test('restores binary files and the executable bit', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		await writeFile(join(repo, 'img.bin'), Buffer.from([0, 1, 2, 3]));
		const pre = await snap();
		await writeFile(join(repo, 'img.bin'), Buffer.from([9, 0, 9]));
		git(repo, 'update-index', '--chmod=+x', 'b.txt');
		spawnSync('chmod', ['+x', join(repo, 'b.txt')]);
		const post = await snap();
		await writeFile(join(repo, 'img.bin'), Buffer.from([7, 0, 7]));
		const conflict = await service.restore({ repoRoot: repo, steps: [{ before: pre.commit, after: post.commit }], paths: ['img.bin'] });
		assert.deepStrictEqual(conflict.entries.map(e => [e.outcome, e.binary]), [['conflict', true]], 'a binary changed since the agent is not merged');
		await writeFile(join(repo, 'img.bin'), Buffer.from([9, 0, 9]));
		await service.restore({ repoRoot: repo, steps: [{ before: pre.commit, after: post.commit }] });
		assert.deepStrictEqual([...await readFile(join(repo, 'img.bin'))], [0, 1, 2, 3]);
		assert.strictEqual((await stat(join(repo, 'b.txt'))).mode & 0o111, 0, 'mode-only change undone');
	});

	test('leaves out big untracked files for good, dependency folders, and files over the count limit', async () => {
		await writeFile(join(repo, 'big.dat'), Buffer.alloc(2048, 1));
		await mkdir(join(repo, 'node_modules', 'left-pad'), { recursive: true });
		await writeFile(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
		await writeFile(join(repo, 'small.txt'), 'small\n');
		const first = await snap({ maxFileBytes: 1024 });
		assert.strictEqual(first.skipped, 1);
		const files = git(repo, 'ls-tree', '-r', '--name-only', first.commit).trim().split('\n');
		assert.deepStrictEqual(files.sort(), ['.gitignore', 'a.txt', 'b.txt', 'small.txt']);

		// It shrinks: still left out, so restoring never deletes a file a snapshot did not have.
		await writeFile(join(repo, 'big.dat'), 'tiny\n');
		const second = await snap({ maxFileBytes: 1024 });
		assert.ok(!git(repo, 'ls-tree', '-r', '--name-only', second.commit).includes('big.dat'));

		for (let i = 0; i < 3; i++) {
			await writeFile(join(repo, `many-${i}.txt`), `${i}\n`);
		}
		const capped = await snap({ maxNewFiles: 2 });
		assert.strictEqual(capped.skipped, 1);
		assert.strictEqual(git(repo, 'ls-tree', '-r', '--name-only', capped.commit).split('\n').filter(f => f.startsWith('many-')).length, 2);
	});

	test('reuses an unchanged snapshot instead of writing a new commit', async () => {
		const first = await snap();
		const again = await service.snapshot({ repoRoot: repo, indexFile: privateIndex, ref: `${VOLT_SNAPSHOT_REF_PREFIX}t/reuse`, message: 'again', reuse: first });
		assert.deepStrictEqual(again, first);
		assert.deepStrictEqual(await service.listRefs({ repoRoot: repo, prefix: `${VOLT_SNAPSHOT_REF_PREFIX}t/reuse` }), [], 'the ref is not written');
	});

	test('reads blobs as checked out, with line-ending attributes applied', async () => {
		await writeFile(join(repo, '.gitattributes'), '*.crlf text eol=crlf\n');
		await writeFile(join(repo, 'x.crlf'), 'a\r\nb\r\n');
		const shot = await snap();
		const blob = git(repo, 'rev-parse', `${shot.commit}:x.crlf`).trim();
		assert.strictEqual((await service.readBlob({ repoRoot: repo, sha: blob })).toString(), 'a\nb\n', 'stored normalized');
		assert.strictEqual((await service.readBlob({ repoRoot: repo, sha: blob, path: 'x.crlf' })).toString(), 'a\r\nb\r\n', 'read back as on disk');
	});

	test('folders outside git get a private repo; nothing is written into them', async () => {
		const plain = join(root, 'plain');
		await mkdir(plain);
		await writeFile(join(plain, 'notes.md'), 'v1\n');
		const resolved = await service.resolveSnapshotRepo(plain);
		assert.ok(resolved?.shadow);
		assert.strictEqual(await service.resolveRepo(plain), undefined, 'still not a git folder to everyone else');
		assert.strictEqual(await service.resolveSnapshotRepo(homedir()), undefined, 'never the home folder');

		const shot = (name: string) => service.snapshot({ repoRoot: resolved.repoRoot, workTree: resolved.workTree, indexFile: resolved.indexFile, ref: `${VOLT_SNAPSHOT_REF_PREFIX}p/${name}`, message: name });
		const pre = await shot('pre');
		await writeFile(join(plain, 'notes.md'), 'v2\n');
		await writeFile(join(plain, 'added.md'), 'new\n');
		const post = await shot('post');
		const diff = await service.diffSummary({ repoRoot: resolved.repoRoot, from: pre.commit, to: post.commit });
		assert.deepStrictEqual(diff.map(e => [e.path, e.kind]).sort(), [['added.md', 'added'], ['notes.md', 'modified']]);
		await service.restore({ repoRoot: resolved.repoRoot, steps: [{ before: pre.commit, after: post.commit }] });
		assert.strictEqual(await readFile(join(plain, 'notes.md'), 'utf8'), 'v1\n');
		await assert.rejects(() => stat(join(plain, 'added.md')));
		await assert.rejects(() => stat(join(plain, '.git')), 'no .git in the folder');

		// A second service (an app restart) finds the same private repo and its refs.
		const restarted = disposables.add(new VoltGitService(async () => process.env, undefined, { shadowRoot: join(root, 'shadows') }));
		const again = await restarted.resolveSnapshotRepo(plain);
		assert.strictEqual(again?.gitDir, resolved.gitDir);
		assert.strictEqual((await restarted.listRefs({ repoRoot: plain, prefix: `${VOLT_SNAPSHOT_REF_PREFIX}p/` })).length, 2);
	});
});

suite('VoltGitService clone and branches', function () {

	this.timeout(30_000);
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let origin: string;
	let service: VoltGitService;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'volt-clone-'));
		origin = join(root, 'origin');
		await mkdir(origin);
		service = disposables.add(new VoltGitService(async () => process.env));
		git(origin, 'init', '-q', '-b', 'main');
		git(origin, 'config', 'user.email', 'test@volt.local');
		git(origin, 'config', 'user.name', 'Volt Test');
		git(origin, 'config', 'commit.gpgsign', 'false');
		await writeFile(join(origin, 'README.md'), '# origin\n');
		git(origin, 'add', '-A');
		git(origin, 'commit', '-q', '-m', 'init');
		git(origin, 'branch', 'feature');
		git(origin, 'tag', 'v1');
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('clones with progress into a new nested folder, then lists and switches branches', async () => {
		const progress: IVoltGitCloneProgress[] = [];
		disposables.add(service.onDidCloneProgress(e => progress.push(e)));
		const dest = join(root, 'code', 'nested', 'copy');
		await service.clone({ jobId: 'j1', url: `file://${origin}`, dest });
		assert.strictEqual(await readFile(join(dest, 'README.md'), 'utf8'), '# origin\n');
		assert.strictEqual(progress[0].phase, 'starting');
		assert.deepStrictEqual(progress.at(-1), { jobId: 'j1', phase: 'done', percent: 100, message: undefined });

		const branches = await service.listBranches({ repoRoot: dest });
		assert.strictEqual(branches.head, 'main');
		assert.strictEqual(branches.unborn, false);
		assert.deepStrictEqual(branches.local, ['main']);
		assert.deepStrictEqual([...branches.remote].sort(), ['origin/feature', 'origin/main']);
		assert.deepStrictEqual(branches.tags, ['v1']);
		const main = branches.refs.find(ref => ref.ref === 'refs/heads/main');
		assert.strictEqual(main?.kind, 'local');
		assert.ok(main.subject && main.author && main.date > 0, 'refs carry their latest commit');
		assert.strictEqual(main.ahead, undefined, 'a branch in step with its upstream has no counts');
		git(dest, '-c', 'user.email=test@volt.local', '-c', 'user.name=Volt Test', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'local only');
		const ahead = (await service.listBranches({ repoRoot: dest })).refs.find(ref => ref.ref === 'refs/heads/main');
		assert.deepStrictEqual([ahead?.ahead, ahead?.behind], [1, 0], 'a local commit puts the branch ahead of origin');

		await service.checkout({ repoRoot: dest, ref: 'origin/feature', kind: 'remote' });
		assert.strictEqual((await service.listBranches({ repoRoot: dest })).head, 'feature', 'remote pick creates a tracking branch');
		await service.checkout({ repoRoot: dest, ref: 'main', kind: 'local' });
		await service.createBranch({ repoRoot: dest, name: 'feat/pickers' });
		assert.strictEqual((await service.listBranches({ repoRoot: dest })).head, 'feat/pickers');
		await assert.rejects(() => service.createBranch({ repoRoot: dest, name: 'bad name' }), isVoltGitError);
		await service.createBranch({ repoRoot: dest, name: 'from-feature', from: 'refs/remotes/origin/feature' });
		assert.strictEqual((await service.listBranches({ repoRoot: dest })).head, 'from-feature');
		await service.checkout({ repoRoot: dest, ref: 'refs/heads/main', kind: 'detached' });
		assert.strictEqual((await service.listBranches({ repoRoot: dest })).head, undefined, 'detached checkout leaves no branch');
		await service.checkout({ repoRoot: dest, ref: 'v1', kind: 'tag' });
		const detached = await service.listBranches({ repoRoot: dest });
		assert.strictEqual(detached.head, undefined);
		assert.match(detached.detached ?? '', /^[0-9a-f]{7,}$/);
	});

	test('a freshly initialized repo names its branch but has no commits on it', async () => {
		const fresh = join(root, 'fresh');
		await mkdir(fresh);
		git(fresh, 'init', '-q', '-b', 'main');
		const branches = await service.listBranches({ repoRoot: fresh });
		assert.strictEqual(branches.head, 'main');
		assert.strictEqual(branches.unborn, true);
		assert.deepStrictEqual(branches.refs, []);
		await service.createBranch({ repoRoot: fresh, name: 'start' });
		assert.deepStrictEqual(await service.listBranches({ repoRoot: fresh }).then(b => [b.head, b.unborn]), ['start', true], 'a new branch before the first commit is still empty');
	});

	test('fails loudly and refuses unsafe URLs', async () => {
		await assert.rejects(() => service.clone({ jobId: 'j2', url: join(root, 'nope'), dest: join(root, 'x') }), (err: Error) => isVoltGitError(err) && /exit 128/.test(err.message));
		await assert.rejects(() => service.clone({ jobId: 'j3', url: 'ext::sh -c touch% /tmp/x', dest: join(root, 'y') }), isVoltGitError);
		await assert.rejects(() => service.clone({ jobId: 'j4', url: origin, dest: 'relative/path' }), isVoltGitError);
	});

	test('cancel stops the clone', async () => {
		const dest = join(root, 'cancelled');
		const pending = service.clone({ jobId: 'j5', url: `file://${origin}`, dest });
		await service.cancelClone('j5');
		await pending.then(() => undefined, err => assert.ok(isVoltGitError(err)));
	});
});

suite('Clone helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps git progress lines to overall percent', () => {
		assert.deepStrictEqual(parseCloneProgress('Receiving objects:  50% (5/10), 1.00 MiB | 2.00 MiB/s'), { phase: 'receiving', percent: 45 });
		assert.deepStrictEqual(parseCloneProgress('remote: Counting objects: 100% (10/10), done.'), { phase: 'counting', percent: 5 });
		assert.deepStrictEqual(parseCloneProgress('Resolving deltas: 100% (3/3), done.'), { phase: 'resolving', percent: 92 });
		assert.deepStrictEqual(parseCloneProgress('Updating files:  10% (1/10)'), { phase: 'checkout', percent: 93 });
		assert.strictEqual(parseCloneProgress('warning: redirecting to https://x'), undefined);
	});

	test('allows normal URLs and blocks command transports and options', () => {
		for (const url of ['https://github.com/a/b.git', 'git@github.com:a/b.git', 'ssh://git@h/a/b', 'file:///tmp/r', '/tmp/r']) {
			assert.ok(isSafeCloneUrl(url), url);
		}
		for (const url of ['ext::sh -c x', '--upload-pack=x', 'fd::17', 'https://x/\u0000', '']) {
			assert.ok(!isSafeCloneUrl(url), url);
		}
	});
});

suite('parseDiffSummary', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('pairs raw and numstat records, including renames and paths with tabs', () => {
		const sha1 = 'a'.repeat(40);
		const sha2 = 'b'.repeat(40);
		const zero = '0'.repeat(40);
		const output = [
			`:100644 100644 ${sha1} ${sha2} M`, 'src/a b.ts',
			`:100644 100644 ${sha1} ${sha2} R087`, 'old.ts', 'new\tname.ts',
			`:000000 100644 ${zero} ${sha2} A`, 'img.png',
			'3\t1\tsrc/a b.ts',
			'2\t2\t', 'old.ts', 'new\tname.ts',
			'-\t-\timg.png',
			'',
		].join('\0');
		assert.deepStrictEqual(parseDiffSummary(output), [
			{ path: 'src/a b.ts', kind: 'modified', oldBlob: sha1, newBlob: sha2, oldMode: '100644', newMode: '100644', additions: 3, deletions: 1, binary: false },
			{ path: 'new\tname.ts', oldPath: 'old.ts', kind: 'renamed', oldBlob: sha1, newBlob: sha2, oldMode: '100644', newMode: '100644', additions: 2, deletions: 2, binary: false },
			{ path: 'img.png', kind: 'added', newBlob: sha2, newMode: '100644', additions: 0, deletions: 0, binary: true },
		]);
		assert.deepStrictEqual(parseDiffSummary(''), []);
	});
});

function pick(entry: { kind: string; additions: number; deletions: number; binary: boolean } | undefined) {
	return entry && { kind: entry.kind, additions: entry.additions, deletions: entry.deletions, binary: entry.binary };
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	}
	return result.stdout;
}
