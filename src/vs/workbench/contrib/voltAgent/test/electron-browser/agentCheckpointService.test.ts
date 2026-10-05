/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
// This suite drives the renderer service against the real git service on real repos, which only
// runs in node; the renderer test host has node integration.
/* eslint-disable local/code-import-patterns, local/code-layering */
import { spawnSync } from 'child_process';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { VoltGitService } from '../../../../../platform/voltGit/node/voltGitService.js';
/* eslint-enable local/code-import-patterns, local/code-layering */
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IVoltEvent, IVoltEventEnvelope } from '../../../../services/voltRuntime/common/events.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSession } from '../../../../services/voltRuntime/common/session.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IAgentBinaryBaseline, IAgentEditsService, IAgentPendingFile } from '../../browser/review/agentEditsService.js';
import { AgentCheckpointService } from '../../browser/review/agentCheckpointService.js';

interface IRecorded {
	readonly sessionId: string;
	readonly uri: URI;
	readonly before?: string;
	readonly binary?: IAgentBinaryBaseline;
	readonly renamedFrom?: URI;
	readonly agentText?: string;
}

/** Records what the checkpoint service offers for review. */
class RecordingEdits {
	readonly onDidResolve = Event.None;
	readonly recorded: IRecorded[] = [];
	getPendingFile(uri: URI): IAgentPendingFile | undefined {
		return this.recorded.some(entry => isEqual(entry.uri, uri)) ? { uri } as IAgentPendingFile : undefined;
	}
	recordBaseline(sessionId: string, uri: URI, before: string | undefined, options?: { agentText?: string; renamedFrom?: URI }): void {
		this.recorded.push({ sessionId, uri, before, renamedFrom: options?.renamedFrom, agentText: options?.agentText });
	}
	recordBinaryBaseline(sessionId: string, uri: URI, binary: IAgentBinaryBaseline | undefined, options?: { renamedFrom?: URI }): void {
		this.recorded.push({ sessionId, uri, binary, renamedFrom: options?.renamedFrom });
	}
	paths(root: string): string[] {
		return this.recorded.map(entry => entry.uri.fsPath.slice(root.length + 1)).sort();
	}
}

