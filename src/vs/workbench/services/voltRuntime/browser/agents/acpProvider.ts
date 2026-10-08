/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { bareTaskToolName } from '../../common/orchestration/agentTasks.js';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IAccessDecision, IAccessGate, IAccessRequest, ICompiledPolicy } from '../../common/access/accessTypes.js';
import { IProviderAccessBridge } from '../../common/access/providerAccessBridge.js';
import { classifyRisk } from '../../common/access/riskClassifier.js';
import { compactionEventsFromAcpUpdate } from '../../common/acpCompaction.js';
import { IAcpNotice, noticesFromAcpPayload, noticesFromAcpUpdate } from '../../common/acpNotices.js';
import { acpModeForVoltMode, collectAcpToolDiffs, collectAcpToolInput, collectAcpToolLocations, IAcpSessionMode } from '../../common/acpToolInput.js';
import { IVoltEvent } from '../../common/events.js';
import { parseTokenUsage } from '../../common/tokenUsage.js';
import { VoltMode } from '../../common/modes.js';
import { IProviderProfile } from '../../common/profiles.js';
import { IAgentMessage, IAgentProvider, IAgentSessionHandle, IAgentStartRequest, IDetectResult, IModelImage, IModelInfo } from '../../common/providers.js';
import { DEFAULT_ACP_CAPABILITIES } from '../../common/capabilities.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { isVoltHostTool, IVoltHostToolService, IVoltMcpServer } from '../../common/hostTools.js';
import { AgentQuestionDraft, cursorAskQuestionResult, elicitationResult, elicitationToQuestions, IAgentQuestionResponse, parseQuestionDraft } from '../../common/questions.js';
import { mapAcpToolKind } from '../../common/harness/workLog.js';
import { ACP_IDLE_TIMINGS, ACP_STALL_NOTICE_TITLE, declaredToolWaitMs, IdleWatchdog, IIdleStageInfo, IIdleWatchdogTimings, IWatchdogClock, realWatchdogClock } from '../../common/harness/acpStall.js';
import { ACP_RUN_BUDGET, IRunSupervisorOptions, RunSupervisor, SupervisorDirective } from '../../common/harness/supervisor.js';
import { acpResourceBlock, AcpResourcePromptBlock } from '../../common/fileAttachments.js';
import { isCursorPlanWall, isCursorPlanWallPrefix, isCursorTransientError, nextCursorFallback, normalizeCursorModelId } from '../../common/harness/cursorQuota.js';
import { accessBridgeFor } from './bridges/accessBridges.js';
import { AcpJsonRpcClient, AcpRequestAbandonedError, IAcpIncomingRequest } from './acpJsonRpc.js';
import { listClaudeModels } from './claudeCatalog.js';
import { acpLaunchFor, cliAgentDefinition, listAntigravityModels, listOpenCodeModels } from './cliAgents.js';
import { listCodexModels } from './codexAppServer.js';
import { resolveAntigravityCliModelLabel } from '../../common/models/antigravityModels.js';
import { IModelOptionDescriptor, MODEL_OPTION_REASONING, unionDescriptors } from '../../common/models/modelOptions.js';
import { advertisedModelVariant, applyContextWindowSuffix, applyOptionsToParameterizedId, configUpdatesForOptions, descriptorsFromAcpModel, flattenChoices, formatAgentModelLabel, IAcpAvailableModel, IAcpConfigOption, IAcpModelMeta, isModelConfigOption, metadataForAcpModel, parseParameterizedModelId } from './acpModels.js';

/** `initialize`'s `agentCapabilities.mcpCapabilities`: the MCP transports the agent can connect to. */
type IAcpMcpCapabilities = { http?: boolean; sse?: boolean };

interface IAcpSession {
	handle: IAgentSessionHandle;
	client: AcpJsonRpcClient;
	processId: string;
	configOptions?: IAcpConfigOption[];
	modes?: IAcpSessionMode[];
	/** The read-only mode switched on for a Plan or Ask turn; undefined while the access policy decides. */
	voltModeId?: string;
	policy?: ICompiledPolicy;
	voltSessionId?: string;
	runId?: string;
	mode?: VoltMode;
	currentModel?: string;
	/** The agent's current session mode, so an unchanged `session/set_mode` is not sent again. */
	currentModeId?: string;
	/** The agent accepts `image` prompt blocks (`promptCapabilities.image`). */
	promptImages?: boolean;
	/** The agent takes `resource` prompt blocks with the file's text (`promptCapabilities.embeddedContext`). */
	promptEmbedded?: boolean;
	/** Slash commands from the agent's last `available_commands_update`, without the slash. */
	commands?: ReadonlySet<string>;
	/**
	 * The prompt turn in flight. `session/update` notifications and agent requests route here, and
	 * only here: a cancelled turn that is still winding down never sees the next turn's updates.
	 */
	turn?: AcpPromptTurn;
	/** Settles once the last `session/prompt` has been answered or abandoned. The next prompt waits for it. */
	settling?: Promise<void>;
	/** Pool key of the setup this session was started with (spares are matched on it). */
	setupKey?: string;
	/** The host MCP servers `session/new` connected (JSON), and what they were derived from. */
	hostMcp?: { readonly sessionId?: string; readonly capabilities?: IAcpMcpCapabilities; readonly servers: string };
	/** The agent takes `_session/steering`: a message goes into the running turn without stopping it (Claude, Codex). */
	steering?: boolean;
	/** The harness's own subagents of this session, by child session id (native) or Task call id (Cursor). */
	children?: Map<string, IAcpChild>;
	/** Tool calls that only control a native subagent (Claude's Agent call): their updates are not tool rows. */
	subagentCalls?: Set<string>;
}

/** A harness subagent Volt has seen start: what its card shows and what its report is. */
interface IAcpChild {
	readonly title: string;
	parentToolCallId?: string;
	/** The child's own messages; the last one is its report. */
	text: string;
	ended?: boolean;
}

/** A session started ahead of time that no chat owns yet. */
interface IAcpSpare {
	readonly key: string;
	readonly startedAt: number;
	readonly session: Promise<IAcpSession>;
	expiry?: ReturnType<typeof setTimeout>;
}

/** Knobs for supervision; tests swap the clock and shorten the timings. */
export interface IAcpSupervisionOptions {
	readonly idle?: IIdleWatchdogTimings;
	readonly clock?: IWatchdogClock;
	readonly supervisor?: IRunSupervisorOptions;
	/** How long a cancelled `session/prompt` may take to answer before Volt stops waiting. */
	readonly cancelLingerMs?: number;
}

type TurnFollowUp = { readonly reason: 'stall' | 'steer'; readonly prompt: IAcpPromptBlock[] };

type IAcpPromptBlock = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string } | AcpResourcePromptBlock;

/** One `send()`: the event queue the generator drains plus the state supervision needs. */
class AcpPromptTurn {
	private readonly queue: IVoltEvent[] = [];
	private waiting: (() => void) | undefined;
	/** `run.end` is queued; nothing else is accepted. */
	ended = false;
	/** The prompt loop returned; the generator stops once the queue is empty. */
	private done = false;
	userCancelled = false;
	followUp: TurnFollowUp | undefined;
	/** What the in-flight `session/prompt` sent; a stall before any activity sends it again. */
	lastPrompt: IAcpPromptBlock[] = [];
	/** The in-flight `session/prompt`: cancelling it abandons the reply. */
	promptCts: CancellationTokenSource | undefined;
	/** `session/cancel` already went out for the in-flight prompt. */
	cancelSentFor: CancellationTokenSource | undefined;
	assistant = '';
	usedTools = false;
	held: IVoltEvent[] = [];
	readonly seenNotices = new Set<string>();
	watchdog!: IdleWatchdog;
	supervisor!: RunSupervisor;

	constructor(readonly runId: string) { }

	push(event: IVoltEvent): void {
		if (this.ended) {
			return;
		}
		if (event.type === 'run.end') {
			this.ended = true;
		}
		this.queue.push(event);
		this.wake();
	}

	finish(): void {
		this.done = true;
		this.wake();
	}

	async next(): Promise<IVoltEvent | undefined> {
		while (!this.queue.length) {
			if (this.done || this.ended) {
				return undefined;
			}
			await new Promise<void>(resolve => { this.waiting = resolve; });
			this.waiting = undefined;
		}
		return this.queue.shift();
	}

	/** Linger timers stay armed: the next turn waits on them if the agent never answers its cancel. */
	dispose(): void {
		this.watchdog?.dispose();
	}

	private wake(): void {
		this.waiting?.();
	}
}

export interface IAcpFileWrite {
	readonly sessionId: string;
	readonly runId: string;
	readonly uri: URI;
	/** The file's text before this write; undefined when the write created it. */
	readonly before: string | undefined;
}

interface ISessionNewResponse {
	sessionId: string;
	modes?: { currentModeId?: string; availableModes?: IAcpSessionMode[] };
	configOptions?: IAcpConfigOption[];
	models?: { availableModels?: IAcpAvailableModel[]; currentModelId?: string };
}

/** Opting in makes Cursor expose per model reasoning, context, and fast toggles. */
/**
 * Session-failure titles are the sentence the CLI shows for a limit, retry, or sign-in.
 * Notices stay off: with that capability the adapter drops info-level lines instead of sending them.
 */
