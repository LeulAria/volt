/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { hash } from '../../../../../base/common/hash.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { cloudAgentForFamily, cloudTaskStatusText, ICloudTask, isCloudTaskActive } from '../../common/cloud/cloudTasks.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../common/hostTools.js';
import { blindLabel, blindOrder, describeSpend, formatUsd, isLiveTaskState, isTerminalTaskState, normalizeTaskRole, stringListArg, TASK_WAIT_MS } from '../../common/orchestration/agentTasks.js';
import { clip, describeModelCatalog, matchCatalogModel } from '../../common/orchestration/agentThreadTools.js';
import { describeMachine, IMachineCapacity, ORCH_MACHINE_CAPACITY_SETTING, parseMachineCapacity, parseParallelAnswer, planParallel } from '../../common/orchestration/machineCapacity.js';
import {
	buildMemberBrief, COUNCIL_MAX_ROUNDS, COUNCIL_MAX_SEATS, COUNCIL_TOOL_NAME, councilAnswerBrief, councilReviewBrief, councilVerdictBrief, describeMachineRow, fillTemplate, IOrchestraMachine,
	localMachine, MACHINE_RUN_TOOL_NAME, MAX_UPSTREAM, memberBase, memberNames, ORCHESTRA_COUNCIL_MODERATOR_SETTING, ORCHESTRA_COUNCIL_PARTICIPANTS_SETTING, ORCHESTRA_STATUS_TOOL_NAME,
	ORCHESTRA_TOOLS, parseRanking, resolveMachine, rosterSizes, runnerMachine, SPAWN_TEAM_TOOL_NAME, splitItems, tallyRankings, TEAM_BOARD_TOOL_NAME, TEAM_SEND_TOOL_NAME,
} from '../../common/orchestration/orchestra.js';
import { IAgentOrchestratorService, IOrchPrompt, IOrchSpawnOutcome, IOrchTask, IOrchThread, readOrchLimits } from '../../common/orchestration/orchestrator.js';
import { applyBoardOp, BoardOp, boardCounts, describeBoard, describeBoardCounts, ITeamBoard, ITeamMemberRecord, newTeamBoard, normalizeNoteKind, parseBoardItems, parseTeamBoard } from '../../common/orchestration/teamBoard.js';
import { IVoltCatalogItem } from '../../common/providers.js';
import { IAgentRuntimeService } from '../../common/runtime.js';
import { IVoltSessionContextService } from '../../common/sessionContext.js';
import { IAgentCloudTasksService } from '../cloud/agentCloudTasksService.js';
import { providerFamily } from '../providers/providerFamily.js';

export const IAgentOrchestraService = createDecorator<IAgentOrchestraService>('agentOrchestraService');

/**
 * Teams, councils and machines for agents (see `common/orchestration/orchestra.ts`). It serves the
 * orchestra tools where the agents run (the agent server, or a window running its own) and keeps
 * team boards on disk next to the orchestrator's state.
 */
export interface IAgentOrchestraService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** Teams and councils of the chat's request (its root chat), newest first. */
	teamsOf(threadId: string): readonly ITeamBoard[];
}

/** How long one call waits for the user's "how many at once" answer before asking the agent to call again. */
const ASK_WAIT_MS = 40_000;
/** Messages one chat may send to teammates in one of its turns. */
const MAX_TEAM_SENDS_PER_TURN = 120;
const TEAM_MESSAGE_CHARS = 8_000;
/** Finished teams' boards are kept this long (their tasks' chats stay in history). */
const BOARD_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const RUNNERS_TIMEOUT_MS = 4_000;
const MACHINE_RUN_ATTEMPTS = 3;

interface ICaller {
	readonly threadId: string;
	readonly thread: IOrchThread | undefined;
	/** The task this chat runs (a member or a subagent). */
	readonly task: IOrchTask | undefined;
	readonly rootId: string;
}

interface IMachineRunRecord {
	readonly id: string;
	readonly threadId: string;
	readonly title: string;
	readonly createdAt: number;
	readonly notified: boolean;
	readonly attempts: number;
}

interface IPendingAsk {
	readonly requestId: string;
	readonly at: number;
}

const ATOMIC = { atomic: { postfix: '.tmp' } } as const;

/** Boards and machine runs on disk: one file per team, written whole and atomically, never two writes to one file at once. */
class OrchestraStore {

	private readonly chains = new Map<string, Promise<void>>();

	constructor(private readonly home: URI, private readonly fileService: IFileService, private readonly logService: ILogService) { }

	private boardFile(id: string): URI {
		return joinPath(this.home, 'teams', `${id}.json`);
	}

	private get runsFile(): URI {
		return joinPath(this.home, 'machineRuns.json');
	}

	async loadBoards(): Promise<ITeamBoard[]> {
		try {
			const stat = await this.fileService.resolve(joinPath(this.home, 'teams'));
			const files = (stat.children ?? []).filter(child => child.isFile && child.name.endsWith('.json'));
			const boards = await Promise.all(files.map(async file => parseTeamBoard(await this.readJson(file.resource))));
			return boards.filter((board): board is ITeamBoard => !!board);
		} catch (err) {
			if (!isNotFound(err)) {
				this.logService.warn('[volt orchestra] could not read team boards', err);
			}
			return [];
		}
	}

	saveBoard(board: ITeamBoard): Promise<void> {
		return this.write(board.id, this.boardFile(board.id), board);
	}

	deleteBoard(id: string): Promise<void> {
		return this.chain(id, async () => {
			await this.fileService.del(this.boardFile(id)).catch(() => undefined);
		});
	}

	async loadRuns(): Promise<IMachineRunRecord[]> {
		const raw = await this.readJson(this.runsFile);
		return (Array.isArray(raw) ? raw : []).flatMap((entry): IMachineRunRecord[] => {
			const run = entry as Record<string, unknown> | undefined;
			return run && typeof run.id === 'string' && typeof run.threadId === 'string'
				? [{ id: run.id, threadId: run.threadId, title: typeof run.title === 'string' ? run.title : 'Machine run', createdAt: typeof run.createdAt === 'number' ? run.createdAt : 0, notified: run.notified === true, attempts: typeof run.attempts === 'number' ? run.attempts : 0 }]
				: [];
		});
	}

	saveRuns(runs: readonly IMachineRunRecord[]): Promise<void> {
		return this.write('machineRuns', this.runsFile, runs);
	}

	private write(key: string, file: URI, value: unknown): Promise<void> {
		return this.chain(key, async () => {
			try {
				await this.fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(value)), ATOMIC);
			} catch (err) {
				this.logService.warn(`[volt orchestra] could not save ${key}`, err);
			}
		});
	}

	private chain(key: string, run: () => Promise<void>): Promise<void> {
		const next = (this.chains.get(key) ?? Promise.resolve()).then(run, run);
		this.chains.set(key, next);
		return next;
	}

	private async readJson(file: URI): Promise<unknown> {
		try {
			return JSON.parse((await this.fileService.readFile(file)).value.toString());
		} catch (err) {
			if (!isNotFound(err)) {
				this.logService.warn(`[volt orchestra] ignoring unreadable ${file.path}`, err);
			}
			return undefined;
		}
	}
}

function isNotFound(err: unknown): boolean {
	return err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND
		|| (typeof err === 'object' && !!err && (err as { code?: unknown }).code === 'FileNotFound');
}

