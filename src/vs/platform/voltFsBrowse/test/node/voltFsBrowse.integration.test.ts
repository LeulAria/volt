/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltFsEntry } from '../../common/voltFsBrowse.js';
import { isSubsequence, VoltFsBrowseService } from '../../node/voltFsBrowseService.js';

suite('VoltFsBrowseService on real folders', function () {

	this.timeout(30_000);
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let service: VoltFsBrowseService;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'volt-fs-'));
		service = disposables.add(new VoltFsBrowseService());
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('lists folders with git, symlink and hidden handling', async () => {
		await mkdir(join(root, 'repo', '.git'), { recursive: true });
		await mkdir(join(root, 'worktree'));
		await writeFile(join(root, 'worktree', '.git'), 'gitdir: /elsewhere\n');
		await mkdir(join(root, 'plain'));
		await mkdir(join(root, '.hidden'));
		await writeFile(join(root, 'file.txt'), 'x');
		await symlink(join(root, 'plain'), join(root, 'linked'));
		await symlink(join(root, 'missing'), join(root, 'broken'));

		const listing = await service.list(root);
		const byName = new Map(listing.entries.map(entry => [entry.name, entry]));
		assert.deepStrictEqual([...byName.keys()], ['linked', 'plain', 'repo', 'worktree']);
		assert.strictEqual(byName.get('repo')?.gitRepo, true);
		assert.strictEqual(byName.get('worktree')?.gitRepo, true, 'a .git file counts');
		assert.strictEqual(byName.get('plain')?.gitRepo, undefined);
		assert.strictEqual(byName.get('linked')?.symlink, true);
		assert.strictEqual(byName.get('linked')?.kind, 'dir');
		assert.ok(typeof byName.get('plain')?.mtime === 'number');

		const hidden = await service.list(root, { showHidden: true });
		assert.ok(hidden.entries.some(entry => entry.name === '.hidden'));
		const withFiles = await service.list(root, { dirsOnly: false });
		assert.ok(withFiles.entries.some(entry => entry.name === 'file.txt' && entry.kind === 'file'));
	});

	test('reports missing folders and files instead of throwing', async () => {
		assert.strictEqual((await service.list(join(root, 'nope'))).error, 'notFound');
		await writeFile(join(root, 'f'), '');
		assert.strictEqual((await service.list(join(root, 'f'))).error, 'notDirectory');
	});

	test('lists 10k folders quickly', async () => {
		const big = join(root, 'big');
		await mkdir(big);
		for (let i = 0; i < 10_000; i += 500) {
			await Promise.all(Array.from({ length: 500 }, (_, j) => mkdir(join(big, `d${i + j}`))));
		}
		const started = Date.now();
		const listing = await service.list(big);
		const elapsed = Date.now() - started;
		assert.strictEqual(listing.entries.length, 10_000);
		assert.strictEqual(listing.truncated, true, 'metadata stops past the limit');
		assert.strictEqual(listing.entries[0].name, 'd0', 'numeric sort');
		assert.strictEqual(listing.entries[2].name, 'd2');
		assert.ok(elapsed < 5000, `took ${elapsed}ms`);
	});

	test('streams deep search results and skips build folders', async () => {
		await mkdir(join(root, 'work', 'client', 'api', '.git'), { recursive: true });
		await mkdir(join(root, 'work', 'client', 'api', 'inner-api'), { recursive: true });
		await mkdir(join(root, 'node_modules', 'api'), { recursive: true });
		await mkdir(join(root, 'docs', 'api-notes'), { recursive: true });
		const found: IVoltFsEntry[] = [];
		const store = new DisposableStore();
		const done = new Promise<void>(resolve => store.add(service.onDidFindFolders(e => {
			if (e.requestId === 'q') {
				found.push(...e.entries);
				if (e.done) {
					resolve();
				}
			}
		})));
		await service.findFolders('q', 'api', [root]);
		await done;
		store.dispose();
		const paths = found.map(entry => entry.path).sort();
		assert.deepStrictEqual(paths, [join(root, 'docs', 'api-notes'), join(root, 'work', 'client', 'api')]);
		assert.strictEqual(found.find(entry => entry.name === 'api')?.gitRepo, true);
	});

	test('creates folders, inspects them, and reads the origin remote', async () => {
		const created = await service.mkdir(root, 'fresh');
		assert.strictEqual(created, join(root, 'fresh'));
		await assert.rejects(() => service.mkdir(root, '../escape'));
		assert.deepStrictEqual(await service.inspect(created), { exists: true, directory: true, empty: true, gitRemote: undefined });
		await mkdir(join(created, '.git'));
		await writeFile(join(created, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/org/repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
		assert.deepStrictEqual(await service.inspect(created), { exists: true, directory: true, empty: false, gitRemote: 'https://github.com/org/repo.git' });
		assert.deepStrictEqual(await service.inspect(join(root, 'none')), { exists: false, directory: false, empty: true });
	});

	test('quick access starts at home', async () => {
		const roots = await service.quickAccess();
		assert.strictEqual(roots[0].id, 'home');
		assert.strictEqual(new Set(roots.map(r => r.path)).size, roots.length, 'no duplicates');
	});

	test('subsequence matching', () => {
		assert.ok(isSubsequence('api', 'my-api'));
		assert.ok(isSubsequence('', 'x'));
		assert.ok(!isSubsequence('api', 'pai'));
	});
});
