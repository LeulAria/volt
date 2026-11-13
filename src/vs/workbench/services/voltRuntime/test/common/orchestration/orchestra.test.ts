/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { blindLabel, blindOrder, buildTaskNotification, withUpstreamReports } from '../../../common/orchestration/agentTasks.js';
import { computeMachineCapacity, parseMachineCapacity, parseParallelAnswer, planParallel } from '../../../common/orchestration/machineCapacity.js';
import {
	agentMentionBlock, buildMemberBrief, councilReviewBrief, councilVerdictBrief, fillTemplate, localMachine, machineMentionBlock, memberNames, MENTION_COUNCIL_VALUE, MENTION_TEAM_VALUE,
	parseRanking, resolveMachine, rosterSizes, splitItems, tallyRankings,
} from '../../../common/orchestration/orchestra.js';
import { DEFAULT_ORCH_LIMITS, IOrchTask, ORCH_MAX_PARALLEL_SETTING, ORCH_MAX_PARALLEL_TOTAL_SETTING, readOrchLimits } from '../../../common/orchestration/orchestrator.js';
import { extractRoot, parseRootSnapshot } from '../../../common/orchestration/orchestratorCodec.js';
import { isDeliverable } from '../../../common/orchestration/orchestratorDecider.js';
import { applyBoardOp, describeBoardCounts, ITeamBoard, MAX_ITEM_CLAIMS, newTeamBoard, parseBoardItems, parseTeamBoard } from '../../../common/orchestration/teamBoard.js';
import { OrchSim } from './orchestratorSim.js';

const GB = 1024;

suite('Volt orchestra: machine capacity', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('memory and cores bound how many agents run at once', () => {
		const laptop = computeMachineCapacity({ totalMemMb: 16 * GB, cpus: 8 }, 1);
		assert.deepStrictEqual([laptop.recommended, laptop.max], [6, 16], '16 GB, 8 cores: cores keep 2 for the user; memory allows 17 at 700 MB');
		const studio = computeMachineCapacity({ totalMemMb: 64 * GB, cpus: 12 }, 1);
		assert.deepStrictEqual([studio.recommended, studio.max], [10, 24]);
		const small = computeMachineCapacity({ totalMemMb: 8 * GB, cpus: 4 }, 1);
		assert.deepStrictEqual([small.recommended, small.max], [2, 7], 'memory is the limit on a small machine');
		const tiny = computeMachineCapacity({ totalMemMb: 2 * GB, cpus: 1 }, 1);
		assert.deepStrictEqual([tiny.recommended, tiny.max], [1, 1], 'never below one');
		const huge = computeMachineCapacity({ totalMemMb: 1024 * GB, cpus: 128 }, 1);
		assert.deepStrictEqual([huge.recommended, huge.max], [64, 64], 'capped at the orchestrator ceiling');
		assert.ok(laptop.recommended <= laptop.max);
	});

	test('the saved setting parses, and damaged values are ignored', () => {
		const saved = computeMachineCapacity({ totalMemMb: 32 * GB, cpus: 10, cpuModel: 'Apple M3 Pro', platform: 'darwin', arch: 'arm64' }, 42);
		assert.deepStrictEqual(parseMachineCapacity(JSON.parse(JSON.stringify(saved))), saved);
		assert.strictEqual(parseMachineCapacity(undefined), undefined);
		assert.strictEqual(parseMachineCapacity({ recommended: 'four' }), undefined);
		assert.deepStrictEqual(parseMachineCapacity({ recommended: 9, max: 4 })?.recommended, 4, 'recommended never passes max');
	});

	test('the parallel limits follow the machine until the user sets them', () => {
		const capacity = { recommended: 10, max: 24 };
		const auto = readOrchLimits(key => key === 'volt.orchestra.machineCapacity' ? capacity : key === ORCH_MAX_PARALLEL_SETTING || key === ORCH_MAX_PARALLEL_TOTAL_SETTING ? 0 : undefined);
		assert.deepStrictEqual([auto.runningPerParent, auto.runningTotal], [10, 24]);
		const set = readOrchLimits(key => key === 'volt.orchestra.machineCapacity' ? capacity : key === ORCH_MAX_PARALLEL_SETTING ? 3 : undefined);
		assert.deepStrictEqual([set.runningPerParent, set.runningTotal], [3, 24]);
		const unmeasured = readOrchLimits(() => undefined);
		assert.deepStrictEqual([unmeasured.runningPerParent, unmeasured.runningTotal], [DEFAULT_ORCH_LIMITS.runningPerParent, DEFAULT_ORCH_LIMITS.runningTotal]);
	});

	test('a spawn within the comfortable number starts; past it the user is asked', () => {
		assert.deepStrictEqual(planParallel(5, { recommended: 8, max: 16 }, 0), { ask: false, parallel: 5, recommended: 5, max: 5 });
		assert.deepStrictEqual(planParallel(34, { recommended: 8, max: 16 }, 0), { ask: true, parallel: 8, recommended: 8, max: 16 });
		assert.deepStrictEqual(planParallel(100, { recommended: 8, max: 16 }, 0, 4), { ask: false, parallel: 4, recommended: 8, max: 16 }, 'asking for fewer at once than recommended needs no question');
		assert.deepStrictEqual(planParallel(10, { recommended: 8, max: 16 }, 6), { ask: true, parallel: 2, recommended: 2, max: 10 }, 'agents already running count');
		assert.strictEqual(parseParallelAnswer('run 12 please', 34, 64), 12);
		assert.strictEqual(parseParallelAnswer('all', 34, 64), 34);
		assert.strictEqual(parseParallelAnswer('500', 1000, 64), 64);
		assert.strictEqual(parseParallelAnswer('none of these', 34, 64), undefined);
	});
});

