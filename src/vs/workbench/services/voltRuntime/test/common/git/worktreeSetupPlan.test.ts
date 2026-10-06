/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { buildWorktreeSetupPlan, currentSetupStep, IProjectFile, IWorktreesJson, parseProjectFile, parseWorktreesJson, setupOutputTail, worktreeSetupUnits } from '../../../common/git/worktreeSetupPlan.js';

suite('Volt worktree setup plan', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('t3.json: submodule mode and the scripts that run on worktree creation, async by default', () => {
		const parsed = parseProjectFile(JSON.stringify({
			$schema: 'https://t3.codes/schema.json',
			iconPath: 'icon.png',
			worktreeSubmodules: 'top-level',
			scripts: [
				{ name: 'Install', command: 'bun install', runOnWorktreeCreate: true, async: false },
				{ name: 'Dev server', command: 'bun dev', previewUrl: 'http://localhost:3000' },
				{ name: 'Link env', command: 'cp $T3CODE_PROJECT_ROOT/.env .env', runOnWorktreeCreate: true },
			],
		}), 't3.json');
		assert.strictEqual(parsed.kind, 'ok');
		const file = (parsed as { value: IProjectFile }).value;
		assert.strictEqual(file.worktreeSubmodules, 'top-level');
		assert.deepStrictEqual(file.scripts.map(script => [script.name, script.runOnWorktreeCreate, script.async]), [['Install', true, false], ['Dev server', false, true], ['Link env', true, true]]);

		const steps = buildWorktreeSetupPlan({ projectFile: file, hasGitmodules: true });
		assert.deepStrictEqual(steps.map(step => [step.label, step.command, !!step.async]), [
			['Initialize top-level submodules', 'git submodule update --init', false],
			['Install', 'bun install', false],
			['Link env', 'cp $T3CODE_PROJECT_ROOT/.env .env', true],
		]);

		assert.match((parseProjectFile('{"worktreeSubmodules":"all"}', 't3.json') as { error: string }).error, /recursive/);
		assert.match((parseProjectFile('{"scripts":[{"name":"x"}]}', 't3.json') as { error: string }).error, /needs a "command"/);
		assert.strictEqual(parseProjectFile('nope', 't3.json').kind, 'error');
	});

	test('submodules initialize recursively by default, and not at all with "none" or without .gitmodules', () => {
		assert.deepStrictEqual(buildWorktreeSetupPlan({ hasGitmodules: true }).map(step => step.command), ['git submodule update --init --recursive']);
		assert.deepStrictEqual(buildWorktreeSetupPlan({ hasGitmodules: false }), []);
		assert.deepStrictEqual(buildWorktreeSetupPlan({ hasGitmodules: true, projectFile: { source: 't3.json', worktreeSubmodules: 'none', scripts: [] } }), []);
	});

	test('Cursor worktrees.json commands share one shell; each step announces itself so progress can be read', () => {
		const parsed = parseWorktreesJson(JSON.stringify({ 'setup-worktree': ['npm ci', 'cp $ROOT_WORKTREE_PATH/.env .env'], 'setup-worktree-windows': ['npm ci'] }), '.cursor/worktrees.json', 'unix');
		assert.strictEqual(parsed.kind, 'ok');
		const steps = buildWorktreeSetupPlan({ worktreesJson: (parsed as { value: IWorktreesJson }).value, hasGitmodules: true });
		assert.strictEqual(steps.length, 3);
		const units = worktreeSetupUnits(steps, '/wt/a', 'unix');
		assert.deepStrictEqual(units.map(unit => unit.steps), [[0], [1, 2]], 'the list is one unit');
		assert.ok(units[1].script.startsWith('set -e\n'));
		assert.ok(units[1].script.includes(`echo '::volt-setup-step 1'\nnpm ci`));

		// A retry skips what finished: the list resumes at the command that failed.
		assert.deepStrictEqual(worktreeSetupUnits(steps, '/wt/a', 'unix', new Set([0, 1])).map(unit => unit.steps), [[2]]);
		assert.strictEqual(currentSetupStep('::volt-setup-step 1\nadded 10 packages\n::volt-setup-step 2\n'), 2);
		assert.strictEqual(setupOutputTail('::volt-setup-step 1\n\x1b[32mok\x1b[0m\n\n'), 'ok');
		assert.strictEqual(parseWorktreesJson('{}', '.volt/worktrees.json', 'unix').kind, 'none');
		assert.strictEqual(parseWorktreesJson('{"setup-worktree": [1]}', '.volt/worktrees.json', 'unix').kind, 'error');
	});
});