suite('AgentCheckpointService on real repos', function () {

	this.timeout(60_000);
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let repo: string;
	let store: DisposableStore;
	let git: VoltGitService;
	let events: Emitter<IVoltEventEnvelope>;
	let sessions: Map<string, IVoltSession>;
	let edits: RecordingEdits;
	let service: AgentCheckpointService;
	let seq = 0;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'volt-ckpt-svc-'));
		repo = join(root, 'repo');
		await mkdir(repo);
		sh(repo, 'init', '-q', '-b', 'main');
		sh(repo, 'config', 'user.email', 'test@volt.local');
		sh(repo, 'config', 'user.name', 'Volt Test');
		sh(repo, 'config', 'commit.gpgsign', 'false');
		await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
		await writeFile(join(repo, 'b.txt'), 'bee\n');
		await writeFile(join(repo, '.gitignore'), 'ignored/\n');
		sh(repo, 'add', '-A');
		sh(repo, 'commit', '-q', '-m', 'init');
		await writeFile(join(repo, 'notes.txt'), 'mine\n');
		store = disposables.add(new DisposableStore());
		git = store.add(new VoltGitService(async () => process.env, undefined, { shadowRoot: join(root, 'shadows') }));
		events = store.add(new Emitter<IVoltEventEnvelope>());
		sessions = new Map();
		edits = new RecordingEdits();
		service = create(repo);
	});

	teardown(async () => {
		for (const sessionId of sessions.keys()) {
			await service.whenIdle(sessionId);
		}
		store.dispose();
		await rm(root, { recursive: true, force: true });
	});

	function create(folder: string): AgentCheckpointService {
		const runtime = { onDidEmit: events.event, getOrCreateSession: session } as Partial<IAgentRuntimeService> as IAgentRuntimeService;
		const sessionContext = { rootFor: () => URI.file(folder) } as Partial<IVoltSessionContextService> as IVoltSessionContextService;
		const workspace = { getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService;
		const textFiles = { files: { onDidSave: Event.None } } as unknown as ITextFileService;
		return store.add(new AgentCheckpointService(runtime, git, edits as unknown as IAgentEditsService, sessionContext, workspace, textFiles, new NullLogService()));
	}

	function session(sessionId: string): IVoltSession {
		let found = sessions.get(sessionId);
		if (!found) {
			found = { sessionId, conversationId: sessionId, mode: 'agent', messages: [] } as unknown as IVoltSession;
			sessions.set(sessionId, found);
		}
		return found;
	}

	function emit(sessionId: string, runId: string, event: IVoltEvent): void {
		events.fire({ seq: ++seq, runId, sessionId, timestamp: Date.now(), event });
	}

	/** A user message, then the run starting, as the runtime does it. */
	async function startRun(sessionId: string, runId: string, uiTurn?: string): Promise<void> {
		if (uiTurn) {
			await service.beginTurn(sessionId, uiTurn);
		}
		session(sessionId).messages.push({ role: 'user', content: `prompt ${runId}` });
		emit(sessionId, runId, { type: 'run.start', runId, mode: 'agent' });
		await service.whenIdle(sessionId);
	}

	async function endRun(sessionId: string, runId: string): Promise<void> {
		emit(sessionId, runId, { type: 'run.end', runId, reason: 'done' });
		await timeout(0);
		await service.whenIdle(sessionId);
	}

	async function exists(path: string): Promise<boolean> {
		return stat(path).then(() => true, () => false);
	}

	test('captures shell side effects, restores them with everything else, and redo brings them back', async () => {
		await startRun('S', 'r1');
		// One shell call: edits a tracked file, rewrites an untracked one, creates, deletes, writes an
		// ignored cache and a binary.
		emit('S', 'r1', { type: 'tool.start', callId: 'c1', name: 'Shell', kind: 'execute' });
		await writeFile(join(repo, 'a.txt'), 'one\ntwo\nTHREE\nfour\nfive\nsix\n');
		await writeFile(join(repo, 'notes.txt'), 'sed rewrote this\n');
		await mkdir(join(repo, 'gen'));
		await writeFile(join(repo, 'gen', 'out.txt'), 'generated\n');
		await unlink(join(repo, 'b.txt'));
		await mkdir(join(repo, 'ignored'));
		await writeFile(join(repo, 'ignored', 'cache.txt'), 'cache\n');
		await writeFile(join(repo, 'logo.png'), Buffer.from([0x89, 0, 1, 2]));
		emit('S', 'r1', { type: 'tool.end', callId: 'c1', exitCode: 0 });
		await timeout(700);
		await service.whenIdle('S');

		assert.deepStrictEqual(edits.paths(repo), ['a.txt', 'b.txt', 'gen/out.txt', 'logo.png', 'notes.txt'], 'offered for review after the batch, ignored files left out');
		const byPath = new Map(edits.recorded.map(entry => [entry.uri.fsPath.slice(repo.length + 1), entry]));
		assert.strictEqual(byPath.get('notes.txt')?.before, 'mine\n', 'baseline from the pre-turn snapshot');
		assert.strictEqual(byPath.get('b.txt')?.before, 'bee\n');
		assert.strictEqual(byPath.get('gen/out.txt')?.before, undefined);
		assert.ok(byPath.get('logo.png') && !byPath.get('logo.png')!.binary, 'a new binary has no baseline bytes');
		await endRun('S', 'r1');

		const [checkpoint] = service.getCheckpoints('S');
		assert.deepStrictEqual([checkpoint.turnId, checkpoint.userTurn, checkpoint.running, !!checkpoint.after], ['r1', 0, false, true]);
		const preview = await service.previewRestore('S', 'r1');
		assert.deepStrictEqual(preview?.files.map(file => [file.path, file.action]).sort(), [
			['a.txt', 'write'], ['b.txt', 'create'], ['gen/out.txt', 'delete'], ['logo.png', 'delete'], ['notes.txt', 'write'],
		]);
		assert.strictEqual(await readFile(join(repo, 'notes.txt'), 'utf8'), 'sed rewrote this\n', 'preview writes nothing');

		const result = await service.restoreCheckpoint('S', 'r1');
		assert.strictEqual(result?.applied, true);
		assert.strictEqual(await readFile(join(repo, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
		assert.strictEqual(await readFile(join(repo, 'notes.txt'), 'utf8'), 'mine\n', 'shell side effect reverted');
		assert.strictEqual(await readFile(join(repo, 'b.txt'), 'utf8'), 'bee\n');
		assert.strictEqual(await exists(join(repo, 'gen')), false);
		assert.strictEqual(await exists(join(repo, 'logo.png')), false);
		assert.strictEqual(await readFile(join(repo, 'ignored', 'cache.txt'), 'utf8'), 'cache\n', 'ignored files untouched');
		assert.strictEqual(sh(repo, 'status', '--porcelain', '--untracked-files=no').trim(), '', 'tracked files back to HEAD, user index untouched');
		assert.strictEqual(service.canRedo('S'), true);

		const redo = await service.redo('S');
		assert.strictEqual(redo?.applied, true);
		assert.strictEqual(await readFile(join(repo, 'notes.txt'), 'utf8'), 'sed rewrote this\n');
		assert.strictEqual(await readFile(join(repo, 'gen', 'out.txt'), 'utf8'), 'generated\n');
		assert.strictEqual(await exists(join(repo, 'b.txt')), false);
		assert.strictEqual(service.canRedo('S'), false);
	});

	test('turn ids from beginTurn, restore by message index, and another chat\'s work survives', async () => {
		await startRun('A', 'ra1', 'ui-1');
		await writeFile(join(repo, 'x.txt'), 'chat A\n');
		await endRun('A', 'ra1');
		await startRun('B', 'rb1');
		await writeFile(join(repo, 'y.txt'), 'chat B\n');
		await endRun('B', 'rb1');
		await startRun('A', 'ra2', 'ui-2');
		await writeFile(join(repo, 'x.txt'), 'chat A again\n');
		await endRun('A', 'ra2');

		assert.deepStrictEqual(service.getCheckpoints('A').map(c => [c.turnId, c.userTurn]), [['ui-1', 0], ['ui-2', 1]]);
		// Before turn 2 of chat A: x.txt as turn 1 left it.
		await service.restoreCheckpoint('A', 1);
		assert.strictEqual(await readFile(join(repo, 'x.txt'), 'utf8'), 'chat A\n');
		await service.restoreCheckpoint('A', 'ui-1');
		assert.strictEqual(await exists(join(repo, 'x.txt')), false);
		assert.strictEqual(await readFile(join(repo, 'y.txt'), 'utf8'), 'chat B\n', 'chat B\'s file is not chat A\'s to restore');
	});

	test('edits made after the agent: merged when apart, a conflict (left alone) when they overlap', async () => {
		await startRun('S', 'r1');
		await writeFile(join(repo, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\n');
		await writeFile(join(repo, 'b.txt'), 'bee (agent)\n');
		await endRun('S', 'r1');
		await writeFile(join(repo, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix (mine)\n');
		await writeFile(join(repo, 'b.txt'), 'bee (agent and mine)\n');

		const preview = await service.previewRestore('S', 0);
		const byPath = new Map(preview!.files.map(file => [file.path, file]));
		assert.deepStrictEqual([byPath.get('a.txt')?.outcome, byPath.get('a.txt')?.editedSince], ['merged', true]);
		assert.deepStrictEqual(preview!.conflicts.map(file => file.path), ['b.txt']);

		const result = await service.restoreCheckpoint('S', 0);
		assert.strictEqual(result?.conflicts.length, 1);
		assert.strictEqual(await readFile(join(repo, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nfour\nfive\nsix (mine)\n');
		assert.strictEqual(await readFile(join(repo, 'b.txt'), 'utf8'), 'bee (agent and mine)\n');
		await service.restoreCheckpoint('S', 0, { overwrite: true });
		assert.strictEqual(await readFile(join(repo, 'b.txt'), 'utf8'), 'bee\n');
	});

	test('restoreFile backs Discard: only files this chat changed', async () => {
		await startRun('S', 'r1');
		await writeFile(join(repo, 'a.txt'), 'agent\n');
		await endRun('S', 'r1');
		await writeFile(join(repo, 'b.txt'), 'the user, between turns\n');
		assert.strictEqual(await service.restoreFile('S', URI.file(join(repo, 'b.txt'))), 'unavailable', 'never touched by the agent');
		assert.strictEqual(await readFile(join(repo, 'b.txt'), 'utf8'), 'the user, between turns\n');
		assert.strictEqual(await service.restoreFile('S', URI.file(join(repo, 'a.txt'))), 'restored');
		assert.strictEqual(await readFile(join(repo, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
	});

	test('checkpoints load back from refs, and editing an earlier message drops the abandoned turns', async () => {
		await startRun('S', 'r1', 'ui-1');
		await writeFile(join(repo, 'a.txt'), 'turn 1\n');
		await endRun('S', 'r1');
		await startRun('S', 'r2', 'ui-2');
		await writeFile(join(repo, 'a.txt'), 'turn 2\n');
		await endRun('S', 'r2');

		const reloaded = create(repo);
		assert.deepStrictEqual((await reloaded.loadCheckpoints('S')).map(c => [c.turnId, c.userTurn, !!c.after]), [['ui-1', 0, true], ['ui-2', 1, true]]);
		await reloaded.restoreCheckpoint('S', 'ui-2');
		assert.strictEqual(await readFile(join(repo, 'a.txt'), 'utf8'), 'turn 1\n');
		assert.strictEqual(reloaded.canRedo('S'), true);

		// The user edits message 2 and resends: the old turn 2 is history that no longer exists.
		sessions.get('S')!.messages.splice(1);
		service = reloaded;
		await startRun('S', 'r2b', 'ui-2b');
		await endRun('S', 'r2b');
		assert.deepStrictEqual(service.getCheckpoints('S').map(c => c.turnId), ['ui-1', 'ui-2b']);
		assert.strictEqual((await git.listRefs({ repoRoot: repo, prefix: 'refs/volt/s/S/0001-ui-2/' })).length, 0);
	});

	test('folders outside git get checkpoints through a private repo', async () => {
		const plain = join(root, 'plain');
		await mkdir(plain);
		await writeFile(join(plain, 'notes.md'), 'v1\n');
		service = create(plain);
		await startRun('P', 'p1');
		await writeFile(join(plain, 'notes.md'), 'v2\n');
		await writeFile(join(plain, 'new.md'), 'new\n');
		await endRun('P', 'p1');
		await service.restoreCheckpoint('P', 'p1');
		assert.strictEqual(await readFile(join(plain, 'notes.md'), 'utf8'), 'v1\n');
		assert.strictEqual(await exists(join(plain, 'new.md')), false);
		assert.strictEqual(await exists(join(plain, '.git')), false);
	});

	test('refuses to restore while the agent runs', async () => {
		await startRun('S', 'r1');
		sessions.get('S')!.activeRun = { runId: 'r1', sessionId: 'S', status: 'running', startedAt: Date.now() } as IVoltSession['activeRun'];
		await assert.rejects(() => service.restoreCheckpoint('S', 'r1'), /Stop the agent/);
		sessions.get('S')!.activeRun = undefined;
		await endRun('S', 'r1');
	});
});

function sh(cwd: string, ...args: string[]): string {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	}
	return result.stdout;
}
