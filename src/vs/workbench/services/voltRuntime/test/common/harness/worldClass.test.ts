/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { evaluateConfidence } from '../../../common/harness/confidence.js';
import { createEnvelope, forkEnvelope } from '../../../common/harness/envelope.js';
import { resolveCapabilities, understandEnvironment } from '../../../common/harness/environment.js';
import { budgetFromLane, ResourceGovernor } from '../../../common/harness/governor.js';
import { applyHumanAction } from '../../../common/harness/humanLoop.js';
import { classifyIntent } from '../../../common/harness/intent.js';
import { WorkerLeaseManager } from '../../../common/harness/lease.js';
import { LessonBook } from '../../../common/harness/lessons.js';
import { TaskLifecycle } from '../../../common/harness/lifecycle.js';
import { mergeResults } from '../../../common/harness/merger.js';
import { applyPatch, draftMission, endMission, readyTasks, sealedIds, submitPlan } from '../../../common/harness/mission.js';
import { advanceOoda, createOoda, phaseFor } from '../../../common/harness/ooda.js';
import { EvalLedger } from '../../../common/harness/eval.js';
import { EventStore } from '../../../common/harness/eventStore.js';
import { SteeringInbox } from '../../../common/harness/inbox.js';
import { checkInvariants } from '../../../common/harness/invariants.js';
import { applyEvalHints } from '../../../common/harness/optimizer.js';
import { prepareRun } from '../../../common/harness/pipeline.js';
import { runPreStep } from '../../../common/harness/preStep.js';
import { applyRestored } from '../../../common/harness/restore.js';
import { titleFrom } from '../../../common/harness/sessionTitle.js';
import { SkillCatalog } from '../../../common/harness/skills.js';
import { repairTranscript } from '../../../common/harness/transcriptRepair.js';
import { FileTracker } from '../../../common/harness/fileTracker.js';
import { MistakeTracker } from '../../../common/harness/mistakes.js';
import { mutationLane } from '../../../common/harness/mutationQueue.js';
import { balancedPrefix } from '../../../common/harness/contextEngine.js';
import { ProgressTracker } from '../../../common/harness/progress.js';
import { replay } from '../../../common/harness/replay.js';
import { createRunHarness } from '../../../common/harness/runHarness.js';
import { SessionManager } from '../../../common/harness/sessionControl.js';
import { selectStrategy } from '../../../common/harness/strategy.js';
import { analyzeTask } from '../../../common/harness/taskIntel.js';
import { dedupeCalls, planToolBatch, validateArgs } from '../../../common/harness/toolPolicy.js';
import { WorktreeAllocator } from '../../../common/harness/worktree.js';
import { IVoltTool } from '../../../common/tools/tool.js';

