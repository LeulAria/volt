/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { FileOperationError, FileOperationResult, FileSystemProviderCapabilities, IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolResult, IVoltHostToolService, SCHEDULE_TOOL_NAMES } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentOrchestratorService, IOrchPrompt } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import {
	AgentScheduleTarget, decideScheduleRun, describeSchedule, firstScheduleRun, IAgentSchedule, IAgentScheduleInput, IAgentScheduleRun, IAgentScheduleService,
	nextDueAt, parseScheduleSpec, parseSchedulesFile, recordScheduleRun, scheduledRunPrompt, SCHEDULES_STATE_VERSION, titleFromPrompt,
} from '../../../../services/voltRuntime/common/schedules/agentSchedules.js';
import { IVoltProjectRecord, IVoltSessionContextService, canonicalProjectRoot, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { attachSessionToProject } from '../workspace/agentShell.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { IAgentScheduledRunHost } from './agentScheduleCommands.js';

/** The timer never sleeps longer than this, so a clock change or a machine waking up is noticed. */
const MAX_TIMER_MS = 5 * 60_000;

/**
 * Keeps scheduled tasks (`User/voltSchedules/schedules.json`), fires them on a timer, and sends each
 * run through the orchestrator: into the task's chat (queued if it is busy) or into a new chat in
 * the task's project. A run is written down before it is sent, so a crash cannot send it twice.
 */
export class AgentScheduleService extends Disposable implements IAgentScheduleService {

	declare readonly _serviceBrand: undefined;

	private readonly file: URI;
	private tasks: IAgentSchedule[] = [];
	private loaded = false;
	private writes: Promise<void> = Promise.resolve();
	private readonly timer = this._register(new RunOnceScheduler(() => void this.tick(), MAX_TIMER_MS));
	private readonly firing = new Set<string>();
	readonly whenReady: Promise<void>;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentWorkspaceService private readonly workspace: IAgentWorkspaceService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		this.file = joinPath(environmentService.userRoamingDataHome, 'voltSchedules', 'schedules.json');
		this.whenReady = this.load();
		this._register(hostTools.registerToolProvider({
			tools: SCHEDULE_TOOLS,
			invoke: (name, args, call) => this.invokeTool(name, args, call),
		}));
		this._register(lifecycleService.onWillShutdown(e => e.join(this.writes, { id: 'voltSchedules', label: localize('voltSchedules.saving', "Saving scheduled tasks") })));
		this._register(toDisposable(() => this.timer.cancel()));
		// Runs missed while Volt was closed are decided once everything a run needs is loaded.
		void Promise.all([this.whenReady, this.history.whenReady, this.orchestrator.whenReady]).then(() => this.tick(), () => this.tick());
	}

	//#region Store

	private async load(): Promise<void> {
		try {
			const content = await this.fileService.readFile(this.file);
			this.tasks = parseSchedulesFile(JSON.parse(content.value.toString()));
		} catch (err) {
			if (!(err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				this.logService.warn('[volt schedules] could not read scheduled tasks; keeping a copy as schedules.json.broken', err);
				await this.fileService.copy(this.file, joinPath(this.file, '..', 'schedules.json.broken'), true).catch(() => undefined);
			}
		}
		this.loaded = true;
		if (this.tasks.length) {
			this._onDidChange.fire();
		}
	}

	private save(): Promise<void> {
		if (!this.loaded) {
			return this.whenReady.then(() => this.save());
		}
		const content = JSON.stringify({ version: SCHEDULES_STATE_VERSION, tasks: this.tasks }, null, '\t');
		// Atomic where the provider can (the user data folder can); a plain write elsewhere.
		const atomic = this.fileService.hasCapability(this.file, FileSystemProviderCapabilities.FileAtomicWrite) ? { atomic: { postfix: '.vsctmp' } } as const : undefined;
		this.writes = this.writes.then(() => this.fileService.writeFile(this.file, VSBuffer.fromString(content), atomic).then(() => undefined))
			.catch(err => this.logService.error('[volt schedules] could not save scheduled tasks', err));
		return this.writes;
	}

	private replace(task: IAgentSchedule): void {
		this.tasks = this.tasks.map(candidate => candidate.id === task.id ? task : candidate);
	}

	//#endregion

	//#region API

	list(): readonly IAgentSchedule[] {
		return this.tasks;
	}

	get(id: string): IAgentSchedule | undefined {
		return this.tasks.find(task => task.id === id);
	}

	forThread(threadId: string): readonly IAgentSchedule[] {
		return this.tasks.filter(task => task.target.kind === 'thread' && task.target.threadId === threadId);
	}

	async create(input: IAgentScheduleInput): Promise<IAgentSchedule> {
		await this.whenReady;
		const now = Date.now();
		const enabled = input.enabled !== false;
		const task: IAgentSchedule = {
			id: `s-${generateUuid().slice(0, 8)}`,
			title: input.title?.trim() || titleFromPrompt(input.prompt),
			prompt: input.prompt.trim(),
			enabled,
			schedule: input.schedule,
			target: input.target,
			...(input.modelRef ? { modelRef: input.modelRef } : {}),
			...(input.mode ? { mode: input.mode } : {}),
			createdAt: now,
			createdBy: input.createdBy ?? 'user',
			...(input.sourceThreadId ? { sourceThreadId: input.sourceThreadId } : {}),
			...(enabled && firstScheduleRun(input.schedule, now) !== undefined ? { nextRunAt: firstScheduleRun(input.schedule, now)! } : {}),
			runs: [],
			runCount: 0,
		};
		this.tasks = [...this.tasks, task];
		await this.changed();
		return task;
	}

	async update(id: string, patch: Partial<IAgentScheduleInput>): Promise<IAgentSchedule | undefined> {
		await this.whenReady;
		const task = this.get(id);
		if (!task) {
			return undefined;
		}
		const now = Date.now();
		const schedule = patch.schedule ?? task.schedule;
		const enabled = patch.enabled ?? task.enabled;
		const timing = patch.schedule || (patch.enabled !== undefined && patch.enabled !== task.enabled);
		const { nextRunAt: _next, ...rest } = task;
		const next = enabled ? (timing ? firstScheduleRun(schedule, now) : task.nextRunAt) : undefined;
		const updated: IAgentSchedule = {
			...rest,
			...(patch.title !== undefined ? { title: patch.title.trim() || titleFromPrompt(patch.prompt ?? task.prompt) } : {}),
			...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() } : {}),
			...(patch.target ? { target: patch.target } : {}),
			...(patch.modelRef !== undefined ? { modelRef: patch.modelRef || undefined } : {}),
			...(patch.mode !== undefined ? { mode: patch.mode || undefined } : {}),
			schedule,
			enabled,
			...(next !== undefined ? { nextRunAt: next } : {}),
		};
		this.replace(updated);
		await this.changed();
		return updated;
	}

	setEnabled(id: string, enabled: boolean): Promise<void> {
		return this.update(id, { enabled }).then(() => undefined);
	}

	async delete(id: string): Promise<void> {
		await this.whenReady;
		if (!this.get(id)) {
			return;
		}
		this.tasks = this.tasks.filter(task => task.id !== id);
		await this.changed();
	}

	async runNow(id: string): Promise<IAgentScheduleRun | undefined> {
		await this.whenReady;
		const task = this.get(id);
		return task ? this.fire(task, Date.now(), true) : undefined;
	}

	private async changed(): Promise<void> {
		this._onDidChange.fire();
		this.reschedule();
		await this.save();
	}

	//#endregion

	//#region Clock

	private reschedule(): void {
		if (!this.loaded) {
			return;
		}
		const due = nextDueAt(this.tasks);
		if (due === undefined) {
			this.timer.cancel();
			return;
		}
		this.timer.schedule(Math.max(1_000, Math.min(MAX_TIMER_MS, due - Date.now())));
	}

	private async tick(): Promise<void> {
		const now = Date.now();
		for (const task of [...this.tasks]) {
			const decision = decideScheduleRun(task, now);
			if (decision.kind === 'skip') {
				this.logService.info(`[volt schedules] skipped a missed run of ${task.id} "${task.title}"`);
				this.replace(recordScheduleRun(task, { at: now, status: 'skipped', error: 'Volt was not running at the scheduled time.' }, decision.nextRunAt));
				this._onDidChange.fire();
				await this.save();
			} else if (decision.kind === 'run') {
				await this.fire(task, now, false, decision.nextRunAt);
			}
		}
		this.reschedule();
	}

	/**
	 * One run. The clock's runs record the next run time first and save, then send; Run now leaves
	 * the next run where it was.
	 */
	private async fire(task: IAgentSchedule, at: number, manual: boolean, nextRunAt = task.nextRunAt): Promise<IAgentScheduleRun> {
		if (this.firing.has(task.id)) {
			return { at, status: 'skipped', error: 'A run of this task is starting already.', ...(manual ? { manual } : {}) };
		}
		this.firing.add(task.id);
		const pending: IAgentScheduleRun = { at, status: 'queued', ...(manual ? { manual } : {}) };
		this.replace(recordScheduleRun(task, pending, nextRunAt));
		this._onDidChange.fire();
		await this.save();
		let run: IAgentScheduleRun;
		try {
			run = await this.send(task, at, manual);
		} catch (err) {
			run = { at, status: 'failed', error: err instanceof Error ? err.message : String(err), ...(manual ? { manual } : {}) };
		} finally {
			this.firing.delete(task.id);
		}
		const current = this.get(task.id);
		if (current) {
			this.replace({ ...current, runs: [...current.runs.slice(0, -1), run] });
			this._onDidChange.fire();
			await this.save();
		}
		if (run.status === 'failed') {
			this.logService.warn(`[volt schedules] run of ${task.id} "${task.title}" failed: ${run.error}`);
		}
		return run;
	}

	private async send(task: IAgentSchedule, at: number, manual: boolean): Promise<IAgentScheduleRun> {
		const threadId = task.target.kind === 'thread' ? task.target.threadId : `agent-${generateUuid()}`;
		if (task.target.kind === 'thread') {
			if (!this.history.get(threadId) && !this.orchestrator.getThread(threadId)) {
				throw new Error(localize('voltSchedules.chatGone', "Its chat was deleted."));
			}
		} else {
			const project = this.projectFor(task);
			if (!project) {
				throw new Error(localize('voltSchedules.noProject', "It has no project to start a chat in."));
			}
			attachSessionToProject(this.sessionContext, this.workspace, this.history, threadId, project);
			this.history.open(threadId).setMeta({ title: task.title });
		}
		const host: IAgentScheduledRunHost = { scheduled: { id: task.id, title: task.title } };
		const prompt: IOrchPrompt = {
			text: scheduledRunPrompt(task, at),
			display: { text: task.prompt },
			mode: task.mode ?? 'Agent',
			...(task.modelRef ? { modelRef: task.modelRef } : {}),
			host,
		};
		// The fire time names the turn, so a run that is retried is not sent twice.
		const result = await this.orchestrator.submit(threadId, prompt, 'auto', `sched-${task.id}-${at}`);
		if (result.outcome === 'rejected') {
			throw new Error(result.reason ?? localize('voltSchedules.rejected', "The chat refused the prompt."));
		}
		return { at, status: result.outcome === 'started' ? 'started' : 'queued', threadId, ...(manual ? { manual } : {}) };
	}

	/** The task's project, else the project of the chat it was made in, else the selected project. */
	private projectFor(task: IAgentSchedule): IVoltProjectRecord | undefined {
		const root = task.target.kind === 'new' ? task.target.projectRoot : undefined;
		if (root) {
			const uri = canonicalProjectRoot(uriFromStoredRoot(root));
			return this.sessionContext.projects.find(project => canonicalProjectRoot(project.root).toString() === uri.toString())
				?? this.sessionContext.registerProject(uri, basename(uri));
		}
		const bound = task.sourceThreadId ? this.sessionContext.bindingFor(task.sourceThreadId) : undefined;
		return (bound ? this.sessionContext.getProject(bound.projectId) : undefined) ?? this.sessionContext.activeProject;
	}

	//#endregion

	//#region Agent tools

	private async invokeTool(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const threadId = call?.sessionId ? this.runtime.chatFor(call.sessionId) : undefined;
		await this.whenReady;
		try {
			switch (name) {
				case SCHEDULE_TASK_TOOL: {
					const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
					if (!prompt) {
						return { error: 'schedule_task needs a `prompt`: what the agent should do on each run.' };
					}
					const parsed = parseScheduleSpec(args.schedule);
					if (!parsed.spec) {
						return { error: parsed.error };
					}
					const target = this.targetFromArgs(args, threadId);
					if ('error' in target) {
						return { error: target.error };
					}
					const task = await this.create({
						prompt,
						schedule: parsed.spec,
						target: target.target,
						...(typeof args.title === 'string' ? { title: args.title } : {}),
						...(typeof args.mode === 'string' ? { mode: args.mode } : {}),
						...(typeof args.model === 'string' && this.modelRef(args.model) ? { modelRef: this.modelRef(args.model)! } : {}),
						createdBy: 'agent',
						...(threadId ? { sourceThreadId: threadId } : {}),
					});
					return { text: `Scheduled ${task.id}.\n${describeTask(task)}` };
				}
				case LIST_TOOL: {
					const tasks = threadId && args.all !== true ? this.tasks.filter(task => task.sourceThreadId === threadId || (task.target.kind === 'thread' && task.target.threadId === threadId)) : this.tasks;
					return { text: tasks.length ? tasks.map(describeTask).join('\n\n') : 'No scheduled tasks.' };
				}
				case UPDATE_TOOL: {
					const id = String(args.task_id ?? '');
					if (!this.get(id)) {
						return { error: `No scheduled task ${id}.` };
					}
					const parsed = args.schedule !== undefined ? parseScheduleSpec(args.schedule) : undefined;
					if (parsed && !parsed.spec) {
						return { error: parsed.error };
					}
					const updated = await this.update(id, {
						...(typeof args.title === 'string' ? { title: args.title } : {}),
						...(typeof args.prompt === 'string' ? { prompt: args.prompt } : {}),
						...(parsed?.spec ? { schedule: parsed.spec } : {}),
						...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
					});
					return { text: `Updated ${id}.\n${describeTask(updated!)}` };
				}
				case DELETE_TOOL: {
					const id = String(args.task_id ?? '');
					if (!this.get(id)) {
						return { error: `No scheduled task ${id}.` };
					}
					await this.delete(id);
					return { text: `Deleted ${id}.` };
				}
				case RUN_NOW_TOOL: {
					const id = String(args.task_id ?? '');
					const run = await this.runNow(id);
					return run ? { text: `Ran ${id}: ${run.status}${run.threadId ? ` in chat ${run.threadId}` : ''}${run.error ? ` (${run.error})` : ''}.` } : { error: `No scheduled task ${id}.` };
				}
			}
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
		return { error: `Unknown tool ${name}` };
	}

	private targetFromArgs(args: Record<string, unknown>, threadId: string | undefined): { target: AgentScheduleTarget } | { error: string } {
		const where = typeof args.target === 'string' ? args.target : 'this_chat';
		if (where === 'new_chat') {
			const bound = threadId ? this.sessionContext.bindingFor(threadId) : undefined;
			return { target: { kind: 'new', ...(bound ? { projectRoot: bound.root.toString() } : {}) } };
		}
		if (!threadId) {
			return { error: 'target "this_chat" only works from a Volt chat; use "new_chat".' };
		}
		return { target: { kind: 'thread', threadId } };
	}

	private modelRef(value: string): string | undefined {
		const wanted = value.trim().toLowerCase();
		const items = this.runtime.listCatalog().filter(item => item.enabled);
		return (items.find(item => item.ref.toLowerCase() === wanted || item.id.toLowerCase() === wanted || item.label.toLowerCase() === wanted)
			?? items.find(item => item.label.toLowerCase().includes(wanted)))?.ref;
	}

	//#endregion
}