const ACP_CLIENT_CAPABILITIES = {
	fs: { readTextFile: true, writeTextFile: true },
	terminal: false,
	// Form elicitations are how Claude's AskUserQuestion (and Codex's request-user-input) reach the question tray.
	elicitation: { form: {} },
	// Compaction as its own entity (`compaction_update`): Claude and Codex then report when it starts and ends,
	// the summary they kept and the tokens before and after, instead of a generic "Compact conversation" tool call.
	session: { compaction: {} },
	_meta: {
		parameterizedModelPicker: true,
		jetbrains: {
			air: {
				version: 1,
				// Native subagent sessions: Claude and Codex announce each subagent, stream its own
				// updates under its session id, and report how it ended (.aInsp/research/cursor-subagents-protocol.md section 2.4).
				capabilities: ['sessionFailure', 'nativeSubagentSessions'],
			},
		},
	},
};

const MODEL_PROBE_TIMEOUT_MS = 8000;
const MAX_TRANSPORT_RESUMES = 2;
const TRANSPORT_RESUME_DELAY_MS = 1500;

/** Cursor waits 6 s for a soft-cancelled stream to end before cutting it (`softCancelLingerMs`). */
const PROMPT_CANCEL_LINGER_MS = 6_000;
/** A spare session nobody adopted is stopped after this long; its process holds a model connection. */
const SPARE_TTL_MS = 10 * 60_000;
const MAX_SPARES = 2;

const STALL_RESUME_TEXT = 'Your previous response stopped making progress and was interrupted. Continue exactly where you left off; do not repeat work that is already done.';

/** A CLI that has not answered `initialize` by now is not going to. */
const ACP_INITIALIZE_TIMEOUT_MS = 45_000;
/** `session/new` connects the session's MCP servers (cursor-agent waits up to 60s for each). */
const ACP_SESSION_NEW_TIMEOUT_MS = 120_000;

/** The CLI's link to its backend failed, not the model: `RetriableError: Connection stalled`, `[unavailable] PING timed out`, `ECONNRESET`. */
export function isAgentTransportError(message: string): boolean {
	return /RetriableError|Connection stalled|PING timed out|ECONNRESET|ETIMEDOUT|socket hang up|\[(unavailable|aborted|deadline_exceeded)\]/i.test(message);
}

export type AcpQuestionAsker = (sessionId: string, runId: string, draft: AgentQuestionDraft) => Promise<IAgentQuestionResponse>;

/** A permission prompt for one of Volt's own MCP tools (`volt-browser_click: browser_click`, `mcp__volt__ask_question`). */
function isVoltHostToolPermission(params: unknown): boolean {
	const toolCall = (params as { toolCall?: { title?: unknown; rawInput?: { providerIdentifier?: unknown; toolName?: unknown } } } | undefined)?.toolCall;
	if (!toolCall) {
		return false;
	}
	const raw = toolCall.rawInput;
	if (raw && raw.providerIdentifier === 'volt' && typeof raw.toolName === 'string') {
		return isVoltHostTool(raw.toolName) || !!bareTaskToolName(raw.toolName);
	}
	const title = typeof toolCall.title === 'string' ? toolCall.title.trim() : '';
	return /^(volt[-:]|mcp__volt__)/i.test(title) && (isVoltHostTool(title) || !!bareTaskToolName(title));
}

function allowOncePermission(params: unknown): unknown {
	const options = (params as { options?: { optionId?: string; kind?: string }[] } | undefined)?.options ?? [];
	const allow = options.find(option => option.kind === 'allow_once') ?? options.find(option => option.kind === 'allow_always') ?? options[0];
	return allow?.optionId ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error('ACP request timed out')), ms)),
	]);
}

export class AcpAgentProvider implements IAgentProvider {

	private readonly sessions = new Map<string, IAcpSession>();
	private readonly bridge: IProviderAccessBridge;
	private gate: IAccessGate | undefined;
	private writeObserver: ((write: IAcpFileWrite) => void) | undefined;
	private questionAsker: AcpQuestionAsker | undefined;
	private supervision: IAcpSupervisionOptions = {};
	private readonly spares = new Map<string, IAcpSpare>();

	constructor(
		readonly id: string,
		readonly label: string,
		private readonly defaultCommand: string,
		private readonly defaultArgs: string[],
		private readonly stdio: IVoltStdioService,
		private readonly workspace: IWorkspaceContextService,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
		private readonly hostTools?: IVoltHostToolService,
	) {
		this.bridge = accessBridgeFor(id);
	}

	setAccessGate(gate: IAccessGate): void {
		this.gate = gate;
	}

	/** Answers `cursor/ask_question` and form elicitations with the question tray. */
	setQuestionAsker(asker: AcpQuestionAsker): void {
		this.questionAsker = asker;
	}

	/** Overrides the idle watchdog, run supervisor and clock (tests; future settings). */
	setSupervisionOptions(options: IAcpSupervisionOptions): void {
		this.supervision = options;
	}

	/** Told about every `fs/write_text_file` the agent routes through Volt, with the text it replaced. */
	setFileWriteObserver(observer: (write: IAcpFileWrite) => void): void {
		this.writeObserver = observer;
	}

	setRunContext(session: IAgentSessionHandle, context: { sessionId: string; runId: string; mode: VoltMode }): void {
		const live = this.sessions.get(session.id);
		if (!live) {
			return;
		}
		live.voltSessionId = context.sessionId;
		live.runId = context.runId;
		live.mode = context.mode;
	}

	async applyAccessPolicy(session: IAgentSessionHandle, policy: ICompiledPolicy): Promise<void> {
		const live = this.sessions.get(session.id);
		if (!live) {
			return;
		}
		live.policy = policy;
		if (live.voltModeId) {
			// A Plan or Ask turn holds the read-only mode; the policy applies again when it ends.
			return;
		}
		const sessionId = live.handle.providerSessionId ?? live.handle.id;
		const config = this.bridge.translate(policy, { configOptions: live.configOptions, modes: live.modes });
		for (const update of config.configOptions ?? []) {
			await this.setConfigOption(live, sessionId, update.id, update.value);
		}
		if (config.sessionModeId) {
			await this.setMode(live, sessionId, config.sessionModeId);
		}
	}

	/** `session/set_mode`, skipped when the agent is already in that mode. */
	private async setMode(live: IAcpSession, sessionId: string, modeId: string): Promise<boolean> {
		if (live.currentModeId === modeId) {
			return true;
		}
		try {
			await live.client.request('session/set_mode', { sessionId, modeId });
			live.currentModeId = modeId;
			return true;
		} catch (err) {
			this.logService.trace('[ACP] session/set_mode failed', err);
			return false;
		}
	}

	async detect(profile: IProviderProfile): Promise<IDetectResult> {
		const command = profile.command || this.defaultCommand;
		const path = await this.stdio.which(command);
		return {
			available: !!path,
			version: path,
			authenticated: !!path,
			detail: path ? `Found ${command} at ${path}` : `${command} not found on PATH`,
		};
	}

	/**
	 * Asks the CLI what it can run. Cursor answers the `cursor/list_available_models` extension
	 * with per model config options; other agents expose a `model` select or an
	 * `availableModels` list on the new session. An agent that answers none of these has no
	 * catalog. A signed-out or missing CLI contributes nothing, so the picker does not invent a row.
	 */
	async listModels(profile: IProviderProfile): Promise<IModelInfo[]> {
		if (this.id === 'codex') {
			return listCodexModels(this.stdio, profile.command || this.defaultCommand).catch(() => []);
		}
		if (this.id === 'claude-code') {
			return listClaudeModels(this.stdio).catch(() => []);
		}
		if (this.id === 'antigravity') {
			const listed = await listAntigravityModels(this.stdio, profile.command || this.defaultCommand).catch(() => []);
			if (listed.length) {
				return listed;
			}
		}
		if (this.id === 'opencode') {
			const listed = await this.probeAcpModels(profile);
			return listed.length ? listed : listOpenCodeModels(this.stdio, profile.command || this.defaultCommand).catch(() => []);
		}
		return this.probeAcpModels(profile);
	}

	private probeAcpModels(profile: IProviderProfile): Promise<IModelInfo[]> {
		return this.probe(profile, async (client, session) => {
			const listed = await withTimeout(
				client.request<{ models?: IAcpAvailableModel[] }>('cursor/list_available_models', {}),
				MODEL_PROBE_TIMEOUT_MS,
			).catch(() => undefined);
			if (listed?.models?.length) {
				return this.collapseModels(listed.models.map(model => {
					const value = model.value ?? '';
					const { base, params } = parseParameterizedModelId(value);
					return this.toModelInfo(
						value,
						formatAgentModelLabel(this.label, base || model.name, model.name),
						descriptorsFromAcpModel(model, params, [], this.id, base || value, model.name),
						undefined,
						metadataForAcpModel(model, params, this.id, base || value, model.name),
					);
				}));
			}

			const shared = descriptorsFromAcpModel(
				{ name: this.label, configOptions: session?.configOptions?.filter(option => !isModelConfigOption(option)) },
				{},
				[],
				this.id,
			);

			const modelOption = session?.configOptions?.find(isModelConfigOption);
			const choices = flattenChoices(modelOption);
			if (choices.length) {
				return this.collapseModels(choices.map(choice => this.fromParameterized(choice.value, choice.name, shared)));
			}

			return this.collapseModels((session?.models?.availableModels ?? []).map(model => {
				return this.fromParameterized(model.value ?? model.modelId ?? '', model.name, shared, model);
			}));
		}).catch(() => []);
	}

