/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { fuzzyFindPaths, fuzzyTerms, scorePath } from '../../common/fuzzyPath.js';

const PATHS = [
	'src/vs/platform/voltCodeIndex/node/rootIndex.ts',
	'src/vs/platform/voltCodeIndex/common/voltCodeIndex.ts',
	'src/index.ts',
	'test/fixtures/deep/nested/index.ts',
	'kernel/sched/fair.c',
	'kernel/sched/core.c',
	'arch/x86/include/asm/fpu/sched.h',
	'docs/My Notes/release plan.md',
	'src/components/UserService.tsx',
	'src/components/userService.test.tsx',
	'README.md',
];

suite('Volt code index: fuzzy file search', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('an exact file name ranks first, ahead of looser matches', () => {
		const found = fuzzyFindPaths(PATHS, 'rootIndex.ts', 5);
		assert.strictEqual(found.paths[0], 'src/vs/platform/voltCodeIndex/node/rootIndex.ts');
		assert.strictEqual(found.typos, false);
	});

	test('a missing letter still matches as a subsequence', () => {
		assert.strictEqual(fuzzyFindPaths(PATHS, 'rootIndx', 5).paths[0], 'src/vs/platform/voltCodeIndex/node/rootIndex.ts');
		assert.strictEqual(fuzzyFindPaths(PATHS, 'usrsrvc', 5).paths[0], 'src/components/UserService.tsx');
	});

	test('one wrong letter is forgiven only when nothing matches as written', () => {
		const found = fuzzyFindPaths(PATHS, 'rootIndez', 5);
		assert.strictEqual(found.paths[0], 'src/vs/platform/voltCodeIndex/node/rootIndex.ts');
		assert.strictEqual(found.typos, true);
		assert.deepStrictEqual(fuzzyFindPaths(PATHS, 'abc', 5).paths, [], 'short words are not typo-corrected into everything');
	});

	test('each word narrows the results', () => {
		const found = fuzzyFindPaths(PATHS, 'sched fair', 5);
		assert.strictEqual(found.paths[0], 'kernel/sched/fair.c');
		assert.ok(!found.paths.includes('kernel/sched/core.c'));
	});

	test('shallow paths win ties, and paths with spaces match', () => {
		const found = fuzzyFindPaths(PATHS, 'index.ts', 5);
		assert.strictEqual(found.paths[0], 'src/index.ts');
		assert.strictEqual(fuzzyFindPaths(PATHS, 'release plan', 5).paths[0], 'docs/My Notes/release plan.md');
	});

	test('a folder path in the query matches the path, not only the name', () => {
		assert.strictEqual(fuzzyFindPaths(PATHS, 'kernel/sched/', 5).total, 2);
	});

	test('empty and unmatched queries return nothing and say how many matched', () => {
		assert.deepStrictEqual(fuzzyFindPaths(PATHS, '   ', 5), { paths: [], total: 0, typos: false });
		assert.deepStrictEqual(fuzzyFindPaths(PATHS, 'zzqqxx', 5).paths, []);
		const limited = fuzzyFindPaths(PATHS, 'src', 2);
		assert.strictEqual(limited.paths.length, 2);
		assert.ok(limited.total > 2);
	});

	test('terms are lower-cased and backslashes become slashes', () => {
		assert.deepStrictEqual(fuzzyTerms(' Kernel\\Sched  FAIR '), ['kernel/sched', 'fair']);
		assert.ok(scorePath('kernel/sched/fair.c', fuzzyTerms('Kernel\\Sched')) > 0);
	});
});