function describeTask(task: IAgentSchedule): string {
	const lines = [
		`task_id: ${task.id}`,
		`title: ${task.title}`,
		`schedule: ${describeSchedule(task.schedule)}`,
		`target: ${task.target.kind === 'thread' ? `chat ${task.target.threadId}` : 'a new chat each run'}`,
		`enabled: ${task.enabled}`,
	];
	if (task.enabled && task.nextRunAt !== undefined) {
		lines.push(`next run: ${new Date(task.nextRunAt).toISOString()}`);
	}
	const last = task.runs.at(-1);
	if (last) {
		lines.push(`last run: ${new Date(last.at).toISOString()} ${last.status}${last.error ? ` (${last.error})` : ''}`);
	}
	lines.push(`prompt: ${task.prompt}`);
	return lines.join('\n');
}

const [SCHEDULE_TASK_TOOL, LIST_TOOL, UPDATE_TOOL, DELETE_TOOL, RUN_NOW_TOOL] = SCHEDULE_TOOL_NAMES;

const SCHEDULE_ARG = {
	description: 'When it runs: {"type":"interval","everyMs":3600000} (at least 60000), or {"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]} in the user\'s local time (weekdays 0 = Sunday; omit for every day). Words also work: "every 2 hours", "daily at 09:00", "weekdays at 18:30".',
};

