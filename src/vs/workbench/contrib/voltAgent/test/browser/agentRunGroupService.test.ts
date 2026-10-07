/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IVoltExecRequest, IVoltExecResult, IVoltJobOutput } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { AgentOrchestratorService } from '../../../../services/voltRuntime/browser/orchestration/agentOrchestratorService.js';
import { IVoltEvent, IVoltEventEnvelope } from '../../../../services/voltRuntime/common/events.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { AgentWorktreeTarget, IGitRunResult } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { IOrchStartTurnRequest, IOrchTurnHost } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IRunGroupModel } from '../../../../services/voltRuntime/common/runGroups/runGroups.js';
import { IVoltSendRequest } from '../../../../services/voltRuntime/common/session.js';
import { AgentRunGroupService } from '../../browser/runGroups/agentRunGroupService.js';

const CLAUDE: IRunGroupModel = { ref: 'agent:claude:sonnet', label: 'Claude Sonnet 4.5', family: 'claude' };
const CODEX: IRunGroupModel = { ref: 'agent:codex:gpt', label: 'GPT-5 Codex', family: 'codex' };
const CURSOR: IRunGroupModel = { ref: 'agent:cursor:grok', label: 'Grok Fast', family: 'cursor' };

/** Runs nothing: records sends, and the test ends runs. */
class FakeRuntime {
	private readonly emitter = new Emitter<IVoltEventEnvelope>();
	readonly onDidEmit = this.emitter.event;
	private seq = 0;
	private runs = 0;
	readonly sends: { threadId: string; request: IVoltSendRequest; runId: string }[] = [];
	readonly cancelled: string[] = [];
	readonly worktrees = new Map<string, string>();

	listCatalog() {
		return [CLAUDE, CODEX, CURSOR].map(model => ({ ref: model.ref, kind: 'agent', providerId: model.family, profileId: 'p', id: model.ref, label: model.label, enabled: true }));
	}
	canSteer() { return false; }
	getModelOptions() { return {}; }
	rememberWorktree(threadId: string, path: string) { this.worktrees.set(threadId, path); }
	getOrCreateSession() { return { providerRef: undefined, messages: [] }; }
	async send(threadId: string, request: IVoltSendRequest): Promise<string> {
		const runId = `run${++this.runs}`;
		this.sends.push({ threadId, request, runId });
		this.emit(threadId, runId, { type: 'run.start', runId, mode: request.mode });
		return runId;
	}
	async cancel(threadId: string) {
		this.cancelled.push(threadId);
		const last = [...this.sends].reverse().find(send => send.threadId === threadId);
		if (last) {
			this.emit(threadId, last.runId, { type: 'run.end', runId: last.runId, reason: 'abort' });
		}
	}
	emit(threadId: string, runId: string, event: IVoltEvent): void {
		this.emitter.fire({ seq: ++this.seq, runId, sessionId: threadId, timestamp: Date.now(), event });
	}
	finish(threadId: string): void {
		const last = [...this.sends].reverse().find(send => send.threadId === threadId);
		assert.ok(last, `no run in ${threadId}`);
		this.emit(threadId, last.runId, { type: 'run.end', runId: last.runId, reason: 'done' });
	}
	dispose() {
		this.emitter.dispose();
	}
}

class FakeHost implements IOrchTurnHost {
	constructor(private readonly runtime: FakeRuntime) { }
	async startTurn(request: IOrchStartTurnRequest): Promise<string | undefined> {
		return request.isCurrent() ? this.runtime.send(request.threadId, { text: request.turn.prompt.text, mode: 'agent', ...(request.turn.prompt.modelRef ? { providerRef: request.turn.prompt.modelRef } : {}) }) : undefined;
	}
}

/** Git as the service sees it: worktree creation, a runner with scripted answers, refs. */
class FakeWorktrees {
	readonly created: { repoRoot: string; target?: AgentWorktreeTarget }[] = [];
	readonly removed: { path: string; branch: string; options: unknown }[] = [];
	readonly commands: { cwd: string; args: readonly string[] }[] = [];
	failCreate = new Set<string>();
	answers: ((cwd: string, args: readonly string[]) => IGitRunResult | undefined)[] = [];

