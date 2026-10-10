/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { FileOperationError, FileOperationResult, FileSystemProviderCapabilities, IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { asJson, asText, IRequestService } from '../../../../../platform/request/common/request.js';
import { IVoltPullRequestService, IVoltPrRepo } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import {
	AUTOMATIONS_STATE_VERSION, AutomationRunToolKind, AutomationToolStatus, automationRunPrompt, describeSchedule, dueSchedules, IAutomation, IAutomationCreateInput, IAutomationDeliveryInput,
	IAutomationDraft, IAutomationRepository, IAutomationRun, IAutomationService, isActiveRun, MAX_REPOSITORIES_PER_RUN, migrateScheduledTasks, nameFromInstructions,
	nextDueAt, parseAutomationsFile, parseScheduleText, patchRun, planNextRuns, recordRun, withRunTool,
} from '../../../../services/voltRuntime/common/automations/automations.js';
import { AutomationProvider } from '../../../../services/voltRuntime/common/automations/automationTriggers.js';
import { newWebhookTrigger } from '../../../../services/voltRuntime/common/automations/automationWebhooks.js';
import { IVoltEventEnvelope } from '../../../../services/voltRuntime/common/events.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { AUTOMATION_TOOL_NAMES, IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolResult, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { canonicalProjectRoot, IVoltProjectRecord, IVoltSessionContextService, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { AgentScratchFolders } from '../workspace/agentScratchProject.js';
import { attachSessionToProject } from '../workspace/agentShell.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { IAutomationRunHost } from './automationCommands.js';

/** The timer never sleeps longer than this, so a clock change or a machine waking up is noticed. */
const MAX_TIMER_MS = 5 * 60_000;
/** Status and tool updates are batched into one write; a run's start is written at once. */
const SAVE_DELAY_MS = 400;
const MEMORY_FILE = 'MEMORIES.md';
const MEMORY_FILE_NAME = /^[\w][\w.-]{0,79}$/;
/** What a run reads from Slack or Teams, at most. */
const READ_LIMIT_CHARS = 8000;

interface IRunOrigin {
	readonly provider: AutomationProvider | 'manual';
	readonly event?: string;
	readonly label: string;
	readonly triggerId?: string;
	readonly deliveryId?: string;
	readonly at?: number;
	readonly instructions?: string;
	readonly eventLines?: readonly string[];
	readonly payload?: string;
}

interface ITracked {
	readonly automationId: string;
	readonly runId: string;
}

function shortId(prefix: string): string {
	return `${prefix}-${generateUuid().replace(/-/g, '').slice(0, 10)}`;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Keeps automations (`User/voltAutomations/automations.json`, migrated once from the old scheduled
 * tasks), fires their schedules, starts runs (one new chat per repository, or the automation's
 * chat), follows each run's turn until it settles, and records the tools it used. A run is written
 * down before it is sent, so a crash cannot send it twice.
 */
export class AutomationService extends Disposable implements IAutomationService {

	declare readonly _serviceBrand: undefined;

	private readonly file: URI;
	private readonly legacyFile: URI;
	private readonly memoryRoot: URI;
	private automations: IAutomation[] = [];
	private loaded = false;
	private writes: Promise<void> = Promise.resolve();
	private readonly saveSoon = this._register(new RunOnceScheduler(() => void this.save(), SAVE_DELAY_MS));
	private readonly timer = this._register(new RunOnceScheduler(() => void this.tick(), MAX_TIMER_MS));
	private readonly firing = new Set<string>();
	/** Thread id → the runs whose turns go there and have not settled. */
	private readonly tracked = new Map<string, ITracked[]>();
	/** Watches tool calls only while a run is active: no cost for the rest of Volt's chats. */
	private readonly toolWatch = this._register(new MutableDisposable());
	private readonly toolCalls = new Map<string, ITracked & { readonly kind: AutomationRunToolKind; readonly detail?: string }>();
	private readonly scratch: AgentScratchFolders;
	private login: string | undefined;
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
		@IVoltPullRequestService private readonly pullRequests: IVoltPullRequestService,
		@IRequestService private readonly requestService: IRequestService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const root = joinPath(environmentService.userRoamingDataHome, 'voltAutomations');
		this.file = joinPath(root, 'automations.json');
		this.memoryRoot = joinPath(root, 'memory');
		this.legacyFile = joinPath(environmentService.userRoamingDataHome, 'voltSchedules', 'schedules.json');
		this.scratch = instantiationService.createInstance(AgentScratchFolders);
		this.whenReady = this.load();
		this._register(hostTools.registerToolProvider({
			tools: AUTOMATION_TOOLS,
			invoke: (name, args, call) => this.invokeTool(name, args, call),
		}));
		this._register(lifecycleService.onWillShutdown(e => e.join(this.flush(), { id: 'voltAutomations', label: localize('voltAutomations.saving', "Saving automations") })));
		this._register(toDisposable(() => this.timer.cancel()));
		this._register(orchestrator.onDidChange(change => {
			for (const threadId of change.threads) {
				if (this.tracked.has(threadId)) {
					this.settleThread(threadId);
				}
			}
		}));
		this._register(pullRequests.onDidChangeAccounts(() => this.login = undefined));
		// Runs missed while Volt was closed, and runs it was in the middle of, are decided once a run's needs are loaded.
		void Promise.all([this.whenReady, history.whenReady, orchestrator.whenReady]).then(() => this.recover(), () => this.recover());
		void this.resolveLogin();
	}

	//#region Store

	private async load(): Promise<void> {
		try {
			const content = await this.fileService.readFile(this.file);
			this.automations = parseAutomationsFile(JSON.parse(content.value.toString()));
		} catch (err) {
			if (err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				await this.migrate();
			} else {
				this.logService.warn('[volt automations] could not read automations; keeping a copy as automations.json.broken', err);
				await this.fileService.copy(this.file, joinPath(this.file, '..', 'automations.json.broken'), true).catch(() => undefined);
			}
		}
		this.loaded = true;
		if (this.automations.length) {
			this._onDidChange.fire();
		}
	}

	/** Scheduled tasks from before Automations become automations, once. */
	private async migrate(): Promise<void> {
		try {
			const content = await this.fileService.readFile(this.legacyFile);
			this.automations = migrateScheduledTasks(JSON.parse(content.value.toString()), Date.now());
			if (this.automations.length) {
				this.loaded = true;
				await this.save();
				this.logService.info(`[volt automations] moved ${this.automations.length} scheduled task(s) to Automations`);
			}
		} catch {
			// No scheduled tasks to bring over.
		}
	}

	private save(): Promise<void> {
		if (!this.loaded) {
			return this.whenReady.then(() => this.save());
		}
		this.saveSoon.cancel();
		const content = JSON.stringify({ version: AUTOMATIONS_STATE_VERSION, automations: this.automations }, null, '\t');
		const atomic = this.fileService.hasCapability(this.file, FileSystemProviderCapabilities.FileAtomicWrite) ? { atomic: { postfix: '.vsctmp' } } as const : undefined;
		this.writes = this.writes.then(() => this.fileService.writeFile(this.file, VSBuffer.fromString(content), atomic).then(() => undefined))
			.catch(err => this.logService.error('[volt automations] could not save automations', err));
		return this.writes;
	}

	private flush(): Promise<void> {
		return this.saveSoon.isScheduled() ? this.save() : this.writes;
	}

	/** Fires, re-arms the clock and saves: at once (`now`) or batched. */
	private changed(now: boolean): Promise<void> {
		this._onDidChange.fire();
		this.reschedule();
		if (now) {
			return this.save();
		}
		this.saveSoon.schedule();
		return Promise.resolve();
	}

	private mutate(id: string, change: (automation: IAutomation) => IAutomation): IAutomation | undefined {
		let result: IAutomation | undefined;
		this.automations = this.automations.map(automation => automation.id === id ? (result = change(automation)) : automation);
		return result;
	}

	//#endregion

	//#region API

	list(): readonly IAutomation[] {
		return this.automations;
	}

	get(id: string): IAutomation | undefined {
		return this.automations.find(automation => automation.id === id);
	}

	creator(): string {
		return this.login ?? localize('voltAutomations.you', "You");
	}

	private async resolveLogin(): Promise<string | undefined> {
		try {
			const accounts = await Promise.race([
				this.pullRequests.accounts(),
				new Promise<[]>(resolve => setTimeout(() => resolve([]), 2000)),
			]);
			const account = accounts.find(entry => entry.active && entry.ok && entry.host === 'github.com') ?? accounts.find(entry => entry.active && entry.ok) ?? accounts[0];
			this.login = account?.login;
		} catch {
			// No CLI or no accounts: "You".
		}
		return this.login;
	}

	async create(input: IAutomationCreateInput): Promise<IAutomation> {
		await this.whenReady;
		if (!this.login) {
			await this.resolveLogin();
		}
		const now = Date.now();
		const draft: IAutomationDraft = {
			name: input.name?.trim() || (input.instructions ? nameFromInstructions(input.instructions) : localize('voltAutomations.untitled', "Untitled")),
			instructions: input.instructions ?? '',
			enabled: input.enabled ?? false,
			triggers: input.triggers ?? [],
			repositories: input.repositories ?? [],
			tools: input.tools ?? [{ id: shortId('t'), kind: 'memories' }],
			...(input.modelRef ? { modelRef: input.modelRef } : {}),
			...(input.mode ? { mode: input.mode } : {}),
			...(input.shared ? { shared: true } : {}),
			...(input.templateId ? { templateId: input.templateId } : {}),
			...(input.threadId ? { threadId: input.threadId } : {}),
		};
		const base: IAutomation = {
			id: shortId('a'),
			...draft,
			createdAt: now,
			updatedAt: now,
			createdBy: this.creator(),
			...(input.createdByAgent ? { createdByAgent: true } : {}),
			...(input.sourceThreadId ? { sourceThreadId: input.sourceThreadId } : {}),
			nextRuns: {},
			runs: [],
			runCount: 0,
		};
		const automation = { ...base, nextRuns: planNextRuns(base, now) };
		this.automations = [...this.automations, automation];
		await this.changed(true);
		return automation;
	}

	async update(id: string, patch: Partial<IAutomationDraft>): Promise<IAutomation | undefined> {
		await this.whenReady;
		const now = Date.now();
		const updated = this.mutate(id, automation => {
			const next: IAutomation = { ...automation, ...patch, updatedAt: now };
			// Optional fields cleared by the editor ("Auto" model) come in as undefined.
			const cleaned = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as unknown as IAutomation;
			return { ...cleaned, nextRuns: planNextRuns(cleaned, now, automation.enabled ? automation : undefined) };
		});
		if (updated) {
			await this.changed(true);
		}
		return updated;
	}

	async setEnabled(id: string, enabled: boolean): Promise<void> {
		await this.update(id, { enabled });
	}

	async duplicate(id: string): Promise<IAutomation | undefined> {
		const source = this.get(id);
		if (!source) {
			return undefined;
		}
		// New hooks: two automations must never answer the same URL.
		const triggers = source.triggers.map(trigger => ({
			...trigger,
			id: shortId('tr'),
			...(trigger.hook ? { hook: { ...newWebhookTrigger(`hook_${generateUuid().replace(/-/g, '')}`, generateUuid().replace(/-/g, '')), signature: trigger.hook.signature, filters: trigger.hook.filters, ...(trigger.hook.holdOffline === false ? { holdOffline: false } : {}) } } : {}),
		}));
		return this.create({
			name: localize('voltAutomations.copyName', "{0} (copy)", source.name),
			instructions: source.instructions,
			enabled: false,
			triggers,
			repositories: source.repositories,
			tools: source.tools.map(tool => ({ ...tool, id: shortId('t') })),
			...(source.modelRef ? { modelRef: source.modelRef } : {}),
			...(source.mode ? { mode: source.mode } : {}),
			...(source.shared ? { shared: true } : {}),
			...(source.templateId ? { templateId: source.templateId } : {}),
		});
	}

	async delete(id: string): Promise<void> {
		await this.whenReady;
		if (!this.get(id)) {
			return;
		}
		this.automations = this.automations.filter(automation => automation.id !== id);
		await this.changed(true);
		await this.fileService.del(joinPath(this.memoryRoot, id), { recursive: true }).catch(() => undefined);
	}

	async setRelayUrl(id: string, hookId: string, url: string, relayId: string): Promise<void> {
		await this.whenReady;
		if (this.mutate(id, automation => ({ ...automation, relayUrls: { ...automation.relayUrls, [hookId]: { url, relayId } } }))) {
			await this.changed(true);
		}
	}

	async runNow(id: string): Promise<readonly IAutomationRun[]> {
		await this.whenReady;
		const automation = this.get(id);
		return automation ? this.start(automation, { provider: 'manual', label: localize('voltAutomations.runNowLabel', "Run now") }) : [];
	}

	async runFromDelivery(id: string, triggerId: string, input: IAutomationDeliveryInput): Promise<readonly IAutomationRun[]> {
		await this.whenReady;
		const automation = this.get(id);
		const trigger = automation?.triggers.find(candidate => candidate.id === triggerId);
		if (!automation || !trigger) {
			return [];
		}
		// A redelivered or retried delivery answers with the runs it already started.
		const done = automation.runs.filter(run => run.deliveryId === input.deliveryId && run.status !== 'skipped');
		if (done.length) {
			return done;
		}
		return this.start(automation, {
			provider: trigger.provider,
			event: trigger.event,
			triggerId,
			label: input.label,
			deliveryId: input.deliveryId,
			at: input.receivedAt,
			instructions: input.instructions,
			eventLines: input.eventLines,
			...(input.payload ? { payload: input.payload } : {}),
		});
	}

	async recordSkippedDelivery(id: string, triggerId: string, input: { readonly deliveryId: string; readonly receivedAt: number; readonly label: string; readonly note: string }): Promise<void> {
		await this.whenReady;
		const trigger = this.get(id)?.triggers.find(candidate => candidate.id === triggerId);
		const run: IAutomationRun = {
			id: shortId('r'), at: input.receivedAt, status: 'skipped', provider: trigger?.provider ?? 'webhook', ...(trigger ? { event: trigger.event, triggerId } : {}),
			label: input.label, deliveryId: input.deliveryId, note: input.note, finishedAt: input.receivedAt,
		};
		if (this.mutate(id, automation => automation.runs.some(entry => entry.deliveryId === input.deliveryId) ? automation : recordRun(automation, run))) {
			await this.changed(false);
		}
	}

	async stopRuns(id?: string): Promise<number> {
		await this.whenReady;
		let count = 0;
		const threads = new Set<string>();
		for (const automation of this.automations) {
			if (id && automation.id !== id) {
				continue;
			}
			for (const run of automation.runs) {
				if (!isActiveRun(run)) {
					continue;
				}
				count++;
				if (run.threadId) {
					threads.add(run.threadId);
				} else {
					this.mutate(automation.id, current => patchRun(current, run.id, { status: 'cancelled', finishedAt: Date.now(), note: localize('voltAutomations.stopped', "Stopped") }));
				}
			}
		}
		await Promise.all([...threads].map(threadId => this.orchestrator.cancel(threadId).catch(err => this.logService.warn('[volt automations] could not stop a run', err))));
		if (count) {
			await this.changed(false);
		}
		return count;
	}

	//#endregion

	//#region Memory

	private memoryFile(id: string, file = MEMORY_FILE): URI {
		if (!MEMORY_FILE_NAME.test(file)) {
			throw new Error(localize('voltAutomations.badMemoryFile', "Memory files are named with letters, digits, dots, dashes and underscores (like MEMORIES.md)."));
		}
		return joinPath(this.memoryRoot, id, file);
	}

	async listMemoryFiles(id: string): Promise<readonly string[]> {
		try {
			const stat = await this.fileService.resolve(joinPath(this.memoryRoot, id));
			const names = (stat.children ?? []).filter(child => child.isFile).map(child => child.name);
			return [...new Set([MEMORY_FILE, ...names])].sort((a, b) => a === MEMORY_FILE ? -1 : b === MEMORY_FILE ? 1 : a.localeCompare(b));
		} catch {
			return [MEMORY_FILE];
		}
	}

	async readMemory(id: string, file?: string): Promise<string> {
		try {
			return (await this.fileService.readFile(this.memoryFile(id, file))).value.toString();
		} catch (err) {
			if (err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				return '';
			}
			throw err;
		}
	}

	async writeMemory(id: string, file: string, content: string): Promise<void> {
		await this.fileService.writeFile(this.memoryFile(id, file), VSBuffer.fromString(content));
	}

	async deleteMemory(id: string, file: string): Promise<void> {
		await this.fileService.del(this.memoryFile(id, file)).catch(() => undefined);
	}

	//#endregion

	//#region Clock

	private reschedule(): void {
		if (!this.loaded) {
			return;
		}
		const due = nextDueAt(this.automations);
		if (due === undefined) {
			this.timer.cancel();
			return;
		}
		this.timer.schedule(Math.max(1_000, Math.min(MAX_TIMER_MS, due - Date.now())));
	}

	private async tick(): Promise<void> {
		const now = Date.now();
		for (const automation of [...this.automations]) {
			const decisions = dueSchedules(automation, now);
			if (!decisions.length) {
				continue;
			}
			// The next runs are written before anything is sent: a crash mid-run never repeats the slot.
			const updated = this.mutate(automation.id, current => {
				const nextRuns = { ...current.nextRuns };
				for (const decision of decisions) {
					if (decision.next === undefined) {
						delete nextRuns[decision.triggerId];
					} else {
						nextRuns[decision.triggerId] = decision.next;
					}
				}
				let result: IAutomation = { ...current, nextRuns };
				for (const decision of decisions.filter(entry => entry.kind === 'skip')) {
					const trigger = current.triggers.find(candidate => candidate.id === decision.triggerId);
					result = recordRun(result, {
						id: shortId('r'), at: decision.due, status: 'skipped', provider: 'schedule', ...(trigger ? { event: trigger.event } : {}), triggerId: decision.triggerId,
						label: trigger?.schedule ? describeSchedule(trigger.schedule) : 'Scheduled', finishedAt: now,
						note: localize('voltAutomations.missed', "Volt was not running at the scheduled time."),
					});
				}
				return result;
			});
			await this.changed(true);
			const run = decisions.find(entry => entry.kind === 'run');
			const trigger = run && updated?.triggers.find(candidate => candidate.id === run.triggerId);
			if (updated && run && trigger?.schedule) {
				await this.start(updated, { provider: 'schedule', event: trigger.event, triggerId: trigger.id, label: describeSchedule(trigger.schedule), at: now });
			}
		}
		this.reschedule();
	}

	//#endregion

	//#region Runs

	private async start(automation: IAutomation, origin: IRunOrigin): Promise<IAutomationRun[]> {
		const repositories: (IAutomationRepository | undefined)[] = automation.threadId || !automation.repositories.length
			? [undefined]
			: automation.repositories.slice(0, MAX_REPOSITORIES_PER_RUN);
		const runs = await Promise.all(repositories.map(repository => this.startOne(automation.id, origin, repository)));
		return runs.filter((run): run is IAutomationRun => !!run);
	}

	private async startOne(automationId: string, origin: IRunOrigin, repository: IAutomationRepository | undefined): Promise<IAutomationRun | undefined> {
		const key = origin.deliveryId ? `${automationId}:${origin.deliveryId}:${repository?.root ?? ''}` : undefined;
		if (key && this.firing.has(key)) {
			return undefined;
		}
		if (key) {
			this.firing.add(key);
		}
		const id = shortId('r');
		const run: IAutomationRun = {
			id,
			at: origin.at ?? Date.now(),
			status: 'queued',
			provider: origin.provider,
			label: origin.label,
			turnId: `auto-${id}`,
			...(origin.event ? { event: origin.event } : {}),
			...(origin.triggerId ? { triggerId: origin.triggerId } : {}),
			...(origin.deliveryId ? { deliveryId: origin.deliveryId } : {}),
			...(repository ? { repository: repository.owner ? `${repository.owner}/${repository.name}` : repository.name } : {}),
		};
		try {
			if (!this.mutate(automationId, automation => recordRun(automation, run))) {
				return undefined;
			}
			await this.changed(true);
			try {
				const sent = await this.send(automationId, run, origin, repository);
				const now = Date.now();
				const status = sent.outcome === 'duplicate' ? 'skipped' : sent.outcome === 'started' ? 'running' : 'queued';
				this.mutate(automationId, automation => patchRun(automation, id, {
					threadId: sent.threadId,
					status,
					...(status === 'running' ? { startedAt: now } : {}),
					...(status === 'skipped' ? { note: localize('voltAutomations.duplicate', "Already sent"), finishedAt: now } : {}),
				}));
				if (status !== 'skipped') {
					this.track(sent.threadId, { automationId, runId: id });
				}
			} catch (err) {
				this.logService.warn(`[volt automations] run of ${automationId} failed: ${errorText(err)}`);
				this.mutate(automationId, automation => patchRun(automation, id, { status: 'failed', error: errorText(err), finishedAt: Date.now() }));
			}
			await this.changed(false);
			return this.get(automationId)?.runs.find(entry => entry.id === id) ?? run;
		} finally {
			if (key) {
				this.firing.delete(key);
			}
		}
	}

	private async send(automationId: string, run: IAutomationRun, origin: IRunOrigin, repository: IAutomationRepository | undefined): Promise<{ threadId: string; outcome: string }> {
		const automation = this.get(automationId);
		if (!automation) {
			throw new Error(localize('voltAutomations.gone', "The automation was deleted."));
		}
		let threadId: string;
		if (automation.threadId) {
			threadId = automation.threadId;
			if (!this.history.get(threadId) && !this.orchestrator.getThread(threadId)) {
				throw new Error(localize('voltAutomations.chatGone', "Its chat was deleted."));
			}
		} else {
			threadId = `agent-${generateUuid()}`;
			if (repository) {
				attachSessionToProject(this.sessionContext, this.workspace, this.history, threadId, this.projectFor(repository));
			} else if (!await this.scratch.bind(threadId, automation.name)) {
				throw new Error(localize('voltAutomations.noFolder', "Could not make a folder for the run; pick a repository."));
			}
			this.history.open(threadId).setMeta({ title: automation.name });
		}
		const memory = automation.tools.some(tool => tool.kind === 'memories') ? await this.readMemory(automation.id).catch(() => '') : undefined;
		const text = automationRunPrompt(automation, {
			runId: run.id,
			at: run.at,
			triggerLabel: run.label,
			manual: origin.provider === 'manual',
			...(repository ? { repository } : {}),
			...(memory !== undefined ? { memory } : {}),
			...(origin.eventLines?.length ? { eventLines: origin.eventLines, eventProvider: origin.provider } : {}),
			...(origin.payload ? { payload: origin.payload } : {}),
			...(origin.instructions ? { instructions: origin.instructions } : {}),
			mcpServers: automation.tools.flatMap(tool => tool.kind === 'mcp' && tool.server ? [tool.server] : []),
			actions: runActions(automation, !!repository || !!automation.threadId),
		});
		const modelRef = automation.modelRef ?? (automation.sourceThreadId ? this.orchestrator.getThread(automation.sourceThreadId)?.modelRef : undefined);
		const host: IAutomationRunHost = { scheduled: { id: automation.id, title: automation.name, runId: run.id, ...(origin.provider !== 'schedule' && origin.provider !== 'manual' ? { webhook: true } : {}) } };
		const result = await this.orchestrator.submit(threadId, {
			text,
			display: { text: (origin.instructions ?? automation.instructions).trim() || automation.name },
			mode: automation.mode ?? 'Agent',
			...(modelRef ? { modelRef } : {}),
			host,
		}, 'auto', run.turnId);
		if (result.outcome === 'rejected') {
			throw new Error(result.reason ?? localize('voltAutomations.rejected', "The chat refused the prompt."));
		}
		return { threadId, outcome: result.outcome };
	}

	private projectFor(repository: IAutomationRepository): IVoltProjectRecord {
		const uri = canonicalProjectRoot(uriFromStoredRoot(repository.root));
		return this.sessionContext.projects.find(project => canonicalProjectRoot(project.root).toString() === uri.toString())
			?? this.sessionContext.registerProject(uri, repository.name);
	}

	private track(threadId: string, entry: ITracked): void {
		const list = this.tracked.get(threadId) ?? [];
		if (!list.some(candidate => candidate.runId === entry.runId)) {
			this.tracked.set(threadId, [...list, entry]);
		}
		if (!this.toolWatch.value) {
			this.toolWatch.value = this.runtime.onDidEmit(event => this.onRuntimeEvent(event));
		}
		this.settleThread(threadId);
	}

	private untrack(threadId: string, runId: string): void {
		const list = (this.tracked.get(threadId) ?? []).filter(entry => entry.runId !== runId);
		if (list.length) {
			this.tracked.set(threadId, list);
		} else {
			this.tracked.delete(threadId);
		}
		if (!this.tracked.size) {
			this.toolWatch.clear();
			this.toolCalls.clear();
		}
	}

	/** Moves the thread's runs along: running when their turn is active, done when it settled. */
	private settleThread(threadId: string, recovering = false): void {
		const entries = this.tracked.get(threadId);
		const thread = this.orchestrator.getThread(threadId);
		if (!entries || !thread) {
			return;
		}
		let changed = false;
		for (const entry of entries) {
			const run = this.get(entry.automationId)?.runs.find(candidate => candidate.id === entry.runId);
			if (!run || !isActiveRun(run)) {
				this.untrack(threadId, entry.runId);
				continue;
			}
			if (thread.active?.id === run.turnId) {
				if (run.status !== 'running') {
					this.mutate(entry.automationId, automation => patchRun(automation, run.id, { status: 'running', startedAt: Date.now() }));
					changed = true;
				}
				continue;
			}
			const last = thread.last;
			if (last && last.turnId === run.turnId) {
				const status = last.outcome === 'done' ? 'succeeded' : last.outcome === 'failed' ? 'failed' : 'cancelled';
				this.finish(entry, status, last.at, last.error ?? (status === 'cancelled' ? localize('voltAutomations.stopped', "Stopped") : undefined));
				this.untrack(threadId, entry.runId);
				changed = true;
				continue;
			}
			if (thread.queue.some(item => item.id === run.turnId)) {
				continue;
			}
			// Neither running, queued nor the last turn: it ran and another turn followed in the same batch.
			if (run.status === 'running' || recovering) {
				this.finish(entry, recovering && run.status !== 'running' ? 'failed' : 'succeeded', Date.now(), recovering ? localize('voltAutomations.interrupted', "Volt closed before the run finished.") : undefined);
				this.untrack(threadId, entry.runId);
				changed = true;
			}
		}
		if (changed) {
			void this.changed(false);
		}
	}

	private finish(entry: ITracked, status: 'succeeded' | 'failed' | 'cancelled', at: number, error: string | undefined): void {
		this.mutate(entry.automationId, automation => {
			const run = automation.runs.find(candidate => candidate.id === entry.runId);
			if (!run) {
				return automation;
			}
			// A tool call still pending when the turn ended did not finish.
			const tools = run.tools?.map(tool => tool.status === 'pending' ? { ...tool, status: (status === 'succeeded' ? 'success' : 'failed') as AutomationToolStatus } : tool);
			return patchRun(automation, run.id, { status, finishedAt: at, ...(tools ? { tools } : {}), ...(error ? (status === 'succeeded' ? { note: error } : { error }) : {}) });
		});
	}

	/** Runs Volt was in the middle of when it closed: follow them again, or close them out. */
	private async recover(): Promise<void> {
		let touched = false;
		for (const automation of this.automations) {
			for (const run of automation.runs.filter(isActiveRun)) {
				touched = true;
				if (!run.threadId) {
					this.mutate(automation.id, current => patchRun(current, run.id, { status: 'failed', error: localize('voltAutomations.notStarted', "Volt closed before the run started."), finishedAt: Date.now() }));
					continue;
				}
				await this.orchestrator.ensureThreadLoaded(run.threadId).catch(() => undefined);
				this.tracked.set(run.threadId, [...(this.tracked.get(run.threadId) ?? []), { automationId: automation.id, runId: run.id }]);
				this.settleThread(run.threadId, !this.orchestrator.getThread(run.threadId)?.active);
			}
		}
		if (this.tracked.size && !this.toolWatch.value) {
			this.toolWatch.value = this.runtime.onDidEmit(event => this.onRuntimeEvent(event));
		}
		if (touched) {
			await this.changed(true);
		}
		await this.tick();
	}

	/** MCP tool calls of an active run, for its Tools column. */
	private onRuntimeEvent(envelope: IVoltEventEnvelope): void {
		const event = envelope.event;
		if (event.type !== 'tool.start' && event.type !== 'tool.end') {
			return;
		}
		if (event.type === 'tool.end') {
			const call = this.toolCalls.get(event.callId);
			if (call) {
				this.toolCalls.delete(event.callId);
				this.recordTool(call, call.kind, event.error ? 'failed' : 'success', call.detail);
			}
			return;
		}
		const entries = this.tracked.get(this.runtime.chatFor(envelope.sessionId));
		const entry = entries?.at(-1);
		if (!entry) {
			return;
		}
		const server = mcpServerOf(event.name, event.title, this.get(entry.automationId)?.tools.flatMap(tool => tool.kind === 'mcp' && tool.server ? [tool.server] : []) ?? []);
		if (server) {
			this.toolCalls.set(event.callId, { ...entry, kind: 'mcp', detail: server });
			this.recordTool(entry, 'mcp', 'pending', server);
		}
	}

	private recordTool(entry: ITracked, kind: AutomationRunToolKind, status: AutomationToolStatus, detail?: string): void {
		this.mutate(entry.automationId, automation => ({
			...automation,
			runs: automation.runs.map(run => run.id === entry.runId ? withRunTool(run, { kind, status, at: Date.now(), ...(detail ? { detail } : {}) }) : run),
		}));
		void this.changed(false);
	}

	//#endregion

	//#region Agent tools

	private async invokeTool(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		await this.whenReady;
		try {
			return name === MANAGE_TOOL ? await this.manage(args, call) : await this.act(args, call);
		} catch (err) {
			return { error: errorText(err) };
		}
	}

	private async manage(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const threadId = call?.sessionId ? this.runtime.chatFor(call.sessionId) : undefined;
		const action = String(args.action ?? 'list');
		const id = typeof args.automation_id === 'string' ? args.automation_id : undefined;
		const target = id ? this.get(id) : undefined;
		if (id && !target) {
			return { error: `No automation ${id}.` };
		}
		const fromArgs = (): Partial<IAutomationDraft> | { error: string } => {
			const patch: { -readonly [K in keyof IAutomationDraft]?: IAutomationDraft[K] } = {};
			if (typeof args.name === 'string') {
				patch.name = args.name;
			}
			if (typeof args.instructions === 'string') {
				patch.instructions = args.instructions;
			}
			if (typeof args.enabled === 'boolean') {
				patch.enabled = args.enabled;
			}
			if (typeof args.schedule === 'string' && args.schedule.trim()) {
				const parsed = parseScheduleText(args.schedule);
				if (!parsed.schedule) {
					return { error: parsed.error ?? 'Bad schedule.' };
				}
				const others = (target?.triggers ?? []).filter(trigger => trigger.provider !== 'schedule');
				patch.triggers = [...others, { id: shortId('tr'), provider: 'schedule', event: parsed.schedule.type === 'interval' ? 'hourly' : parsed.schedule.type, schedule: parsed.schedule }];
			}
			if (args.repository === 'none') {
				patch.repositories = [];
			} else if (args.repository === 'this' && threadId) {
				const binding = this.sessionContext.bindingFor(threadId);
				const project = binding ? this.sessionContext.getProject(binding.projectId) : undefined;
				if (project && !project.scratch) {
					patch.repositories = [{ root: project.root.toString(), name: project.displayName }];
				}
			}
			return patch;
		};
		switch (action) {
			case 'list': {
				const list = this.automations;
				return { text: list.length ? list.map(describeForAgent).join('\n\n') : 'No automations.' };
			}
			case 'create': {
				if (typeof args.instructions !== 'string' || !args.instructions.trim()) {
					return { error: 'create needs `instructions`: what the agent does on each run, written to stand on its own.' };
				}
				const patch = fromArgs();
				if ('error' in patch) {
					return { error: patch.error };
				}
				const created = await this.create({ ...patch, enabled: args.enabled !== false && !!patch.triggers?.length, createdByAgent: true, ...(threadId ? { sourceThreadId: threadId } : {}) });
				return { text: `Created ${created.id}${created.enabled ? '' : ' (inactive: give it a schedule, or add event triggers on the Automations page)'}.\n${describeForAgent(created)}` };
			}
			case 'update': {
				if (!target) {
					return { error: 'update needs `automation_id`.' };
				}
				const patch = fromArgs();
				if ('error' in patch) {
					return { error: patch.error };
				}
				const updated = await this.update(target.id, patch);
				return { text: `Updated ${target.id}.\n${describeForAgent(updated!)}` };
			}
			case 'delete':
				if (!target) {
					return { error: 'delete needs `automation_id`.' };
				}
				await this.delete(target.id);
				return { text: `Deleted ${target.id}. Chats its runs started stay.` };
			case 'run_now': {
				if (!target) {
					return { error: 'run_now needs `automation_id`.' };
				}
				const runs = await this.runNow(target.id);
				return { text: runs.map(run => `Run ${run.id}: ${run.status}${run.threadId ? ` in chat ${run.threadId}` : ''}${run.error ? ` (${run.error})` : ''}`).join('\n') || 'Nothing ran.' };
			}
		}
		return { error: `Unknown action ${action}. Use create, list, update, delete or run_now.` };
	}

	/** The `automation` tool: what a run does through Volt (memory, Slack, Teams, pull requests). */
	private async act(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const threadId = call?.sessionId ? this.runtime.chatFor(call.sessionId) : undefined;
		const runId = typeof args.run_id === 'string' ? args.run_id : undefined;
		let entry: ITracked | undefined = runId ? this.automations.flatMap(automation => automation.runs.some(run => run.id === runId) ? [{ automationId: automation.id, runId }] : [])[0] : undefined;
		entry ??= threadId ? this.tracked.get(threadId)?.at(-1) : undefined;
		const automation = entry ? this.get(entry.automationId) : undefined;
		if (!entry || !automation) {
			return { error: 'The automation tool only works inside an automation run (pass the run_id from its prompt).' };
		}
		const action = String(args.action ?? '');
		const text = typeof args.text === 'string' ? args.text : '';
		const tool = (kind: 'slack_send' | 'slack_read' | 'teams_send' | 'teams_read') => automation.tools.find(candidate => candidate.kind === kind);
		const done = async (kind: AutomationRunToolKind, work: () => Promise<string>, detail?: string): Promise<IVoltHostToolResult> => {
			this.recordTool(entry, kind, 'pending', detail);
			try {
				const result = await work();
				this.recordTool(entry, kind, 'success', detail);
				return { text: result };
			} catch (err) {
				this.recordTool(entry, kind, 'failed', detail);
				return { error: errorText(err) };
			}
		};
		switch (action) {
			case 'memory_read':
				return { text: (await this.readMemory(automation.id, typeof args.file === 'string' ? args.file : undefined)) || '(empty)' };
			case 'memory_write':
			case 'memory_append': {
				const file = typeof args.file === 'string' ? args.file : MEMORY_FILE;
				const before = action === 'memory_append' ? await this.readMemory(automation.id, file) : '';
				const content = action === 'memory_append' ? `${before.replace(/\s*$/, '')}${before.trim() ? '\n' : ''}${text}\n` : text;
				await this.writeMemory(automation.id, file, content);
				return { text: `Saved ${file} (${content.length} characters).` };
			}
			case 'send_slack': {
				const slack = tool('slack_send');
				if (!slack?.url) {
					return { error: 'This automation has no Send to Slack tool with a webhook URL.' };
				}
				return done('slack', () => this.postJson(slack.url!, { text }).then(() => 'Sent to Slack.'), slack.channel);
			}
			case 'send_teams': {
				const teams = tool('teams_send');
				if (!teams?.url) {
					return { error: 'This automation has no Send to Microsoft Teams tool with a webhook URL.' };
				}
				// Works for classic connectors (text) and Workflows webhooks (an Adaptive Card).
				return done('teams', () => this.postJson(teams.url!, {
					type: 'message', text,
					attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text, wrap: true }] } }],
				}).then(() => 'Sent to Microsoft Teams.'), teams.channel);
			}
			case 'read_slack': {
				const slack = tool('slack_read');
				const channel = typeof args.channel === 'string' && args.channel ? args.channel : slack?.channel;
				if (!slack?.token || !channel) {
					return { error: 'This automation has no Read Slack tool with a bot token and channel.' };
				}
				return done('slack_read', () => this.readSlack(slack.token!, channel, typeof args.limit === 'number' ? args.limit : 50), channel);
			}
			case 'read_teams': {
				const teams = tool('teams_read');
				const channel = typeof args.channel === 'string' && args.channel ? args.channel : teams?.channel;
				if (!teams?.token || !channel) {
					return { error: 'This automation has no Read Microsoft Teams tool with a token and teamId/channelId.' };
				}
				return done('teams_read', () => this.readTeams(teams.token!, channel, typeof args.limit === 'number' ? args.limit : 30), channel);
			}
			case 'pr_comment':
			case 'open_pr':
			case 'request_reviewers': {
				const folder = threadId ? this.sessionContext.bindingFor(threadId)?.root.fsPath : undefined;
				const repo = folder ? await this.pullRequests.resolveRepo(folder) : undefined;
				if (!folder || !repo) {
					return { error: 'This run is not in a repository with a remote on a known host.' };
				}
				const number = typeof args.number === 'number' ? args.number : Number.NaN;
				if (action === 'pr_comment') {
					return Number.isInteger(number) && text ? done('pr_comment', () => this.pullRequests.comment({ repo, number, body: text }).then(() => `Commented on #${number}.`), `#${number}`) : { error: 'pr_comment needs number and text.' };
				}
				if (action === 'request_reviewers') {
					const logins = Array.isArray(args.reviewers) ? args.reviewers.filter((login): login is string => typeof login === 'string') : [];
					return Number.isInteger(number) && logins.length ? done('reviewers', () => this.pullRequests.requestReviewers({ repo, number, logins }).then(() => `Requested ${logins.join(', ')} on #${number}.`), `#${number}`) : { error: 'request_reviewers needs number and reviewers.' };
				}
				return done('pull_request', () => this.openPullRequest(folder, repo, args, text));
			}
		}
		return { error: `Unknown action ${action}.` };
	}

	private async openPullRequest(folder: string, repo: IVoltPrRepo, args: Record<string, unknown>, body: string): Promise<string> {
		const status = await this.pullRequests.gitStatus(folder);
		const head = status?.branch;
		if (!head || status?.isDefaultBranch) {
			throw new Error('Commit the change on a new branch first (not the default branch).');
		}
		const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : head;
		await this.pullRequests.push({ folder });
		const created = await this.pullRequests.create({
			repo, head, base: typeof args.base === 'string' && args.base ? args.base : status.defaultBranch ?? 'main', title, body, draft: args.draft === true,
		});
		return `Opened ${created.url}`;
	}

	private async postJson(url: string, body: unknown): Promise<void> {
		const context = await this.requestService.request({ type: 'POST', url, headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(body) }, CancellationToken.None);
		const status = context.res.statusCode ?? 0;
		if (status < 200 || status >= 300) {
			throw new Error(`The webhook answered ${status}: ${(await asText(context))?.slice(0, 300) ?? ''}`);
		}
	}

	private async readSlack(token: string, channel: string, limit: number): Promise<string> {
		const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel.replace(/^#/, ''))}&limit=${Math.min(200, Math.max(1, Math.round(limit)))}`;
		const context = await this.requestService.request({ type: 'GET', url, headers: { Authorization: `Bearer ${token}` } }, CancellationToken.None);
		const reply = await asJson<{ ok?: boolean; error?: string; messages?: { user?: string; username?: string; text?: string; ts?: string }[] }>(context);
		if (!reply?.ok) {
			throw new Error(`Slack: ${reply?.error ?? 'no answer'}`);
		}
		const lines = (reply.messages ?? []).reverse().map(message => `${message.ts ? new Date(Number(message.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ') : ''} ${message.user ?? message.username ?? '?'}: ${(message.text ?? '').replace(/\s+/g, ' ')}`);
		return clip(lines.join('\n') || '(no messages)', READ_LIMIT_CHARS);
	}

	private async readTeams(token: string, channel: string, limit: number): Promise<string> {
		const [team, id] = channel.split('/');
		if (!team || !id) {
			throw new Error('The Teams channel is teamId/channelId.');
		}
		const url = `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(team)}/channels/${encodeURIComponent(id)}/messages?$top=${Math.min(50, Math.max(1, Math.round(limit)))}`;
		const context = await this.requestService.request({ type: 'GET', url, headers: { Authorization: `Bearer ${token}` } }, CancellationToken.None);
		const reply = await asJson<{ error?: { message?: string }; value?: { createdDateTime?: string; from?: { user?: { displayName?: string } }; body?: { content?: string } }[] }>(context);
		if (!reply || reply.error) {
			throw new Error(`Microsoft Graph: ${reply?.error?.message ?? 'no answer'}`);
		}
		const lines = (reply.value ?? []).reverse().map(message => `${message.createdDateTime?.slice(0, 16).replace('T', ' ') ?? ''} ${message.from?.user?.displayName ?? '?'}: ${(message.body?.content ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')}`);
		return clip(lines.join('\n') || '(no messages)', READ_LIMIT_CHARS);
	}

	//#endregion
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(text.length - max)}\n(older messages cut)` : text;
}

/** The `automation` actions a run has, from its tools (pull request actions need a repository). */
export function runActions(automation: Pick<IAutomation, 'tools'>, inRepository: boolean): string[] {
	const actions: string[] = [];
	const has = (kind: string) => automation.tools.some(tool => tool.kind === kind);
	if (has('memories')) {
		actions.push('memory_read', 'memory_write', 'memory_append');
	}
	if (has('slack_send')) {
		actions.push('send_slack');
	}
	if (has('slack_read')) {
		actions.push('read_slack');
	}
	if (has('teams_send')) {
		actions.push('send_teams');
	}
	if (has('teams_read')) {
		actions.push('read_teams');
	}
	if (inRepository) {
		actions.push('pr_comment', 'open_pr', 'request_reviewers');
	}
	return actions;
}

/** The MCP server behind an agent's tool name (`mcp__aws-docs__search`, `aws-docs: search`), if it is one. */
export function mcpServerOf(name: string, title: string | undefined, configured: readonly string[]): string | undefined {
	const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
	for (const raw of [name, title ?? '']) {
		const claude = /^mcp__(.+?)__/.exec(raw);
		if (claude && claude[1] !== 'volt') {
			return configured.find(server => norm(server) === norm(claude[1])) ?? claude[1];
		}
		const colon = /^([^:\s]+):\s/.exec(raw);
		const match = configured.find(server => norm(server) === norm(colon?.[1] ?? '') || norm(raw).startsWith(norm(server)));
		if (match) {
			return match;
		}
	}
	return undefined;
}

function describeForAgent(automation: IAutomation): string {
	const lines = [
		`automation_id: ${automation.id}`,
		`name: ${automation.name}`,
		`status: ${automation.enabled ? 'active' : 'inactive'}`,
		`triggers: ${automation.triggers.map(trigger => trigger.provider === 'schedule' && trigger.schedule ? describeSchedule(trigger.schedule) : `${trigger.provider} ${trigger.event}`).join('; ') || 'none'}`,
		`repositories: ${automation.repositories.map(repo => repo.name).join(', ') || 'none'}`,
	];
	const last = automation.runs.filter(run => run.status !== 'skipped').at(-1);
	if (last) {
		lines.push(`last run: ${new Date(last.at).toISOString()} ${last.status}${last.error ? ` (${last.error})` : ''}`);
	}
	lines.push(`instructions: ${automation.instructions.length > 400 ? `${automation.instructions.slice(0, 400)}…` : automation.instructions}`);
	return lines.join('\n');
}

const [MANAGE_TOOL, ACTION_TOOL] = AUTOMATION_TOOL_NAMES;

export const AUTOMATION_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: MANAGE_TOOL,
		title: 'Automations',
		group: 'tasks',
		description: 'Volt automations: an agent with instructions that runs on a schedule or on events (GitHub, Slack, Teams, Sentry, Linear, PagerDuty, webhooks), each run in a new chat. action: create | list | update | delete | run_now. create/update take name, instructions, schedule ("daily at 09:00", "weekdays at 18:30", "hourly at :15", "every 2 hours", or cron "0 9 * * 1-5"), repository ("this" for this chat\'s project, or "none"), enabled. Event triggers need a URL set up in the sender: point the user to the Automations page for those.',
		inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['create', 'list', 'update', 'delete', 'run_now'] },
				automation_id: { type: 'string' },
				name: { type: 'string' },
				instructions: { type: 'string', description: 'What the agent does on each run, written so it stands on its own.' },
				schedule: { type: 'string' },
				repository: { type: 'string', enum: ['this', 'none'] },
				enabled: { type: 'boolean' },
			},
			required: ['action'],
		},
	},
	{
		name: ACTION_TOOL,
		title: 'Automation action',
		group: 'tasks',
		description: 'Only inside an automation run; its prompt lists the actions it has and its run_id. memory_read/memory_write/memory_append (MEMORIES.md, or `file`), send_slack/send_teams (text), read_slack/read_teams (channel, limit), pr_comment (number, text), open_pr (title, text as body, base, draft; push your branch first), request_reviewers (number, reviewers).',
		inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['memory_read', 'memory_write', 'memory_append', 'send_slack', 'read_slack', 'send_teams', 'read_teams', 'pr_comment', 'open_pr', 'request_reviewers'] },
				run_id: { type: 'string' },
				text: { type: 'string' },
				file: { type: 'string' },
				channel: { type: 'string' },
				limit: { type: 'number' },
				number: { type: 'number' },
				title: { type: 'string' },
				base: { type: 'string' },
				draft: { type: 'boolean' },
				reviewers: { type: 'array', items: { type: 'string' } },
			},
			required: ['action'],
		},
	},
];