export const SCHEDULE_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: SCHEDULE_TASK_TOOL,
		title: 'Scheduled task',
		group: 'tasks',
		description: 'Create a recurring task: Volt sends `prompt` on a schedule, into this chat (target "this_chat", the default; a run waits if the chat is busy) or into a new chat in this project each time (target "new_chat"). Use it when the user asks for something to happen regularly or at a later time (a daily CI check, a weekly dependency review). Runs keep going while Volt is open; a run missed while it was closed runs late (intervals) or is skipped (fixed times).',
		inputSchema: {
			type: 'object',
			properties: {
				prompt: { type: 'string', description: 'What the agent does on each run, written so it stands on its own.' },
				schedule: SCHEDULE_ARG,
				title: { type: 'string', description: 'Short title shown in Volt.' },
				target: { type: 'string', enum: ['this_chat', 'new_chat'] },
				model: { type: 'string', description: 'Model for the runs (a list_models value); default: the chat\'s model.' },
				mode: { type: 'string', enum: ['Agent', 'Plan', 'Ask'] },
			},
			required: ['prompt', 'schedule'],
		},
	},
	{
		name: LIST_TOOL,
		title: 'Listed scheduled tasks',
		group: 'tasks',
		description: 'List the scheduled tasks of this chat (all=true: every scheduled task), with their schedule, next run and last run.',
		inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } },
	},
	{
		name: UPDATE_TOOL,
		title: 'Updated scheduled task',
		group: 'tasks',
		description: 'Change a scheduled task: its prompt, title, schedule, or pause/resume it (enabled).',
		inputSchema: {
			type: 'object',
			properties: { task_id: { type: 'string' }, prompt: { type: 'string' }, title: { type: 'string' }, schedule: SCHEDULE_ARG, enabled: { type: 'boolean' } },
			required: ['task_id'],
		},
	},
	{
		name: DELETE_TOOL,
		title: 'Deleted scheduled task',
		group: 'tasks',
		description: 'Delete a scheduled task. Chats its runs started stay.',
		inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
	},
	{
		name: RUN_NOW_TOOL,
		title: 'Ran scheduled task',
		group: 'tasks',
		description: 'Run a scheduled task once now, off its schedule (its next scheduled run does not move).',
		inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
	},
];