	async create(repoRoot: string, target?: AgentWorktreeTarget) {
		this.created.push({ repoRoot, target });
		const name = target && target.kind === 'new' ? target.name : 'volt/x';
		if (this.failCreate.has(name)) {
			throw new Error(`fatal: could not create ${name}`);
		}
		return { path: `/wt/${name.replace(/\//g, '-')}`, branch: name, commit: 'base1' };
	}
	async ensure() { return false; }
	async remove(_repoRoot: string, path: string, branch: string, options: unknown) {
		this.removed.push({ path, branch, options });
		return 'removed' as const;
	}
	serialize<T>(_repoRoot: string, work: () => Promise<T>): Promise<T> { return work(); }
	async git(cwd: string, args: readonly string[]): Promise<IGitRunResult> {
		this.commands.push({ cwd, args });
		for (const answer of this.answers) {
			const result = answer(cwd, args);
			if (result) {
				return result;
			}
		}
		if (args[0] === 'rev-parse') {
			return { exitCode: 0, stdout: cwd === '/repo' ? 'base1\n' : 'head2\n', stderr: '' };
		}
		if (args[0] === 'worktree' && args[1] === 'list') {
			return { exitCode: 0, stdout: 'worktree /repo\nHEAD base1\nbranch refs/heads/main\n', stderr: '' };
		}
		return { exitCode: 0, stdout: '', stderr: '' };
	}
	ran(prefix: string): { cwd: string; args: readonly string[] }[] {
		return this.commands.filter(command => command.args.join(' ').startsWith(prefix));
	}
}

/** Setup commands: each exec resolves with the scripted exit code; `hold` keeps it running. */
class FakeStdio {
	readonly execs: IVoltExecRequest[] = [];
	readonly cancelled: string[] = [];
	exitCode = 0;
	hold = false;
	private readonly running = new Set<string>();

	async exec(request: IVoltExecRequest): Promise<IVoltExecResult> {
		this.execs.push(request);
		const running = this.hold;
		if (running) {
			this.running.add(request.id);
		}
		const output = `::volt-setup-step 0\ninstalling\n${running ? '' : '::volt-setup-step 1\nbuilt\n'}`;
		return { id: request.id, exitCode: running ? null : this.exitCode, stdout: output, stderr: '', combined: output, truncated: false, durationMs: 1, timedOut: false, cancelled: false, running };
	}
	async jobOutput(id: string): Promise<IVoltJobOutput> {
		return { id, command: '', output: '::volt-setup-step 0\ninstalling\n', offset: 10, running: this.running.has(id), exitCode: null };
	}
	async jobWait(id: string): Promise<IVoltJobOutput | undefined> {
		await new Promise(resolve => setTimeout(resolve, 5));
		return { id, command: '', output: '', offset: 10, running: this.running.has(id), exitCode: this.running.has(id) ? null : this.exitCode };
	}
	async cancelExec(id: string): Promise<void> {
		this.cancelled.push(id);
		this.running.delete(id);
	}
}

