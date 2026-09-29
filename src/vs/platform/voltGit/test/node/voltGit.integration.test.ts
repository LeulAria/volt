/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawnSync } from 'child_process';
import { mkdtemp, readFile, rm, unlink, writeFile, rename, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isVoltGitError, VOLT_SNAPSHOT_REF_PREFIX } from '../../common/voltGit.js';
import { parseDiffSummary, VoltGitService } from '../../node/voltGitService.js';

suite('VoltGitService on real repos', function () {

	this.timeout(30_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let repo: string;
	let privateIndex: string;
	let service: VoltGitService;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'volt-git-'));
		repo = join(root, 'repo');
		await mkdir(repo);
		privateIndex = join(root, 'index', 'session.idx');
		service = new VoltGitService(async () => process.env);
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
