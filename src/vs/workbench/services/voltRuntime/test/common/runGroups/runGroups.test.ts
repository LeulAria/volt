/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import type { IOrchThreadStatus } from '../../../common/orchestration/orchestratorViews.js';
import {
	accumulateRunUsage,
	EMPTY_RUN_USAGE,
	estimateRunGroup,
	IRunGroup,
	IRunGroupRun,
	isValidRunBranch,
	modelSlug,
	parseRememberedModels,
	runBranchNames,
	runGroupRollup,
	runGroupTitle,
	RunStatus,
	runStatus,
	runStopPlan,
	runWinnerPlan,
	runWorkMs,
	taskSlug,
	toggleRunModel,
	trackRunClock,
	validateRunSelection,
} from '../../../common/runGroups/runGroups.js';

const CLAUDE = { ref: 'agent:claude:sonnet', label: 'Claude Sonnet 4.5', family: 'claude' };
const CODEX = { ref: 'agent:codex:gpt-5', label: 'GPT-5 Codex', family: 'codex' };
const CURSOR = { ref: 'agent:cursor:grok', label: 'Grok 4.7 Fast', family: 'cursor' };
const DEEPSEEK = { ref: 'model:deepseek:v3', label: 'DeepSeek V3.2', family: 'deepseek' };
const OPENCODE = { ref: 'agent:opencode:x', label: 'OpenCode Big Pickle', family: 'opencode' };

function status(kind: IOrchThreadStatus['kind'], extra: Partial<IOrchThreadStatus> = {}): IOrchThreadStatus {
	return { kind, running: 0, waiting: 0, queued: 0, undelivered: 0, busy: kind === 'working', ...extra };
}

function run(id: string, extra: Partial<IRunGroupRun> = {}): IRunGroupRun {
	return {
		id,
		model: CLAUDE,
		branch: `volt/task-${id}`,
		worktreePath: `/wt/${id}`,
		setup: { state: 'done', steps: [] },
		usage: EMPTY_RUN_USAGE,
		workMs: 0,
		...extra,
	};
}

function group(runs: IRunGroupRun[], extra: Partial<IRunGroup> = {}): IRunGroup {
	return {
		id: 'g1',
		title: 'Add dark mode',
		prompt: { text: 'Add dark mode' },
		createdAt: 1,
		repoRoot: '/repo',
		base: { ref: 'main', commit: 'abc' },
		runs,
		followUp: 'selected',
		...extra,
	};
}

suite('Run groups: names', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('task slug keeps the words that say something', () => {
		assert.strictEqual(taskSlug('Please add a dark mode toggle to the settings page'), 'add-dark-mode-toggle-settings');
		assert.strictEqual(taskSlug('\n\n  Fix the login bug\nmore details here'), 'fix-login-bug');
		assert.strictEqual(taskSlug('Café résumé naïve'), 'cafe-resume-naive');
		assert.strictEqual(taskSlug('???'), 'task');
	});

	test('task slug is bounded at a word boundary', () => {
		const slug = taskSlug('implement incremental rebuilding of the dependency graph across workspaces quickly');
		assert.ok(slug.length <= 32, slug);
		assert.ok(!slug.endsWith('-'), slug);
	});

	test('model slug', () => {
		assert.strictEqual(modelSlug('Claude Sonnet 4.5 (thinking)'), 'claude-sonnet-4-5');
		assert.strictEqual(modelSlug('GPT-5 Codex'), 'gpt-5-codex');
		assert.strictEqual(modelSlug('!!!'), 'model');
	});

	test('one branch per model, volt/<task>-<model>', () => {
		const names = runBranchNames('Add dark mode', [CLAUDE, CODEX, CURSOR]);
		assert.deepStrictEqual(names, ['volt/add-dark-mode-claude-sonnet-4-5', 'volt/add-dark-mode-gpt-5-codex', 'volt/add-dark-mode-grok-4-7-fast']);
		assert.ok(names.every(isValidRunBranch));
	});

	test('names that exist get a number; the same model twice gets two names', () => {
		const names = runBranchNames('Add dark mode', [CLAUDE, CLAUDE, CODEX], new Set(['volt/add-dark-mode-claude-sonnet-4-5', 'volt/add-dark-mode-gpt-5-codex']));
		assert.deepStrictEqual(names, ['volt/add-dark-mode-claude-sonnet-4-5-2', 'volt/add-dark-mode-claude-sonnet-4-5-3', 'volt/add-dark-mode-gpt-5-codex-2']);
	});

	test('branch validity', () => {
		assert.ok(isValidRunBranch('volt/a-b-1'));
		assert.ok(!isValidRunBranch('volt/a..b'));
		assert.ok(!isValidRunBranch('feature/x'));
		assert.ok(!isValidRunBranch('volt/-x'));
		assert.ok(!isValidRunBranch('volt/x.lock'));
	});

	test('title', () => {
		assert.strictEqual(runGroupTitle('  Add   dark mode \nmore'), 'Add dark mode');
		assert.strictEqual(runGroupTitle(''), 'Compare models');
		assert.strictEqual(runGroupTitle('x'.repeat(100), 10), `${'x'.repeat(9)}…`);
	});
});