suite('Volt orchestra: rosters and briefs', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('shares of a total come out whole and add up', () => {
		assert.deepStrictEqual(rosterSizes([{ share: 0.5 }, { share: 0.5 }], 34, 100), [17, 17]);
		assert.deepStrictEqual(rosterSizes([{}, {}, {}], 10, 100), [4, 3, 3], 'no shares: an even split, remainder to the first');
		assert.deepStrictEqual(rosterSizes([{ count: 4 }, { share: 50 }, {}], 20, 100), [4, 8, 8], 'counts first; percent shares; the rest split the leftover');
		assert.deepStrictEqual(rosterSizes([{ count: 3 }, { count: 2 }], undefined, 100), [3, 2]);
		assert.match(String(rosterSizes([{ count: 3 }, { count: 2 }], 6, 100)), /add up to 5, but count is 6/);
		assert.match(String(rosterSizes([{ share: 0.5 }], undefined, 100)), /Give each group a count/);
		assert.match(String(rosterSizes([{ count: 150 }], undefined, 100)), /at most 100/);
		assert.match(String(rosterSizes([{ count: 0 }], undefined, 100)), /no members/);
	});

	test('member names are numbered within a group and unique across the team', () => {
		assert.deepStrictEqual(memberNames(['Claude', 'Codex'], [2, 1]), [['Claude 1', 'Claude 2'], ['Codex']]);
		assert.deepStrictEqual(memberNames(['Claude', 'Claude'], [1, 2]), [['Claude 1'], ['Claude 2', 'Claude 3']], 'two groups on one model keep counting');
		assert.deepStrictEqual(memberNames(['Reviewer', 'Reviewer 1'], [1, 1]), [['Reviewer'], ['Reviewer 1']]);
		assert.deepStrictEqual(memberNames(['Reviewer 1', 'Reviewer'], [1, 2]), [['Reviewer 1'], ['Reviewer 1 (2)', 'Reviewer 2']], 'a numbered name that collides gets a suffix');
	});

	test('split deals items round-robin; templates fill per member', () => {
		assert.deepStrictEqual(splitItems(['a', 'b', 'c', 'd', 'e'], 2), [['a', 'c', 'e'], ['b', 'd']]);
		assert.strictEqual(fillTemplate('{{member}} ({{index}}/{{count}}) on {{team}} {{other}}', { member: 'Codex 2', index: 2, count: 9, team: 'Auth' }), 'Codex 2 (2/9) on Auth {{other}}');
	});

	test('a member brief names the member, the roster and how the board works', () => {
		const teammates = Array.from({ length: 20 }, (_, index) => `Claude ${index + 2}`);
		const text = buildMemberBrief({ teamId: 'team-1', teamName: 'Auth', goal: 'All routes check the session', brief: 'Fix {{member}}\'s routes.', member: 'Claude 1', index: 1, count: 21, teammates, board: true, leadTitle: 'Harden auth' });
		assert.ok(text.startsWith('You are Claude 1, member 1 of 21 of the team "Auth" (team_id: team-1), started by the chat "Harden auth".'));
		assert.ok(text.includes('Fix Claude 1\'s routes.'));
		assert.ok(text.includes('and 8 more (team_board read lists everyone)'));
		assert.ok(text.includes('team_board {"op":"claim"}'));
		const split = buildMemberBrief({ teamId: 'team-1', teamName: 'Auth', brief: 'Fix them.', member: 'Codex', index: 2, count: 2, teammates: ['Claude'], items: ['a.ts', 'b.ts'], board: false });
		assert.ok(split.includes('Your items (yours alone; do them in order):\n1. a.ts\n2. b.ts'));
		assert.ok(!split.includes('"op":"claim"'), 'no board, no claiming');
	});

	test('reviews end with a ranking that parses and tallies', () => {
		assert.ok(councilReviewBrief('Which cache?', 1, 1).includes('FINAL RANKING:'));
		assert.ok(councilVerdictBrief('Which cache?', [{ label: 'A', model: 'Codex' }, { label: 'B', model: 'Claude' }], 1).includes('- Response A: Codex'));
		const ranking = parseRanking('Response A cites the wrong file.\n\nFINAL RANKING:\n1. Response B\n2. **Response A**\n3. Response B\n');
		assert.deepStrictEqual(ranking, ['B', 'A']);
		assert.deepStrictEqual(parseRanking('no ranking here'), []);
		assert.deepStrictEqual(tallyRankings([['B', 'A'], ['B', 'C'], ['A', 'B']]).map(entry => [entry.label, entry.mean, entry.votes]), [['B', 4 / 3, 3], ['A', 1.5, 2], ['C', 2, 1]]);
	});
});

