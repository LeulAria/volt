/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { timeout } from '../../../../base/common/async.js';
import { join } from '../../../../base/common/path.js';
import { isLinux } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isGitPath, watchWorkTree } from '../../../node/voltAgent/serverCheckpoints.js';

suite('Volt agent server: checkpoint work-tree watch without a watcher process (round 7)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('paths inside a git folder are not changes', () => {
		assert.strictEqual(isGitPath('.git/index.lock'), true);
		assert.strictEqual(isGitPath('sub/.git/HEAD'), true);
		assert.strictEqual(isGitPath('.git'), true);
		assert.strictEqual(isGitPath('src\\.git\\objects'), true);
		assert.strictEqual(isGitPath('src/app.ts'), false);
		assert.strictEqual(isGitPath('.gitignore'), false);
	});

	(isLinux ? test.skip : test)('a file written in the tree is seen, one in .git is not, nothing after dispose', async function () {
		this.timeout(20_000);
		const dir = realpathSync(await fs.mkdtemp(join(tmpdir(), 'volt-ckpt-watch-')));
		await fs.mkdir(join(dir, '.git'));
		let changes = 0;
		const watch = watchWorkTree(dir, () => changes++, () => { /* none expected */ })!;
		try {
			// FSEvents starts delivering a moment after the stream is scheduled, and its first delivery can replay
			// what happened just before: the `.git` folder made above, and the work tree's own entry (named by its
			// basename). Count from after that settle.
			await timeout(500);
			changes = 0;
			await fs.writeFile(join(dir, '.git', 'index'), 'x');
			await timeout(1_500);
			assert.strictEqual(changes, 0, 'a write under .git is not a change');
			await fs.writeFile(join(dir, 'app.ts'), 'x');
			for (let i = 0; i < 40 && !changes; i++) {
				await timeout(100);
			}
			assert.ok(changes > 0, 'a write in the tree is a change');
		} finally {
			watch.dispose();
		}
		const seen = changes;
		await fs.writeFile(join(dir, 'other.ts'), 'x');
		await timeout(1_000);
		assert.strictEqual(changes, seen, 'nothing is reported once disposed');
		await fs.rm(dir, { recursive: true, force: true });
	});
});