	async start(req: IAgentStartRequest): Promise<IAgentSessionHandle> {
		const adopted = await this.adoptSpare(req);
		if (adopted) {
			return adopted.handle;
		}
		const live = await this.createSession(req);
		this.sessions.set(live.handle.id, live);
		return live.handle;
	}

	/**
	 * Starts a session for `req` ahead of time (spawn, `initialize`, `session/new`, model and
	 * options) and parks it. The next {@link start} with the same setup adopts it instantly instead
	 * of paying the cold start (about 5 s for cursor-agent's `session/new` alone). One spare per
	 * setup; an unadopted spare is stopped after {@link SPARE_TTL_MS}.
	 *
	 * The setup includes the host MCP servers, whose URL names the chat. A spare made for chat A is
	 * not handed to chat B, so pass the `sessionId` the spare is meant for.
	 */
	prewarmSpare(req: IAgentStartRequest): Promise<void> {
		const key = this.setupKey(req);
		const existing = this.spares.get(key);
		if (existing && Date.now() - existing.startedAt < SPARE_TTL_MS) {
			return existing.session.then(() => undefined, () => undefined);
		}
		if (existing) {
			this.dropSpare(key, existing);
		}
		while (this.spares.size >= MAX_SPARES) {
			const [oldestKey, oldest] = [...this.spares.entries()].sort((x, y) => x[1].startedAt - y[1].startedAt)[0];
			this.dropSpare(oldestKey, oldest);
		}
		const spare: IAcpSpare = { key, startedAt: Date.now(), session: this.createSession(req) };
		this.spares.set(key, spare);
		spare.expiry = setTimeout(() => {
			if (this.spares.get(key) === spare) {
				this.dropSpare(key, spare);
			}
		}, SPARE_TTL_MS);
		return spare.session.then(live => {
			live.client.whenDead(() => this.forgetSpare(key, spare));
		}, err => {
			this.forgetSpare(key, spare);
			this.logService.trace('[ACP] spare session failed', err);
		});
	}

	/** True when a spare for this setup is parked or starting. */
	hasSpare(req: IAgentStartRequest): boolean {
		return this.spares.has(this.setupKey(req));
	}

	/** Stops every parked spare. */
	async disposeSpares(): Promise<void> {
		const all = [...this.spares.entries()];
		for (const [key, spare] of all) {
			this.forgetSpare(key, spare);
		}
		await Promise.all(all.map(([, spare]) => spare.session.then(live => this.stopSession(live), () => undefined)));
	}

	private dropSpare(key: string, spare: IAcpSpare): void {
		this.forgetSpare(key, spare);
		void spare.session.then(live => this.stopSession(live), () => undefined);
	}

	private forgetSpare(key: string, spare: IAcpSpare): void {
		clearTimeout(spare.expiry);
		if (this.spares.get(key) === spare) {
			this.spares.delete(key);
		}
	}

	private async adoptSpare(req: IAgentStartRequest): Promise<IAcpSession | undefined> {
		const key = this.setupKey(req);
		const spare = this.spares.get(key);
		if (!spare) {
			return undefined;
		}
		this.forgetSpare(key, spare);
		const live = await spare.session.catch(() => undefined);
		if (!live || live.client.isDead) {
			return undefined;
		}
		this.sessions.set(live.handle.id, live);
		return live;
	}

	private async stopSession(live: IAcpSession): Promise<void> {
		live.client.dispose();
		await this.stdio.kill(live.processId).catch(() => undefined);
	}

	/** Everything that makes two sessions interchangeable before their first prompt. */
	private setupKey(req: IAgentStartRequest): string {
		const cwd = req.cwd || req.profile.cwd || this.workspace.getWorkspace().folders[0]?.uri.fsPath || '';
		return JSON.stringify([
			this.id,
			req.profile.command || this.defaultCommand,
			this.startArgs(req),
			cwd,
			req.modelId ?? '',
			Object.entries(req.options ?? {}).sort(([x], [y]) => x.localeCompare(y)),
			this.hostTools?.getMcpServers(req.sessionId) ?? [],
		]);
	}

	private async createSession(req: IAgentStartRequest): Promise<IAcpSession> {
		const { command, args } = await this.launchFor(req.profile, this.startArgs(req));
		const cwd = req.cwd || req.profile.cwd || this.workspace.getWorkspace().folders[0]?.uri.fsPath;
		const env = cliAgentDefinition(this.id)?.acpEnv;
		const processId = await this.stdio.spawn({ command, args, cwd, ...(env ? { env: { ...env } } : {}) });
		const client = new AcpJsonRpcClient(this.stdio, processId);
		this.bindClientRequests(client);
		client.whenDead(() => {
			for (const [id, session] of this.sessions) {
				if (session.client === client) {
					this.sessions.delete(id);
				}
			}
		});

		// Setup that never answers would leave the chat on "Thinking" with nothing to show for it:
		// the prompt watchdog only starts once there is a session. Bound it, and stop the process.
		let initialized: {
			agentCapabilities?: {
				session?: { _meta?: unknown; modes?: { availableModes?: { id: string; name?: string }[] } };
				mcpCapabilities?: IAcpMcpCapabilities;
				promptCapabilities?: { image?: boolean; embeddedContext?: boolean };
			};
			configOptions?: IAcpConfigOption[];
		};
		let created: ISessionNewResponse;
		let hostMcp: IAcpSession['hostMcp'];
		try {
			initialized = await client.request('initialize', {
				protocolVersion: 1,
				clientCapabilities: ACP_CLIENT_CAPABILITIES,
				clientInfo: { name: 'volt', title: 'Volt', version: '0.1.0' },
			}, ACP_INITIALIZE_TIMEOUT_MS);
			const capabilities = initialized.agentCapabilities?.mcpCapabilities;
			const mcpServers = this.hostMcpServers(req.sessionId, capabilities);
			hostMcp = { sessionId: req.sessionId, capabilities, servers: JSON.stringify(mcpServers) };
			created = await client.request<ISessionNewResponse>('session/new', { cwd: cwd ?? '', mcpServers }, ACP_SESSION_NEW_TIMEOUT_MS);
		} catch (err) {
			client.dispose();
			void this.stdio.kill(processId);
			throw err;
		}

		const handle: IAgentSessionHandle = {
			id: created.sessionId,
			providerSessionId: created.sessionId,
		};
		const live: IAcpSession = {
			handle,
			client,
			processId,
			configOptions: created.configOptions ?? initialized.configOptions,
			modes: created.modes?.availableModes ?? initialized.agentCapabilities?.session?.modes?.availableModes,
			currentModeId: created.modes?.currentModeId,
			promptImages: initialized.agentCapabilities?.promptCapabilities?.image === true,
			promptEmbedded: initialized.agentCapabilities?.promptCapabilities?.embeddedContext === true,
			setupKey: this.setupKey(req),
			hostMcp,
			steering: (initialized as { _meta?: { steering?: { supported?: unknown } } })._meta?.steering?.supported === true,
		};
		// One listener for the life of the session; it routes to whichever turn is current.
		client.handleNotifications(note => {
			if (note.method === 'session/update') {
				this.onSessionUpdate(live, note.params);
			}
		});
		try {
			await this.applySelection(live, req);
		} catch (err) {
			await this.stopSession(live);
			throw err;
		}
		// What the agent actually runs, for model-variant parity checks against its own CLI.
		const config = (live.configOptions ?? []).filter(option => option.id !== 'mode').map(option => `${option.id}=${String(option.currentValue ?? '')}`).join(' ');
		this.logService.info(`[ACP] ${this.id} session ${handle.id}: ${command} ${args.join(' ')} | ${config}`);
		return live;
	}

	/**
	 * A session whose host MCP servers are no longer the current ones (it started before the
	 * window's server was up, or the server restarted on another port) cannot reach Volt's tools,
	 * render_chart included. It counts as dead, so the next turn starts a new one with the recap.
	 */
	isLive(session: IAgentSessionHandle): boolean {
		const live = this.sessions.get(session.id);
		return !!live && !live.client.isDead
			&& (!live.hostMcp || JSON.stringify(this.hostMcpServers(live.hostMcp.sessionId, live.hostMcp.capabilities)) === live.hostMcp.servers);
	}

	private hostMcpServers(sessionId: string | undefined, capabilities: IAcpMcpCapabilities | undefined): IVoltMcpServer[] {
		return acceptedMcpServers(this.hostTools?.getMcpServers(sessionId) ?? [], capabilities);
	}

	private async launchFor(profile: IProviderProfile, args: string[]): Promise<{ command: string; args: string[] }> {
		const command = profile.command || this.defaultCommand;
		const def = cliAgentDefinition(this.id);
		const adapter = def?.acpAdapter;
		const adapterOnPath = !!adapter && def.commands.includes(command) && !!await this.stdio.which(adapter.command);
		return acpLaunchFor(def, command, args, adapterOnPath);
	}

	private startArgs(req: IAgentStartRequest): string[] {
		const args = req.profile.args?.length ? [...req.profile.args] : [...this.defaultArgs];
		if (this.id === 'antigravity' && req.modelId) {
			args.push('--model', this.antigravityModelLabel(req));
		}
		if (this.id === 'cursor-acp') {
			const model = this.cursorModelArg(req);
			const acp = args.lastIndexOf('acp');
			if (acp >= 0) {
				args.splice(acp, 0, '--model', model);
			} else {
				args.push('--model', model);
			}
		}
		return args;
	}

