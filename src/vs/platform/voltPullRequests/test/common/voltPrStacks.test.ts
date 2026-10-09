/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	buildRestackConflictPrompt,
	IVoltStackBranchState,
	parseStackConfig,
	planRestack,
	retargetAfterMerge,
	stackBranchName,
	stackOrder,
} from '../../common/voltPrStacks.js';

function branches(...states: Array<Partial<IVoltStackBranchState> & { name: string }>): Map<string, IVoltStackBranchState> {
	return new Map(states.map(state => [state.name, { oid: state.name.padEnd(40, '0'), ...state }]));
}

suite('Volt pull requests: stacked branch rules', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a stack reads bottom first from the trunk up, and stops at a fork', () => {
		const map = branches(
			{ name: 'main' },
			{ name: 'a', parent: 'main' },
			{ name: 'b', parent: 'a' },
			{ name: 'c', parent: 'b' },
			{ name: 'b2', parent: 'a' },
		);
		assert.deepStrictEqual(stackOrder(map, 'c', 'main'), ['a', 'b', 'c']);
		assert.deepStrictEqual(stackOrder(map, 'a', 'main'), ['a'], 'a fork ends the walk up');
		assert.deepStrictEqual(stackOrder(map, 'main', 'main'), []);
	});

	test('a loop in the records or a missing parent ends the walk without hanging', () => {
		const loop = branches({ name: 'x', parent: 'y' }, { name: 'y', parent: 'x' });
		assert.deepStrictEqual(stackOrder(loop, 'x', 'main'), ['y', 'x']);
		const gone = branches({ name: 'z', parent: 'deleted' });
		assert.deepStrictEqual(stackOrder(gone, 'z', 'main'), ['z']);
		const loose = branches({ name: 'solo' });
		assert.deepStrictEqual(stackOrder(loose, 'solo', 'main'), []);
	});

	test('a restack moves the layers above a moved parent, using the recorded parent commit', () => {
		const steps = planRestack([
			{ branch: 'a', parent: 'main', oid: 'a1', upToDate: true, forkPoint: 'm1' },
			{ branch: 'b', parent: 'a', oid: 'b1', upToDate: false, parentOid: 'a0', forkPoint: 'a0' },
			{ branch: 'c', parent: 'b', oid: 'c1', upToDate: true, forkPoint: 'b1' },
		], { trunkRef: 'origin/main', trunk: 'main' });
		assert.deepStrictEqual(steps, [
			{ branch: 'b', onto: 'a', upstream: 'a0' },
			{ branch: 'c', onto: 'b', upstream: 'b1' },
		]);
	});

	test('the bottom layer follows the trunk only when asked to sync', () => {
		const layers = [{ branch: 'a', parent: 'main', oid: 'a1', upToDate: false, parentOid: 'm0' }];
		assert.deepStrictEqual(planRestack(layers, { trunkRef: 'origin/main', trunk: 'main' }), []);
		assert.deepStrictEqual(planRestack(layers, { trunkRef: 'origin/main', trunk: 'main', syncTrunk: true }), [{ branch: 'a', onto: 'origin/main', upstream: 'm0' }]);
	});

	test('only the chosen layers move, and a layer with no known start is left alone', () => {
		const layers = [
			{ branch: 'a', parent: 'main', oid: 'a1', upToDate: true, forkPoint: 'm1' },
			{ branch: 'b', parent: 'a', oid: 'b1', upToDate: false },
		];
		assert.deepStrictEqual(planRestack(layers, { trunkRef: 'origin/main', trunk: 'main', only: ['a'] }), [], 'b has no recorded start, so the climb stops');
	});

	test('after a parent merges, its children retarget to the parent\'s parent', () => {
		const map = branches(
			{ name: 'main' },
			{ name: 'a', parent: 'main' },
			{ name: 'b', parent: 'a' },
			{ name: 'c', parent: 'a' },
		);
		assert.deepStrictEqual(retargetAfterMerge(map, 'a', 'main').map(m => [m.branch, m.to]), [['b', 'main'], ['c', 'main']]);
		const deeper = branches({ name: 'a', parent: 'main' }, { name: 'b', parent: 'a' }, { name: 'c', parent: 'b' });
		assert.deepStrictEqual(retargetAfterMerge(deeper, 'b', 'main').map(m => [m.branch, m.to]), [['c', 'a']]);
	});

	test('a new layer gets a branch name from its title, unused and under volt/', () => {
		assert.strictEqual(stackBranchName('Add the Gitea client!'), 'volt/add-the-gitea-client');
		assert.strictEqual(stackBranchName('Add the client', new Set(['volt/add-the-client'])), 'volt/add-the-client-2');
		assert.strictEqual(stackBranchName('!!!'), 'volt/layer');
	});

	test('the config records parse into parent and parent commit per branch', () => {
		const parsed = parseStackConfig([
			'branch.feat/a.volt-parent main',
			'branch.feat/a.volt-parent-oid 0123456789abcdef0123456789abcdef01234567',
			'branch.feat/b.volt-parent feat/a',
			'branch.feat/b.remote origin',
		].join('\n'));
		assert.deepStrictEqual(parsed.get('feat/a'), { parent: 'main', parentOid: '0123456789abcdef0123456789abcdef01234567' });
		assert.deepStrictEqual(parsed.get('feat/b'), { parent: 'feat/a' });
	});

	test('a conflict prompt says where the rebase waits and what to do next', () => {
		const prompt = buildRestackConflictPrompt({ branch: 'feat/b', reason: 'conflict', message: 'CONFLICT', files: ['b.txt'], worktree: '/work', command: 'git rebase --onto a a0' }, ['feat/a', 'feat/b']);
		assert.ok(prompt.includes('feat/a → feat/b'));
		assert.ok(prompt.includes('/work with conflicts in b.txt'));
		assert.ok(prompt.includes('restack_stack'));
		assert.ok(prompt.includes('Do not abort it.'));
	});
});