suite('Run groups: selection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('2 to 4 distinct models', () => {
		assert.strictEqual(validateRunSelection([CLAUDE]).ok, false);
		assert.strictEqual(validateRunSelection([CLAUDE, CODEX]).ok, true);
		assert.strictEqual(validateRunSelection([CLAUDE, CODEX, CURSOR, DEEPSEEK]).ok, true);
		assert.strictEqual(validateRunSelection([CLAUDE, CODEX, CURSOR, DEEPSEEK, OPENCODE]).ok, false);
		assert.strictEqual(validateRunSelection([CLAUDE, CLAUDE]).ok, false);
	});

	test('toggle adds, removes and stops at the maximum', () => {
		let models = toggleRunModel([], CLAUDE);
		models = toggleRunModel(models, CODEX);
		assert.deepStrictEqual(models.map(m => m.ref), [CLAUDE.ref, CODEX.ref]);
		models = toggleRunModel(models, CLAUDE);
		assert.deepStrictEqual(models.map(m => m.ref), [CODEX.ref]);
		const full = [CLAUDE, CODEX, CURSOR, DEEPSEEK];
		assert.strictEqual(toggleRunModel(full, OPENCODE), full);
	});

	test('remembered set drops models that are gone', () => {
		const available = new Set([CLAUDE.ref, CODEX.ref]);
		assert.deepStrictEqual(parseRememberedModels(JSON.stringify([CLAUDE.ref, 'gone', CODEX.ref, CLAUDE.ref]), available), [CLAUDE.ref, CODEX.ref]);
		assert.deepStrictEqual(parseRememberedModels('not json', available), []);
		assert.deepStrictEqual(parseRememberedModels(undefined, available), []);
	});
});