	/** Cursor's CLI default is whatever is in ~/.cursor/cli-config.json - often a premium row that ACP then paywalls. Pin Auto unless the user picked something else. */
	private cursorModelArg(req: IAgentStartRequest): string {
		const selected = normalizeCursorModelId(req.modelId);
		if (!selected) {
			return 'auto';
		}
		return applyContextWindowSuffix(applyOptionsToParameterizedId(selected, req.options), req.options);
	}

	private antigravityModelLabel(req: IAgentStartRequest): string {
		const effort = typeof req.options?.[MODEL_OPTION_REASONING] === 'string' ? req.options[MODEL_OPTION_REASONING] : undefined;
		return resolveAntigravityCliModelLabel(req.modelId ?? '', effort);
	}

	/**
	 * Pushes the picked model and its options onto a freshly created session. Each
	 * `session/set_config_option` costs cursor-agent about 2 s even when nothing changes, so values
	 * the session already has are skipped.
	 */
	private async applySelection(session: IAcpSession, req: IAgentStartRequest): Promise<void> {
		const sessionId = session.handle.providerSessionId ?? session.handle.id;
		const modelConfigId = session.configOptions?.find(isModelConfigOption)?.id ?? 'model';
		if (this.id === 'cursor-acp' && !req.modelId) {
			await this.setConfigOption(session, sessionId, modelConfigId, 'auto');
		} else if (req.modelId) {
			const selected = this.id === 'antigravity'
				? this.antigravityModelLabel(req)
				: this.id === 'cursor-acp'
					? this.cursorModelArg(req)
					: req.modelId;
			const reconstructed = applyContextWindowSuffix(applyOptionsToParameterizedId(selected, req.options), req.options);
			let applied = await this.setConfigOption(session, sessionId, modelConfigId, reconstructed);
			if (!applied && reconstructed !== req.modelId) {
				applied = await this.setConfigOption(session, sessionId, modelConfigId, req.modelId);
			}
			// Otherwise the session silently stays on the agent's default model.
			const variant = applied ? undefined : advertisedModelVariant(session.configOptions?.find(option => option.id === modelConfigId), req.modelId);
			if (variant) {
				await this.setConfigOption(session, sessionId, modelConfigId, variant);
			}
		}
		// Sequential on purpose: the agent rebuilds the model variant on each write, and two writes in
		// flight at once can each start from the old variant and undo the other.
		for (const update of configUpdatesForOptions(session.configOptions, req.options)) {
			await this.setConfigOption(session, sessionId, update.configId, update.value);
		}
	}

	private async setConfigOption(session: IAcpSession, sessionId: string, configId: string, value: string | boolean): Promise<boolean> {
		const isModel = configId === 'model' || isModelConfigOption({ id: configId, name: configId });
		if (configValueIsCurrent(session.configOptions?.find(option => option.id === configId), value)) {
			if (isModel && typeof value === 'string') {
				session.currentModel = value;
			}
			return true;
		}
		const params = typeof value === 'boolean'
			? { sessionId, configId, type: 'boolean', value }
			: { sessionId, configId, value };
		try {
			const response = await session.client.request<{ configOptions?: IAcpConfigOption[] }>('session/set_config_option', params);
			if (response?.configOptions) {
				session.configOptions = response.configOptions;
			}
			if (typeof value === 'string' && isModel) {
				session.currentModel = value;
			}
			return true;
		} catch (err) {
			// Agents that predate the parameterized picker reject unknown config ids; the session
			// still works with its own defaults, so this is logged rather than fatal.
			this.logService.trace(`[ACP] set_config_option ${configId} failed`, err);
			return false;
		}
	}

	private fromParameterized(id: string, rawName: string, shared: IModelOptionDescriptor[], source?: IAcpAvailableModel): IModelInfo {
		const { base, params } = parseParameterizedModelId(id);
		return this.toModelInfo(
			id,
			formatAgentModelLabel(this.label, base || rawName, rawName),
			descriptorsFromAcpModel(source, params, shared, this.id, base || id, rawName),
			undefined,
			source
				? metadataForAcpModel(source, params, this.id, base || id, rawName)
				: metadataForAcpModel({ name: rawName }, params, this.id, base || id, rawName),
		);
	}

	/**
	 * Cursor advertises one row per baked-in combo. Collapse those to one model per base slug so
	 * the picker can show Effort / Fast instead of "grok-4.6 High - Fast" as a dead label.
	 */
	private collapseModels(models: IModelInfo[]): IModelInfo[] {
		const seen = new Map<string, IModelInfo>();
		const order: string[] = [];
		for (const model of models) {
			const { base } = parseParameterizedModelId(model.id);
			const key = base || model.id;
			const existing = seen.get(key);
			if (!existing) {
				seen.set(key, model);
				order.push(key);
				continue;
			}
			seen.set(key, {
				...existing,
				description: existing.description ?? model.description,
				contextLabel: existing.contextLabel ?? model.contextLabel,
				capabilities: existing.contextLabel ? existing.capabilities : model.capabilities,
				optionDescriptors: unionDescriptors(existing.optionDescriptors ?? [], model.optionDescriptors ?? []),
			});
		}
		return order.map(key => seen.get(key)!);
	}

	private toModelInfo(id: string, label: string, optionDescriptors: IModelOptionDescriptor[], detail?: string, meta?: IAcpModelMeta): IModelInfo {
		const contextWindow = meta?.contextWindow ?? DEFAULT_ACP_CAPABILITIES.contextWindow;
		return {
			id: id.trim(),
			label: label.trim() || id.trim(),
			capabilities: { ...DEFAULT_ACP_CAPABILITIES, contextWindow },
			...(optionDescriptors.length ? { optionDescriptors } : {}),
			...(detail ? { detail } : {}),
			...(meta?.description ? { description: meta.description } : {}),
			...(meta?.contextLabel ? { contextLabel: meta.contextLabel } : {}),
		};
	}

	/** Spawns a throwaway session purely to interrogate the agent, then tears it down. */
	private async probe<T>(profile: IProviderProfile, use: (client: AcpJsonRpcClient, session: ISessionNewResponse | undefined) => Promise<T>): Promise<T> {
		const command = profile.command || this.defaultCommand;
		if (!await this.stdio.which(command)) {
			throw new Error(`${command} is not installed`);
		}
		const launch = await this.launchFor(profile, profile.args?.length ? [...profile.args] : [...this.defaultArgs]);
		const cwd = profile.cwd || this.workspace.getWorkspace().folders[0]?.uri.fsPath;
		const processId = await this.stdio.spawn({ command: launch.command, args: launch.args, cwd });
		const client = new AcpJsonRpcClient(this.stdio, processId);
		try {
			await withTimeout(client.request('initialize', {
				protocolVersion: 1,
				clientCapabilities: ACP_CLIENT_CAPABILITIES,
				clientInfo: { name: 'volt', title: 'Volt', version: '0.1.0' },
			}), MODEL_PROBE_TIMEOUT_MS);
			const session = await withTimeout(
				client.request<ISessionNewResponse>('session/new', { cwd: cwd ?? '', mcpServers: [] }),
				MODEL_PROBE_TIMEOUT_MS,
			).catch(() => undefined);
			return await use(client, session);
		} finally {
			client.dispose();
			await this.stdio.kill(processId).catch(() => undefined);
		}
	}

	async *send(session: IAgentSessionHandle, msg: IAgentMessage, _profile: IProviderProfile, token: CancellationToken): AsyncIterable<IVoltEvent> {
		const live = this.sessions.get(session.id);
		if (!live || live.client.isDead) {
			yield { type: 'error', message: 'ACP session is not running. Reconnect the agent in Volt Settings.', retryable: true };
			return;
		}

		// One turn per session. A turn still winding down (cancelled, or the user sent again) is
		// ended now, so it stops receiving updates, and its prompt settles before the new one goes out.
		const previous = live.turn;
		if (previous) {
			this.endTurn(live, previous, 'abort');
		}
		await live.settling;
		if (token.isCancellationRequested || live.client.isDead) {
			yield { type: 'run.end', runId: session.id, reason: token.isCancellationRequested ? 'abort' : 'fail' };
			return;
		}

		const turn = new AcpPromptTurn(session.id);
		const clock = this.supervision.clock ?? realWatchdogClock;
		turn.watchdog = new IdleWatchdog(info => this.onIdle(live, turn, info), this.supervision.idle ?? ACP_IDLE_TIMINGS, clock);
		turn.supervisor = new RunSupervisor({ budget: ACP_RUN_BUDGET, ...this.supervision.supervisor, startedAt: clock.now() });
		live.turn = turn;
		const cancel = token.onCancellationRequested(() => this.cancelTurn(live, turn, 'user'));
		// Not awaited at the end: once `run.end` is out, a cancelled prompt may still be settling.
		void this.runTurn(live, turn, msg, token)
			.catch(err => this.endTurn(live, turn, 'fail', { message: err instanceof Error ? err.message : String(err), retryable: true }))
			.finally(() => turn.finish());

		try {
			for (let event = await turn.next(); event; event = await turn.next()) {
				yield event;
			}
		} finally {
			cancel.dispose();
			if (!turn.ended) {
				// The consumer stopped listening mid-turn; don't leave the agent working for nobody.
				this.endTurn(live, turn, 'abort');
			}
			turn.dispose();
			if (live.turn === turn) {
				live.turn = undefined;
			}
		}
	}