suite('Volt orchestra: team board', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const board = (): ITeamBoard => newTeamBoard({ id: 'team-1', kind: 'team', name: 'Auth', rootId: 'root', leadId: 'root', at: 1 });

	test('members claim open items in order, never the same one, and items wait on their dependencies', () => {
		let state = applyBoardOp(board(), { op: 'add', items: [{ title: 'schema' }, { title: 'api', after: ['1'] }, { title: 'docs' }] }, 2).board;
		const first = applyBoardOp(state, { op: 'claim', member: 'Claude 1', taskId: 't-1' }, 3);
		state = first.board;
		assert.strictEqual(first.item?.id, 'i1');
		const second = applyBoardOp(state, { op: 'claim', member: 'Codex 1', taskId: 't-2' }, 4);
		state = second.board;
		assert.strictEqual(second.item?.id, 'i3', 'api waits for schema; docs is next');
		assert.strictEqual(applyBoardOp(state, { op: 'claim', member: 'Claude 1', taskId: 't-1' }, 5).item?.id, 'i1', 'claiming again returns what it holds');
		assert.strictEqual(applyBoardOp(state, { op: 'claim', member: 'Gemini', taskId: 't-3' }, 5).empty, 'waiting');
		state = applyBoardOp(state, { op: 'done', member: 'Claude 1', taskId: 't-1', result: 'schema in db.ts' }, 6).board;
		assert.strictEqual(applyBoardOp(state, { op: 'claim', member: 'Gemini', taskId: 't-3' }, 7).item?.id, 'i2', 'done unblocks what waited on it');
		assert.match(String(applyBoardOp(state, { op: 'done', member: 'Gemini', taskId: 't-3', itemId: 'i3', result: 'x' }, 8).error), /held by Codex 1/);
		assert.strictEqual(describeBoardCounts(state), '3 items: 1 done, 1 in progress, 1 open');
	});

	test('items of a member that ended go back, and one given back too often is blocked', () => {
		let state = applyBoardOp(board(), { op: 'add', items: [{ title: 'flaky' }] }, 1).board;
		for (let attempt = 1; attempt <= MAX_ITEM_CLAIMS; attempt++) {
			state = applyBoardOp(state, { op: 'claim', member: `m${attempt}`, taskId: `t-${attempt}` }, attempt).board;
			state = applyBoardOp(state, { op: 'memberEnded', taskId: `t-${attempt}`, state: 'failed' }, attempt).board;
		}
		assert.strictEqual(state.items[0].status, 'blocked');
		assert.match(state.items[0].reason ?? '', /Given back 3 times/);
		assert.strictEqual(applyBoardOp(state, { op: 'claim', member: 'm9', taskId: 't-9' }, 9).empty, 'done');
	});

	test('bad input is refused without changing the board, and boards survive a save', () => {
		const start = board();
		assert.match(String(applyBoardOp(start, { op: 'add', items: [{ title: 'a', after: ['3'] }] }, 1).error), /not an earlier item/);
		assert.match(String(parseBoardItems([{ detail: 'no title' }])), /needs a title/);
		assert.deepStrictEqual(parseBoardItems(['one', { title: 'two', after: [1] }, '  ']), [{ title: 'one' }, { title: 'two', after: ['1'] }]);
		let state = applyBoardOp(start, { op: 'add', items: [{ title: 'a' }, { title: 'b' }] }, 1).board;
		state = applyBoardOp(state, { op: 'note', member: 'Lead', kind: 'decision', text: 'Use JWT' }, 2).board;
		state = { ...state, members: [{ name: 'Claude', taskId: 't-1', childId: 'agent-1', modelLabel: 'Opus' }] };
		assert.deepStrictEqual(parseTeamBoard(JSON.parse(JSON.stringify(state))), state);
		assert.strictEqual(parseTeamBoard({ version: 2 }), undefined);
	});
});

