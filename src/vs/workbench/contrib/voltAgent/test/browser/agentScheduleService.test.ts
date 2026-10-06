/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IVoltHostToolProvider } from '../../../../services/voltRuntime/common/hostTools.js';
import { IOrchPrompt, IOrchSubmitResult } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentSchedule } from '../../../../services/voltRuntime/common/schedules/agentSchedules.js';
import { IVoltProjectRecord } from '../../../../services/voltRuntime/common/sessionContext.js';
import { scheduledRunOf } from '../../browser/schedules/agentScheduleCommands.js';
import { AgentScheduleService } from '../../browser/schedules/agentScheduleService.js';

suite('Agent schedule service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const project: IVoltProjectRecord = { id: 'p1', root: URI.file('/repo'), displayName: 'repo', authority: 'file' } as IVoltProjectRecord;

	async function setup(existing?: FileService) {
		const disposables = store.add(new DisposableStore());
		let fileService = existing;
		if (!fileService) {
			fileService = disposables.add(new FileService(new NullLogService()));
			disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		}
		const submits: { threadId: string; prompt: IOrchPrompt; turnId: string | undefined }[] = [];
		const meta = new Map<string, Record<string, unknown>>();
		const bindings = new Map<string, string>();
		let tools: IVoltHostToolProvider | undefined;
		const stub = <T>(value: object) => value as unknown as T;
		const service = disposables.add(new AgentScheduleService(
			fileService,
			stub({ userRoamingDataHome: URI.file('/user') }),
			new NullLogService(),
			stub({
				whenReady: Promise.resolve(),
				getThread: () => undefined,
				submit: async (threadId: string, prompt: IOrchPrompt, _delivery: string, turnId?: string): Promise<IOrchSubmitResult> => {
					submits.push({ threadId, prompt, turnId });
					return { outcome: 'started' };
				},
			}),
			stub({
				whenReady: Promise.resolve(),
				get: (id: string) => id === 'chat' || meta.has(id) ? { id, title: 'Chat' } : undefined,
				open: (id: string) => ({ setMeta: (value: Record<string, unknown>) => meta.set(id, { ...meta.get(id), ...value }) }),
				pinSessionWorkspace: () => undefined,
			}),
			stub({
				projects: [project],
				activeProject: project,
				getProject: () => project,
				bindingFor: (id: string) => bindings.has(id) ? { sessionId: id, projectId: 'p1', root: project.root, authority: 'file' } : undefined,
				bindSession: (id: string) => {
					bindings.set(id, 'p1');
					return { sessionId: id, projectId: 'p1', root: project.root, authority: 'file' };
				},
				registerProject: () => project,
			}),
			stub({ bindProject: () => undefined }),
			stub({ chatFor: (id: string) => id, listCatalog: () => [] }),
			stub({ registerToolProvider: (provider: IVoltHostToolProvider) => { tools = provider; return toDisposable(() => tools = undefined); } }),
			stub({ onWillShutdown: Event.None }),
		));
		await service.whenReady;
		await settle();
		const tool = async (threadId: string, name: string, args: Record<string, unknown>) => {
			const result = await tools!.invoke(name, args, { sessionId: threadId });
			return result.error ?? result.text ?? '';
		};
		return { service, submits, meta, bindings, fileService, tool };
	}

	async function settle(): Promise<void> {
		for (let i = 0; i < 5; i++) {
			await timeout(0);
		}
	}

	test('Run now sends the prompt into its chat through the orchestrator, marked as scheduled', async () => {
		const { service, submits } = await setup();
		const task = await service.create({ prompt: 'Check the CI on main', schedule: { type: 'interval', everyMs: 3_600_000 }, target: { kind: 'thread', threadId: 'chat' }, mode: 'Agent' });
		assert.ok(task.nextRunAt! > Date.now(), 'an interval waits one interval before its first run');
		const run = await service.runNow(task.id);
		assert.strictEqual(run?.status, 'started');
		assert.strictEqual(submits.length, 1);
		assert.strictEqual(submits[0].threadId, 'chat');
		assert.ok(submits[0].prompt.text.includes('Scheduled task "Check the CI on main"'));
		assert.deepStrictEqual(submits[0].prompt.display, { text: 'Check the CI on main' }, 'the transcript shows what the user wrote');
		assert.deepStrictEqual(scheduledRunOf(submits[0].prompt.host), { id: task.id, title: 'Check the CI on main' });
		assert.strictEqual(service.get(task.id)?.nextRunAt, task.nextRunAt, 'Run now leaves the schedule alone');
		assert.strictEqual(service.get(task.id)?.runCount, 1);
	});

	test('a new-chat task starts a chat in its project each run; a deleted chat fails the run', async () => {
		const { service, submits, meta, bindings } = await setup();
		const fresh = await service.create({ title: 'Deps', prompt: 'Update dependencies', schedule: { type: 'fixed_time', timeOfDay: '09:00' }, target: { kind: 'new', projectRoot: '/repo' } });
		await service.runNow(fresh.id);
		await service.runNow(fresh.id);
		assert.strictEqual(submits.length, 2);
		assert.notStrictEqual(submits[0].threadId, submits[1].threadId, 'a new chat each run');
		assert.ok(submits.every(submit => submit.threadId.startsWith('agent-') && bindings.has(submit.threadId)));
		assert.strictEqual(meta.get(submits[0].threadId)?.title, 'Deps');

		const gone = await service.create({ prompt: 'x', schedule: { type: 'interval', everyMs: 60_000 }, target: { kind: 'thread', threadId: 'deleted' } });
		const run = await service.runNow(gone.id);
		assert.strictEqual(run?.status, 'failed');
		assert.match(run?.error ?? '', /deleted/);
	});

	test('tasks survive a restart; a missed interval runs once, a missed morning slot is skipped', async () => {
		const first = await setup();
		const interval = await first.service.create({ prompt: 'hourly', schedule: { type: 'interval', everyMs: 3_600_000 }, target: { kind: 'thread', threadId: 'chat' } });
		const daily = await first.service.create({ prompt: 'daily', schedule: { type: 'fixed_time', timeOfDay: '09:00' }, target: { kind: 'thread', threadId: 'chat' } });
		// Pretend Volt was closed for five hours: both were due long ago.
		const file = joinPath(URI.file('/user'), 'voltSchedules', 'schedules.json');
		const stored = JSON.parse((await first.fileService.readFile(file)).value.toString()) as { tasks: IAgentSchedule[] };
		const past = Date.now() - 5 * 3_600_000;
		await first.fileService.writeFile(file, VSBuffer.fromString(JSON.stringify({ ...stored, tasks: stored.tasks.map(task => ({ ...task, nextRunAt: past })) })));

		const second = await setup(first.fileService);
		await settle();
		assert.deepStrictEqual(second.submits.map(submit => submit.prompt.display), [{ text: 'hourly' }], 'only the interval ran');
		assert.ok(second.service.get(interval.id)!.nextRunAt! > Date.now());
		assert.strictEqual(second.service.get(daily.id)?.runs.at(-1)?.status, 'skipped');
		assert.ok(second.service.get(daily.id)!.nextRunAt! > Date.now());
	});

	test('agents create, list, pause and delete schedules with the T3-style tools', async () => {
		const { service, tool } = await setup();
		assert.match(await tool('chat', 'schedule_task', { prompt: 'Summarise open PRs', schedule: { type: 'fixed_time', timeOfDay: '17:00', weekdays: [1, 2, 3, 4, 5] }, title: 'PR summary' }), /Scheduled s-/);
		const task = service.list()[0];
		assert.deepStrictEqual(task.target, { kind: 'thread', threadId: 'chat' });
		assert.strictEqual(task.createdBy, 'agent');
		assert.match(await tool('chat', 'list_scheduled_tasks', {}), /Weekdays at 17:00/);
		assert.match(await tool('chat', 'schedule_task', { prompt: 'x', schedule: { type: 'interval', everyMs: 10 } }), /at least 60000/);
		await tool('chat', 'update_scheduled_task', { task_id: task.id, enabled: false });
		assert.strictEqual(service.get(task.id)?.enabled, false);
		assert.strictEqual(service.get(task.id)?.nextRunAt, undefined, 'a paused task has no next run');
		await tool('chat', 'update_scheduled_task', { task_id: task.id, enabled: true });
		assert.ok(service.get(task.id)?.nextRunAt);
		await tool('chat', 'delete_scheduled_task', { task_id: task.id });
		assert.strictEqual(service.list().length, 0);
	});
});
