/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { currentSetupStep, parseWorktreeSetup, setupOutputTail, worktreeSetupCommand, worktreeSetupEnv, WORKTREE_SETUP_MARKER } from '../../../common/runGroups/worktreeSetup.js';

suite('Worktree setup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Cursor\'s generic list', () => {
		const parsed = parseWorktreeSetup('{"setup-worktree": ["npm ci", "  cp $ROOT_WORKTREE_PATH/.env .env  "]}', '.cursor/worktrees.json', '/repo/.cursor', 'unix');
		assert.deepStrictEqual(parsed, { kind: 'config', config: { source: '.cursor/worktrees.json', steps: ['npm ci', 'cp $ROOT_WORKTREE_PATH/.env .env'] } });
	});

	test('the platform key wins over the generic one', () => {
		const text = JSON.stringify({ 'setup-worktree': ['generic'], 'setup-worktree-unix': ['unix'], 'setup-worktree-windows': ['win'] });
		assert.deepStrictEqual(parseWorktreeSetup(text, 's', '/r', 'unix'), { kind: 'config', config: { source: 's', steps: ['unix'] } });
		assert.deepStrictEqual(parseWorktreeSetup(text, 's', '/r', 'windows'), { kind: 'config', config: { source: 's', steps: ['win'] } });
	});

	test('a script path is relative to the file', () => {
		const parsed = parseWorktreeSetup('{"setup-worktree-unix": "setup.sh"}', '.cursor/worktrees.json', '/repo/.cursor', 'unix');
		assert.deepStrictEqual(parsed, { kind: 'config', config: { source: '.cursor/worktrees.json', steps: ['setup.sh'], script: '/repo/.cursor/setup.sh' } });
		assert.ok(parsed.kind === 'config');
		const command = worktreeSetupCommand(parsed.config, '/wt/x', 'unix');
		assert.strictEqual(command, `echo '${WORKTREE_SETUP_MARKER} 0' && bash /repo/.cursor/setup.sh /wt/x`);
	});

	test('nothing to do, and bad files', () => {
		assert.deepStrictEqual(parseWorktreeSetup('{}', 's', '/r', 'unix'), { kind: 'none' });
		assert.deepStrictEqual(parseWorktreeSetup('{"setup-worktree": []}', 's', '/r', 'unix'), { kind: 'none' });
		assert.strictEqual(parseWorktreeSetup('{nope', 's', '/r', 'unix').kind, 'error');
		assert.strictEqual(parseWorktreeSetup('[1]', 's', '/r', 'unix').kind, 'error');
		assert.strictEqual(parseWorktreeSetup('{"setup-worktree": 3}', 's', '/r', 'unix').kind, 'error');
		assert.strictEqual(parseWorktreeSetup('{"setup-worktree": ["ok", 3]}', 's', '/r', 'unix').kind, 'error');
	});

	test('one shell, a marker per step, resumable at a step', () => {
		const config = { source: 's', steps: ['npm ci', 'npm run build'] };
		assert.strictEqual(worktreeSetupCommand(config, '/wt', 'unix'), `set -e\necho '${WORKTREE_SETUP_MARKER} 0'\nnpm ci\necho '${WORKTREE_SETUP_MARKER} 1'\nnpm run build`);
		assert.strictEqual(worktreeSetupCommand(config, '/wt', 'unix', 1), `set -e\necho '${WORKTREE_SETUP_MARKER} 1'\nnpm run build`);
	});

	test('reads progress and a clean tail from the output', () => {
		const output = `${WORKTREE_SETUP_MARKER} 0\nadded 10 packages\n\x1b[32mok\x1b[0m\n${WORKTREE_SETUP_MARKER} 1\nbuilding\n\n`;
		assert.strictEqual(currentSetupStep(output), 1);
		assert.strictEqual(currentSetupStep('no markers'), -1);
		assert.strictEqual(setupOutputTail(output), 'added 10 packages\nok\nbuilding');
		assert.strictEqual(setupOutputTail(output, 1), 'building');
	});

	test('environment names the checkout like Cursor does', () => {
		const env = worktreeSetupEnv({ repoRoot: '/repo', worktreePath: '/wt', branch: 'volt/x', model: 'Claude' });
		assert.strictEqual(env.ROOT_WORKTREE_PATH, '/repo');
		assert.strictEqual(env.VOLT_WORKTREE_PATH, '/wt');
		assert.strictEqual(env.VOLT_RUN_BRANCH, 'volt/x');
	});
});