suite('Volt orchestra: teams and councils in the orchestrator', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a team wakes its lead once, with every member\'s report', () => {
		const sim = new OrchSim();
		sim.submit('lead', 'go');
		sim.start('lead');
		const ids = ['one', 'two', 'three'].map(name => sim.spawn('lead', `review ${name}`, { team: 'team-1' }).taskId!);
		const solo = sim.spawn('lead', 'unrelated work').taskId!;
		sim.settle('lead', 'done');
		sim.complete(sim.childOf(ids[0]), 'done', 'first');
		sim.complete(sim.childOf(ids[1]), 'done', 'second');
		assert.strictEqual(sim.thread('lead').active, undefined, 'two of three members done: no wake-up yet');
		assert.strictEqual(isDeliverable(sim.state, sim.state.tasks[ids[0]]), false);
		sim.complete(sim.childOf(solo), 'done', 'solo report');
		assert.deepStrictEqual(sim.thread('lead').active?.taskIds, [solo], 'other tasks still report on their own');
		sim.complete('lead');
		sim.complete(sim.childOf(ids[2]), 'done', 'third');
		const wake = sim.thread('lead').active;
		assert.deepStrictEqual([...wake?.taskIds ?? []].sort(), [...ids].sort());
		for (const text of ['first', 'second', 'third']) {
			assert.ok(wake?.prompt.text.includes(text));
		}
	});

	test('quiet tasks never wake the lead; the task waiting on them reads them', () => {
		const sim = new OrchSim();
		sim.submit('lead', 'decide');
		sim.start('lead');
		const answers = ['a', 'b'].map(name => sim.spawn('lead', `answer ${name}`, { team: 'council-1', quiet: true }).taskId!);
		const verdict = sim.spawn('lead', 'verdict', { team: 'council-1', after: answers }).taskId!;
		sim.settle('lead', 'done');
		assert.strictEqual(sim.state.tasks[verdict].state, 'queued');
		sim.complete(sim.childOf(answers[0]), 'done', 'answer A text');
		sim.complete(sim.childOf(answers[1]), 'done', 'answer B text');
		assert.strictEqual(sim.state.tasks[answers[0]].delivery, 'none');
		assert.strictEqual(sim.thread('lead').active, undefined, 'answers do not wake the lead');
		assert.strictEqual(sim.state.tasks[verdict].state, 'running');
		const brief = sim.thread(sim.childOf(verdict))?.active?.prompt.text ?? '';
		assert.ok(brief.includes('answer A text') && brief.includes('answer B text'), 'the verdict reads both answers');
		sim.complete(sim.childOf(verdict), 'done', 'Decision: B');
		assert.deepStrictEqual(sim.thread('lead').active?.taskIds, [verdict]);
	});

	test('the user\'s "N at a time" caps the lead\'s running members, and lifting it starts the rest', () => {
		const sim = new OrchSim({ ...DEFAULT_ORCH_LIMITS, runningPerParent: 16, runningTotal: 32 });
		sim.submit('lead', 'go');
		sim.start('lead');
		sim.run({ type: 'thread.children', threadId: 'lead', maxRunning: 2 });
		assert.strictEqual(sim.thread('lead').maxChildren, 2);
		const ids = Array.from({ length: 5 }, (_, index) => sim.spawn('lead', `item ${index}`, { team: 'team-1' }).taskId!);
		const running = () => ids.filter(id => sim.state.tasks[id].state === 'running').length;
		assert.strictEqual(running(), 2);
		sim.complete(sim.childOf(ids[0]), 'done', 'r0');
		assert.strictEqual(running(), 2, 'a finished member frees its slot for the next');
		sim.run({ type: 'thread.children', threadId: 'lead', maxRunning: undefined });
		assert.strictEqual(sim.thread('lead').maxChildren, undefined);
		assert.strictEqual(running(), 4, 'back to the per-chat limit');
	});

	test('team spawns have their own cap, apart from the delegation loop guard', () => {
		const sim = new OrchSim({ ...DEFAULT_ORCH_LIMITS, maxSpawnsPerTurn: 2, maxTeamAgents: 3 });
		sim.submit('lead', 'go');
		sim.start('lead');
		sim.spawn('lead', 'plain one');
		sim.spawn('lead', 'plain two');
		assert.match(String(sim.spawn('lead', 'plain three').rejected), /already started 2 subagents/);
		for (const name of ['a', 'b', 'c']) {
			assert.strictEqual(sim.spawn('lead', `member ${name}`, { team: 'team-1' }).rejected, undefined);
		}
		assert.match(String(sim.spawn('lead', 'member d', { team: 'team-1' }).rejected), /volt\.orchestra\.maxAgentsPerRequest/);
	});

	test('a blind review sees the others\' answers under shared labels, never its own, in its own order', () => {
		const tasks = ['t-a', 't-b', 't-c'].map((id, index): IOrchTask => ({ id, source: 'volt', parentId: 'lead', rootId: 'lead', title: `Answer · Model ${index}`, role: 'review', origin: 'agent', brief: '', modelLabel: `Model ${index}`, isolation: 'shared', depth: 1, createdAt: 1, state: 'completed', steps: 0, files: [], delivery: 'none', rounds: 1, result: `answer from ${id}` }));
		const pool = blindOrder(tasks).map(task => task.id);
		const label = (id: string) => `Response ${blindLabel(pool.indexOf(id))}`;
		const forA = withUpstreamReports('Review these.', tasks.filter(task => task.id !== 't-a'), { pool, seed: 'review-a' });
		assert.ok(!forA.includes('answer from t-a'), 'not its own answer');
		assert.ok(!/Model \d|t-[abc]"/.test(forA), 'no model names or task ids');
		assert.ok(forA.includes(`<report label="${label('t-b')}">\nanswer from t-b`));
		const forC = withUpstreamReports('Review these.', tasks.filter(task => task.id !== 't-c'), { pool, seed: 'review-c' });
		assert.ok(forC.includes(`<report label="${label('t-b')}">\nanswer from t-b`), 'the same answer has the same label for every judge');
		assert.deepStrictEqual([blindLabel(0), blindLabel(25), blindLabel(26), blindLabel(27)], ['A', 'Z', 'AA', 'AB']);
	});

	test('team, blind, quiet and the lead\'s cap survive a restart', () => {
		const sim = new OrchSim();
		sim.submit('lead', 'go');
		sim.start('lead');
		sim.run({ type: 'thread.children', threadId: 'lead', maxRunning: 3 });
		const answer = sim.spawn('lead', 'answer', { team: 'council-1', quiet: true }).taskId!;
		const review = sim.spawn('lead', 'review', { team: 'council-1', blind: [answer], after: [answer] }).taskId!;
		const restored = parseRootSnapshot(JSON.parse(JSON.stringify(extractRoot(sim.state, 'lead', [], 5))));
		assert.strictEqual(restored?.threads.find(thread => thread.id === 'lead')?.maxChildren, 3);
		const tasks = Object.fromEntries((restored?.tasks ?? []).map(task => [task.id, task]));
		assert.deepStrictEqual([tasks[answer]?.team, tasks[answer]?.quiet, tasks[review]?.blind], ['council-1', true, [answer]]);
	});

	test('a teammate\'s message steers in as a notification, and stays one when the steer fails', () => {
		const sim = new OrchSim();
		sim.submit('lead', 'go');
		sim.run({ type: 'run.started', threadId: 'lead', runId: 'run-1', turnId: sim.thread('lead').active!.id, steerable: true });
		assert.strictEqual(sim.thread('lead').active?.steerable, true);
		const before = sim.effects.length;
		const decision = sim.run({ type: 'thread.notify', threadId: 'lead', turnId: 'tm-1', prompt: { text: 'blocked on i3' }, steer: true });
		assert.strictEqual(decision.outcome, 'steered');
		const [steer] = sim.effectsOf('steer', before);
		assert.strictEqual(steer?.notification, true);
		sim.run({ type: 'steer.failed', threadId: 'lead', steerId: 'tm-1', prompt: { text: 'blocked on i3' }, notification: true });
		assert.strictEqual(sim.thread('lead').queue[0]?.kind, 'notification', 'never the user\'s prompt: the request\'s budget does not start over');
		assert.notStrictEqual(sim.thread('lead').active?.phase, 'cancelling', 'the running turn is not stopped');
	});

	test('a council goes on without a participant that failed', () => {
		const sim = new OrchSim();
		sim.submit('lead', 'decide');
		sim.start('lead');
		const answers = ['a', 'b', 'c'].map(name => sim.spawn('lead', `answer ${name}`, { team: 'council-1', quiet: true }).taskId!);
		const review = sim.spawn('lead', 'review', { team: 'council-1', quiet: true, after: [answers[1], answers[2]], blind: answers }).taskId!;
		const verdict = sim.spawn('lead', 'verdict', { team: 'council-1', after: [...answers, review] }).taskId!;
		sim.settle('lead', 'done');
		sim.complete(sim.childOf(answers[0]), 'done', 'A says x');
		sim.complete(sim.childOf(answers[1]), 'failed', '');
		sim.complete(sim.childOf(answers[2]), 'done', 'C says y');
		assert.strictEqual(sim.state.tasks[review].state, 'running', 'one answer failed; the review still runs');
		const brief = sim.thread(sim.childOf(review))?.active?.prompt.text ?? '';
		assert.ok(brief.includes('C says y') && brief.includes('did not finish'));
		sim.complete(sim.childOf(review), 'done', 'FINAL RANKING:\n1. Response C');
		assert.strictEqual(sim.state.tasks[verdict].state, 'running');
	});

	test('a team asks the same of many members, and its report gets through the wake-up limit', () => {
		const sim = new OrchSim({ ...DEFAULT_ORCH_LIMITS, maxBriefRepeats: 1, maxWakeups: 1 });
		sim.submit('lead', 'go');
		sim.start('lead');
		const first = sim.spawn('lead', 'check every route', { team: 'team-1', modelRef: 'a' }).taskId!;
		sim.complete(sim.childOf(first), 'done', 'r1');
		assert.strictEqual(sim.spawn('lead', 'check every route', { team: 'team-1', modelRef: 'b' }).rejected, undefined, 'the repeat guard leaves teams alone');
		sim.settle('lead', 'done');
		sim.run({ type: 'thread.notify', threadId: 'lead', turnId: 'tm-2', prompt: { text: 'a message' } });
		sim.complete('lead');
		assert.strictEqual(sim.thread('lead').wakeups, 1);
		const second = Object.values(sim.state.tasks).find(task => task.id !== first && task.team === 'team-1')!;
		sim.complete(sim.childOf(second.id), 'done', 'r2');
		assert.strictEqual(sim.thread('lead').pause, undefined, 'a finished team is delivered past the limit');
		assert.strictEqual(sim.thread('lead').active?.taskIds?.length, 2);
	});

	test('many reports in one wake-up share one budget', () => {
		const tasks = Array.from({ length: 30 }, (_, index): IOrchTask => ({ id: `t-${index}`, source: 'volt', parentId: 'lead', rootId: 'lead', title: `Member ${index}`, role: 'general', origin: 'agent', brief: '', isolation: 'shared', depth: 1, createdAt: 1, state: 'completed', steps: 0, files: [], delivery: 'pending', rounds: 1, team: 'team-1', result: 'x'.repeat(5_000) }));
		const text = buildTaskNotification(tasks, [], 10);
		assert.ok(text.length < 60_000, `30 reports stay compact (${text.length} chars)`);
		assert.ok(text.includes('team_board read'));
	});
});