	/** Routes one `session/update` to the current turn, holding Cursor's plan-wall text until it is clear. */
	private onSessionUpdate(live: IAcpSession, params: unknown): void {
		const commands = availableCommandsUpdate(params);
		if (commands) {
			live.commands = commands;
		}
		const modeUpdate = currentModeUpdate(params);
		if (modeUpdate) {
			live.currentModeId = modeUpdate;
			if (live.voltModeId && modeUpdate !== live.voltModeId) {
				// The agent left the read-only mode itself, e.g. the user approved its plan.
				live.voltModeId = undefined;
			}
		}
		const turn = live.turn;
		if (!turn || turn.ended) {
			return;
		}
		if (this.routeSubagentUpdate(live, turn, params)) {
			return;
		}
		for (const event of this.mapUpdate(params)) {
			if (event.type === 'notice') {
				this.pushNotice(live, turn, event);
				continue;
			}
			if (event.type === 'tool.start') {
				turn.usedTools = true;
				this.flushHeld(turn);
			}
			if (this.id === 'cursor-acp' && event.type === 'text.delta' && event.delta) {
				turn.assistant += event.delta;
				if (!turn.usedTools && isCursorPlanWallPrefix(turn.assistant)) {
					turn.held.push(event);
					turn.watchdog.modelOutput();
					continue;
				}
				this.flushHeld(turn);
			}
			this.pushActivity(live, turn, event);
		}
	}

	/**
	 * Native subagents (Claude, Codex): `subagent_spawned` / `subagent_state_update` on the parent
	 * session, the child's own updates under its session id, and the parent's Agent call that only
	 * carries the launch. True when the update was a subagent's and must not reach the parent's steps.
	 */
	private routeSubagentUpdate(live: IAcpSession, turn: AcpPromptTurn, params: unknown): boolean {
		const body = params as { sessionId?: unknown; update?: Record<string, unknown> } | undefined;
		const update = body?.update;
		if (!update) {
			return false;
		}
		const kind = String(update.sessionUpdate ?? '');
		const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined;
		const root = live.handle.providerSessionId ?? live.handle.id;
		const children = live.children ??= new Map();
		if (kind === 'subagent_spawned' && typeof update.subagentSessionId === 'string') {
			const childId = update.subagentSessionId;
			const title = typeof update.name === 'string' && update.name.trim() ? update.name.trim() : 'Subagent';
			if (!children.has(childId)) {
				children.set(childId, { title, text: '' });
				turn.watchdog.activity();
				this.pushActivity(live, turn, {
					type: 'subagent.spawned',
					childId,
					title,
					...(typeof update.task === 'string' && update.task.trim() ? { prompt: update.task.trim() } : {}),
					source: this.id === 'codex-acp' ? 'codex' : this.id.startsWith('claude') ? 'claude' : 'acp',
				});
			}
			return true;
		}
		if (kind === 'subagent_state_update' && typeof update.subagentSessionId === 'string') {
			const child = children.get(update.subagentSessionId);
			if (child && !child.ended) {
				child.ended = true;
				const state = String(update.state ?? 'completed');
				const status = state === 'failed' ? 'failed' : state === 'cancelled' || state === 'disconnected' ? 'cancelled' : 'completed';
				this.pushActivity(live, turn, {
					type: 'subagent.completed',
					childId: update.subagentSessionId,
					status,
					...(child.text.trim() ? { result: child.text.trim() } : {}),
					...(status === 'failed' ? { error: `The subagent ${state}.` } : {}),
				});
			}
			return true;
		}
		if (sessionId && sessionId !== root) {
			// A child's own update: keep it out of the parent's steps and its loop/stall supervision.
			const child = children.get(sessionId);
			turn.watchdog.activity();
			for (const event of this.mapUpdate(params)) {
				if (event.type === 'text.delta' && event.delta && child) {
					child.text += event.delta;
				}
				if (event.type === 'tool.start') {
					turn.push({ type: 'subagent.update', childId: sessionId, activity: event.title || event.name });
				}
				if (event.type !== 'notice' && event.type !== 'usage') {
					turn.push({ type: 'subagent.event', childId: sessionId, event });
				}
			}
			return true;
		}
		// The parent's Agent call learns which child it launched (Claude's toolResponse.agentId).
		const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
		if (toolCallId) {
			const meta = (update._meta as { claudeCode?: { toolResponse?: { agentId?: unknown; resolvedModel?: unknown } } } | undefined)?.claudeCode?.toolResponse;
			const agentId = typeof meta?.agentId === 'string' ? meta.agentId : undefined;
			const child = agentId ? children.get(agentId) : undefined;
			if (child && agentId) {
				(live.subagentCalls ??= new Set()).add(toolCallId);
				if (!child.parentToolCallId) {
					child.parentToolCallId = toolCallId;
					this.pushActivity(live, turn, {
						type: 'subagent.update',
						childId: agentId,
						parentToolCallId: toolCallId,
						...(typeof meta?.resolvedModel === 'string' ? { model: meta.resolvedModel } : {}),
					});
				}
				return true;
			}
			if (live.subagentCalls?.has(toolCallId)) {
				return true;
			}
		}
		return false;
	}

	/** Delivers agent activity: feeds the idle watchdog and the run supervisor, then acts on what they decide. */
	private pushActivity(live: IAcpSession, turn: AcpPromptTurn, event: IVoltEvent): void {
		if (turn.ended) {
			return;
		}
		switch (event.type) {
			case 'tool.start':
				turn.watchdog.toolStarted(event.callId, declaredToolWaitMs(event.input));
				break;
			case 'tool.input.delta': {
				const declared = event.append ? undefined : declaredToolWaitMs(event.delta);
				if (declared) {
					turn.watchdog.toolDeclared(event.callId, declared);
				}
				turn.watchdog.activity();
				break;
			}
			case 'tool.end':
				turn.watchdog.toolEnded(event.callId);
				break;
			case 'text.delta':
			case 'reasoning.delta':
				turn.watchdog.modelOutput();
				break;
			case 'context.compaction':
				// Summarizing a long chat is quiet for a minute or more: it waits like a running tool.
				if (event.status === 'running') {
					turn.watchdog.toolStarted(`compaction:${event.id}`);
				} else if (event.status) {
					turn.watchdog.toolEnded(`compaction:${event.id}`);
				} else {
					turn.watchdog.activity();
				}
				break;
			default:
				turn.watchdog.activity();
		}
		turn.push(event);
		this.applyDirectives(live, turn, turn.supervisor.observe(event, (this.supervision.clock ?? realWatchdogClock).now()));
	}

	private pushNotice(live: IAcpSession, turn: AcpPromptTurn, notice: IAcpNotice): void {
		const title = notice.title.trim();
		const key = title.toLowerCase();
		if (!title || turn.seenNotices.has(key)) {
			return;
		}
		turn.seenNotices.add(key);
		this.pushActivity(live, turn, {
			type: 'notice',
			severity: notice.severity,
			title,
			...(notice.description ? { description: notice.description } : {}),
		});
	}

	private flushHeld(turn: AcpPromptTurn): void {
		const held = turn.held;
		turn.held = [];
		for (const event of held) {
			turn.push(event);
		}
	}

	private applyDirectives(live: IAcpSession, turn: AcpPromptTurn, directives: readonly SupervisorDirective[]): void {
		for (const directive of directives) {
			if (turn.ended) {
				return;
			}
			switch (directive.kind) {
				case 'notice':
					turn.push({ type: 'notice', severity: directive.severity, title: directive.title, ...(directive.description ? { description: directive.description } : {}) });
					break;
				case 'steer':
					// Cursor has no cross-step loop check at all; here the agent gets one short correction.
					turn.push({ type: 'notice', severity: 'warning', title: directive.title, description: directive.description });
					this.logService.info(`[ACP] steering ${this.id}: ${directive.signal.kind} x${directive.signal.count} ${directive.signal.label}`);
					turn.followUp = { reason: 'steer', prompt: [{ type: 'text', text: directive.text }] };
					this.cancelTurn(live, turn, 'steer');
					break;
				case 'stop':
					this.logService.info(`[ACP] stopping ${this.id}: ${directive.reason}`);
					this.endTurn(live, turn, 'fail', { message: directive.message, retryable: directive.retryable });
					break;
			}
		}
	}

