/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { MemoryEngine } from '../../../common/harness/memory.js';

suite('Volt memory engine', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('recalls a project fact by query and prefers it over working memory in the prompt', () => {
		const memory = new MemoryEngine();
		memory.remember('working', 'scratch', 'temp note about login', 'step');
		memory.remember('project', 'package manager', 'this repo uses pnpm', 'agents.md');
		const hits = memory.recall('what package manager does the repo use');
		assert.ok(hits.some(hit => hit.fact.scope === 'project'));
		const block = memory.promptBlock('package manager');
		assert.ok(block && /pnpm/.test(block));
		assert.ok(block && !/temp note/.test(block));
	});

	test('expired facts disappear', () => {
		const memory = new MemoryEngine();
		memory.remember('session', 'branch', 'feat/login', 'git', 1_000, 10);
		assert.strictEqual(memory.recall('branch', 1_005).length, 1);
		assert.strictEqual(memory.recall('branch', 1_020).length, 0);
	});

	test('clearWorking drops only that scope', () => {
		const memory = new MemoryEngine();
		memory.remember('working', 'a', 'one', 't');
		memory.remember('session', 'b', 'two', 't');
		memory.clearWorking();
		assert.strictEqual(memory.all('working').length, 0);
		assert.strictEqual(memory.all('session').length, 1);
	});
});