suite('Volt orchestra: machines and mentions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const machines = [
		localMachine('This Mac', computeMachineCapacity({ totalMemMb: 32 * GB, cpus: 10 }, 1), 2),
		{ id: 'm-studio', name: 'Mac Studio', kind: 'runner' as const, online: true, detail: '24 cores' },
		{ id: 'm-ubuntu', name: 'ubuntu-server', kind: 'runner' as const, online: false, detail: '' },
	];

	test('machines resolve by id, name, alias or a unique part of the name', () => {
		assert.strictEqual(resolveMachine('@ThisPC', machines)?.id, 'local');
		assert.strictEqual(resolveMachine('this mac', machines)?.id, 'local');
		assert.strictEqual(resolveMachine('m-studio', machines)?.id, 'm-studio');
		assert.strictEqual(resolveMachine('MacStudio', machines)?.id, 'm-studio');
		assert.strictEqual(resolveMachine('ubuntu', machines)?.id, 'm-ubuntu');
		assert.strictEqual(resolveMachine('m', machines), undefined, 'ambiguous');
		assert.ok(machines[0].detail.includes('2 running'));
	});

	test('mention blocks tell the agent where and with whom to work', () => {
		assert.ok(machineMentionBlock(machines[1]).includes('machine_run {"machine":"m-studio"'));
		assert.ok(machineMentionBlock(machines[2]).includes('offline'));
		assert.ok(machineMentionBlock(machines[0]).includes('run here, on this machine'));
		assert.ok(agentMentionBlock({ label: 'Council', value: MENTION_COUNCIL_VALUE }, ['codex:gpt-6', 'claude-code:opus']).includes('participants ["codex:gpt-6","claude-code:opus"]'));
		assert.ok(agentMentionBlock({ label: 'Team', value: MENTION_TEAM_VALUE }, []).includes('spawn_team'));
		assert.ok(agentMentionBlock({ label: 'Opus', value: 'agent:claude:opus' }, []).includes('delegate_task with model "agent:claude:opus"'));
	});
});