suite('Volt world-class harness fabric', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('envelope identity survives a fork', () => {
		const source = createEnvelope({ id: 'r1', sessionId: 's1', conversationId: 'c1', mode: 'agent', permissions: ['read', 'edit'] });
		const child = forkEnvelope(source, 'r2');
		assert.strictEqual(child.forkedFrom, 'r1');
		assert.strictEqual(child.sessionId, 's1');
		assert.deepStrictEqual(child.permissions, ['read', 'edit']);
	});

	test('session manager create / pause / resume / fork / cancel', () => {
		const manager = new SessionManager();
		assert.strictEqual(manager.create('s1', 'c1').ok, true);
		manager.mark('s1', 'planning');
		manager.mark('s1', 'running');
		assert.strictEqual(manager.pause('s1')?.phase, 'paused');
		assert.strictEqual(manager.resume('s1')?.phase, 'running');
		const fork = manager.fork('s1', 's2');
		assert.strictEqual(fork?.ok, true);
		assert.strictEqual(fork?.session.forkedFrom, 's1');
		assert.strictEqual(fork?.phase, 'created');
		assert.strictEqual(manager.cancel('s1')?.ok, true);
	});

	test('a dead worker lease expires and can be reassigned', () => {
		let now = 1_000;
		const leases = new WorkerLeaseManager({ ttlMs: 1_000, now: () => now });
		assert.ok(leases.acquire('w1', 't1'));
		assert.strictEqual(leases.acquire('w2', 't1'), undefined);
		now = 2_100;
		assert.ok(leases.acquire('w2', 't1'));
	});

	test('governor trips the step meter before a provider call would', () => {
		const governor = new ResourceGovernor(budgetFromLane({ maxModelCalls: 2, maxToolCalls: 4 }, { tokens: 100 }));
		governor.consume({ steps: 1, tokens: 40 });
		governor.consume({ steps: 1, tokens: 40 });
		const snap = governor.consume({ steps: 1, tokens: 40 });
		assert.ok(snap.exceeded.includes('steps'));
		assert.ok(snap.exceeded.includes('tokens'));
		assert.strictEqual(governor.canAfford('steps'), false);
	});

	test('capability resolver strips browser and git when the environment cannot support them', () => {
		const intent = classifyIntent('run the app and show me in the browser', 'agent', { hasWorkspace: true });
		const env = understandEnvironment({ hasWorkspace: true, hasBrowserHost: false, hasGit: false, hasNetwork: true });
		const resolved = resolveCapabilities({ ...intent, groups: [...intent.groups, 'browser', 'git'] }, env);
		assert.ok(resolved.denied.some(item => item.group === 'browser'));
		assert.ok(resolved.denied.some(item => item.group === 'git'));
		assert.ok(!resolved.granted.includes('browser'));
	});

	test('debug requests pick the debug strategy; chat picks answer', () => {
		const debugIntent = classifyIntent('the login crash has a stack trace, fix it', 'debug', { hasWorkspace: true });
		const debug = selectStrategy(analyzeTask('the login crash has a stack trace, fix it', debugIntent), debugIntent, { webRequired: false, browserRequired: false, workspaceRequired: true, autonomy: 'assisted', risk: 'medium' }, 'debug');
		assert.strictEqual(debug.strategy, 'debug');
		assert.strictEqual(debug.policy.parallelism, 1);

		const chatIntent = classifyIntent('what is 2+2', 'agent');
		const chat = selectStrategy(analyzeTask('what is 2+2', chatIntent), chatIntent, { webRequired: false, browserRequired: false, workspaceRequired: false, autonomy: 'supervised', risk: 'safe' }, 'agent');
		assert.strictEqual(chat.strategy, 'answer');
		assert.strictEqual(chat.exit.requireMutation, false);

		const researchIntent = classifyIntent('tell me each model and their price give me in a table', 'ask');
		const research = selectStrategy(analyzeTask('tell me each model and their price give me in a table', researchIntent), researchIntent, { webRequired: true, browserRequired: false, workspaceRequired: false, autonomy: 'supervised', risk: 'safe' }, 'ask');
		assert.strictEqual(research.strategy, 'research-answer');
		assert.ok((research.budgets.tools ?? 0) >= 16);

		const implementDocs = classifyIntent('implement login using the official docs', 'agent', { hasWorkspace: true });
		const first = selectStrategy(analyzeTask('implement login using the official docs', implementDocs), implementDocs, { webRequired: true, browserRequired: false, workspaceRequired: true, autonomy: 'assisted', risk: 'safe' }, 'agent');
		assert.strictEqual(first.strategy, 'research-first');
	});

	test('OODA advances observe → orient → … → learn → observe', () => {
		let state = createOoda();
		assert.strictEqual(state.phase, 'observe');
		state = advanceOoda(state);
		assert.strictEqual(state.phase, 'orient');
		for (let i = 0; i < 5; i++) {
			state = advanceOoda(state);
		}
		assert.strictEqual(state.phase, 'learn');
		state = advanceOoda(state);
		assert.strictEqual(state.phase, 'observe');
		assert.strictEqual(state.cycle, 2);
		assert.strictEqual(phaseFor('recovery'), 'reason');
	});

	test('schema validation, dedupe, and batch planning', () => {
		const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
		assert.strictEqual(validateArgs(schema, {}).ok, false);
		assert.strictEqual(validateArgs(schema, { path: 'a.ts' }).ok, true);

		const calls = [
			{ id: '1', name: 'read_file', args: { path: 'a.ts' } },
			{ id: '2', name: 'read_file', args: { path: 'a.ts' } },
			{ id: '3', name: 'edit_file', args: { path: 'a.ts' } },
		];
		const deduped = dedupeCalls(calls);
		assert.strictEqual(deduped.unique.length, 2);
		assert.strictEqual(deduped.duplicates.length, 1);

		const tools = new Map<string, IVoltTool>([
			['read_file', tool('read_file', 'read', true)],
			['edit_file', tool('edit_file', 'edit', false)],
		]);
		const plan = planToolBatch(calls, tools);
		assert.strictEqual(plan.parallel.length, 1);
		assert.strictEqual(plan.serial.length, 1);
		assert.ok(plan.skipped.some(item => /Duplicate/.test(item.reason)));
	});

	test('confidence refuses a complete claim with no proof', () => {
		const report = evaluateConfidence({
			completion: { complete: true, failed: [], pending: [], unavailable: [], reason: 'Nothing left to do.' },
			gates: [{ kind: 'test', criteria: ['c0'], status: 'pending' }],
			exit: { requirePlanComplete: true, requireGates: true, requireMutation: true, requireConfidence: 0.55 },
			changedFiles: 0,
		});
		assert.strictEqual(report.sufficient, false);
		assert.ok(report.score < 0.55);
	});

	test('consensus agrees, majorities, and conflicts', () => {
		assert.strictEqual(mergeResults([
			{ workerId: 'a', value: 'pass', ok: true },
			{ workerId: 'b', value: 'pass', ok: true },
		]).kind, 'agree');
		assert.strictEqual(mergeResults([
			{ workerId: 'a', value: 'pass', ok: true },
			{ workerId: 'b', value: 'pass', ok: true },
			{ workerId: 'c', value: 'fail', ok: true },
		]).kind, 'majority');
		assert.strictEqual(mergeResults([
			{ workerId: 'a', value: 'pass', ok: true },
			{ workerId: 'b', value: 'fail', ok: true },
		]).kind, 'conflict');
	});

	test('isolated worktrees never share a path', () => {
		const alloc = new WorktreeAllocator('/tmp/volt', 'worktree');
		const a = alloc.allocate('w1');
		const b = alloc.allocate('w2');
		assert.notStrictEqual(a.path, b.path);
		assert.strictEqual(alloc.isIsolated(), true);
		alloc.release(a.id);
		const c = alloc.allocate('w3');
		assert.strictEqual(c.path, a.path);
	});

	test('lessons remember a recovery that worked', () => {
		const book = new LessonBook();
		book.record('not-found', 'nudge', false, 'guessed a path');
		book.record('not-found', 'switch', true, 'searched first');
		assert.strictEqual(book.lastSuccess('not-found'), 'switch');
		assert.deepStrictEqual(book.failedFor('not-found'), ['nudge']);
	});

	test('human pause and edit-plan', () => {
		const life = new TaskLifecycle();
		life.transition('planning');
		life.transition('running');
		assert.strictEqual(applyHumanAction({ kind: 'pause' }, life).phase, 'paused');
		assert.strictEqual(applyHumanAction({ kind: 'resume' }, life).phase, 'running');
	});

	test('mission submitPlan refuses uncovered contracts and endMission refuses leftover work', () => {
		const intent = classifyIntent('add login and add signup and make sure the tests pass', 'multitask', { hasWorkspace: true });
		const intel = analyzeTask('add login and add signup and make sure the tests pass', intent);
		const draft = draftMission('m1', intel);
		const submitted = submitPlan(draft);
		assert.ok(!('error' in submitted));
		assert.strictEqual(submitted.phase, 'running');
		assert.ok(readyTasks(submitted).length >= 1);
		const ended = endMission(submitted);
		assert.ok('error' in ended);
	});

	test('replay rebuilds the projection and model-visible tools from the durable log', () => {
		const store = new EventStore();
		const base = { runId: 'r1', sessionId: 's1', timestamp: 1 };
		store.append({ ...base, event: { type: 'run.start', runId: 'r1', mode: 'agent' } });
		store.append({ ...base, timestamp: 2, event: { type: 'tool.start', callId: 'c1', name: 'read_file', input: '{"path":"a.ts"}' } });
		store.append({ ...base, timestamp: 3, event: { type: 'tool.end', callId: 'c1', result: 'export const a = 1' } });
		store.append({ ...base, timestamp: 4, event: { type: 'run.end', runId: 'r1', reason: 'done' } });
		const result = replay(store.all('r1'));
		assert.ok(result);
		assert.strictEqual(result.projection.reason, 'done');
		assert.ok(result.messages.some(message => message.role === 'tool' && message.content.includes('export')));
	});

	test('progress detects oscillation between two resources', () => {
		const tracker = new ProgressTracker();
		const ping = (step: number, path: string) => tracker.observe({
			step,
			calls: [{ id: `c${step}`, name: 'read_file', args: { path } }],
			results: [{ callId: `c${step}`, name: 'read_file', kind: 'read', text: 'x' }],
			assistantText: '',
			filesChanged: 0,
		});
		ping(1, 'a.ts');
		ping(2, 'b.ts');
		ping(3, 'a.ts');
		const last = ping(4, 'b.ts');
		assert.strictEqual(last.signals.oscillation, 1);
	});

	test('pipeline now carries envelope, strategy, environment, and capabilities', () => {
		const prepared = prepareRun({
			text: 'add a logout button to the header and update the tests so they pass',
			mode: 'agent',
			intentContext: { hasWorkspace: true },
			sessionId: 's1',
			conversationId: 'c1',
		});
		assert.strictEqual(prepared.envelope.sessionId, 's1');
		assert.ok(prepared.strategy.strategy);
		assert.strictEqual(prepared.environment.hasWorkspace, true);
		assert.ok(prepared.capabilities.granted.includes('edit'));
		assert.ok(prepared.plan);
		assert.strictEqual(prepared.requestKind, 'build');
		assert.strictEqual(prepared.clarification.path, 'none');
	});

	test('clarification asks on a dangling first-turn "fix it" and proceeds when history exists', () => {
		const dangling = prepareRun({ text: 'fix it', mode: 'agent', intentContext: { hasWorkspace: true } });
		assert.strictEqual(dangling.clarification.path, 'ask');
		assert.ok(dangling.clarify);

		const follow = prepareRun({
			text: 'fix it',
			mode: 'agent',
			intentContext: { hasWorkspace: true },
			intelContext: { hasPriorTurns: true },
		});
		assert.strictEqual(follow.clarification.path, 'none');
		assert.ok(!follow.clarify);
	});

	test('eval engine scores a failed doom run below a verified complete one', () => {
		const ledger = new EvalLedger();
		const fail = ledger.record({
			lane: 'agent', strategy: 'explore-implement-verify', outcome: 'fail', complete: false,
			steps: 12, tools: 20, toolErrors: 10, tokens: 40_000, durationMs: 80_000,
			recoveries: 3, doom: true, regression: true, stuck: true, confidence: 0.1,
		});
		const win = ledger.record({
			lane: 'agent', strategy: 'explore-implement-verify', outcome: 'done', complete: true,
			steps: 6, tools: 8, toolErrors: 0, tokens: 12_000, durationMs: 20_000,
			recoveries: 0, doom: false, regression: false, stuck: false, confidence: 0.8,
		});
		assert.ok(win.score > fail.score);
		assert.strictEqual(win.meters.successRate, 1);
		assert.ok(ledger.hints().length >= 1);
	});

	test('steering inbox waits for a waking message before claiming context', () => {
		const box = new SteeringInbox();
		box.inject('remember the public API', false);
		assert.deepStrictEqual(box.claim(), []);
		box.inject('also add logout');
		assert.deepStrictEqual(box.claim(), ['remember the public API', 'also add logout']);
		assert.strictEqual(box.pending, 0);
	});

	test('scheduler leases the highest-priority ready worker and is fair', () => {
		const prepared = prepareRun({
			text: 'add login and add signup and make sure the tests pass',
			mode: 'multitask',
			intentContext: { hasWorkspace: true },
		});
		const harness = createRunHarness(prepared, { test: 'npm test' }, () => ({
			canEscalate: true, canDelegate: true, canRollback: true, canReset: true,
		}));
		const first = harness.scheduler.dispatch(prepared.plan);
		assert.ok(first);
		assert.strictEqual(first.status, 'leased');
		harness.scheduler.complete(first.id);
		assert.strictEqual(harness.scheduler.snapshot().done, 1);
	});

	test('eval hints escalate the next run and compact earlier', () => {
		const prepared = prepareRun({
			text: 'add a logout button to the header and update the tests so they pass',
			mode: 'agent',
			intentContext: { hasWorkspace: true },
			evalHints: [
				{ target: 'model', message: 'The lane budget ran out; escalate.' },
				{ target: 'context', message: 'Tokens are high; compact earlier.' },
				{ target: 'tools', message: 'This run looped; switch tools.' },
			],
		});
		assert.strictEqual(prepared.preferEscalate, true);
		assert.strictEqual(prepared.forceCompact, true);
		assert.strictEqual(prepared.strategy.contingency.onFail, 'escalate');
		assert.strictEqual(prepared.strategy.contingency.onStuck, 'switch');
		const optimized = applyEvalHints(prepared.strategy, prepared.tools, [{ target: 'tools', message: 'Most tool calls failed.' }]);
		const read = optimized.tools.hints.find(hint => hint.name === 'read_file')?.score ?? 0;
		const edit = optimized.tools.hints.find(hint => hint.name === 'edit_file')?.score ?? 0;
		assert.ok(read >= edit, `expected safer tools first: read=${read} edit=${edit}`);
	});

	test('rollback snapshots write existing files and delete created ones', async () => {
		const writes: string[] = [];
		const removed: string[] = [];
		const report = await applyRestored([
			{ path: 'src/a.ts', content: 'old', existed: true },
			{ path: 'src/new.ts', content: '', existed: false },
		], {
			write: async (path, content) => { writes.push(`${path}:${content}`); },
			remove: async path => { removed.push(path); },
		});
		assert.strictEqual(report.applied, 2);
		assert.deepStrictEqual(writes, ['src/a.ts:old']);
		assert.deepStrictEqual(removed, ['src/new.ts']);
	});

	test('pre-step rejects an empty transcript and repairs unpaired tool calls', () => {
		const empty = runPreStep({ messages: [], claimed: [], step: 0, target: 'step' });
		assert.strictEqual(empty.kind, 'reject');
		const broken = runPreStep({
			messages: [
				{ role: 'user', content: 'edit a.ts' },
				{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }] },
			],
			claimed: [],
			step: 1,
			target: 'step',
		});
		assert.strictEqual(broken.kind, 'enter');
		assert.ok(broken.messages.some(message => message.role === 'tool' && message.callId === 'c1'));
	});

	test('transcript repair remaps orphan results and fills missing ones', () => {
		const repaired = repairTranscript([
			{ role: 'user', content: 'go' },
			{ role: 'assistant', content: '', toolCalls: [{ id: 'new', name: 'read_file', args: {} }] },
			{ role: 'tool', content: 'src', callId: 'old', name: 'read_file' },
		]);
		assert.strictEqual(repaired.remapped, 1);
		assert.strictEqual(repaired.messages[2]?.callId, 'new');
	});

	test('stale files cannot be edited until re-read; mistakes tilt recovery', () => {
		const tracker = new FileTracker();
		tracker.touch('src/a.ts', 'read');
		tracker.touch('src/a.ts', 'external');
		assert.strictEqual(tracker.isStale('src/a.ts'), true);
		const mistakes = new MistakeTracker();
		assert.strictEqual(mistakes.record(true).prefer, undefined);
		assert.strictEqual(mistakes.record(true).prefer, undefined);
		assert.strictEqual(mistakes.record(true).prefer, 'switch');
	});

	test('edits to different files are separate lanes; shell is exclusive', () => {
		const edit = tool('edit_file', 'edit', false);
		assert.deepStrictEqual(mutationLane({ id: '1', name: 'edit_file', args: { path: 'a.ts' } }, edit), { kind: 'path', path: 'a.ts' });
		assert.deepStrictEqual(mutationLane({ id: '2', name: 'shell', args: { command: 'ls' } }, tool('shell', 'execute', false)), { kind: 'exclusive' });
	});

	test('compaction cut never splits a tool call from its result', () => {
		const cut = balancedPrefix([
			{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: {} }] },
			{ role: 'tool', content: 'ok', callId: 'c1', name: 'read_file' },
			{ role: 'user', content: 'continue' },
		]);
		assert.strictEqual(cut, 2);
	});

	test('session title is log-only and skills stay name-only until loaded', () => {
		assert.strictEqual(titleFrom('/agent add a logout button to the header please'), 'add a logout button to the header please');
		const skills = new SkillCatalog();
		skills.register({ name: 'review', description: 'Review a diff', source: 'test', body: 'Always cite files.' });
		assert.ok(skills.promptBlock()?.includes('review:'));
		assert.ok(!skills.promptBlock()?.includes('Always cite'));
		assert.strictEqual(skills.load('review')?.body, 'Always cite files.');
	});

	test('a passed gate seals its upstream tasks against supersede', () => {
		const drafted = draftMission('m1', analyzeTask('add login and add tests', classifyIntent('add login and add tests', 'multitask', { hasWorkspace: true }), { hasWorkspace: true }));
		const withGate = applyPatch(drafted, {
			add: [{ id: 'G1', type: 'gate', body: 'prove it', targets: ['c0'], dependsOn: drafted.tasks.map(task => task.id) }],
		}, 'add gate');
		const passed = { ...withGate, tasks: withGate.tasks.map(task => task.id === 'G1' ? { ...task, status: 'passed' as const } : task.status === 'pending' && task.type === 'work' ? { ...task, status: 'passed' as const } : task) };
		assert.ok(sealedIds(passed.tasks).has('G1'));
		const patched = applyPatch(passed, { supersede: [{ old: 'G1', next: { id: 'G2', type: 'gate', body: 'rewrite history', targets: ['c0'], dependsOn: [] } }] }, 'illegal');
		assert.ok(patched.tasks.some(task => task.id === 'G1' && task.status === 'passed'));
		assert.ok(!patched.tasks.some(task => task.id === 'G2'));
	});

	test('inbox turn-target opens a new turn; step-target does not', () => {
		const box = new SteeringInbox();
		box.inject('nudge the model', { wake: true, target: 'step' });
		assert.strictEqual(box.claimBatch().opensTurn, false);
		box.inject('new instruction', { wake: true, target: 'turn', interrupt: true });
		assert.strictEqual(box.claimBatch().opensTurn, true);
	});

	test('model-visible tool results must appear in the durable log', () => {
		const store = new EventStore();
		store.append({ runId: 'r1', sessionId: 's1', timestamp: 1, event: { type: 'tool.end', callId: 'c1', result: 'ok' } });
		const ok = checkInvariants([
			{ role: 'tool', content: 'ok', callId: 'c1', name: 'read_file' },
		], store.all());
		assert.strictEqual(ok.ok, true);
		const missing = checkInvariants([
			{ role: 'tool', content: 'ok', callId: 'c2', name: 'read_file' },
		], store.all());
		assert.strictEqual(missing.ok, false);
	});
});

function tool(name: string, kind: IVoltTool['kind'], parallelSafe: boolean): IVoltTool {
	return {
		name,
		group: kind === 'edit' ? 'edit' : 'read',
		kind,
		description: name,
		schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
		parallelSafe,
		snippet: name,
		execute: async () => ({ callId: '', name, kind, text: 'ok' }),
	};
}