function str(value: unknown, max = 4_000): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class AgentOrchestraService extends Disposable implements IAgentOrchestraService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly boards = new Map<string, ITeamBoard>();
	private runs: IMachineRunRecord[] = [];
	private readonly store: OrchestraStore | undefined;
	private readonly loaded: Promise<void>;
	/** Open "how many at once" questions, by the spawn they belong to. */
	private readonly asks = new Map<string, IPendingAsk>();
	/** Team messages per caller turn (`<chat>:<turn>`). */
	private readonly sends = new Map<string, number>();
	private readonly cloudTasks: IAgentCloudTasksService | undefined;

	constructor(
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IFileService fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// A window whose agents run in the agent server mirrors its orchestrator: the server serves these tools.
		if (!orchestrator.spawnTasks) {
			this.loaded = Promise.resolve();
			return;
		}
		this.cloudTasks = instantiationService.invokeFunction(accessor => accessor.getIfExists(IAgentCloudTasksService));
		this.store = new OrchestraStore(joinPath(environmentService.userRoamingDataHome, 'voltOrchestrator', 'orchestra'), fileService, logService);
		this.loaded = this.load();
		this._register(hostTools.registerToolProvider({ tools: ORCHESTRA_TOOLS, invoke: (name, args, call) => this.invoke(name, args, call) }));
		this._register(orchestrator.onDidChangeTasks(ids => void this.loaded.then(() => this.onTasksChanged(ids))));
		if (this.cloudTasks) {
			this._register(this.cloudTasks.onDidChange(() => void this.loaded.then(() => this.deliverMachineRuns())));
		}
	}

	private async load(): Promise<void> {
		if (!this.store) {
			return;
		}
		const [boards, runs] = await Promise.all([this.store.loadBoards(), this.store.loadRuns()]);
		const now = Date.now();
		for (const board of boards) {
			// Old boards whose members are all gone leave; the chats stay in history.
			if (now - board.updatedAt > BOARD_TTL_MS && !board.members.some(member => isLiveTaskState(this.orchestrator.getTask(member.taskId)?.state ?? 'completed'))) {
				void this.store.deleteBoard(board.id);
				continue;
			}
			this.boards.set(board.id, board);
		}
		this.runs = runs.filter(run => !run.notified || now - run.createdAt < BOARD_TTL_MS);
		this._onDidChange.fire();
	}

	teamsOf(threadId: string): readonly ITeamBoard[] {
		const rootId = this.orchestrator.getThread(threadId)?.rootId ?? threadId;
		return [...this.boards.values()].filter(board => board.rootId === rootId || board.leadId === threadId).sort((a, b) => b.createdAt - a.createdAt);
	}

	//#region Tools

	private async invoke(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const threadId = call?.sessionId ? this.runtime.chatFor(call.sessionId) : undefined;
		if (!threadId || !call?.sessionId) {
			return { error: `${name} only works from a Volt chat.` };
		}
		await Promise.all([this.loaded, this.orchestrator.whenReady]);
		await this.orchestrator.ensureThreadLoaded(threadId);
		const caller = this.caller(threadId);
		const token = call.token ?? CancellationToken.None;
		try {
			switch (name) {
				case ORCHESTRA_STATUS_TOOL_NAME: return await this.status(caller, args);
				case SPAWN_TEAM_TOOL_NAME: return await this.spawnTeam(caller, args, call.sessionId, token);
				case TEAM_SEND_TOOL_NAME: return await this.teamSend(caller, args, token);
				case TEAM_BOARD_TOOL_NAME: return await this.teamBoard(caller, args);
				case COUNCIL_TOOL_NAME: return await this.council(caller, args, token);
				case MACHINE_RUN_TOOL_NAME: return await this.machineRun(caller, args);
			}
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
		return { error: `Unknown tool ${name}` };
	}

	private caller(threadId: string): ICaller {
		const thread = this.orchestrator.getThread(threadId);
		const task = thread?.taskId ? this.orchestrator.getTask(thread.taskId) : undefined;
		return { threadId, thread, task, rootId: thread?.rootId ?? threadId };
	}

	private limits() {
		return readOrchLimits(key => this.configurationService.getValue<unknown>(key));
	}

	/** The machine's measured capacity, or the limits when it was never measured (web, a fresh agent server). */
	private capacity(): IMachineCapacity {
		const measured = parseMachineCapacity(this.configurationService.getValue<unknown>(ORCH_MACHINE_CAPACITY_SETTING));
		if (measured) {
			return measured;
		}
		const limits = this.limits();
		return { recommended: limits.runningPerParent, max: limits.runningTotal, memoryMb: 0, cpus: 0, perAgentMb: 0, reservedMb: 0, measuredAt: 0 };
	}

	private runningAgents(): number {
		return Object.values(this.orchestrator.getState().tasks).filter(task => task.source === 'volt' && (task.state === 'running' || task.state === 'waiting')).length;
	}

	private machineName(): string {
		return isMacintosh ? 'This Mac' : 'This PC';
	}

	private catalog(): IVoltCatalogItem[] {
		return this.runtime.listCatalog().filter(item => item.enabled);
	}

	private resolveModel(value: string): IVoltCatalogItem {
		const match = matchCatalogModel(this.catalog(), value);
		if (!match) {
			throw new Error(`No connected model matches "${value}". orchestra_status lists the models by provider.`);
		}
		return match;
	}

	private async machines(): Promise<IOrchestraMachine[]> {
		const capacity = parseMachineCapacity(this.configurationService.getValue<unknown>(ORCH_MACHINE_CAPACITY_SETTING));
		const list = [localMachine(this.machineName(), capacity, this.runningAgents())];
		if (this.cloudTasks) {
			const runners = await Promise.race([
				this.cloudTasks.runners().catch(() => []),
				new Promise<[]>(resolve => setTimeout(() => resolve([]), RUNNERS_TIMEOUT_MS)),
			]);
			const now = Date.now();
			list.push(...runners.map(machine => runnerMachine(machine, now)));
		}
		return list;
	}

	//#endregion

	//#region orchestra_status

	private async status(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const teamId = str(args.team_id, 80);
		if (teamId) {
			const board = this.boardFor(caller, teamId);
			return { text: this.describeTeam(board, true) };
		}
		const limits = this.limits();
		const capacity = this.capacity();
		const running = this.runningAgents();
		const lines: string[] = ['## This machine'];
		lines.push(`${this.machineName()}${capacity.memoryMb ? ` · ${describeMachine(capacity)}` : ''}: runs ${capacity.recommended} agents at once comfortably, ${capacity.max} at most. ${running} running now. Limits: ${limits.runningPerParent} per chat, ${limits.runningTotal} in total; a request may start ${limits.maxTeamAgents} team members. More at once than the comfortable number asks the user first.`);
		const root = this.orchestrator.getThread(caller.rootId);
		const spend = describeSpend(root?.spend, limits);
		lines.push(limits.budgetUsd > 0 ? `Budget: subagents of one request may spend ${formatUsd(limits.budgetUsd)} together (setting volt.agent.multitask.budgetUsd).${spend ? ` ${spend}` : ''}` : spend ?? 'Budget: no limit on subagent spend.');
		lines.push('', '## Agents and models (pass the id or label as `model`)');
		lines.push(...describeModelCatalog(this.catalog(), caller.thread?.modelRef));
		lines.push('', '## Machines');
		const machines = await this.machines();
		lines.push(...machines.map(describeMachineRow));
		if (machines.length === 1) {
			lines.push('No remote servers are connected (the user adds them in Settings > Orchestration).');
		}
		const teams = this.teamsOf(caller.threadId);
		lines.push('', '## Teams and councils of this request');
		lines.push(...(teams.length ? teams.map(board => this.describeTeam(board, false)) : ['None yet.']));
		return { text: lines.join('\n') };
	}

	private memberStates(board: ITeamBoard): { readonly running: number; readonly queued: number; readonly done: number; readonly failed: number } {
		const counts = { running: 0, queued: 0, done: 0, failed: 0 };
		for (const member of board.members) {
			const state = this.orchestrator.getTask(member.taskId)?.state;
			if (state === 'running' || state === 'waiting') {
				counts.running++;
			} else if (state === 'queued') {
				counts.queued++;
			} else if (state === 'completed' || state === undefined) {
				counts.done++;
			} else {
				counts.failed++;
			}
		}
		return counts;
	}

	private describeTeam(board: ITeamBoard, full: boolean): string {
		const states = this.memberStates(board);
		const head = `- ${board.kind === 'council' ? 'Council' : 'Team'} "${board.name}" (team_id: ${board.id}) · ${board.members.length} members: ${[states.running && `${states.running} running`, states.queued && `${states.queued} queued`, states.done && `${states.done} done`, states.failed && `${states.failed} failed or stopped`].filter(Boolean).join(', ') || 'none started'}${board.parallel ? ` · ${board.parallel} at a time` : ''}${board.items.length ? ` · ${describeBoardCounts(board)}` : ''}`;
		const lines = [head];
		if (board.kind === 'council' && board.seats?.length) {
			const reviews = board.members.filter(member => member.role === 'review').map(member => parseRanking(this.orchestrator.getTask(member.taskId)?.result)).filter(ranking => ranking.length);
			const tally = tallyRankings(reviews);
			if (tally.length) {
				const model = (label: string) => board.seats!.find(seat => seat.label === label)?.model ?? '?';
				lines.push(`  Ranking so far (${reviews.length} reviews): ${tally.map(entry => `Response ${entry.label} (${model(entry.label)}) ${entry.mean.toFixed(1)}`).join(' · ')}`);
			}
		}
		if (full) {
			lines.push(describeBoard(board, { notes: 30, results: true }));
			for (const member of board.members) {
				const task = this.orchestrator.getTask(member.taskId);
				lines.push(`- ${member.name} [${member.taskId}] ${task?.state ?? 'finished'}${member.modelLabel ? ` · ${member.modelLabel}` : ''}${task?.activity && isLiveTaskState(task.state) ? ` · ${task.activity}` : ''}`);
			}
		}
		return lines.join('\n');
	}

	//#endregion

	//#region Boards

	private boardFor(caller: ICaller, teamId: string | undefined): ITeamBoard {
		if (teamId) {
			const board = this.boards.get(teamId);
			if (!board || (board.rootId !== caller.rootId && board.leadId !== caller.threadId && !board.members.some(member => member.taskId === caller.task?.id))) {
				throw new Error(`No team ${teamId} in this request. orchestra_status lists them.`);
			}
			return board;
		}
		const own = caller.task?.team ? this.boards.get(caller.task.team) : undefined;
		if (own) {
			return own;
		}
		const led = [...this.boards.values()].filter(board => board.leadId === caller.threadId).sort((a, b) => b.createdAt - a.createdAt);
		const live = led.filter(board => board.members.some(member => isLiveTaskState(this.orchestrator.getTask(member.taskId)?.state ?? 'completed')));
		const pick = live.length === 1 ? live[0] : !live.length && led.length ? led[0] : undefined;
		if (!pick) {
			throw new Error(led.length ? `This chat leads ${live.length} running teams: pass team_id (${live.map(board => `${board.id} "${board.name}"`).join(', ')}).` : 'You are not on a team, and this chat started none. Start one with spawn_team.');
		}
		return pick;
	}

	private async updateBoard(board: ITeamBoard, op: BoardOp): Promise<ReturnType<typeof applyBoardOp>> {
		// Applied against the latest copy, in order: two members claiming at once get different items.
		const current = this.boards.get(board.id) ?? board;
		const step = applyBoardOp(current, op, Date.now());
		if (!step.error && step.board !== current) {
			this.boards.set(step.board.id, step.board);
			this._onDidChange.fire();
			await this.store?.saveBoard(step.board);
		}
		return step;
	}

	private memberOf(board: ITeamBoard, caller: ICaller): ITeamMemberRecord | undefined {
		const task = caller.task;
		if (!task) {
			return undefined;
		}
		const listed = board.members.find(member => member.taskId === task.id);
		if (listed || task.team !== board.id) {
			return listed;
		}
		// A member whose first call lands before spawn_team saved the roster: its name is in its title.
		const cut = task.title.lastIndexOf(' · ');
		return { name: cut > 0 ? task.title.slice(0, cut) : task.title, taskId: task.id, ...(task.childId ? { childId: task.childId } : {}) };
	}

	private authorName(board: ITeamBoard, caller: ICaller): string {
		return this.memberOf(board, caller)?.name ?? (caller.threadId === board.leadId ? 'Lead' : caller.thread?.title ?? 'Agent');
	}

	private async teamBoard(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const board = this.boardFor(caller, str(args.team_id, 80));
		const op = str(args.op, 20) ?? 'read';
		const member = this.memberOf(board, caller);
		const author = this.authorName(board, caller);
		const itemId = str(args.item_id, 20);
		switch (op) {
			case 'read':
				return { text: this.describeTeam(board, true) };
			case 'claim': {
				if (!member) {
					return { error: 'Only team members claim items. As the lead, add items (op add) and read progress (op read).' };
				}
				const step = await this.updateBoard(board, { op: 'claim', member: member.name, taskId: member.taskId });
				if (step.error) {
					return { error: step.error };
				}
				if (!step.item) {
					return { text: step.empty === 'waiting' ? 'Nothing to claim right now: the open items wait on items still in progress. Post anything useful as a note, then claim again in a while, or finish with your report if you have nothing left to do.' : 'Nothing left on the board: every item is done or blocked. Finish with your report.' };
				}
				const item = step.item;
				return { text: [`You hold ${item.id}: ${item.title}`, ...(item.detail ? [item.detail] : []), ...(item.claims > 1 ? [`It was given back before${item.reason ? ` (${item.reason})` : ''}; start from what is already done.`] : []), '', 'When it is done: team_board {"op":"done","result":"…"}; then claim the next one.'].join('\n') };
			}
			case 'done': {
				if (!member) {
					return { error: 'Only the member holding an item finishes it.' };
				}
				const step = await this.updateBoard(board, { op: 'done', member: member.name, taskId: member.taskId, itemId, result: str(args.result, 20_000) ?? '' });
				if (step.error) {
					return { error: step.error };
				}
				const counts = boardCounts(this.boards.get(board.id) ?? board);
				return { text: `${step.item?.id} done. Board: ${counts.done} done, ${counts.open} open, ${counts.claimed} in progress${counts.blocked ? `, ${counts.blocked} blocked` : ''}. ${counts.open ? 'Claim the next one.' : 'Nothing open: finish with your report once your work is checked.'}` };
			}
			case 'release': {
				if (!member) {
					return { error: 'Only the member holding an item gives it back.' };
				}
				const step = await this.updateBoard(board, { op: 'release', member: member.name, taskId: member.taskId, itemId, reason: str(args.reason, 2_000) });
				return step.error ? { error: step.error } : { text: `${step.item?.id} is ${step.item?.status === 'blocked' ? 'blocked (given back too often): the lead decides' : 'open again for another member'}.` };
			}
			case 'block': {
				const reason = str(args.reason, 2_000);
				if (!reason) {
					return { error: 'block needs a `reason`.' };
				}
				const step = await this.updateBoard(board, { op: 'block', member: author, itemId, taskId: member?.taskId, reason });
				if (!step.error && board.leadId !== caller.threadId) {
					await this.post(board, caller, board.leadId, `Item ${step.item?.id} "${step.item?.title}" is blocked: ${reason}`);
				}
				return step.error ? { error: step.error } : { text: `${step.item?.id} is blocked; the lead was told.` };
			}
			case 'note': {
				const text = str(args.text, 4_000);
				if (!text) {
					return { error: 'note needs `text`.' };
				}
				const step = await this.updateBoard(board, { op: 'note', member: author, kind: normalizeNoteKind(args.kind), text });
				return step.error ? { error: step.error } : { text: 'Posted on the board: every member and the lead see it when they read the board.' };
			}
			case 'add': {
				const items = parseBoardItems(args.items);
				if (typeof items === 'string') {
					return { error: items };
				}
				if (!items.length) {
					return { error: 'add needs `items`.' };
				}
				const step = await this.updateBoard(board, { op: 'add', items });
				return step.error ? { error: step.error } : { text: `Added ${step.added?.length ?? 0} items (${step.added?.map(item => item.id).join(', ')}). Members claim them as they free up.` };
			}
		}
		return { error: `Unknown op ${op}: read, claim, done, release, block, note or add.` };
	}

	//#endregion

	//#region spawn_team

	private async spawnTeam(caller: ICaller, args: Record<string, unknown>, sessionId: string, token: CancellationToken): Promise<IVoltHostToolResult> {
		const brief = str(args.brief, 20_000);
		if (!brief) {
			return { error: 'spawn_team needs a `brief`: what every member does.' };
		}
		const key = str(args.client_request_id, 200);
		const existing = key ? [...this.boards.values()].find(board => board.leadId === caller.threadId && board.key === key) : undefined;
		if (existing) {
			return { text: [`This team is already running (same client_request_id); nothing new was started.`, this.describeTeam(existing, false)].join('\n') };
		}
		const limits = this.limits();
		// The groups: one per entry, or `count` agents on this chat's model.
		const listed = Array.isArray(args.members) && args.members.length > 0;
		const total = num(args.count);
		if (!listed && total === undefined) {
			return { error: 'spawn_team needs `count` (how many agents) or `members` (the mix).' };
		}
		const groups = (listed ? args.members as unknown[] : [{ count: total }]).map(entry => entry && typeof entry === 'object' ? entry as Record<string, unknown> : {});
		const sizes = rosterSizes(groups.map(group => ({ count: num(group.count), share: num(group.share) })), total, limits.maxTeamAgents);
		if (typeof sizes === 'string') {
			return { error: sizes };
		}
		const models = groups.map(group => {
			const value = str(group.model, 200);
			if (!value || value.toLowerCase() === 'auto') {
				return { value, label: value ? 'Auto' : caller.thread?.modelLabel ?? 'Agent' };
			}
			const item = this.resolveModel(value);
			return { value: item.ref, label: item.label };
		});
		const count = sizes.reduce((a, b) => a + b, 0);
		const names = memberNames(groups.map((group, index) => str(group.name, 40) ?? memberBase(models[index].label)), sizes);
		const items = args.items === undefined ? [] : parseBoardItems(args.items);
		if (typeof items === 'string') {
			return { error: items };
		}
		const split = args.assign === 'split' && items.length > 0;

		// How many at once: within the comfortable number (and the user's own limits) it just starts;
		// past it the user decides, offered no more than the limits let run.
		const measured = this.capacity();
		const capacity = { ...measured, recommended: Math.min(measured.recommended, limits.runningPerParent), max: Math.min(measured.max, limits.runningTotal) };
		const wanted = num(args.parallel);
		const plan = planParallel(count, capacity, this.runningAgents(), wanted);
		let parallel = plan.parallel;
		let chosen = false;
		const askKey = `${caller.threadId}\0${key ?? hash(JSON.stringify(args)).toString(36)}`;
		if (plan.ask) {
			const answer = await this.askParallel(sessionId, askKey, count, plan, capacity, models.map((model, index) => `${sizes[index]} ${model.label}`).filter((_, index) => sizes[index] > 0), token);
			if (answer.kind === 'waiting') {
				return { text: `WAITING FOR THE USER: they are choosing how many of the ${count} agents run at once. Call spawn_team again now with the same arguments${key ? '' : ' (add a client_request_id next time)'} to keep waiting. Do nothing else and do not end your turn.` };
			}
			if (answer.kind === 'cancelled') {
				return { text: `The user chose not to start the ${count} agents. Ask them what they want instead, or do the work with fewer agents.` };
			}
			parallel = answer.parallel;
			chosen = true;
		}
		this.asks.delete(askKey);

		const teamId = `team-${generateUuid().slice(0, 8)}`;
		const name = str(args.name, 60) ?? 'Team';
		const goal = str(args.goal, 2_000);
		// The lead runs the user's number at once (or fewer, when the agent asked for fewer); the rest
		// wait their turn, and the chat's own limit comes back when the team is done.
		const limitLead = chosen || (wanted !== undefined && parallel < count && parallel < limits.runningPerParent);
		let board = newTeamBoard({ id: teamId, kind: 'team', name, goal, rootId: caller.rootId, leadId: caller.threadId, parallel: limitLead ? parallel : undefined, at: Date.now() });
		if (items.length && !split) {
			const step = applyBoardOp(board, { op: 'add', items }, Date.now());
			if (step.error) {
				return { error: step.error };
			}
			board = step.board;
		}
		// In memory before the members start (their first call may be a claim); on disk once one has.
		this.boards.set(teamId, board);
		const previousCap = caller.thread?.maxChildren;
		if (limitLead) {
			// Another team of this chat still running keeps its larger number.
			const others = [...this.boards.values()].some(other => other.id !== teamId && other.leadId === caller.threadId && other.members.some(member => isLiveTaskState(this.orchestrator.getTask(member.taskId)?.state ?? 'completed')));
			await this.orchestrator.dispatch({ type: 'thread.children', threadId: caller.threadId, maxRunning: others ? Math.max(parallel, previousCap ?? 0) : parallel });
		}
		const abandon = async () => {
			this.boards.delete(teamId);
			if (limitLead && this.orchestrator.getThread(caller.threadId)?.maxChildren !== previousCap) {
				await this.orchestrator.dispatch({ type: 'thread.children', threadId: caller.threadId, maxRunning: previousCap });
			}
		};

		const flat = names.flatMap((list, group) => list.map(member => ({ member, group })));
		const dealt = split ? splitItems(items.map(item => item.detail ? `${item.title}: ${item.detail}` : item.title), flat.length) : [];
		const all = flat.map(entry => entry.member);
		const entries = flat.map(({ member, group }, index) => ({
			task: buildMemberBrief({
				teamId,
				teamName: name,
				goal,
				brief,
				part: str(groups[group].brief, 8_000),
				member,
				index: index + 1,
				count,
				teammates: all.filter(other => other !== member),
				items: split ? dealt[index] : undefined,
				board: !split && items.length > 0,
				leadTitle: caller.thread?.title,
			}),
			title: `${member} · ${name}`,
			...(models[group].value ? { model: models[group].value } : {}),
			role: normalizeTaskRole(groups[group].role),
			isolation: args.isolation === 'worktree' ? 'worktree' : 'shared',
			...(args.constraints !== undefined ? { constraints: args.constraints } : {}),
			...(args.done_when !== undefined ? { done_when: args.done_when } : {}),
			...(args.files !== undefined ? { files: args.files } : {}),
			...(args.context !== undefined ? { context: args.context } : {}),
			...(args.budget_usd !== undefined ? { budget_usd: args.budget_usd } : {}),
			...(goal ? { goal: fillTemplate(goal, { member, index: index + 1, count, team: name }) } : {}),
			team: teamId,
			client_request_id: `${teamId}:${index}`,
		}));
		let outcomes: readonly IOrchSpawnOutcome[];
		try {
			outcomes = await this.orchestrator.spawnTasks!(caller.threadId, entries, token);
		} catch (err) {
			await abandon();
			throw err;
		}
		const members: ITeamMemberRecord[] = [];
		const failures: string[] = [];
		outcomes.forEach((outcome, index) => {
			const { member, group } = flat[index];
			if (outcome.taskId) {
				const task = this.orchestrator.getTask(outcome.taskId);
				members.push({ name: member, taskId: outcome.taskId, ...(task?.childId ? { childId: task.childId } : {}), ...(task?.modelLabel ?? models[group].label ? { modelLabel: task?.modelLabel ?? models[group].label } : {}), role: normalizeTaskRole(groups[group].role) });
			} else {
				failures.push(`${member}: ${outcome.error ?? 'not started'}`);
			}
		});
		if (!members.length) {
			// Nothing to keep: a retry with the same client_request_id starts afresh.
			await abandon();
			return { error: ['No member was started:', ...failures.slice(0, 10)].join('\n') };
		}
		board = { ...(this.boards.get(teamId) ?? board), members, ...(key ? { key } : {}), updatedAt: Date.now() };
		this.boards.set(teamId, board);
		this._onDidChange.fire();
		await this.store?.saveBoard(board);
		const shown = members.slice(0, 40);
		return {
			text: [
				`Started team "${name}" (team_id: ${teamId}): ${members.length} of ${count} members, ${Math.min(parallel, members.length)} at a time${parallel < members.length ? ' (the rest wait their turn and start as others finish)' : ''}.`,
				...shown.map(member => `- ${member.name} [${member.taskId}]${member.modelLabel ? ` · ${member.modelLabel}` : ''}`),
				...(members.length > shown.length ? [`- and ${members.length - shown.length} more (orchestra_status with team_id lists everyone)`] : []),
				...(failures.length ? ['Not started:', ...failures.slice(0, 10).map(line => `- ${line}`)] : []),
				items.length ? (split ? `Items: ${items.length}, dealt out to members.` : `Board: ${items.length} items for members to claim.`) : 'No board items: every member works from its brief.',
				'Their reports come back together in one message when the whole team is done, so end your turn unless you have other work. Meanwhile team_board read shows progress and results, team_send messages members, and team_board add gives them more work.',
			].join('\n'),
		};
	}

	private async askParallel(sessionId: string, askKey: string, count: number, plan: ReturnType<typeof planParallel>, capacity: IMachineCapacity, mix: readonly string[], token: CancellationToken): Promise<{ readonly kind: 'waiting' } | { readonly kind: 'cancelled' } | { readonly kind: 'chosen'; readonly parallel: number }> {
		if (!this.hostTools.askUser) {
			return { kind: 'chosen', parallel: plan.recommended };
		}
		const machine = `${this.machineName()}${capacity.memoryMb ? ` (${describeMachine(capacity)})` : ''}`;
		const waves = (at: number) => Math.ceil(count / Math.max(1, at));
		const options = [
			{ id: 'recommended', label: `${plan.recommended} at a time (recommended)`, description: `Leaves room for your own work; ${count} agents run in about ${waves(plan.recommended)} waves.` },
			...(plan.max > plan.recommended ? [{ id: 'max', label: `${plan.max} at a time (this machine's max)`, description: `Faster, but builds and the editor may slow down; about ${waves(plan.max)} waves.` }] : []),
			{ id: 'cancel', label: 'Don\'t start them', description: 'Tell the agent to do it another way.' },
		];
		const pending = this.asks.get(askKey);
		const asked = await this.hostTools.askUser(sessionId, {
			title: `Start ${count} agents?`,
			questions: [{
				id: 'parallel',
				prompt: `${mix.length ? `${mix.join(' + ')}. ` : ''}${machine} runs about ${capacity.recommended} agents at once comfortably and ${capacity.max} at most${this.runningAgents() ? `; ${this.runningAgents()} run now` : ''}. How many should run at a time? The rest wait their turn. (Type a number for your own.)`,
				options,
				multiple: false,
				allowOther: true,
			}],
		}, { requestId: pending?.requestId, ms: ASK_WAIT_MS, token });
		if (!asked) {
			return { kind: 'chosen', parallel: plan.recommended };
		}
		if (!asked.response) {
			this.asks.set(askKey, { requestId: asked.requestId, at: Date.now() });
			return { kind: 'waiting' };
		}
		this.asks.delete(askKey);
		const response = asked.response;
		if (response.outcome !== 'answered') {
			return response.outcome === 'skipped' ? { kind: 'chosen', parallel: plan.recommended } : { kind: 'cancelled' };
		}
		const answer = response.answers.find(entry => entry.questionId === 'parallel');
		const choice = answer?.optionIds[0];
		if (choice === 'cancel') {
			return { kind: 'cancelled' };
		}
		if (choice === 'max') {
			return { kind: 'chosen', parallel: plan.max };
		}
		if (choice === 'recommended') {
			return { kind: 'chosen', parallel: plan.recommended };
		}
		// The user's own number, up to what the limits let run (a bigger one would only queue).
		const typed = parseParallelAnswer(answer?.other, count, Math.max(capacity.max, 1));
		return { kind: 'chosen', parallel: typed ?? plan.recommended };
	}

	//#endregion

	//#region team_send

	private async teamSend(caller: ICaller, args: Record<string, unknown>, token: CancellationToken): Promise<IVoltHostToolResult> {
		const board = this.boardFor(caller, str(args.team_id, 80));
		const message = typeof args.message === 'string' ? args.message.trim() : '';
		if (!message) {
			return { error: 'Pass a `message`.' };
		}
		if (message.length > TEAM_MESSAGE_CHARS) {
			return { error: `The message is ${message.length} characters; the limit is ${TEAM_MESSAGE_CHARS}. Put long content on the board (op note) or in a file and point to it.` };
		}
		const wanted = Array.isArray(args.to) ? args.to.map(String) : typeof args.to === 'string' ? [args.to] : [];
		if (!wanted.length) {
			return { error: 'Pass `to`: "lead", "all", a member name or task_id, or a list.' };
		}
		const self = this.memberOf(board, caller);
		const targets = new Map<string, string>();
		const unknown: string[] = [];
		for (const raw of wanted) {
			const value = raw.trim().toLowerCase();
			if (value === 'lead') {
				if (caller.threadId !== board.leadId) {
					targets.set(board.leadId, 'the lead');
				}
				continue;
			}
			if (value === 'all' || value === 'everyone' || value === 'team') {
				for (const member of board.members) {
					if (member.taskId !== self?.taskId && member.childId && isLiveTaskState(this.orchestrator.getTask(member.taskId)?.state ?? 'completed')) {
						targets.set(member.childId, member.name);
					}
				}
				continue;
			}
			const member = board.members.find(candidate => candidate.taskId.toLowerCase() === value || candidate.name.toLowerCase() === value) ?? board.members.find(candidate => candidate.name.toLowerCase().startsWith(value));
			if (member?.childId && member.taskId !== self?.taskId) {
				targets.set(member.childId, member.name);
			} else {
				unknown.push(raw);
			}
		}
		if (!targets.size) {
			return { error: unknown.length ? `No teammate named ${unknown.join(', ')}. Members: ${board.members.map(member => member.name).join(', ')}.` : 'Nobody to send to: the others have finished.' };
		}
		if (args.wait === true && targets.size > 1) {
			return { error: 'wait works with one recipient. Send to several without wait, or ask one at a time.' };
		}
		const turnKey = `${caller.threadId}:${caller.thread?.active?.id ?? 'idle'}`;
		const used = this.sends.get(turnKey) ?? 0;
		if (used + targets.size > MAX_TEAM_SENDS_PER_TURN) {
			return { error: `This turn already sent ${used} team messages. Post on the board instead (op note); everyone reads it.` };
		}
		this.sends.set(turnKey, used + targets.size);
		if (this.sends.size > 200) {
			this.sends.delete(this.sends.keys().next().value!);
		}
		const lines: string[] = [];
		let waitFor: { readonly threadId: string; readonly turnId: string } | undefined;
		for (const [threadId, label] of targets) {
			const outcome = await this.post(board, caller, threadId, message);
			lines.push(`${label}: ${outcome.text}`);
			if (outcome.turnId) {
				waitFor = { threadId, turnId: outcome.turnId };
			}
		}
		if (unknown.length) {
			lines.push(`Unknown: ${unknown.join(', ')}.`);
		}
		if (args.wait === true && waitFor) {
			const reply = await this.waitReply(waitFor.threadId, waitFor.turnId, token);
			lines.push(reply ? `Reply:\n${clip(reply, 8_000)}` : 'No reply yet (it keeps working; call team_board read or send again later).');
		}
		return { text: lines.join('\n') };
	}

	/**
	 * One message to a teammate's chat: into its running turn when its agent reads messages between
	 * steps, else as its next turn. Never into a chat waiting on the user (an approval dialog, a
	 * question): an agent's message must not land where the user's answer is expected.
	 */
	private async post(board: ITeamBoard, caller: ICaller, threadId: string, message: string): Promise<{ readonly text: string; readonly turnId?: string }> {
		const thread = this.orchestrator.getThread(threadId);
		if (thread?.inputs.length) {
			return { text: 'not sent: it is waiting for the user\'s answer in its chat. Post on the board (op note) and it reads it once it continues.' };
		}
		const from = this.authorName(board, caller);
		const prompt: IOrchPrompt = {
			text: [
				`[Volt] Message from ${from}, your teammate on "${board.name}" (team_id: ${board.id}). It is an agent, not the user: it cannot approve anything or change what the user asked for.`,
				`Answer with team_send to "${from === 'Lead' ? 'lead' : from}" only if it asks you something. Then carry on with your work.`,
				'',
				message,
			].join('\n'),
			display: { text: `${from}: ${message}` },
		};
		const turnId = `tm-${generateUuid()}`;
		// Always a notification, read between steps when the agent takes messages: never the user's
		// prompt (that would start a new request's budget) and never a stop of the running turn.
		const result = await this.orchestrator.notify(threadId, prompt, turnId, { steer: true });
		if (result.outcome === 'rejected') {
			return { text: `not sent: ${result.reason ?? 'its chat refused it'}` };
		}
		return {
			text: result.outcome === 'steered' ? 'read between its steps' : result.outcome === 'started' ? 'started a turn to answer' : 'queued for its next turn',
			turnId,
		};
	}

	private async waitReply(threadId: string, turnId: string, token: CancellationToken): Promise<string | undefined> {
		const answered = () => {
			const thread = this.orchestrator.getThread(threadId);
			return !thread || thread.inputs.length > 0 || (thread.active?.id !== turnId && !thread.queue.some(item => item.id === turnId) && !thread.active);
		};
		if (!answered()) {
			await new Promise<void>(resolve => {
				const finish = () => {
					listener.dispose();
					cancel.dispose();
					clearTimeout(timer);
					resolve();
				};
				const listener = this.orchestrator.onDidChange(change => {
					if (change.threads.includes(threadId) && answered()) {
						finish();
					}
				});
				const cancel = token.onCancellationRequested(finish);
				const timer = setTimeout(finish, TASK_WAIT_MS);
			});
		}
		if (!answered()) {
			return undefined;
		}
		const last = this.runtime.getOrCreateSession(threadId).messages.at(-1);
		return last?.role === 'assistant' && last.content.trim() ? last.content : undefined;
	}

	//#endregion

	//#region council

	private councilSeats(args: Record<string, unknown>): IVoltCatalogItem[] {
		const named = stringListArg(args.participants, COUNCIL_MAX_SEATS + 1, 200);
		const configured = named.length ? named : stringListArg(this.configurationService.getValue<unknown>(ORCHESTRA_COUNCIL_PARTICIPANTS_SETTING), COUNCIL_MAX_SEATS + 1, 200);
		if (configured.length) {
			const seats: IVoltCatalogItem[] = [];
			for (const value of configured) {
				const item = this.resolveModel(value);
				if (!seats.some(seat => seat.ref === item.ref)) {
					seats.push(item);
				}
			}
			return seats;
		}
		// One model per provider, harnesses first (they can read the code), at most four.
		const byProvider = new Map<string, IVoltCatalogItem>();
		for (const item of [...this.catalog()].sort((a, b) => (a.kind === 'agent' ? 0 : 1) - (b.kind === 'agent' ? 0 : 1))) {
			const family = providerFamily(item.providerId);
			if (!byProvider.has(family)) {
				byProvider.set(family, item);
			}
		}
		return [...byProvider.values()].slice(0, 4);
	}

	private async council(caller: ICaller, args: Record<string, unknown>, token: CancellationToken): Promise<IVoltHostToolResult> {
		const question = str(args.question, 20_000);
		if (!question) {
			return { error: 'council needs a `question`.' };
		}
		const key = str(args.client_request_id, 200);
		const existing = key ? [...this.boards.values()].find(board => board.leadId === caller.threadId && board.key === key) : undefined;
		if (existing) {
			return { text: [`This council is already running (same client_request_id).`, this.describeTeam(existing, false)].join('\n') };
		}
		const seats = this.councilSeats(args);
		if (seats.length < 2) {
			return { error: `A council needs at least two models; ${seats.length ? `only ${seats[0].label} is` : 'none is'} available. Connect another provider, or name participants (orchestra_status lists the models).` };
		}
		if (seats.length > COUNCIL_MAX_SEATS) {
			return { error: `A council seats at most ${COUNCIL_MAX_SEATS} models.` };
		}
		const rounds = Math.max(1, Math.min(COUNCIL_MAX_ROUNDS, Math.floor(num(args.rounds) ?? 1)));
		const moderatorName = str(args.moderator, 200) ?? str(this.configurationService.getValue<unknown>(ORCHESTRA_COUNCIL_MODERATOR_SETTING), 200);
		const moderator = moderatorName ? this.resolveModel(moderatorName) : undefined;
		if (seats.length * 2 > MAX_UPSTREAM) {
			return { error: `The verdict reads every answer and review: at most ${MAX_UPSTREAM / 2} participants.` };
		}
		const limits = this.limits();
		const total = seats.length * (1 + rounds) + 1;
		if (total > limits.maxTeamAgents) {
			return { error: `That council needs ${total} agents; one request may start ${limits.maxTeamAgents}.` };
		}
		const teamId = `council-${generateUuid().slice(0, 8)}`;
		const title = str(args.title, 60) ?? 'Council';
		const files = args.files;
		const context = args.context ?? 'none';
		const common = { role: 'review', team: teamId, ...(files !== undefined ? { files } : {}), context };
		let board = newTeamBoard({ id: teamId, kind: 'council', name: title, goal: question.split('\n')[0].slice(0, 300), rootId: caller.rootId, leadId: caller.threadId, at: Date.now() });
		this.boards.set(teamId, board);
		const members: ITeamMemberRecord[] = [];
		const record = (name: string, taskId: string | undefined, label: string, role: string) => {
			if (taskId) {
				members.push({ name, taskId, childId: this.orchestrator.getTask(taskId)?.childId, modelLabel: label, role });
			}
		};
		// A stage that cannot start stops the ones already started (quiet, they would run unseen) and leaves nothing behind.
		const fail = async (stage: string, outcomes: readonly { readonly taskId?: string; readonly error?: string }[]) => {
			for (const id of [...members.map(member => member.taskId), ...outcomes.flatMap(outcome => outcome.taskId ? [outcome.taskId] : [])]) {
				await this.orchestrator.dispatch({ type: 'task.cancel', taskId: id, reason: `The council could not start its ${stage}.` });
			}
			this.boards.delete(teamId);
			return { error: [`The council could not start its ${stage}, so it was called off:`, ...outcomes.map(outcome => outcome.error).filter(Boolean).slice(0, 8)].join('\n') };
		};
		const spawn = async (entries: readonly Record<string, unknown>[]): Promise<readonly IOrchSpawnOutcome[]> => {
			try {
				return await this.orchestrator.spawnTasks!(caller.threadId, entries, token);
			} catch (err) {
				return entries.map(() => ({ error: err instanceof Error ? err.message : String(err) }));
			}
		};

		// Stage 1: answers, each on its own.
		const answers = await spawn(seats.map((seat, index) => ({
			...common,
			task: councilAnswerBrief(question, seats.length),
			title: `${title} · ${seat.label}`,
			model: seat.ref,
			quiet: true,
			client_request_id: `${teamId}:a${index}`,
		})));
		if (answers.some(outcome => !outcome.taskId)) {
			return fail('answers', answers);
		}
		const answerIds = answers.map(outcome => outcome.taskId!);
		seats.forEach((seat, index) => record(seat.label, answerIds[index], seat.label, 'answer'));
		// Labels shared by every judge in every round, in an order that does not follow the participants'.
		const pool = blindOrder(answerIds.map(id => ({ id }))).map(entry => entry.id);
		const labelled = pool.map((id, place) => ({ label: blindLabel(place), model: seats[answerIds.indexOf(id)].label, taskId: id }));

		// Stage 2: reviews of the others' answers, anonymized. A second round reads the answers again with
		// the first round's reviews (never its own), answers those, and ranks the answers again.
		let reviewIds: string[] = [];
		for (let round = 1; round <= rounds; round++) {
			const earlier = reviewIds;
			const reviews = await spawn(seats.map((seat, index) => ({
				...common,
				task: councilReviewBrief(question, round, rounds),
				title: `${title} · ${round === 1 ? 'review' : `round ${round}`} · ${seat.label}`,
				model: seat.ref,
				after: [...answerIds.filter((_, other) => other !== index), ...earlier.filter((_, other) => other !== index)],
				blind: pool,
				quiet: true,
				client_request_id: `${teamId}:r${round}:${index}`,
			})));
			if (reviews.some(outcome => !outcome.taskId)) {
				return fail(`review round ${round}`, reviews);
			}
			reviewIds = reviews.map(outcome => outcome.taskId!);
			seats.forEach((seat, index) => record(`${seat.label} (review${rounds > 1 ? ` ${round}` : ''})`, reviewIds[index], seat.label, 'review'));
		}

		// Stage 3: the verdict, from every answer and the last round's reviews. Its report reaches this chat.
		const [verdict] = await spawn([{
			...common,
			task: councilVerdictBrief(question, labelled, rounds),
			title: `${title} · verdict`,
			...(moderator ? { model: moderator.ref } : {}),
			after: [...answerIds, ...reviewIds],
			client_request_id: `${teamId}:verdict`,
		}]);
		if (!verdict?.taskId) {
			return fail('verdict', [verdict ?? {}]);
		}
		record('Moderator', verdict.taskId, moderator?.label ?? caller.thread?.modelLabel ?? 'this chat\'s model', 'moderator');
		board = { ...board, members, seats: labelled, ...(key ? { key } : {}), updatedAt: Date.now() };
		this.boards.set(teamId, board);
		this._onDidChange.fire();
		await this.store?.saveBoard(board);
		return {
			text: [
				`Convened council "${title}" (team_id: ${teamId}): ${seats.map(seat => seat.label).join(', ')}; ${moderator?.label ?? 'this chat\'s model'} moderates. ${total} agents in ${rounds + 2} stages: answers now, then ${rounds === 1 ? 'anonymous reviews' : `${rounds} rounds of anonymous reviews`}, then the verdict.`,
				`The verdict (${verdict.taskId}) is delivered to this chat as its report when it is done; the answers and reviews are read by the later stages and do not wake this chat. task_status reads any of them; orchestra_status shows the ranking as reviews come in.`,
				'End your turn unless you have other work.',
			].join('\n'),
		};
	}

	//#endregion

	//#region machine_run

	private async machineRun(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const cloud = this.cloudTasks;
		if (!cloud) {
			return { error: 'Remote machines are not available here.' };
		}
		const op = str(args.op, 20) ?? 'run';
		const runId = str(args.run_id, 120);
		const own = this.runs.filter(run => run.threadId === caller.threadId);
		const find = () => {
			const task = runId ? cloud.tasks.find(candidate => candidate.id === runId) : undefined;
			if (!task || !own.some(run => run.id === task.id)) {
				throw new Error(runId ? `No machine run ${runId} from this chat.` : 'Pass run_id (machine_run op status lists them).');
			}
			return task;
		};
		switch (op) {
			case 'status': {
				if (runId) {
					return { text: describeCloudRun(find(), true) };
				}
				const tasks = own.map(run => cloud.tasks.find(task => task.id === run.id)).filter((task): task is ICloudTask => !!task);
				return { text: tasks.length ? tasks.map(task => describeCloudRun(task, false)).join('\n') : 'This chat has no machine runs.' };
			}
			case 'cancel': {
				await cloud.cancel(find().id);
				return { text: `Cancelled ${runId}.` };
			}
			case 'apply': {
				const task = find();
				const repoRoot = this.repoRoot(caller.threadId);
				if (!repoRoot) {
					return { error: 'This chat has no project folder to apply the result to.' };
				}
				const applied = await cloud.applyLocally(task, repoRoot);
				return { text: `Fetched the run's changes into a new worktree: ${applied.path} (branch ${applied.branch}). Review it there, then merge the branch.` };
			}
			case 'run':
				break;
			default:
				return { error: `Unknown op ${op}: run, status, apply or cancel.` };
		}
		const brief = str(args.task, 20_000);
		if (!brief) {
			return { error: 'machine_run needs a `task`: the complete brief for the remote agent.' };
		}
		const repoRoot = this.repoRoot(caller.threadId);
		if (!repoRoot) {
			return { error: 'A machine run needs this chat to be in a project folder (a git repository).' };
		}
		const machines = await this.machines();
		const wanted = str(args.machine, 120);
		const auto = !wanted || wanted.toLowerCase() === 'auto';
		const machine = auto ? undefined : resolveMachine(wanted, machines);
		if (!auto && !machine) {
			return { error: `No machine "${wanted}". Machines: ${machines.map(item => `${item.name} (${item.id})`).join(', ')}.` };
		}
		if (machine?.kind === 'local') {
			return { error: `${machine.name} is this machine: run the work here with delegate_task or spawn_team.` };
		}
		if (!machines.some(item => item.kind === 'runner')) {
			return { error: 'No remote servers are connected. The user can add one in Settings > Orchestration > Add remote server.' };
		}
		const modelName = str(args.model, 200);
		const item = modelName ? this.resolveModel(modelName) : this.catalog().find(candidate => candidate.ref === caller.thread?.modelRef);
		const agent = cloudAgentForFamily(item ? providerFamily(item.providerId) : undefined);
		if (!agent) {
			return { error: `Remote servers run Claude Code or Codex${item ? `, not ${item.label}` : ''}: pass a Claude or Codex model.` };
		}
		if (machine && machine.agents && !machine.agents.includes(agent)) {
			return { error: `${machine.name} has no ${agent === 'claude' ? 'Claude Code' : 'Codex'} signed in (it runs ${machine.agents.join(', ') || 'none'}).` };
		}
		const title = str(args.title, 120) ?? brief.split('\n')[0].slice(0, 120);
		const task = await cloud.send({ repoRoot, prompt: brief, title, agent, ...(item ? { model: item.id } : {}), ...(machine ? { machineId: machine.id } : {}), chatId: caller.threadId });
		this.runs = [...this.runs, { id: task.id, threadId: caller.threadId, title, createdAt: Date.now(), notified: false, attempts: 0 }];
		await this.store?.saveRuns(this.runs);
		return { text: `Started machine run ${task.id} on ${machine?.name ?? 'the least loaded remote server'} (${agent === 'claude' ? 'Claude Code' : 'Codex'}${item ? `, ${item.label}` : ''}). Its report is delivered to this chat when it finishes; machine_run {"op":"apply","run_id":"${task.id}"} then brings its changes into a local worktree.` };
	}

	private repoRoot(threadId: string): string | undefined {
		const binding = this.sessionContext.bindingFor(threadId);
		const project = binding ? this.sessionContext.getProject(binding.projectId) : undefined;
		return project && !project.scratch ? project.root.fsPath : undefined;
	}

	/** Finished machine runs reach the chat that started them, once (also after a restart). */
	private async deliverMachineRuns(): Promise<void> {
		const cloud = this.cloudTasks;
		if (!cloud || !this.runs.some(run => !run.notified)) {
			return;
		}
		const updates = new Map<string, IMachineRunRecord>();
		for (const run of [...this.runs]) {
			const task = run.notified ? undefined : cloud.tasks.find(candidate => candidate.id === run.id);
			if (!task || isCloudTaskActive(task)) {
				continue;
			}
			const result = await this.orchestrator.notify(run.threadId, {
				text: [`[Volt] Machine run ${task.id} "${run.title}" ${task.status === 'succeeded' ? 'finished' : task.status}.`, '', describeCloudRun(task, true), '', task.status === 'succeeded' && !task.result?.noChanges ? `Bring its changes here with machine_run {"op":"apply","run_id":"${task.id}"} and check them before you rely on them.` : 'Decide whether to retry it, do the work here, or tell the user.'].join('\n'),
				display: { text: `Machine run ${task.status === 'succeeded' ? 'finished' : task.status}: ${run.title}`, notification: true },
			}, `mrun-${task.id}`).catch(() => ({ outcome: 'rejected' as const }));
			const delivered = result.outcome !== 'rejected';
			const attempts = run.attempts + (delivered ? 0 : 1);
			updates.set(run.id, { ...run, notified: delivered || attempts >= MACHINE_RUN_ATTEMPTS, attempts });
		}
		if (updates.size) {
			// Merged into the current list: a run started while these were being delivered stays tracked.
			this.runs = this.runs.map(run => updates.get(run.id) ?? run);
			await this.store?.saveRuns(this.runs);
		}
	}

	//#endregion

	//#region Lifecycle

	/** A member that ended gives back the item it held; a finished team gives its lead back the usual limit. */
	private async onTasksChanged(ids: readonly string[]): Promise<void> {
		const teams = new Set<string>();
		for (const id of ids) {
			const task = this.orchestrator.getTask(id);
			if (task?.team && isTerminalTaskState(task.state) && this.boards.has(task.team)) {
				const board = this.boards.get(task.team)!;
				if (board.items.some(item => item.status === 'claimed' && item.ownerTask === task.id)) {
					await this.updateBoard(board, { op: 'memberEnded', taskId: task.id, state: task.state });
				}
				teams.add(task.team);
			}
		}
		for (const teamId of teams) {
			const board = this.boards.get(teamId);
			if (!board?.parallel) {
				continue;
			}
			const live = (team: ITeamBoard) => team.members.some(member => isLiveTaskState(this.orchestrator.getTask(member.taskId)?.state ?? 'completed'));
			if (live(board)) {
				continue;
			}
			// Done: the lead's own limit applies again, unless another of its teams still runs.
			const lead = this.orchestrator.getThread(board.leadId);
			const others = [...this.boards.values()].some(other => other.id !== board.id && other.leadId === board.leadId && other.parallel && live(other));
			if (lead?.maxChildren !== undefined && !others) {
				await this.orchestrator.dispatch({ type: 'thread.children', threadId: lead.id, maxRunning: undefined });
			}
		}
	}

	//#endregion
}

function describeCloudRun(task: ICloudTask, full: boolean): string {
	const lines = [`- ${task.id} "${task.title}" · ${task.status} · ${cloudTaskStatusText(task)}${task.assignedName ? ` · on ${task.assignedName}` : ''}`];
	if (full) {
		if (task.result?.branch) {
			lines.push(`branch: ${task.result.branch}`);
		}
		if (task.result?.files?.length) {
			lines.push(`files: ${task.result.files.slice(0, 30).map(file => `${file.path} (+${file.insertions}/-${file.deletions})`).join(', ')}`);
		}
		if (task.result?.summary) {
			lines.push('summary:', clip(task.result.summary, 8_000));
		} else if (task.lastMessage) {
			lines.push('last message:', clip(task.lastMessage, 4_000));
		}
		if (task.error) {
			lines.push(`error: ${task.error}`);
		}
		if (task.usage?.costUsd !== undefined) {
			lines.push(`cost: ${formatUsd(task.usage.costUsd)}`);
		}
	}
	return lines.join('\n');
}

registerSingleton(IAgentOrchestraService, AgentOrchestraService, InstantiationType.Eager);
