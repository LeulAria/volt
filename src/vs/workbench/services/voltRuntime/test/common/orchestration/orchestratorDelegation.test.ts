/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { buildTaskPrompt, contractFromArgs, describeSpend, describeTask, lintTaskBrief, withUpstreamReports } from '../../../common/orchestration/agentTasks.js';
import { DEFAULT_ORCH_LIMITS, IOrchLimits, IOrchTask, IOrchTaskUsage, readOrchLimits } from '../../../common/orchestration/orchestrator.js';
import { extractRoot, parseRootSnapshot } from '../../../common/orchestration/orchestratorCodec.js';
import { buildParentCapsule, userRequests } from '../../../common/orchestration/taskContext.js';
import { foldSpend, seedSpendTracker, spendUsage } from '../../../common/orchestration/taskSpend.js';
import { OrchSim } from './orchestratorSim.js';

function usage(costUsd: number, tokens = 1_000): IOrchTaskUsage {
	return { tokens, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, costUsd, priced: 'reported' };
}

suite('Volt orchestrator: handoff contract and context', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the contract reaches the child prompt, with owned files, the digest, the budget and fixed report headings', () => {
		const contract = contractFromArgs({ goal: 'Dark mode toggle works', constraints: ['Keep the public API'], done_when: ['npm test passes'], files: ['src/theme.ts'] });
		assert.deepStrictEqual(contract, { goal: 'Dark mode toggle works', constraints: ['Keep the public API'], doneWhen: ['npm test passes'], files: ['src/theme.ts'] });
		assert.strictEqual(contractFromArgs({ task: 'x' }), undefined, 'no contract fields, no contract');

		const text = buildTaskPrompt('Add the toggle to the header.', {
			role: 'implementation', depth: 1, isolation: 'shared', contract, scope: ['src/header/'],
			capsule: '<parent_context>\nthe user wants dark mode\n</parent_context>', budget: { requestLeftUsd: 12.5, taskUsd: 2 }, after: ['t-aaaaaa'],
		});
		assert.ok(text.includes('<goal>\nDark mode toggle works\n</goal>'));
		assert.ok(text.includes('<owned_files>\n- src/header/\n</owned_files>'));
		assert.ok(text.includes('<read_first>\n- src/theme.ts\n</read_first>'));
		assert.ok(text.includes('<done_when>\n- npm test passes\n</done_when>'));
		assert.ok(text.includes('may change only them: src/header/'));
		assert.ok(text.includes('this task may spend up to $2.00; the subagents of this request have $12.50 left'));
		assert.ok(text.includes('This task waited for t-aaaaaa'));
		assert.ok(text.indexOf('<parent_context>') < text.indexOf('<task>'), 'the digest comes before the brief');
		assert.ok(text.trimEnd().endsWith('"## Open issues" (what is left, risks, anything you were unsure of; "None" if nothing).'), 'the report format is the last thing it reads');
		assert.ok(text.includes('"## Changes"') && text.includes('each done_when check: met or not met'));

		const review = buildTaskPrompt('Review it.', { role: 'review', depth: 1, isolation: 'shared', scope: ['src/header/'] });
		assert.ok(review.includes('"## Findings"'));
		assert.ok(!review.includes('<owned_files>'), 'a read-only task owns nothing');
	});

	test('brief notes point at the gaps that send a child exploring, and never block', () => {
		assert.deepStrictEqual(lintTaskBrief('Fix the bug in src/app.ts where save fails on empty titles.', 'implementation', { doneWhen: ['the save test passes'] }, undefined, 'brief'), []);
		const notes = lintTaskBrief('Make the settings page faster.', 'implementation', undefined, undefined, 'brief');
		assert.strictEqual(notes.length, 2);
		assert.ok(notes[0].startsWith('no done_when'));
		assert.ok(notes[1].startsWith('no files named'));
		assert.ok(lintTaskBrief('Check it.', 'research', undefined, undefined, 'none')[0].includes('context is none'));
	});

	test('the parent capsule carries the user\'s request, the plan, the latest reply and the siblings, within its budget', () => {
		const capsule = buildParentCapsule({
			parentTitle: 'Dark "mode"',
			requests: ['first ask', 'second ask', 'Add dark mode to every page'],
			lastReply: 'I will split this into header and settings work.',
			plan: [{ content: 'Header toggle', status: 'in_progress' }, { content: 'Settings page', status: 'pending' }, { content: 'Read theme.ts', status: 'completed' }],
			siblings: [{ id: 't-111111', title: 'Settings page', role: 'implementation', state: 'running', modelLabel: 'GPT-6-Astra', scope: ['src/settings/'] }, { id: 't-222222', title: 'Find colors', role: 'research', state: 'completed', result: 'Colors live in theme.ts' }],
		}, 'brief')!;
		assert.ok(capsule.startsWith('<parent_context chat="Dark \'mode\'">'));
		assert.ok(capsule.includes('<user_request>\nAdd dark mode to every page\n</user_request>'));
		assert.ok(capsule.includes('- first ask') && capsule.includes('- second ask'));
		assert.ok(capsule.includes('- [~] Header toggle') && capsule.includes('- [x] Read theme.ts'));
		assert.ok(capsule.includes('t-111111 "Settings page" (implementation, GPT-6-Astra): running; owns src/settings/'));
		assert.ok(capsule.includes('found: Colors live in theme.ts'));
		assert.ok(capsule.endsWith('</parent_context>'));
		assert.strictEqual(buildParentCapsule({ requests: ['x'], siblings: [] }, 'none'), undefined);

		const huge = buildParentCapsule({ requests: ['x'.repeat(50_000)], siblings: [] }, 'brief')!;
		assert.ok(huge.length <= 4_500 && huge.endsWith('</parent_context>'), 'a huge paste is clipped and the block still closes');
	});

	test('the user\'s requests leave out Volt\'s own turns and blocks', () => {
		assert.deepStrictEqual(userRequests([
			{ role: 'user', content: '<volt_workspace source="x">tabs</volt_workspace>\nRefactor the router' },
			{ role: 'assistant', content: 'On it' },
			{ role: 'user', content: '[Volt] Delegated task "Find colors" completed.\n<task_results>...</task_results>' },
			{ role: 'user', content: '[Volt] When a visual helps, render it.\nAnd add tests' },
			{ role: 'user', content: '   ' },
		]), ['Refactor the router', 'And add tests']);
	});

	test('a dependent task gets its upstream reports; spend reads in dollars and tokens', () => {
		const upstream = { id: 't-abcdef', title: 'Find "colors"', state: 'completed', result: 'Colors live in theme.ts', modelLabel: 'Haiku 4.5' } as IOrchTask;
		const text = withUpstreamReports('brief', [upstream]);
		assert.ok(text.startsWith('brief\n\n<upstream_reports>'));
		assert.ok(text.includes('<report task_id="t-abcdef" title="Find \'colors\'" status="completed" model="Haiku 4.5">\nColors live in theme.ts\n</report>'));
		assert.strictEqual(withUpstreamReports('brief', []), 'brief');

		assert.strictEqual(describeSpend(undefined, DEFAULT_ORCH_LIMITS), undefined);
		assert.strictEqual(describeSpend({ usd: 4.2, tokens: 1_500_000, since: 0 }, { budgetUsd: 25, budgetTokens: 0 }), 'Subagent spend this request: $4.20 of $25.00 (1.5M tokens).');
		assert.ok(describeSpend({ usd: 30, tokens: 10, since: 0, capped: { at: 1, reason: 'x' } }, { budgetUsd: 25, budgetTokens: 0 })!.includes('The budget ran out'));
	});

	test('a task\'s spend folds per-call reports, turn totals and Claude\'s cumulative cost', () => {
		let tracker = seedSpendTracker(undefined);
		// Volt's own loop: one report per model call, with `used`.
		tracker = foldSpend(tracker, 'r1', { type: 'usage', input: 100, output: 20, used: 120 });
		tracker = foldSpend(tracker, 'r1', { type: 'usage', input: 150, output: 30, used: 300 });
		assert.deepStrictEqual(spendUsage(tracker, undefined), { tokens: 300, input: 250, output: 50, cacheRead: 0, cacheWrite: 0 });
		// An ACP turn total replaces the run's sum; its occupancy updates spend nothing.
		tracker = foldSpend(tracker, 'r2', { type: 'usage', input: 0, output: 0, used: 40_000, costUsd: 0.5 });
		tracker = foldSpend(tracker, 'r2', { type: 'usage', input: 1_000, output: 200, cache: 30_000 });
		tracker = foldSpend(tracker, 'r2', { type: 'usage', input: 0, output: 0, used: 41_000, costUsd: 0.8 });
		const reported = spendUsage(tracker, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
		assert.strictEqual(reported.tokens, 1_500, 'cache reads do not count toward tokens');
		assert.strictEqual(reported.cacheRead, 30_000);
		assert.strictEqual(reported.costUsd, 0.8, 'the agent\'s own cost wins over list price');
		assert.strictEqual(reported.priced, 'reported');
		// A new agent session reports a smaller cumulative cost: all of it is new.
		tracker = foldSpend(tracker, 'r3', { type: 'usage', input: 0, output: 0, used: 10, costUsd: 0.1 });
		assert.strictEqual(spendUsage(tracker, undefined).costUsd, 0.9);

		const listed = spendUsage(foldSpend(seedSpendTracker(undefined), 'r1', { type: 'usage', input: 1_000_000, output: 100_000 }), { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6 });
		assert.deepStrictEqual([listed.costUsd, listed.priced], [4.5, 'list']);
		// A restart continues from what the task already spent.
		assert.strictEqual(spendUsage(seedSpendTracker(usage(2, 5_000)), undefined).costUsd, 2);
	});

	test('limits read the budget settings: $25 by default, 0 turns a limit off', () => {
		assert.strictEqual(readOrchLimits(() => undefined).budgetUsd, 25);
		assert.strictEqual(readOrchLimits(key => key === 'volt.agent.multitask.budgetUsd' ? 0 : undefined).budgetUsd, 0);
		assert.strictEqual(readOrchLimits(key => key === 'volt.agent.multitask.budgetTokens' ? 2_000_000.7 : undefined).budgetTokens, 2_000_000);
		assert.strictEqual(readOrchLimits(key => key === 'volt.agent.multitask.budgetUsd' ? -3 : undefined).budgetUsd, 0);
	});
});