suite('Run groups: status', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('setup comes first', () => {
		assert.strictEqual(runStatus({ setup: { state: 'worktree', steps: [] } }, undefined), 'setup');
		assert.strictEqual(runStatus({ setup: { state: 'running', steps: [] } }, { status: status('blocked'), turns: 0 }), 'setup');
		assert.strictEqual(runStatus({ setup: { state: 'failed', steps: [] } }, { status: status('blocked'), turns: 0 }), 'setupFailed');
		assert.strictEqual(runStatus({ setup: { state: 'cancelled', steps: [] } }, undefined), 'setupFailed');
	});

	test('then the chat', () => {
		const done = { setup: { state: 'done' as const, steps: [] } };
		assert.strictEqual(runStatus(done, { status: status('working'), turns: 1 }), 'working');
		assert.strictEqual(runStatus(done, { status: status('needsInput'), turns: 1 }), 'needsInput');
		assert.strictEqual(runStatus(done, { status: status('idle'), turns: 0 }), 'waiting');
		assert.strictEqual(runStatus(done, { status: status('idle'), turns: 1, lastOutcome: 'done' }), 'done');
		assert.strictEqual(runStatus(done, { status: status('idle'), turns: 1, lastOutcome: 'cancelled' }), 'stopped');
		assert.strictEqual(runStatus(done, { status: status('paused', { pause: 'stopped' }), turns: 1 }), 'stopped');
		assert.strictEqual(runStatus(done, { status: status('failed'), turns: 1 }), 'failed');
	});

	test('roll-up: waiting on the user wins, then anything live', () => {
		assert.strictEqual(runGroupRollup(['done', 'needsInput', 'working']).status, 'needsInput');
		assert.strictEqual(runGroupRollup(['done', 'setup', 'failed']).status, 'running');
		assert.strictEqual(runGroupRollup(['failed', 'setupFailed']).status, 'failed');
		assert.strictEqual(runGroupRollup(['done', 'failed']).status, 'done');
		assert.strictEqual(runGroupRollup(['stopped', 'stopped']).status, 'stopped');
		const rollup = runGroupRollup(['done', 'working', 'setupFailed']);
		assert.deepStrictEqual({ live: rollup.live, done: rollup.done, failed: rollup.failed, total: rollup.total }, { live: 1, done: 1, failed: 1, total: 3 });
	});
});

suite('Run groups: stop and winner plans', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('stopping the group stops every run at whatever stage it is', () => {
		const statuses: Record<string, RunStatus> = { a: 'working', b: 'setup', c: 'needsInput', d: 'done', e: 'waiting', f: 'working' };
		const g = group([run('a'), run('b'), run('c'), run('d'), run('e'), run('f', { discarded: true })]);
		const plan = runStopPlan(g, id => statuses[id]);
		assert.deepStrictEqual(plan, { cancel: ['a', 'c'], abortSetup: ['b'], pause: ['e'] });
	});

	test('merge: commit the winner, merge into the base, archive the others, remove their worktrees', () => {
		const g = group([run('a', { model: CLAUDE }), run('b', { model: CODEX }), run('c', { model: CURSOR, worktreePath: undefined, setup: { state: 'failed', steps: [] } })]);
		const plan = runWinnerPlan(g, 'b', 'merge', () => 'done', { removeOthers: true });
		assert.strictEqual(plan.error, undefined);
		assert.deepStrictEqual(plan.steps, [
			{ kind: 'commit', runId: 'b', worktreePath: '/wt/b', message: 'Add dark mode (GPT-5 Codex)' },
			{ kind: 'merge', branch: 'volt/task-b', into: 'main', message: 'Merge volt/task-b: Add dark mode' },
			{ kind: 'archive', runIds: ['a', 'c'] },
			{ kind: 'removeWorktrees', runIds: ['a'] },
		]);
	});

	test('checkout and PR; worktrees stay unless asked', () => {
		const g = group([run('a'), run('b')]);
		assert.deepStrictEqual(runWinnerPlan(g, 'a', 'checkout', () => 'done', { removeOthers: false }).steps.map(step => step.kind), ['commit', 'checkout', 'archive']);
		const pr = runWinnerPlan(g, 'a', 'pr', () => 'done', { removeOthers: false });
		assert.deepStrictEqual(pr.steps[1], { kind: 'pr', runId: 'a', branch: 'volt/task-a', base: 'main' });
	});

	test('refuses a live winner, a second winner, a run with no worktree, a merge from a detached base', () => {
		const g = group([run('a'), run('b', { setup: { state: 'failed', steps: [] }, worktreePath: undefined })]);
		assert.ok(runWinnerPlan(g, 'a', 'merge', () => 'working', { removeOthers: false }).error);
		assert.ok(runWinnerPlan(g, 'a', 'merge', () => 'needsInput', { removeOthers: false }).error);
		assert.ok(runWinnerPlan(g, 'b', 'merge', () => 'done', { removeOthers: false }).error);
		assert.ok(runWinnerPlan(g, 'x', 'merge', () => 'done', { removeOthers: false }).error);
		assert.ok(runWinnerPlan({ ...g, winner: { runId: 'a', action: 'pr', at: 1 } }, 'a', 'merge', () => 'done', { removeOthers: false }).error);
		assert.ok(runWinnerPlan({ ...g, base: { commit: 'abc' } }, 'a', 'merge', () => 'done', { removeOthers: false }).error);
		assert.strictEqual(runWinnerPlan({ ...g, base: { commit: 'abc' } }, 'a', 'pr', () => 'done', { removeOthers: false }).error, undefined);
	});
});