	private onIdle(live: IAcpSession, turn: AcpPromptTurn, info: IIdleStageInfo): void {
		if (turn.ended) {
			return;
		}
		const quiet = formatQuiet(info.quietMs);
		this.applyDirectives(live, turn, turn.supervisor.tick((this.supervision.clock ?? realWatchdogClock).now()));
		if (turn.ended) {
			return;
		}
		this.logService.info(`[ACP] ${this.id} quiet for ${quiet} (${info.owner}): ${info.stage}`);
		if (info.stage === 'notice') {
			turn.push({
				type: 'notice',
				severity: 'info',
				title: ACP_STALL_NOTICE_TITLE,
				description: info.owner === 'tool' ? `A tool has been running for ${quiet} without reporting back.` : `No activity from the agent for ${quiet}.`,
			});
			return;
		}
		if (info.stage === 'recover') {
			if (!turn.promptCts) {
				return;
			}
			turn.watchdog.recovered();
			// A prompt that never produced anything is sent again; one that stalled midway is resumed.
			turn.followUp = { reason: 'stall', prompt: info.neverActive ? turn.lastPrompt : [{ type: 'text', text: STALL_RESUME_TEXT }] };
			turn.push({ type: 'retry', attempt: info.recoveries + 1, delayMs: 0, message: `The agent has been quiet for ${quiet}. Interrupting it and asking it to continue.` });
			this.cancelTurn(live, turn, 'recover');
			return;
		}
		// Cursor's own retries cover its transport; this covers an agent that is alive but stuck.
		const message = info.neverActive
			? `ACP agent produced no activity for ${quiet}. The prompt stalled and the turn was stopped.`
			: `The agent stopped responding: no activity for ${quiet}${info.recoveries ? ', even after Volt asked it to continue' : ''}. Retry to pick the turn up from here.`;
		this.endTurn(live, turn, 'fail', { message, retryable: true });
	}