suite('Run group service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(options: { setupFile?: string } = {}) {
		const disposables = store.add(new DisposableStore());
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		if (options.setupFile) {
			await fileService.writeFile(URI.file('/repo/.cursor/worktrees.json'), VSBuffer.fromString(options.setupFile));
		}
		const runtime = new FakeRuntime();
		disposables.add(toDisposable(() => runtime.dispose()));
		const stub = <T>(value: object) => value as unknown as T;
		const archived: string[] = [];
		const history = stub<IAgentHistoryService>({
			whenReady: Promise.resolve(),
			get: (id: string) => ({ id }),
			has: () => true,
			sessionParent: () => undefined,
			open: () => ({ setMeta: () => undefined, load: async () => ({ turns: [{ assistant: { text: 'Added a dark mode toggle.' } }] }) }),
			setArchived: async (id: string) => { archived.push(id); },
		});
		const orchestrator = disposables.add(new AgentOrchestratorService(
			stub(runtime),
			fileService,
			stub({ userRoamingDataHome: URI.file('/user') }),
			new NullLogService(),
			history,
			stub({ registerToolProvider: () => toDisposable(() => undefined) }),
			stub({ create: async () => ({ path: '/wt/a', branch: 'volt/a' }), ensure: async () => false }),
			stub({ rootFor: () => URI.file('/repo') }),
		));
		await orchestrator.whenReady;
		disposables.add(orchestrator.setTurnHost(new FakeHost(runtime)));
		const worktrees = new FakeWorktrees();
		const stdio = new FakeStdio();
		const commands: { id: string; args: unknown[] }[] = [];
		const snapshotCalls: { workTree: string; reuse: unknown }[] = [];
		/** One growing tree id per worktree, so "nothing changed" is a real, checkable condition. */
		const trees = new Map<string, string>();
		const git = {
			listBranches: async () => ({ head: 'main', local: ['main', 'volt/add-dark-mode-gpt-5-codex'], remote: [], tags: [], refs: [] }),
			snapshot: async (request: { workTree: string; reuse?: { commit: string; tree: string } }) => {
				snapshotCalls.push({ workTree: request.workTree, reuse: request.reuse });
				const tree = trees.get(request.workTree) ?? 't';
				if (request.reuse?.tree === tree) {
					return { commit: request.reuse.commit, tree };
				}
				return { commit: tree === 't' ? `snap:${request.workTree}` : `snap:${request.workTree}:${tree}`, tree };
			},
			diffSummary: async (request: { to: string }) => request.to.includes('codex')
				? [{ path: 'a.ts', kind: 'modified', binary: false, additions: 10, deletions: 2 }, { path: 'b.ts', kind: 'added', binary: false, additions: 5, deletions: 0 }]
				: [{ path: 'a.ts', kind: 'modified', binary: false, additions: 3, deletions: 1 }],
			deleteRefs: async () => undefined,
		};
		const create = () => disposables.add(new AgentRunGroupService(
			orchestrator,
			stub(worktrees),
			stub(git),
			stub(stdio),
			history,
			stub(runtime),
			stub({ projects: [], getProject: () => undefined }),
			stub({}),
			fileService,
			stub({ userRoamingDataHome: URI.file('/user') }),
			stub({ executeCommand: async (id: string, ...args: unknown[]) => { commands.push({ id, args }); } }),
			stub({ invokeFunction: (fn: (accessor: unknown) => unknown) => fn({ getIfExists: () => undefined }) }),
			new NullLogService(),
		));
		const service = create();
		await service.whenReady;
		const settle = async () => {
			for (let i = 0; i < 20; i++) {
				await timeout(1);
			}
		};
		return { service, create, orchestrator, runtime, worktrees, stdio, archived, commands, settle, fileService, snapshotCalls, trees };
	}

	test('creating a group makes a chat, a worktree and a branch per model, all from the same base', async () => {
		const { service, orchestrator, runtime, worktrees, settle } = await setup();
		const group = await service.start({ prompt: { text: 'Add dark mode', mode: 'Agent' }, models: [CLAUDE, CODEX, CURSOR], repoRoot: '/repo' });
		await settle();

		assert.strictEqual(group.runs.length, 3);
		assert.deepStrictEqual(group.base, { ref: 'main', commit: 'base1' });
		// The codex name was taken, so it got a number.
		assert.deepStrictEqual(group.runs.map(run => run.branch), ['volt/add-dark-mode-claude-sonnet-4-5', 'volt/add-dark-mode-gpt-5-codex-2', 'volt/add-dark-mode-grok-fast']);
		assert.deepStrictEqual(worktrees.created.map(entry => entry.target), group.runs.map(run => ({ kind: 'new', name: run.branch, from: 'base1' })));
		// Every run went through the orchestrator with its own model; all three are running at once.
		assert.deepStrictEqual(runtime.sends.map(send => [send.threadId, send.request.providerRef, send.request.text]).sort(), group.runs.map(run => [run.id, run.model.ref, 'Add dark mode']).sort());
		for (const run of group.runs) {
			assert.strictEqual(runtime.worktrees.get(run.id), `/wt/${run.branch.replace(/\//g, '-')}`);
			assert.strictEqual(orchestrator.getThread(run.id)?.active?.phase, 'running');
			assert.strictEqual(service.runStatus(group.id, run.id), 'working');
			assert.strictEqual(service.groupOf(run.id)?.id, group.id);
		}
		assert.strictEqual(service.rollup(group.id).status, 'running');
		assert.ok(worktrees.ran('config branch.volt/add-dark-mode-claude-sonnet-4-5.volt-base main').length);

		runtime.finish(group.runs[0].id);
		runtime.finish(group.runs[1].id);
		runtime.finish(group.runs[2].id);
		await settle();
		assert.strictEqual(service.rollup(group.id).status, 'done');
	});

	test('time spent waiting on the user is not work time', async () => {
		const { service, orchestrator, settle } = await setup();
		const group = await service.start({ prompt: { text: 'Add dark mode' }, models: [CLAUDE, CODEX], repoRoot: '/repo' });
		await settle();
		const runId = group.runs[0].id;
		assert.notStrictEqual(service.get(group.id)!.runs[0].activeSince, undefined, 'the clock runs while the agent works');
		await orchestrator.dispatch({ type: 'input.opened', threadId: runId, inputId: 'perm-1', kind: 'approval' });
		await settle();
		assert.strictEqual(service.runStatus(group.id, runId), 'needsInput');
		assert.strictEqual(service.get(group.id)!.runs[0].activeSince, undefined, 'the clock stops at an approval');
		await orchestrator.dispatch({ type: 'input.closed', threadId: runId, inputId: 'perm-1' });
		await settle();
		assert.notStrictEqual(service.get(group.id)!.runs[0].activeSince, undefined, 'and runs again once answered');
	});

	test('refuses fewer than two models', async () => {
		const { service } = await setup();
		await assert.rejects(service.start({ prompt: { text: 'x' }, models: [CLAUDE], repoRoot: '/repo' }), /at least 2/);
	});

	test('a failed worktree fails only its run; Retry starts it', async () => {
		const { service, runtime, worktrees, settle } = await setup();
		worktrees.failCreate.add('volt/fix-login-gpt-5-codex');
		const group = await service.start({ prompt: { text: 'Fix login' }, models: [CLAUDE, CODEX], repoRoot: '/repo' });
		await settle();
		const [claude, codex] = group.runs;
		assert.strictEqual(service.runStatus(group.id, claude.id), 'working');
		assert.strictEqual(service.runStatus(group.id, codex.id), 'setupFailed');
		assert.match(service.get(group.id)!.runs[1].setup.error ?? '', /could not create/);
		assert.deepStrictEqual(runtime.sends.map(send => send.threadId), [claude.id]);

		worktrees.failCreate.clear();
		await service.retrySetup(group.id, codex.id);
		await settle();
		assert.strictEqual(service.runStatus(group.id, codex.id), 'working');
		assert.deepStrictEqual(runtime.sends.map(send => send.threadId), [claude.id, codex.id]);
	});

	test('setup steps run in the worktree with the checkout as ROOT_WORKTREE_PATH; a failing setup holds its run', async () => {
		const { service, runtime, stdio, settle } = await setup({ setupFile: JSON.stringify({ 'setup-worktree': ['npm ci', 'npm run build'] }) });
		stdio.exitCode = 2;
		const group = await service.start({ prompt: { text: 'Add search' }, models: [CLAUDE, CODEX], repoRoot: '/repo' });
		await settle();
		assert.strictEqual(stdio.execs.length, 2);
		assert.strictEqual(stdio.execs[0].env?.ROOT_WORKTREE_PATH, '/repo');
		assert.match(stdio.execs[0].command, /npm ci/);
		assert.ok(stdio.execs.every(exec => exec.cwd?.startsWith('/wt/')));
		const run = service.get(group.id)!.runs[0];
		assert.strictEqual(run.setup.state, 'failed');
		assert.strictEqual(run.setup.source, '.cursor/worktrees.json');
		assert.deepStrictEqual(run.setup.steps.map(step => step.state), ['done', 'failed']);
		assert.match(run.setup.error ?? '', /npm run build/);
		assert.strictEqual(runtime.sends.length, 0, 'no run starts before its setup passes');

		stdio.exitCode = 0;
		await service.retrySetup(group.id, run.id);
		await settle();
		assert.match(stdio.execs[2].command, /npm run build/);
		assert.doesNotMatch(stdio.execs[2].command, /npm ci/, 'the retry resumes at the failed step');
		assert.strictEqual(service.runStatus(group.id, run.id), 'working');
	});

	test('stopping the group stops every run: live turns are cancelled, setups aborted', async () => {
		const { service, runtime, stdio, settle } = await setup({ setupFile: JSON.stringify({ 'setup-worktree': ['npm ci'] }) });
		const group = await service.start({ prompt: { text: 'Add search' }, models: [CLAUDE, CODEX], repoRoot: '/repo' });
		await settle();
		const [claude, codex] = group.runs;
		assert.strictEqual(service.runStatus(group.id, claude.id), 'working');
		// The second run's setup is still going when the user stops the group.
		stdio.hold = true;
		await service.stop(group.id);
		await settle();
		assert.deepStrictEqual(runtime.cancelled, [claude.id, codex.id]);
		assert.strictEqual(service.runStatus(group.id, claude.id), 'stopped');
		assert.strictEqual(service.rollup(group.id).live, 0);

		const held = await service.start({ prompt: { text: 'Add filters' }, models: [CLAUDE, CODEX], repoRoot: '/repo' });
		await settle();
		assert.strictEqual(service.runStatus(held.id, held.runs[0].id), 'setup');
		await service.stop(held.id);
		await settle();
		assert.strictEqual(new Set(stdio.cancelled).size, 2, 'both setup jobs were killed');
		assert.deepStrictEqual(held.runs.map(run => service.runStatus(held.id, run.id)), ['setupFailed', 'setupFailed']);
		assert.strictEqual(service.get(held.id)!.runs[0].setup.state, 'cancelled');
		assert.ok(!runtime.sends.some(send => held.runs.some(run => run.id === send.threadId)), 'stopped setups never start their run');
	});

	test('follow-ups go to the selected run or to all of them, each on its own model', async () => {
		const { service, runtime, settle } = await setup();
		const group = await service.start({ prompt: { text: 'Add dark mode' }, models: [CLAUDE, CODEX], repoRoot: '/repo' });
		await settle();
		group.runs.forEach(run => runtime.finish(run.id));
		await settle();
		await service.followUp(group.id, group.runs[1].id, { text: 'Also add tests' });
		await settle();
		assert.deepStrictEqual(runtime.sends.slice(2).map(send => [send.threadId, send.request.providerRef]), [[group.runs[1].id, CODEX.ref]]);
		runtime.finish(group.runs[1].id);
		await settle();
		await service.followUp(group.id, 'all', { text: 'Run the linter' });
		await settle();
		assert.deepStrictEqual(runtime.sends.slice(3).map(send => send.threadId).sort(), group.runs.map(run => run.id).sort());
	});

	test('stats: files and lines against the base, tokens and reported cost, the last message', async () => {
		const { service, runtime, settle } = await setup();
		const group = await service.start({ prompt: { text: 'Add dark mode' }, models: [CLAUDE, CODEX], repoRoot: '/repo' });
		await settle();
		const [claude, codex] = group.runs;
		runtime.emit(claude.id, 'r', { type: 'usage', input: 100, output: 50, cache: 1000 });
		runtime.emit(claude.id, 'r', { type: 'usage', input: 0, output: 0, used: 1150, costUsd: 0.04 });
		await service.refreshStats(group.id);
		const runs = service.get(group.id)!.runs;
		assert.deepStrictEqual({ files: runs[0].stats?.files, additions: runs[0].stats?.additions, deletions: runs[0].stats?.deletions }, { files: 1, additions: 3, deletions: 1 });
		assert.deepStrictEqual({ files: runs[1].stats?.files, additions: runs[1].stats?.additions, deletions: runs[1].stats?.deletions }, { files: 2, additions: 15, deletions: 2 });
		assert.strictEqual(runs[0].stats?.lastMessage, 'Added a dark mode toggle.');
		assert.strictEqual(runs[0].usage.tokens, 1150);
		assert.strictEqual(runs[0].usage.costUsd, 0.04);
		const diff = await service.diffTarget(group.id, claude.id, codex.id);
		assert.deepStrictEqual([diff.from, diff.to], [`snap:${claude.worktreePath ?? '/wt/volt-add-dark-mode-claude-sonnet-4-5'}`, `snap:/wt/volt-add-dark-mode-gpt-5-codex-2`]);
		const vsBase = await service.diffTarget(group.id, 'base', codex.id);
		assert.strictEqual(vsBase.from, 'base1');
	});

	test('a tool finishing on one run refreshes only that run, not its idle siblings', async function () {
		this.timeout(8000);
		const { service, runtime, settle, snapshotCalls } = await setup();
		const group = await service.start({ prompt: { text: 'Add dark mode' }, models: [CLAUDE, CODEX], repoRoot: '/repo' });
		await settle();
		await service.refreshStats(group.id);
		const [claude, codex] = service.get(group.id)!.runs;
		snapshotCalls.length = 0;

		runtime.emit(claude.id, 'r', { type: 'tool.end', callId: 't1', result: 'ok' });
		await timeout(1600); // past the stats-refresh debounce
		assert.deepStrictEqual(snapshotCalls.map(call => call.workTree), [claude.worktreePath], 'only the run whose tool ended was re-snapshotted');

		snapshotCalls.length = 0;
		runtime.emit(codex.id, 'r', { type: 'run.end', runId: 'r', reason: 'done' });
		await timeout(1600);
		assert.deepStrictEqual(snapshotCalls.map(call => call.workTree), [codex.worktreePath]);
	});

	test('an unchanged worktree reuses its last snapshot instead of writing a new commit', async function () {
		this.timeout(8000);
		const { service, runtime, settle, snapshotCalls, trees } = await setup();
		const group = await service.start({ prompt: { text: 'Add dark mode' }, models: [CLAUDE, CODEX], repoRoot: '/repo' });
		await settle();
		await service.refreshStats(group.id);
		const claude = service.get(group.id)!.runs[0];
		const firstCommit = service.get(group.id)!.runs[0].stats?.snapshot;

		snapshotCalls.length = 0;
		runtime.emit(claude.id, 'r', { type: 'tool.end', callId: 't1', result: 'ok' });
		await timeout(1600);
		assert.strictEqual(snapshotCalls.length, 1);
		assert.deepStrictEqual(snapshotCalls[0].reuse, { commit: firstCommit, tree: 't' }, 'the unchanged run is snapshotted with its last commit and tree as a reuse hint');
		assert.strictEqual(service.get(group.id)!.runs[0].stats?.snapshot, firstCommit, 'the commit did not change');

		trees.set(claude.worktreePath!, 't2');
		runtime.emit(claude.id, 'r', { type: 'tool.end', callId: 't2', result: 'ok' });
		await timeout(1600);
		assert.notStrictEqual(service.get(group.id)!.runs[0].stats?.snapshot, firstCommit, 'a real change gets a new snapshot');
	});

	test('picking a winner merges it where the base is checked out, archives the others and removes their worktrees', async () => {
		const { service, runtime, worktrees, archived, settle } = await setup();
		const group = await service.start({ prompt: { text: 'Add dark mode' }, models: [CLAUDE, CODEX, CURSOR], repoRoot: '/repo' });
		await settle();
		worktrees.answers.push((cwd, args) => args[0] === 'status' && cwd.includes('codex') ? { exitCode: 0, stdout: ' M a.ts\n', stderr: '' } : undefined);

		const early = await service.pickWinner(group.id, group.runs[1].id, 'merge', { removeOthers: true });
		assert.match(early.error ?? '', /still working/);

		group.runs.forEach(run => runtime.finish(run.id));
		await settle();
		const result = await service.pickWinner(group.id, group.runs[1].id, 'merge', { removeOthers: true });
		assert.deepStrictEqual(result, { ok: true });
		const codexPath = '/wt/volt-add-dark-mode-gpt-5-codex-2';
		assert.deepStrictEqual(worktrees.ran('add -A').map(command => command.cwd), [codexPath]);
		assert.deepStrictEqual(worktrees.ran('commit -m').map(command => command.args), [['commit', '-m', 'Add dark mode (GPT-5 Codex)']]);
		assert.deepStrictEqual(worktrees.ran('merge --no-ff').map(command => [command.cwd, command.args.at(-1)]), [['/repo', 'volt/add-dark-mode-gpt-5-codex-2']]);
		assert.deepStrictEqual(archived.sort(), [group.runs[0].id, group.runs[2].id].sort());
		assert.deepStrictEqual(worktrees.removed.map(entry => [entry.branch, entry.options]), [
			['volt/add-dark-mode-claude-sonnet-4-5', { deleteBranch: true, force: true, ownsBranch: true }],
			['volt/add-dark-mode-grok-fast', { deleteBranch: true, force: true, ownsBranch: true }],
		]);
		const after = service.get(group.id)!;
		assert.strictEqual(after.winner?.runId, group.runs[1].id);
		assert.strictEqual(after.winner?.commit, 'head2');
		assert.deepStrictEqual(after.runs.map(run => [!!run.discarded, !!run.worktreeRemoved]), [[true, true], [false, false], [true, true]]);
		assert.match((await service.pickWinner(group.id, group.runs[0].id, 'merge', { removeOthers: false })).error ?? '', /already picked/);
	});

	test('a merge conflict is undone and reported with its files', async () => {
		const { service, runtime, worktrees, settle } = await setup();
		const group = await service.start({ prompt: { text: 'Add dark mode' }, models: [CLAUDE, CODEX], repoRoot: '/repo' });
		await settle();
		group.runs.forEach(run => runtime.finish(run.id));
		await settle();
		worktrees.answers.push((_cwd, args) => args[0] === 'merge' && args[1] === '--no-ff' ? { exitCode: 1, stdout: 'CONFLICT', stderr: '' } : undefined);
		worktrees.answers.push((_cwd, args) => args[0] === 'diff' && args.includes('--diff-filter=U') ? { exitCode: 0, stdout: 'web/app.js\nweb/style.css\n', stderr: '' } : undefined);
		const result = await service.pickWinner(group.id, group.runs[0].id, 'merge', { removeOthers: true });
		assert.strictEqual(result.ok, false);
		assert.match(result.error ?? '', /conflicts in web\/app.js, web\/style.css/);
		assert.strictEqual(worktrees.ran('merge --abort').length, 1);
		assert.strictEqual(service.get(group.id)!.winner, undefined, 'nothing was picked');
		assert.strictEqual(worktrees.removed.length, 0);
	});

	test('checkout frees the branch from its worktree; PR goes through the pull request flow', async () => {
		const { service, runtime, worktrees, commands, settle } = await setup();
		const first = await service.start({ prompt: { text: 'Add dark mode' }, models: [CLAUDE, CODEX], repoRoot: '/repo' });
		const second = await service.start({ prompt: { text: 'Add search' }, models: [CLAUDE, CODEX], repoRoot: '/repo' });
		await settle();
		[...first.runs, ...second.runs].forEach(run => runtime.finish(run.id));
		await settle();
		assert.ok((await service.pickWinner(first.id, first.runs[0].id, 'checkout', { removeOthers: false })).ok);
		assert.deepStrictEqual(worktrees.ran('checkout').map(command => [command.cwd, command.args.join(' ')]), [
			['/wt/volt-add-dark-mode-claude-sonnet-4-5', 'checkout --detach'],
			['/repo', 'checkout volt/add-dark-mode-claude-sonnet-4-5'],
		]);
		assert.strictEqual(worktrees.removed.length, 0);
		assert.ok((await service.pickWinner(second.id, second.runs[1].id, 'pr', { removeOthers: false })).ok);
		assert.deepStrictEqual(commands, [{ id: 'volt.pullRequest.create', args: [second.runs[1].id] }]);
	});

	test('groups survive a restart; a setup cut short can be retried', async () => {
		const { service, create, stdio, runtime, settle, fileService } = await setup({ setupFile: JSON.stringify({ 'setup-worktree': ['npm ci'] }) });
		stdio.hold = true;
		const group = await service.start({ prompt: { text: 'Add search' }, models: [CLAUDE, CODEX], repoRoot: '/repo' });
		await settle();
		await timeout(900);
		const stored = JSON.parse((await fileService.readFile(URI.file('/user/voltRunGroups/groups.json'))).value.toString());
		assert.strictEqual(stored.groups[0].id, group.id);
		assert.strictEqual(stored.groups[0].runs[0].setup.state, 'running');
		service.dispose();

		const restarted = create();
		await restarted.whenReady;
		const restored = restarted.get(group.id)!;
		assert.deepStrictEqual(restored.runs.map(run => run.setup.state), ['cancelled', 'cancelled']);
		assert.strictEqual(restarted.groupOf(group.runs[1].id)?.id, group.id);
		stdio.hold = false;
		await restarted.retrySetup(group.id, group.runs[0].id);
		await settle();
		assert.strictEqual(restarted.runStatus(group.id, group.runs[0].id), 'working');
		assert.deepStrictEqual(runtime.sends.map(send => send.threadId), [group.runs[0].id]);
	});
});
