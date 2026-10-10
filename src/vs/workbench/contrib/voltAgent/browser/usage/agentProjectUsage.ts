/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler, Sequencer, Throttler, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IVoltTokenRates, IVoltUsageService } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IAgentHistoryService, IAgentSessionMeta, IAgentSessionTranscript, IAgentSessionTruncation, IAgentSessionTurn } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { canonicalProjectRoot, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { buildSessionUsage, ISessionUsageMessage, ISessionUsageModelRef, ISessionUsageOptions, sessionModelIds } from '../context/agentSessionUsage.js';

/**
 * What every chat in a project has spent: tokens, cost and agent time, for Project Settings.
 * Each chat's totals are kept in application storage under its id, so deleting a chat (or
 * editing and resending, which drops turns) leaves its spend in the project's totals.
 */

const STORAGE_KEY = 'volt.projects.usage.v1';
/** After a burst of history changes (a streaming reply), count once. */
const REFRESH_DELAY_MS = 1500;

export interface IProjectUsageTally {
	readonly turns: number;
	readonly tokens: number;
	readonly costUsd: number;
	/** Turns with tokens but no price: the agent reported none and the model has no list price. */
	readonly unpricedTurns: number;
	/** Time agents spent answering, summed over replies. */
	readonly activeMs: number;
}

export interface IProjectUsageRecord {
	/** The project's folder, canonical, as a URI string. */
	readonly root: string;
	readonly subagent?: true;
	readonly createdAt: number;
	/** The chat's `updatedAt` when it was last counted. */
	readonly countedAt: number;
	/** The turns the chat has. */
	readonly live: IProjectUsageTally;
	/** Turns the chat dropped. They were still spent. */
	readonly retired?: IProjectUsageTally;
	/** When this copy was written. Between windows the newer copy of a chat wins. */
	readonly writtenAt: number;
}

export interface IProjectUsageTotals extends IProjectUsageTally {
	/** Chats started in the project; subagents' spend counts, their chats do not. */
	readonly chats: number;
	/** Counted chats that are no longer in history. */
	readonly deletedChats: number;
	/** When the first counted chat started. */
	readonly since?: number;
}

export const EMPTY_TALLY: IProjectUsageTally = { turns: 0, tokens: 0, costUsd: 0, unpricedTurns: 0, activeMs: 0 };

export function addTallies(a: IProjectUsageTally, b: IProjectUsageTally | undefined): IProjectUsageTally {
	if (!b) {
		return a;
	}
	return {
		turns: a.turns + b.turns,
		tokens: a.tokens + b.tokens,
		costUsd: a.costUsd + b.costUsd,
		unpricedTurns: a.unpricedTurns + b.unpricedTurns,
		activeMs: a.activeMs + b.activeMs,
	};
}

/** The key a project's chats are filed under: its folder, the way project ids are derived from it. */
export function projectUsageRoot(root: URI): string {
	return canonicalProjectRoot(root).toString();
}

/** The project a chat belongs to, from the folder recorded in its log. */
export function sessionUsageRoot(meta: Pick<IAgentSessionMeta, 'workspaceFolder'>): string | undefined {
	return meta.workspaceFolder ? projectUsageRoot(uriFromStoredRoot(meta.workspaceFolder)) : undefined;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** A stored reply as the Session Usage summary reads it. */
function replyMessage(turn: IAgentSessionTurn): (ISessionUsageMessage & { readonly startedAt?: number; readonly endedAt?: number }) | undefined {
	const message = turn.assistant?.message;
	return message && typeof message === 'object' ? { ...(message as object), kind: 'agent' } : undefined;
}

function replyMs(reply: { readonly durationMs?: number; readonly startedAt?: number; readonly endedAt?: number }): number {
	if (isFiniteNumber(reply.durationMs) && reply.durationMs >= 0) {
		return reply.durationMs;
	}
	return isFiniteNumber(reply.startedAt) && isFiniteNumber(reply.endedAt) && reply.endedAt >= reply.startedAt ? reply.endedAt - reply.startedAt : 0;
}

/** The replies of these turns as messages the Session Usage summary prices. */
export function turnUsageMessages(turns: readonly IAgentSessionTurn[]): ISessionUsageMessage[] {
	const messages: ISessionUsageMessage[] = [];
	for (const turn of turns) {
		messages.push({ kind: 'user', id: turn.id, text: turn.user.text });
		const reply = replyMessage(turn);
		if (reply) {
			messages.push(reply);
		}
	}
	return messages;
}

/** Tokens, cost and agent time of these turns, priced like the Session Usage panel. */
export function tallyTurns(turns: readonly IAgentSessionTurn[], options: ISessionUsageOptions): IProjectUsageTally {
	if (!turns.length) {
		return EMPTY_TALLY;
	}
	const summary = buildSessionUsage(turnUsageMessages(turns), options);
	let activeMs = 0;
	for (const turn of turns) {
		const reply = replyMessage(turn);
		activeMs += reply ? replyMs(reply) : 0;
	}
	return { turns: turns.length, tokens: summary.total, costUsd: summary.costUsd, unpricedTurns: summary.unpricedTurns, activeMs };
}

/** A fork starts with copies of its source's turns; those were spent in the source chat. */
export function forkCopiedTurns(transcript: Pick<IAgentSessionTranscript, 'forkOf'>): number {
	return Math.max(0, transcript.forkOf?.turns ?? 0);
}

/** Every chat filed under `root`, summed. */
export function projectUsageTotals(records: ReadonlyMap<string, IProjectUsageRecord>, root: string, exists: (sessionId: string) => boolean): IProjectUsageTotals {
	let tally = EMPTY_TALLY;
	let chats = 0;
	let deletedChats = 0;
	let since: number | undefined;
	for (const [sessionId, record] of records) {
		if (record.root !== root) {
			continue;
		}
		tally = addTallies(addTallies(tally, record.live), record.retired);
		if (record.subagent || record.live.turns + (record.retired?.turns ?? 0) === 0) {
			continue;
		}
		chats++;
		if (!exists(sessionId)) {
			deletedChats++;
		}
		since = since === undefined ? record.createdAt : Math.min(since, record.createdAt);
	}
	return { ...tally, chats, deletedChats, ...(since !== undefined ? { since } : {}) };
}

function isTally(value: unknown): value is IProjectUsageTally {
	const tally = value as Partial<IProjectUsageTally> | undefined;
	return !!tally && typeof tally === 'object'
		&& isFiniteNumber(tally.turns) && isFiniteNumber(tally.tokens) && isFiniteNumber(tally.costUsd)
		&& isFiniteNumber(tally.unpricedTurns) && isFiniteNumber(tally.activeMs);
}

export function parseProjectUsage(raw: string | undefined): Map<string, IProjectUsageRecord> {
	const records = new Map<string, IProjectUsageRecord>();
	if (!raw) {
		return records;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return records;
	}
	const sessions = (parsed as { sessions?: unknown } | undefined)?.sessions;
	if (!sessions || typeof sessions !== 'object') {
		return records;
	}
	for (const [id, value] of Object.entries(sessions)) {
		const record = value as Partial<IProjectUsageRecord>;
		if (typeof record?.root !== 'string' || !isTally(record.live) || !isFiniteNumber(record.countedAt) || !isFiniteNumber(record.writtenAt)) {
			continue;
		}
		records.set(id, {
			root: record.root,
			...(record.subagent ? { subagent: true } : {}),
			createdAt: isFiniteNumber(record.createdAt) ? record.createdAt : record.countedAt,
			countedAt: record.countedAt,
			live: record.live,
			...(isTally(record.retired) ? { retired: record.retired } : {}),
			writtenAt: record.writtenAt,
		});
	}
	return records;
}

/** Another window's copy of a chat replaces ours when it was written later. Returns whether anything changed. */
export function mergeProjectUsage(into: Map<string, IProjectUsageRecord>, from: ReadonlyMap<string, IProjectUsageRecord>): boolean {
	let changed = false;
	for (const [id, record] of from) {
		const current = into.get(id);
		if (!current || record.writtenAt > current.writtenAt) {
			into.set(id, record);
			changed = true;
		}
	}
	return changed;
}

export const IAgentProjectUsageService = createDecorator<IAgentProjectUsageService>('agentProjectUsageService');

export interface IAgentProjectUsageService {
	readonly _serviceBrand: undefined;
	/** Fires after counted chats change. */
	readonly onDidChange: Event<void>;
	totals(root: URI): IProjectUsageTotals;
	/** Counts every chat that changed since it was last counted. */
	refresh(): Promise<void>;
}

export class AgentProjectUsageService extends Disposable implements IAgentProjectUsageService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly records: Map<string, IProjectUsageRecord>;
	private readonly rates = new Map<string, IVoltTokenRates | null>();
	private readonly throttler = this._register(new Throttler());
	/** Counting and dropped turns write the same records, one at a time. */
	private readonly sequencer = new Sequencer();
	private readonly scheduler = this._register(new RunOnceScheduler(() => void this.refresh(), REFRESH_DELAY_MS));

	constructor(
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IStorageService private readonly storageService: IStorageService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.records = parseProjectUsage(this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION));
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, STORAGE_KEY, this._store)(() => {
			if (mergeProjectUsage(this.records, parseProjectUsage(this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION)))) {
				this._onDidChange.fire();
			}
		}));
		this._register(history.onDidChange(() => this.scheduler.schedule()));
		this._register(history.onDidTruncate(truncation => {
			this.sequencer.queue(() => this.retire(truncation)).catch(err => this.logService.warn(`[project usage] could not keep dropped turns of ${truncation.sessionId}`, err));
		}));
		// The first pass counts chats from before this existed, one log at a time.
		void history.whenReady.then(() => this.scheduler.schedule());
	}

	totals(root: URI): IProjectUsageTotals {
		return projectUsageTotals(this.records, projectUsageRoot(root), id => !!this.history.get(id));
	}

	refresh(): Promise<void> {
		return this.throttler.queue(() => this.sequencer.queue(() => this.countChangedChats()));
	}

	private async countChangedChats(): Promise<void> {
		await this.history.whenReady;
		const stale = this.history.list({ includeArchived: true }).filter(meta => {
			const record = this.records.get(meta.id);
			return meta.turnCount > 0 && (!record || record.countedAt < meta.updatedAt);
		});
		let changed = false;
		for (const meta of stale) {
			const root = sessionUsageRoot(meta);
			if (!root) {
				continue;
			}
			try {
				const transcript = await this.history.readTranscript(meta.id);
				if (!transcript) {
					continue;
				}
				const live = await this.tally(transcript.turns.slice(forkCopiedTurns(transcript)), transcript);
				const previous = this.records.get(meta.id);
				this.records.set(meta.id, {
					root,
					...(meta.subagent ? { subagent: true } : {}),
					createdAt: meta.createdAt,
					countedAt: meta.updatedAt,
					live,
					...(previous?.retired ? { retired: previous.retired } : {}),
					writtenAt: Date.now(),
				});
				changed = true;
			} catch (err) {
				this.logService.warn(`[project usage] could not count ${meta.id}`, err);
			}
			// Backfilling many logs must not hold the window.
			await timeout(0);
		}
		if (changed) {
			this.save();
		}
	}

	/** Dropped turns stay counted: they were billed. A fork's copied turns were counted in their source. */
	private async retire(truncation: IAgentSessionTruncation): Promise<void> {
		const meta = this.history.get(truncation.sessionId);
		const root = meta ? sessionUsageRoot(meta) : this.records.get(truncation.sessionId)?.root;
		if (!root) {
			return;
		}
		const transcript = await this.history.readTranscript(truncation.sessionId).catch(() => undefined);
		const copied = transcript ? forkCopiedTurns(transcript) : 0;
		const dropped = truncation.turns.slice(Math.max(0, copied - truncation.index));
		if (!dropped.length) {
			return;
		}
		const spent = await this.tally(dropped, transcript);
		const previous = this.records.get(truncation.sessionId);
		this.records.set(truncation.sessionId, {
			root,
			...(meta?.subagent ? { subagent: true } : {}),
			createdAt: previous?.createdAt ?? meta?.createdAt ?? Date.now(),
			// Recount the live turns: the dropped ones are no longer among them.
			countedAt: 0,
			live: previous?.live ?? EMPTY_TALLY,
			retired: addTallies(previous?.retired ?? EMPTY_TALLY, spent),
			writtenAt: Date.now(),
		});
		this.save();
		this.scheduler.schedule();
	}

	private async tally(turns: readonly IAgentSessionTurn[], transcript: IAgentSessionTranscript | undefined): Promise<IProjectUsageTally> {
		const catalog = this.runtime.listCatalog();
		const describe = (ref: string) => catalog.find(item => item.ref === ref);
		// Replies from before turns kept their model fall back to the chat's model, stored by label.
		const chatModel = transcript?.model ? catalog.find(item => item.label === transcript.model) : undefined;
		const fallbackModel: ISessionUsageModelRef | undefined = chatModel ? { ref: chatModel.ref, id: chatModel.id, label: chatModel.label } : undefined;
		const options: ISessionUsageOptions = { rates: id => this.rates.get(id) ?? undefined, describe, fallbackModel };
		await this.loadRates(sessionModelIds(turnUsageMessages(turns), options));
		return tallyTurns(turns, options);
	}

	/** List prices from the usage service (main process) for turns the agent did not price. */
	private async loadRates(ids: readonly string[]): Promise<void> {
		const missing = ids.filter(id => !this.rates.has(id));
		if (!missing.length) {
			return;
		}
		const usage = this.instantiationService.invokeFunction(accessor => accessor.getIfExists(IVoltUsageService));
		const none: Record<string, IVoltTokenRates | null> = {};
		const rates = usage ? await usage.getModelRates(missing).catch(() => none) : none;
		for (const id of missing) {
			this.rates.set(id, rates[id] ?? null);
		}
	}

	private save(): void {
		const stored = parseProjectUsage(this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION));
		// Keep what another window counted since we last read.
		mergeProjectUsage(this.records, stored);
		this.storageService.store(STORAGE_KEY, JSON.stringify({ version: 1, sessions: Object.fromEntries(this.records) }), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}
}

registerSingleton(IAgentProjectUsageService, AgentProjectUsageService, InstantiationType.Delayed);

/** Starts counting at startup, so chats deleted before Project Settings is ever opened are counted. */
class AgentProjectUsageContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltAgentProjectUsage';

	constructor(@IAgentProjectUsageService _usage: IAgentProjectUsageService) { }
}

registerWorkbenchContribution2(AgentProjectUsageContribution.ID, AgentProjectUsageContribution, WorkbenchPhase.Eventually);