suite('Run groups: usage, time and cost', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('turn counts add up; occupancy reports do not', () => {
		let usage = accumulateRunUsage(EMPTY_RUN_USAGE, { input: 18, output: 1044, cache: 35435, cacheWrite: 10884 });
		usage = accumulateRunUsage(usage, { input: 0, output: 0, used: 24706 });
		usage = accumulateRunUsage(usage, { input: 100, output: 50 });
		assert.deepStrictEqual(usage, { tokens: 47381 + 150, input: 118, output: 1094, cache: 46319 });
	});

	test('a cumulative session cost adds its growth; a restart starts over', () => {
		let usage = accumulateRunUsage(EMPTY_RUN_USAGE, { input: 0, output: 0, used: 1, costUsd: 0.03 });
		usage = accumulateRunUsage(usage, { input: 0, output: 0, used: 1, costUsd: 0.05 });
		usage = accumulateRunUsage(usage, { input: 0, output: 0, used: 1, costUsd: 0.05 });
		assert.strictEqual(usage.costUsd, 0.05);
		usage = accumulateRunUsage(usage, { input: 0, output: 0, used: 1, costUsd: 0.01 });
		assert.strictEqual(usage.costUsd, 0.06);
		assert.strictEqual(usage.sessionCost, 0.01);
	});

	test('the clock banks work time between turns', () => {
		let clock = { workMs: 0 } as Pick<IRunGroupRun, 'workMs' | 'activeSince' | 'firstStartedAt' | 'lastEndedAt'>;
		clock = trackRunClock(clock, true, 1000);
		assert.strictEqual(runWorkMs(clock, 4000), 3000);
		clock = trackRunClock(clock, true, 2000);
		clock = trackRunClock(clock, false, 5000);
		assert.deepStrictEqual(clock, { workMs: 4000, firstStartedAt: 1000, lastEndedAt: 5000 });
		clock = trackRunClock(clock, true, 10_000);
		clock = trackRunClock(clock, false, 11_000);
		assert.strictEqual(runWorkMs(clock, 99_000), 5000);
	});

	test('warns on cost and on limits, per provider', () => {
		const estimate = estimateRunGroup([CLAUDE, { ...CLAUDE, ref: 'agent:claude:opus', label: 'Opus' }, CODEX, DEEPSEEK], {
			costPerSession: new Map([['claude', 1.2], ['codex', 0.4]]),
			limits: [
				{ family: 'claude', label: 'Claude session limit', usedPercent: 85 },
				{ family: 'codex', label: 'Codex weekly limit', usedPercent: 100, resetsAt: 5 },
				{ family: 'cursor', label: 'Cursor', usedPercent: 99 },
			],
		});
		assert.strictEqual(estimate.estimateUsd?.toFixed(2), '2.80');
		assert.deepStrictEqual(estimate.unknown, ['DeepSeek V3.2']);
		assert.deepStrictEqual(estimate.warnings.map(w => [w.kind, w.family]), [['cost', undefined], ['limit', 'claude'], ['limitReached', 'codex']]);
		assert.match(estimate.warnings[1].message, /2 runs/);
	});

	test('no warning for cheap runs with room left', () => {
		const estimate = estimateRunGroup([CLAUDE, CODEX], { costPerSession: new Map([['claude', 0.2]]), limits: [{ family: 'claude', label: 'x', usedPercent: 10 }] });
		assert.deepStrictEqual(estimate.warnings, []);
	});
});