suite('Volt orchestrator: budgets, dependencies and fallbacks', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const budget: IOrchLimits = { ...DEFAULT_ORCH_LIMITS, budgetUsd: 10 };

	test('a tree\'s subagent spend adds up per request; past the budget the work stops and no more starts until the user\'s next message', () => {
		const sim = new OrchSim(budget);
		sim.submit('root', 'build it');
		sim.start('root');
		const a = sim.spawn('root', 'part a').taskId!;
		const b = sim.spawn('root', 'part b').taskId!;
		sim.start(sim.childOf(a));
		sim.start(sim.childOf(b));
		// The child of `a` delegates once more: depth 2.
		const nested = sim.spawn(sim.childOf(a), 'part a, piece 1').taskId!;

		sim.run({ type: 'task.usage', taskId: a, usage: usage(3) });
		sim.run({ type: 'task.usage', taskId: a, usage: usage(4) });
		assert.strictEqual(sim.thread('root').spend?.usd, 4, 'totals, not increments: a repeat adds only the growth');
		sim.run({ type: 'task.usage', taskId: b, usage: usage(5) });
		assert.strictEqual(sim.thread('root').spend?.usd, 9);
		assert.ok(!sim.thread('root').spend?.capped);

		sim.run({ type: 'task.usage', taskId: nested, usage: usage(1.5) });
		assert.ok(sim.thread('root').spend?.capped, 'the nested task\'s spend counts for the root too');
		assert.strictEqual(sim.state.tasks[a].state, 'failed');
		assert.strictEqual(sim.state.tasks[b].state, 'failed');
		assert.ok(sim.state.tasks[a].error?.startsWith('Stopped: This request\'s subagents spent $10.50 of their $10.00 budget.'));
		assert.strictEqual(sim.state.tasks[a].delivery, 'pending', 'the root hears why its tasks stopped');
		assert.strictEqual(sim.state.tasks[nested].state, 'cancelled', 'a deeper task is cancelled, so its stopped parent does not wake for it');
		assert.strictEqual(sim.state.threads[sim.childOf(a)].active?.phase, 'cancelling');

		const refused = sim.spawn('root', 'part c');
		assert.ok(refused.rejected?.includes('No more subagents until the user\'s next message'));

		// The root's notification turn delivers the failures and says the budget ran out.
		sim.settle(sim.childOf(a), 'cancelled');
		sim.settle(sim.childOf(b), 'cancelled');
		sim.complete('root');
		const notification = sim.thread('root').active;
		assert.strictEqual(notification?.kind, 'notification');
		assert.ok(notification?.prompt.text.includes('The budget ran out'));
		sim.complete('root');

		sim.submit('root', 'go on, spend more');
		assert.strictEqual(sim.thread('root').spend, undefined, 'the user\'s next message starts a new count');
		assert.ok(!sim.spawn('root', 'part c').rejected);
	});

	test('a task\'s own budget stops only that task', () => {
		const sim = new OrchSim(budget);
		sim.submit('root', 'go');
		sim.start('root');
		const capped = sim.spawn('root', 'small job', { budgetUsd: 1 }).taskId!;
		const other = sim.spawn('root', 'other job').taskId!;
		sim.run({ type: 'task.usage', taskId: capped, usage: usage(1.2) });
		assert.strictEqual(sim.state.tasks[capped].state, 'failed');
		assert.ok(sim.state.tasks[capped].error?.includes('of its $1.00 budget'));
		assert.ok(['queued', 'running'].includes(sim.state.tasks[other].state));
		assert.ok(!sim.thread('root').spend?.capped);
	});

	test('a task with `after` waits without a slot, then starts with the reports it waited for', () => {
		const sim = new OrchSim({ ...DEFAULT_ORCH_LIMITS, runningPerParent: 1 });
		sim.submit('root', 'go');
		sim.start('root');
		const research = sim.spawn('root', 'find the colors').taskId!;
		const change = sim.spawn('root', 'apply the colors', { after: [research] }).taskId!;
		assert.strictEqual(sim.state.tasks[research].state, 'running');
		assert.strictEqual(sim.state.tasks[change].state, 'queued');
		assert.ok(describeTask(sim.state.tasks[change], sim.now, { includeResult: false }).includes(`waits for: ${research}`));

		sim.complete(sim.childOf(research), 'done', 'Colors live in theme.ts');
		assert.strictEqual(sim.state.tasks[change].state, 'running');
		const brief = sim.thread(sim.childOf(change)).active!;
		assert.ok(brief.prompt.text.includes('<upstream_reports>'));
		assert.ok(brief.prompt.text.includes('Colors live in theme.ts'));

		assert.ok(sim.spawn('root', 'x', { after: ['t-nope'] }).rejected?.includes('not a task of this chat'));
	});

	test('a task whose upstream failed does not start, and says why', () => {
		const sim = new OrchSim();
		sim.submit('root', 'go');
		sim.start('root');
		const first = sim.spawn('root', 'migrate the schema').taskId!;
		const second = sim.spawn('root', 'update the queries', { after: [first] }).taskId!;
		sim.complete(sim.childOf(first), 'failed', '');
		assert.strictEqual(sim.state.tasks[second].state, 'failed');
		assert.ok(sim.state.tasks[second].error?.startsWith(`Not started: it waited for ${first}`));
		assert.strictEqual(sim.thread(sim.childOf(second)).active, undefined, 'nothing ran');
	});

	test('a failed run goes on in the same chat on the next fallback model, and the task keeps its id', () => {
		const sim = new OrchSim();
		sim.submit('root', 'go');
		sim.start('root');
		const id = sim.spawn('root', 'write the parser', { modelRef: 'claude-code:claude-opus-5-5', modelLabel: 'Opus 5.5', fallbacks: [{ ref: 'codex:gpt-6-astra', label: 'GPT-6-Astra' }] }).taskId!;
		const child = sim.childOf(id);
		sim.start(child);
		sim.settle(child, 'failed', undefined, 'You have hit your limit');
		const task = sim.state.tasks[id];
		assert.strictEqual(task.state, 'running');
		assert.strictEqual(task.modelRef, 'codex:gpt-6-astra');
		assert.deepStrictEqual(task.failedOn, ['Opus 5.5']);
		assert.deepStrictEqual(task.fallbacks, []);
		const retry = sim.thread(child).active!;
		assert.strictEqual(retry.prompt.modelRef, 'codex:gpt-6-astra');
		assert.ok(retry.prompt.text.startsWith('[Volt subagent] The attempt on Opus 5.5 failed: You have hit your limit.'));
		assert.strictEqual(sim.thread(child).modelRef, 'codex:gpt-6-astra');

		// Out of fallbacks: the next failure reports to the parent as before.
		sim.start(child);
		sim.settle(child, 'failed', undefined, 'boom');
		assert.strictEqual(sim.state.tasks[id].state, 'failed');
		assert.strictEqual(sim.state.tasks[id].delivery, 'pending');
	});

	test('contract, dependencies, spend and fallbacks survive a save and load', () => {
		const sim = new OrchSim(budget);
		sim.submit('root', 'go');
		sim.start('root');
		const first = sim.spawn('root', 'one').taskId!;
		const second = sim.spawn('root', 'two', { after: [first], budgetUsd: 3, contract: { goal: 'g', doneWhen: ['d'] }, fallbacks: [{ ref: 'x:y', label: 'Y' }] }).taskId!;
		sim.run({ type: 'task.usage', taskId: first, usage: usage(2) });
		const loaded = parseRootSnapshot(JSON.parse(JSON.stringify(extractRoot(sim.state, 'root', [], sim.now))))!;
		const task = loaded.tasks.find(item => item.id === second)!;
		assert.deepStrictEqual([task.after, task.budgetUsd, task.contract, task.fallbacks], [[first], 3, { goal: 'g', doneWhen: ['d'] }, [{ ref: 'x:y', label: 'Y' }]]);
		assert.deepStrictEqual(loaded.tasks.find(item => item.id === first)!.usage, usage(2));
		assert.strictEqual(loaded.threads.find(thread => thread.id === 'root')!.spend?.usd, 2);
	});
});