	/** Sends the prompt (again, after a fallback, resume, recovery or steer) until the turn ends. */
	private async runTurn(live: IAcpSession, turn: AcpPromptTurn, msg: IAgentMessage, token: CancellationToken): Promise<void> {
		const sessionId = live.handle.providerSessionId ?? live.handle.id;
		const modelConfigId = live.configOptions?.find(isModelConfigOption)?.id ?? 'model';
		const holdPlanWall = this.id === 'cursor-acp';
		const tried: string[] = live.currentModel ? [live.currentModel] : [];
		await this.applyVoltMode(live, sessionId, msg.mode);
		let body = this.promptBlocks(live, msg);
		let resumes = 0;

		while (!turn.ended) {
			if (token.isCancellationRequested || turn.userCancelled) {
				// Stopped before this prompt went out (during mode setup or a resume delay).
				this.endTurn(live, turn, 'abort');
				return;
			}
			const outcome = await this.promptOnce(live, turn, sessionId, body);
			if (turn.ended) {
				return;
			}
			const followUp = turn.followUp as TurnFollowUp | undefined;
			turn.followUp = undefined;
			const stopReason = 'result' in outcome ? outcome.result?.stopReason : undefined;
			if (followUp && !token.isCancellationRequested && !turn.userCancelled && !live.client.isDead && (!('result' in outcome) || stopReason === 'cancelled')) {
				// Volt interrupted the agent itself (stall recovery or loop steer): carry on with the follow-up.
				this.flushHeld(turn);
				body = followUp.prompt;
				continue;
			}

			if ('result' in outcome) {
				const result = outcome.result;
				if (holdPlanWall && !turn.usedTools && !token.isCancellationRequested && isCursorPlanWall(turn.assistant)) {
					const fallback = nextCursorFallback(tried);
					if (fallback) {
						const wall = turn.assistant.trim();
						if (wall) {
							this.pushNotice(live, turn, { severity: 'warning', title: wall });
						}
						tried.push(fallback);
						turn.held = [];
						turn.assistant = '';
						turn.usedTools = false;
						await this.setConfigOption(live, sessionId, modelConfigId, fallback);
						turn.push({
							type: 'retry',
							attempt: tried.length,
							delayMs: 0,
							message: `Cursor blocked that model. Retrying with ${fallback === 'auto' ? 'Auto' : 'Composer 2.5'}.`,
						});
						continue;
					}
				}
				this.flushHeld(turn);
				for (const notice of noticesFromAcpPayload(result)) {
					this.pushNotice(live, turn, notice);
				}
				const usage = parseTokenUsage(result);
				if (usage) {
					turn.push(usage);
				}
				this.endTurn(live, turn, result?.stopReason === 'cancelled' || turn.userCancelled ? 'abort' : 'done');
				return;
			}

			const err = outcome.error;
			if (err instanceof AcpRequestAbandonedError) {
				// Volt stopped waiting: the user's cancel went unanswered, or the turn was ended elsewhere.
				this.endTurn(live, turn, 'abort');
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			if (holdPlanWall && !live.client.isDead && !token.isCancellationRequested && isCursorTransientError(message)) {
				const fallback = nextCursorFallback(tried);
				if (fallback) {
					tried.push(fallback);
					turn.held = [];
					turn.assistant = '';
					turn.usedTools = false;
					await this.setConfigOption(live, sessionId, modelConfigId, fallback);
					turn.push({
						type: 'retry',
						attempt: tried.length,
						delayMs: 0,
						message: `Cursor hit an internal error. Retrying with ${fallback === 'auto' ? 'Auto' : 'Composer 2.5'}.`,
					});
					continue;
				}
			}
			if (!live.client.isDead && !token.isCancellationRequested && resumes < MAX_TRANSPORT_RESUMES && isAgentTransportError(message)) {
				// The CLI lost its connection mid-turn ("Connection stalled", "PING timed out"). Its session
				// still holds the conversation, so pick the turn up again instead of ending it on an error.
				resumes++;
				this.flushHeld(turn);
				turn.push({ type: 'retry', attempt: resumes, delayMs: TRANSPORT_RESUME_DELAY_MS, message: `The agent's connection dropped (${message.replace(/^.*?Error:\s*/, '')}). Resuming the turn.` });
				await timeout(TRANSPORT_RESUME_DELAY_MS * resumes);
				if (!token.isCancellationRequested && !live.client.isDead && !turn.ended) {
					body = [{ type: 'text', text: 'Your previous response was interrupted by a connection error. Continue exactly where you left off; do not repeat work that is already done.' }];
					continue;
				}
			}
			this.endTurn(live, turn, token.isCancellationRequested || turn.userCancelled ? 'abort' : 'fail', { message, retryable: true });
			return;
		}
	}

	/** One `session/prompt`. The reply can be abandoned through `turn.promptCts` (stall, superseded turn). */
	private async promptOnce(live: IAcpSession, turn: AcpPromptTurn, sessionId: string, body: IAcpPromptBlock[]): Promise<{ result: { stopReason?: string; usage?: unknown } | undefined } | { error: unknown }> {
		const cts = new CancellationTokenSource();
		turn.promptCts = cts;
		turn.cancelSentFor = undefined;
		turn.followUp = undefined;
		turn.lastPrompt = body;
		const request = live.client.request<{ stopReason?: string; usage?: unknown }>('session/prompt', { sessionId, prompt: body }, { token: cts.token });
		live.settling = request.then(() => undefined, () => undefined);
		try {
			return { result: await request };
		} catch (error) {
			return { error };
		} finally {
			if (turn.promptCts === cts) {
				turn.promptCts = undefined;
			}
			cts.dispose();
		}
	}

	/**
	 * The single cancel path: user Stop (token and `interrupt()` both land here), stall recovery,
	 * loop steering and ending a turn. At most one `session/cancel` per prompt. An agent must answer
	 * a cancelled prompt with `stopReason: "cancelled"`; one that does not is cut loose after the linger.
	 */
	private cancelTurn(live: IAcpSession, turn: AcpPromptTurn, why: 'user' | 'recover' | 'steer' | 'end'): void {
		if (why === 'user') {
			turn.userCancelled = true;
		}
		const cts = turn.promptCts;
		if (!cts || turn.cancelSentFor === cts) {
			return;
		}
		turn.cancelSentFor = cts;
		void live.client.notify('session/cancel', { sessionId: live.handle.providerSessionId ?? live.handle.id }).catch(() => undefined);
		const clock = this.supervision.clock ?? realWatchdogClock;
		clock.setTimeout(() => cts.cancel(), this.supervision.cancelLingerMs ?? PROMPT_CANCEL_LINGER_MS);
	}

	/** Queues the turn's last events. A prompt still in flight is cancelled; the next turn waits for it to settle. */
	private endTurn(live: IAcpSession, turn: AcpPromptTurn, reason: 'done' | 'abort' | 'fail', error?: { message: string; retryable: boolean }): void {
		if (turn.ended) {
			return;
		}
		this.flushHeld(turn);
		if (error) {
			turn.push({ type: 'error', message: error.message, retryable: error.retryable });
		}
		turn.push({ type: 'run.end', runId: turn.runId, reason });
		turn.watchdog.dispose();
		if (turn.promptCts) {
			this.cancelTurn(live, turn, 'end');
		}
		if (live.turn === turn) {
			live.turn = undefined;
		}
	}

	private promptBlocks(live: IAcpSession, msg: IAgentMessage): IAcpPromptBlock[] {
		// A slash command only runs when it opens the prompt, so it goes without the lead.
		const command = /^\/([\w:-]+)(?:\s|$)/.exec(msg.text)?.[1];
		const lead = command && live.commands?.has(command) ? undefined : msg.lead;
		const blocks: IAcpPromptBlock[] = [{ type: 'text', text: lead ? `${lead}\n\n${msg.text}` : msg.text }];
		// `images` arrives structurally until `IAgentMessage` declares it (WP5).
		const images = (msg as IAgentMessage & { images?: readonly IModelImage[] }).images;
		if (live.promptImages && images?.length) {
			for (const image of images) {
				blocks.push({ type: 'image', mimeType: image.mediaType, data: image.data });
			}
		}
		for (const resource of msg.resources ?? []) {
			blocks.push(acpResourceBlock(resource, !!live.promptEmbedded));
		}
		if (msg.resources?.length) {
			this.logService.info(`[ACP] ${this.id} prompt resources: ${blocks.filter(block => block.type === 'resource' || block.type === 'resource_link').map(block => block.type).join(', ')}`);
		}
		return blocks;
	}

	/**
	 * Plan and Ask must not edit, so they run in the agent's own read-only mode when it has one.
	 * Leaving them hands the mode back to the access policy.
	 */
	private async applyVoltMode(live: IAcpSession, sessionId: string, mode: VoltMode): Promise<void> {
		const target = acpModeForVoltMode(mode, live.modes);
		if (target === live.voltModeId) {
			return;
		}
		if (target) {
			if (await this.setMode(live, sessionId, target)) {
				live.voltModeId = target;
			}
			return;
		}
		live.voltModeId = undefined;
		if (live.policy) {
			await this.applyAccessPolicy(live.handle, live.policy);
		} else {
			const fallback = live.modes?.find(candidate => candidate.id === 'default' || candidate.id === 'agent')?.id;
			if (fallback) {
				await this.setMode(live, sessionId, fallback);
			}
		}
	}

	/** The agent advertised `/name` in its `available_commands_update` (Claude's `/compact`). */
	supportsCommand(session: IAgentSessionHandle, name: string): boolean {
		const live = this.sessions.get(session.id);
		return !!live && !live.client.isDead && !!live.commands?.has(name);
	}

	/** The running turn takes messages without stopping (`_session/steering`). */
	canSteer(session: IAgentSessionHandle): boolean {
		const live = this.sessions.get(session.id);
		return !!live?.steering && !!live.turn && !live.turn.ended;
	}

	/** Puts `text` into the running turn. False when the agent refused (no turn, or it wants a new prompt). */
	async steer(session: IAgentSessionHandle, text: string): Promise<boolean> {
		const live = this.sessions.get(session.id);
		const turn = live?.turn;
		if (!live?.steering || !turn || turn.ended) {
			return false;
		}
		try {
			const result = await live.client.request<{ outcome?: string }>('_session/steering', {
				sessionId: live.handle.providerSessionId ?? live.handle.id,
				prompt: [{ type: 'text', text }],
				_meta: { steering: { idleBehavior: 'promptRequired' } },
			}, 10_000);
			if (result?.outcome === 'injected') {
				turn.watchdog.activity();
				return true;
			}
		} catch (err) {
			this.logService.info(`[ACP] ${this.id} steering failed`, err);
		}
		return false;
	}

	async interrupt(session: IAgentSessionHandle): Promise<void> {
		const live = this.sessions.get(session.id);
		const turn = live?.turn;
		if (live && turn && !turn.ended) {
			this.cancelTurn(live, turn, 'user');
		}
	}

	async dispose(session: IAgentSessionHandle): Promise<void> {
		const live = this.sessions.get(session.id);
		if (!live) {
			return;
		}
		this.sessions.delete(session.id);
		if (live.turn) {
			this.endTurn(live, live.turn, 'abort');
		}
		await this.stopSession(live);
	}

	private mapUpdate(params: unknown): IVoltEvent[] {
		const body = params as { update?: Record<string, unknown>; sessionUpdate?: string };
		const update = (body.update ?? body) as Record<string, unknown>;
		const kind = String(update.sessionUpdate ?? update.type ?? '');
		const compaction = compactionEventsFromAcpUpdate(update);
		if (compaction) {
			return compaction;
		}
		const events: IVoltEvent[] = [];
		if (kind === 'agent_message_chunk' || kind === 'agent_message') {
			const text = this.contentText(update.content);
			if (text) {
				events.push({ type: 'text.delta', id: String(update.messageId ?? 'acp-text'), delta: text });
			}
		} else if (kind === 'agent_thought_chunk' || kind === 'agent_thought') {
			const text = this.contentText(update.content);
			if (text) {
				events.push({ type: 'reasoning.delta', id: String(update.messageId ?? 'acp-think'), delta: text });
			}
		} else if (kind === 'plan') {
			const entries = (update.entries as { content?: string; status?: string; priority?: string }[] | undefined) ?? [];
			events.push({
				type: 'plan',
				entries: entries.map(e => ({
					content: e.content ?? '',
					status: e.status === 'completed' || e.status === 'in_progress' ? e.status : 'pending',
					priority: e.priority,
				})),
			});
		} else if (kind === 'tool_call') {
			const title = typeof update.title === 'string' ? update.title : undefined;
			const toolKind = typeof update.kind === 'string' ? update.kind : undefined;
			const input = collectAcpToolInput(update);
			const locations = collectAcpToolLocations(update);
			const diffs = collectAcpToolDiffs(update);
			events.push({
				type: 'tool.start',
				callId: String(update.toolCallId ?? 'tool'),
				name: String(title || (toolKind && toolKind !== 'other' ? toolKind : undefined) || 'tool'),
				title,
				input,
				cwd: this.toolCwd(update),
				kind: mapAcpToolKind(toolKind),
				...(locations.length ? { locations } : {}),
				...(diffs.length ? { diffs } : {}),
			});
			const status = String(update.status ?? '');
			if (status === 'completed' || status === 'failed') {
				// Some agents report a call that already finished in its first `tool_call`.
				events.push({
					type: 'tool.end',
					callId: String(update.toolCallId ?? 'tool'),
					result: update.content ?? update.rawOutput ?? update.output,
					error: status === 'failed' ? 'Tool failed' : undefined,
					...(diffs.length ? { diffs } : {}),
				});
			}
		} else if (kind === 'tool_call_update') {
			const status = String(update.status ?? '');
			const callId = String(update.toolCallId ?? 'tool');
			const input = collectAcpToolInput(update);
			if (input) {
				events.push({ type: 'tool.input.delta', callId, delta: input });
			}
			const title = typeof update.title === 'string' && update.title.trim() ? update.title : undefined;
			const toolKind = typeof update.kind === 'string' ? mapAcpToolKind(update.kind) : undefined;
			const locations = collectAcpToolLocations(update);
			const diffs = collectAcpToolDiffs(update);
			if (title || toolKind || locations.length || diffs.length) {
				events.push({
					type: 'tool.update',
					callId,
					...(title ? { title } : {}),
					...(toolKind ? { kind: toolKind } : {}),
					...(locations.length ? { locations } : {}),
					...(diffs.length ? { diffs } : {}),
				});
			}
			if (status === 'completed' || status === 'failed') {
				const rawError = (update.rawOutput as { error?: unknown } | undefined)?.error;
				events.push({
					type: 'tool.end',
					callId,
					result: update.content ?? update.rawOutput ?? update.output,
					error: status === 'failed' ? 'Tool failed' : typeof rawError === 'string' && rawError.trim() ? rawError.trim() : undefined,
					...(diffs.length ? { diffs } : {}),
				});
			}
		} else if (kind === 'session_info_update') {
			const title = typeof update.title === 'string' ? update.title.trim() : '';
			if (title) {
				events.push({ type: 'title', text: title });
			}
		} else if (kind === 'usage_update' || kind === 'state_update') {
			const usage = parseTokenUsage(update.usage ?? update);
			if (usage) {
				events.push(usage);
			}
		}
		const nestedUsage = kind === 'usage_update' || kind === 'state_update' ? undefined : parseTokenUsage(update.usage);
		if (nestedUsage) {
			events.push(nestedUsage);
		}
		for (const notice of noticesFromAcpUpdate(update)) {
			events.push({
				type: 'notice',
				severity: notice.severity,
				title: notice.title,
				...(notice.description ? { description: notice.description } : {}),
			});
		}
		return events;
	}

	private toolCwd(update: Record<string, unknown>): string | undefined {
		const input = collectAcpToolInput(update);
		if (!input) {
			return undefined;
		}
		try {
			const o = JSON.parse(input) as Record<string, unknown>;
			if (!o || typeof o !== 'object') {
				return undefined;
			}
			for (const key of ['cwd', 'workdir', 'working_directory', 'workingDirectory']) {
				if (typeof o[key] === 'string' && o[key]) {
					return o[key] as string;
				}
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	private contentText(content: unknown): string {
		if (!content) {
			return '';
		}
		if (typeof content === 'string') {
			return content;
		}
		if (typeof content === 'object' && content && 'text' in content) {
			return String((content as { text?: string }).text ?? '');
		}
		return '';
	}

	private bindClientRequests(client: AcpJsonRpcClient): void {
		client.handleRequests(async req => {
			const received = Date.now();
			const live = this.sessionForClient(client);
			const turn = live?.turn && !live.turn.ended ? live.turn : undefined;
			// An agent asking Volt something is alive and working.
			turn?.watchdog.activity();
			try {
				await this.answerRequest(client, live, turn, req);
			} catch (err) {
				this.logService.error('[ACP]', err);
				await client.respondError(req.id, err instanceof Error ? err.message : String(err)).catch(() => undefined);
			} finally {
				this.logService.trace(`[ACP] ${req.method} answered in ${Date.now() - received}ms`);
			}
		});
	}

	private async answerRequest(client: AcpJsonRpcClient, live: IAcpSession | undefined, turn: AcpPromptTurn | undefined, req: IAcpIncomingRequest): Promise<void> {
		if (req.method === 'fs/read_text_file' || req.method === 'fs/write_text_file') {
			const params = req.params as { path?: string; uri?: string; file?: string; content?: string; line?: number; limit?: number };
			const path = params.uri || params.path || params.file;
			const uri = this.toUri(path);
			if (!uri) {
				await client.respondError(req.id, 'Missing path');
				return;
			}
			const write = req.method === 'fs/write_text_file';
			// The access check and the read are independent: run them together instead of back to back.
			// Reading has no side effects, so a denied request just drops what was read.
			const [allowed, current] = await Promise.all([
				this.authorizeFs(live, turn, write ? 'edit' : 'read', path ?? uri.fsPath),
				write
					? this.fileService.readFile(uri).then(file => file.value.toString(), () => undefined)
					: this.readTextFile(uri, params.line, params.limit).then(text => ({ text }), error => ({ error })),
			]);
			if (!allowed) {
				await client.respondError(req.id, 'Blocked by Volt access policy');
				return;
			}
			if (!write) {
				const read = current as { text: string } | { error: unknown };
				if ('error' in read) {
					throw read.error;
				}
				await client.respond(req.id, { content: read.text });
				return;
			}
			const before = current as string | undefined;
			await this.fileService.writeFile(uri, VSBuffer.fromString(params.content ?? ''));
			await client.respond(req.id, {});
			if (live?.voltSessionId) {
				this.writeObserver?.({ sessionId: live.voltSessionId, runId: live.runId ?? '', uri, before });
			}
			if (live && turn) {
				this.applyDirectives(live, turn, turn.supervisor.observeWrite(uri.fsPath, before, params.content ?? ''));
			}
			return;
		}
		if (req.method === 'session/request_permission' && isVoltHostToolPermission(req.params)) {
			// Volt's own MCP tools (questions, the in-app browser) act inside Volt: asking the
			// user before every click of a test run would make them useless.
			await client.respond(req.id, allowOncePermission(req.params));
			return;
		}
		if (req.method === 'cursor/task') {
			// Cursor reports a finished Task here: which model ran it, its id and how long it took.
			const params = req.params as { toolCallId?: unknown; model?: unknown; agentId?: unknown; durationMs?: unknown } | undefined;
			if (live && turn && typeof params?.toolCallId === 'string') {
				this.pushActivity(live, turn, {
					type: 'subagent.update',
					childId: params.toolCallId,
					...(typeof params.model === 'string' && params.model ? { model: params.model } : {}),
				});
			}
			await client.respond(req.id, {});
			return;
		}
		if (req.method === 'cursor/update_todos') {
			// Cursor's to-do tool: its list arrives here, not as an ACP plan update.
			if (live && turn) {
				this.pushActivity(live, turn, planFromCursorTodos(req.params));
			}
			await client.respond(req.id, {});
			return;
		}
		if (req.method === 'cursor/ask_question' || req.method === 'elicitation/create') {
			// The user owns the clock while the question tray is open.
			const paused = turn?.watchdog.pause();
			try {
				await client.respond(req.id, await this.answerQuestions(live, req.method, req.params));
			} finally {
				paused?.dispose();
			}
			return;
		}
		if (req.method === 'session/request_permission' && !turn) {
			// No turn is running: a request left over from a cancelled one (Cursor sends them late) is refused.
			await client.respond(req.id, this.bridge.toNativeResponse({ requestId: '', effect: 'deny', scope: 'once' }, req.params));
			return;
		}
		if (req.method === 'session/request_permission') {
			const request = this.bridge.normalize(req.method, req.params, {
				sessionId: live?.voltSessionId ?? '',
				runId: live?.runId ?? '',
				providerId: this.id,
			});
			if (!request || !this.gate) {
				await client.respond(req.id, this.bridge.toNativeResponse({ requestId: '', effect: 'deny', scope: 'once' }, req.params));
				return;
			}
			const decision = await this.evaluateGate(turn, request);
			await client.respond(req.id, this.bridge.toNativeResponse(decision, req.params));
			return;
		}
		await client.respondError(req.id, `Unsupported method ${req.method}`);
	}

	/**
	 * Policy and memoised answers come back synchronously and are used as is; a Promise means the
	 * user is being asked, so the idle watchdog pauses until they answer.
	 */
	private async evaluateGate(turn: AcpPromptTurn | undefined, request: IAccessRequest): Promise<IAccessDecision> {
		const decision = this.gate!.evaluate(request);
		if (!(decision instanceof Promise)) {
			return decision;
		}
		const paused = turn?.watchdog.pause();
		try {
			return await decision;
		} finally {
			paused?.dispose();
		}
	}

	private async answerQuestions(live: IAcpSession | undefined, method: string, params: unknown): Promise<unknown> {
		const cursor = method === 'cursor/ask_question';
		const draft = cursor ? parseQuestionDraft(params) : elicitationToQuestions(params);
		if (!draft || !this.questionAsker || !live?.voltSessionId) {
			// Unanswerable here: Cursor falls back to its permission prompts, Claude to a plain question.
			return cursor ? { outcome: { outcome: 'skipped', reason: 'Volt could not show these questions' } } : { action: 'decline' };
		}
		const response = await this.questionAsker(live.voltSessionId, live.runId ?? '', draft);
		return cursor ? cursorAskQuestionResult(draft, response) : elicitationResult(draft, response);
	}

	private sessionForClient(client: AcpJsonRpcClient): IAcpSession | undefined {
		for (const session of this.sessions.values()) {
			if (session.client === client) {
				return session;
			}
		}
		return undefined;
	}

	private async authorizeFs(live: IAcpSession | undefined, turn: AcpPromptTurn | undefined, action: 'read' | 'edit', path: string): Promise<boolean> {
		if (!this.gate) {
			return action === 'read';
		}
		const decision = await this.evaluateGate(turn, {
			id: generateUuid(),
			sessionId: live?.voltSessionId ?? '',
			runId: live?.runId ?? '',
			providerId: this.id,
			action,
			resource: { type: 'file', value: path },
			risk: classifyRisk(action, path),
			preview: { title: action === 'edit' ? 'Edit' : 'Read', detail: path },
			createdAt: Date.now(),
		});
		return decision.effect === 'allow';
	}

	private async readTextFile(uri: URI, line?: number, limit?: number): Promise<string> {
		const file = await this.fileService.readFile(uri);
		let text = file.value.toString();
		if (line || limit) {
			const lines = text.split('\n');
			const start = Math.max(0, (typeof line === 'number' && line > 0 ? line : 1) - 1);
			const end = typeof limit === 'number' && limit > 0 ? start + limit : lines.length;
			text = lines.slice(start, end).join('\n');
		}
		const max = 256_000;
		return text.length > max ? `${text.slice(0, max)}\n\n[truncated after 256KB]` : text;
	}

	private toUri(pathOrUri: string | undefined): URI | undefined {
		if (!pathOrUri) {
			return undefined;
		}
		return pathOrUri.includes('://') ? URI.parse(pathOrUri) : URI.file(pathOrUri);
	}
}

function availableCommandsUpdate(params: unknown): ReadonlySet<string> | undefined {
	const update = (params as { update?: { sessionUpdate?: string; availableCommands?: unknown } } | undefined)?.update;
	if (update?.sessionUpdate !== 'available_commands_update' || !Array.isArray(update.availableCommands)) {
		return undefined;
	}
	const names = update.availableCommands
		.map(command => typeof command?.name === 'string' ? command.name.replace(/^\//, '').trim() : '')
		.filter(Boolean);
	return new Set(names);
}

function currentModeUpdate(params: unknown): string | undefined {
	const body = params as { update?: { sessionUpdate?: string; currentModeId?: unknown } } | undefined;
	const update = body?.update;
	return update?.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string' ? update.currentModeId : undefined;
}

/** `cursor/update_todos` params as a Volt plan event. */
export function planFromCursorTodos(params: unknown): Extract<IVoltEvent, { type: 'plan' }> {
	const todos = (params as { todos?: { content?: string; status?: string }[] } | undefined)?.todos ?? [];
	return {
		type: 'plan',
		entries: todos.map(todo => {
			const status = String(todo.status ?? '').toLowerCase().replace(/^todo_status_/, '');
			return {
				content: todo.content ?? '',
				status: status === 'completed' ? 'completed' : status === 'in_progress' ? 'in_progress' : 'pending',
			};
		}),
	};
}

/**
 * Volt's host MCP server is HTTP. Agents declare HTTP support in `mcpCapabilities.http`; one that
 * does not would reject the whole `session/new` over a transport it cannot speak.
 */
export function acceptedMcpServers(servers: readonly IVoltMcpServer[], capabilities: IAcpMcpCapabilities | undefined): IVoltMcpServer[] {
	return servers.filter(server => server.type !== 'http' || capabilities?.http === true);
}

/** The session already holds this value (Cursor's Auto is the `default` choice). */
export function configValueIsCurrent(option: IAcpConfigOption | undefined, value: string | boolean): boolean {
	if (!option || option.currentValue === undefined || option.currentValue === null) {
		return false;
	}
	const current = String(option.currentValue).trim().toLowerCase();
	const wanted = String(value).trim().toLowerCase();
	if (current === wanted) {
		return true;
	}
	if (wanted === 'auto' && current === 'default') {
		return flattenChoices(option).some(choice => choice.value === 'default' && /^auto$/i.test(choice.name.trim()));
	}
	return false;
}

function formatQuiet(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 120) {
		return `${seconds} s`;
	}
	return `${Math.round(seconds / 60)} min`;
}
