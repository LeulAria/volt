/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IAccessGate, ICompiledPolicy } from '../../common/access/accessTypes.js';
import { IProviderAccessBridge } from '../../common/access/providerAccessBridge.js';
import { classifyRisk } from '../../common/access/riskClassifier.js';
import { collectAcpToolInput } from '../../common/acpToolInput.js';
import { IVoltEvent } from '../../common/events.js';
import { parseTokenUsage } from '../../common/tokenUsage.js';
import { VoltMode } from '../../common/modes.js';
import { IProviderProfile } from '../../common/profiles.js';
import { IAgentMessage, IAgentProvider, IAgentSessionHandle, IAgentStartRequest, IDetectResult, IModelInfo } from '../../common/providers.js';
import { DEFAULT_ACP_CAPABILITIES } from '../../common/capabilities.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltHostToolService } from '../../common/hostTools.js';
import { mapAcpToolKind } from '../../common/harness/workLog.js';
import { ACP_PROMPT_STALL_MS, startPromptStall } from '../../common/harness/acpStall.js';
import { isCursorPlanWall, isCursorPlanWallPrefix, isCursorTransientError, nextCursorFallback, normalizeCursorModelId } from '../../common/harness/cursorQuota.js';
import { accessBridgeFor } from './bridges/accessBridges.js';
import { AcpJsonRpcClient } from './acpJsonRpc.js';
import { listAntigravityModels } from './cliAgents.js';
import { resolveAntigravityCliModelLabel } from '../../common/models/antigravityModels.js';
import { IModelOptionDescriptor, MODEL_OPTION_REASONING, unionDescriptors } from '../../common/models/modelOptions.js';
import { applyContextWindowSuffix, applyOptionsToParameterizedId, configUpdatesForOptions, descriptorsFromAcpModel, flattenChoices, formatAgentModelLabel, IAcpAvailableModel, IAcpConfigOption, IAcpModelMeta, isModelConfigOption, metadataForAcpModel, parseParameterizedModelId } from './acpModels.js';

interface IAcpSession {
	handle: IAgentSessionHandle;
	client: AcpJsonRpcClient;
	processId: string;
	configOptions?: IAcpConfigOption[];
	modes?: { id: string; name?: string }[];
	voltSessionId?: string;
	runId?: string;
	mode?: VoltMode;
	currentModel?: string;
}

interface ISessionNewResponse {
	sessionId: string;
	configOptions?: IAcpConfigOption[];
	models?: { availableModels?: IAcpAvailableModel[]; currentModelId?: string };
}

/** Opting in makes Cursor expose per model reasoning, context, and fast toggles. */
const PARAMETERIZED_MODEL_PICKER = { _meta: { parameterizedModelPicker: true } };

const MODEL_PROBE_TIMEOUT_MS = 8000;

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
		const sessionId = live.handle.providerSessionId ?? live.handle.id;
		const config = this.bridge.translate(policy, { configOptions: live.configOptions, modes: live.modes });
		for (const update of config.configOptions ?? []) {
			await this.setConfigOption(live, sessionId, update.id, update.value);
		}
		if (config.sessionModeId) {
			try {
				await live.client.request('session/set_mode', { sessionId, modeId: config.sessionModeId });
			} catch (err) {
				this.logService.trace('[ACP] session/set_mode failed', err);
			}
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
	 * catalog and the runtime falls back to a single entry for the agent itself.
	 */
	async listModels(profile: IProviderProfile): Promise<IModelInfo[]> {
		if (this.id === 'antigravity') {
			const listed = await listAntigravityModels(this.stdio, profile.command || this.defaultCommand).catch(() => []);
			if (listed.length) {
				return listed;
			}
		}
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
		const command = req.profile.command || this.defaultCommand;
		const args = this.startArgs(req);
		const cwd = req.cwd || req.profile.cwd || this.workspace.getWorkspace().folders[0]?.uri.fsPath;
		const processId = await this.stdio.spawn({ command, args, cwd });
		const client = new AcpJsonRpcClient(this.stdio, processId);
		this.bindClientRequests(client);
		client.whenDead(() => {
			for (const [id, session] of this.sessions) {
				if (session.client === client) {
					this.sessions.delete(id);
				}
			}
		});

		const initialized = await client.request<{
			agentCapabilities?: { session?: { _meta?: unknown; modes?: { availableModes?: { id: string; name?: string }[] } } };
			configOptions?: IAcpConfigOption[];
		}>('initialize', {
			protocolVersion: 1,
			clientCapabilities: {
				fs: { readTextFile: true, writeTextFile: true },
				terminal: false,
				...PARAMETERIZED_MODEL_PICKER,
			},
			clientInfo: { name: 'volt', title: 'Volt', version: '0.1.0' },
		});

		const created = await client.request<ISessionNewResponse>('session/new', {
			cwd: cwd ?? '',
			mcpServers: [...(this.hostTools?.getMcpServers() ?? [])],
		});

		const handle: IAgentSessionHandle = {
			id: created.sessionId,
			providerSessionId: created.sessionId,
		};
		const live: IAcpSession = {
			handle,
			client,
			processId,
			configOptions: created.configOptions ?? initialized.configOptions,
			modes: initialized.agentCapabilities?.session?.modes?.availableModes,
		};
		this.sessions.set(handle.id, live);
		await this.applySelection(live, req);
		return handle;
	}

	isLive(session: IAgentSessionHandle): boolean {
		const live = this.sessions.get(session.id);
		return !!live && !live.client.isDead;
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

	/** Pushes the picked model and its options onto a freshly created session. */
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
			const applied = await this.setConfigOption(session, sessionId, modelConfigId, reconstructed);
			if (!applied && reconstructed !== req.modelId) {
				await this.setConfigOption(session, sessionId, modelConfigId, req.modelId);
			}
		}
		for (const update of configUpdatesForOptions(session.configOptions, req.options)) {
			await this.setConfigOption(session, sessionId, update.configId, update.value);
		}
	}

	private async setConfigOption(session: IAcpSession, sessionId: string, configId: string, value: string | boolean): Promise<boolean> {
		const params = typeof value === 'boolean'
			? { sessionId, configId, type: 'boolean', value }
			: { sessionId, configId, value };
		try {
			const response = await session.client.request<{ configOptions?: IAcpConfigOption[] }>('session/set_config_option', params);
			if (response?.configOptions) {
				session.configOptions = response.configOptions;
			}
			if (typeof value === 'string' && (configId === 'model' || isModelConfigOption({ id: configId, name: configId }))) {
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
		const args = profile.args?.length ? profile.args : this.defaultArgs;
		const cwd = profile.cwd || this.workspace.getWorkspace().folders[0]?.uri.fsPath;
		const processId = await this.stdio.spawn({ command, args, cwd });
		const client = new AcpJsonRpcClient(this.stdio, processId);
		try {
			await withTimeout(client.request('initialize', {
				protocolVersion: 1,
				clientCapabilities: {
					fs: { readTextFile: true, writeTextFile: true },
					terminal: false,
					...PARAMETERIZED_MODEL_PICKER,
				},
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

		const queue: IVoltEvent[] = [];
		let waiting: (() => void) | undefined;
		let finished = false;
		const push = (event: IVoltEvent) => {
			queue.push(event);
			waiting?.();
		};
		const stall = startPromptStall(ACP_PROMPT_STALL_MS, () => {
			if (finished) {
				return;
			}
			push({ type: 'error', message: 'ACP agent produced no activity. The prompt stalled and the turn was stopped.', retryable: true });
			push({ type: 'run.end', runId: session.id, reason: 'fail' });
			finished = true;
			waiting?.();
			void live.client.notify('session/cancel', { sessionId: session.providerSessionId ?? session.id });
		});
		const pushActivity = (event: IVoltEvent) => {
			stall.ping();
			push(event);
		};

		let assistant = '';
		let usedTools = false;
		let held: IVoltEvent[] = [];
		const tried: string[] = live.currentModel ? [live.currentModel] : [];
		const sessionId = session.providerSessionId ?? session.id;
		const modelConfigId = live.configOptions?.find(isModelConfigOption)?.id ?? 'model';
		const holdPlanWall = this.id === 'cursor-acp';

		const flushHeld = () => {
			for (const event of held) {
				push(event);
			}
			held = [];
		};

		const notif = live.client.onNotification(note => {
			if (note.method !== 'session/update') {
				return;
			}
			for (const event of this.mapUpdate(note.params)) {
				if (event.type === 'tool.start') {
					usedTools = true;
					flushHeld();
				}
				if (holdPlanWall && event.type === 'text.delta' && event.delta) {
					assistant += event.delta;
					if (!usedTools && isCursorPlanWallPrefix(assistant)) {
						held.push(event);
						stall.ping();
						continue;
					}
					flushHeld();
				}
				pushActivity(event);
			}
		});

		const cancel = token.onCancellationRequested(() => {
			void live.client.notify('session/cancel', { sessionId });
		});

		const promptBody = [{ type: 'text', text: msg.lead ? `${msg.lead}\n\n${msg.text}` : msg.text }];

		const runPrompt = async (): Promise<void> => {
			try {
				const result = await live.client.request<{ stopReason?: string; usage?: unknown }>('session/prompt', {
					sessionId,
					prompt: promptBody,
				});
				stall.ping();
				if (holdPlanWall && !usedTools && !token.isCancellationRequested && isCursorPlanWall(assistant)) {
					const fallback = nextCursorFallback(tried);
					if (fallback) {
						tried.push(fallback);
						held = [];
						assistant = '';
						usedTools = false;
						await this.setConfigOption(live, sessionId, modelConfigId, fallback);
						push({
							type: 'retry',
							attempt: tried.length,
							delayMs: 0,
							message: `Cursor blocked that model. Retrying with ${fallback === 'auto' ? 'Auto' : 'Composer 2.5'}.`,
						});
						await runPrompt();
						return;
					}
					flushHeld();
				} else {
					flushHeld();
				}
				const usage = parseTokenUsage(result);
				if (usage) {
					push(usage);
				}
				push({ type: 'run.end', runId: session.id, reason: result?.stopReason === 'cancelled' ? 'abort' : 'done' });
			} catch (err) {
				stall.ping();
				const message = err instanceof Error ? err.message : String(err);
				if (holdPlanWall && !live.client.isDead && !token.isCancellationRequested && isCursorTransientError(message)) {
					const fallback = nextCursorFallback(tried);
					if (fallback) {
						tried.push(fallback);
						held = [];
						assistant = '';
						usedTools = false;
						await this.setConfigOption(live, sessionId, modelConfigId, fallback);
						push({
							type: 'retry',
							attempt: tried.length,
							delayMs: 0,
							message: `Cursor hit an internal error. Retrying with ${fallback === 'auto' ? 'Auto' : 'Composer 2.5'}.`,
						});
						await runPrompt();
						return;
					}
				}
				flushHeld();
				push({ type: 'error', message, retryable: true });
				push({ type: 'run.end', runId: session.id, reason: token.isCancellationRequested ? 'abort' : 'fail' });
			}
		};

		const prompt = runPrompt().finally(() => {
			finished = true;
			stall.dispose();
			waiting?.();
		});

		try {
			while (!finished || queue.length) {
				if (!queue.length) {
					await new Promise<void>(resolve => { waiting = resolve; });
					waiting = undefined;
					continue;
				}
				yield queue.shift()!;
			}
			await prompt;
		} finally {
			stall.dispose();
			notif.dispose();
			cancel.dispose();
		}
	}

	async interrupt(session: IAgentSessionHandle): Promise<void> {
		const live = this.sessions.get(session.id);
		if (live) {
			await live.client.notify('session/cancel', { sessionId: session.providerSessionId ?? session.id });
		}
	}

	async dispose(session: IAgentSessionHandle): Promise<void> {
		const live = this.sessions.get(session.id);
		if (!live) {
			return;
		}
		this.sessions.delete(session.id);
		live.client.dispose();
		await this.stdio.kill(live.processId);
	}

	private mapUpdate(params: unknown): IVoltEvent[] {
		const body = params as { update?: Record<string, unknown>; sessionUpdate?: string };
		const update = (body.update ?? body) as Record<string, unknown>;
		const kind = String(update.sessionUpdate ?? update.type ?? '');
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
			events.push({
				type: 'tool.start',
				callId: String(update.toolCallId ?? 'tool'),
				name: String(title || (toolKind && toolKind !== 'other' ? toolKind : undefined) || 'tool'),
				title,
				input,
				cwd: this.toolCwd(update),
				kind: mapAcpToolKind(toolKind),
			});
		} else if (kind === 'tool_call_update') {
			const status = String(update.status ?? '');
			const input = collectAcpToolInput(update);
			if (input) {
				events.push({ type: 'tool.input.delta', callId: String(update.toolCallId ?? 'tool'), delta: input });
			}
			if (status === 'completed' || status === 'failed') {
				events.push({
					type: 'tool.end',
					callId: String(update.toolCallId ?? 'tool'),
					result: update.content ?? update.rawOutput ?? update.output,
					error: status === 'failed' ? 'Tool failed' : undefined,
				});
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
			try {
				if (req.method === 'fs/read_text_file' || req.method === 'fs/write_text_file') {
					const params = req.params as { path?: string; uri?: string; file?: string; content?: string; line?: number; limit?: number };
					const path = params.uri || params.path || params.file;
					const uri = this.toUri(path);
					if (!uri) {
						await client.respondError(req.id, 'Missing path');
						return;
					}
					const allowed = await this.authorizeFs(client, req.method === 'fs/write_text_file' ? 'edit' : 'read', path ?? uri.fsPath);
					if (!allowed) {
						await client.respondError(req.id, 'Blocked by Volt access policy');
						return;
					}
					if (req.method === 'fs/read_text_file') {
						await client.respond(req.id, { content: await this.readTextFile(uri, params.line, params.limit) });
						return;
					}
					await this.fileService.writeFile(uri, VSBuffer.fromString(params.content ?? ''));
					await client.respond(req.id, {});
					return;
				}
				if (req.method === 'session/request_permission') {
					const live = this.sessionForClient(client);
					const request = this.bridge.normalize(req.method, req.params, {
						sessionId: live?.voltSessionId ?? '',
						runId: live?.runId ?? '',
						providerId: this.id,
					});
					if (!request || !this.gate) {
						await client.respond(req.id, this.bridge.toNativeResponse({ requestId: '', effect: 'deny', scope: 'once' }, req.params));
						return;
					}
					const decision = await Promise.resolve(this.gate.evaluate(request));
					await client.respond(req.id, this.bridge.toNativeResponse(decision, req.params));
					return;
				}
				await client.respondError(req.id, `Unsupported method ${req.method}`);
			} catch (err) {
				this.logService.error('[ACP]', err);
				await client.respondError(req.id, err instanceof Error ? err.message : String(err));
			}
		});
	}

	private sessionForClient(client: AcpJsonRpcClient): IAcpSession | undefined {
		for (const session of this.sessions.values()) {
			if (session.client === client) {
				return session;
			}
		}
		return undefined;
	}

	private async authorizeFs(client: AcpJsonRpcClient, action: 'read' | 'edit', path: string): Promise<boolean> {
		if (!this.gate) {
			return action === 'read';
		}
		const live = this.sessionForClient(client);
		const decision = await Promise.resolve(this.gate.evaluate({
			id: generateUuid(),
			sessionId: live?.voltSessionId ?? '',
			runId: live?.runId ?? '',
			providerId: this.id,
			action,
			resource: { type: 'file', value: path },
			risk: classifyRisk(action, path),
			preview: { title: action === 'edit' ? 'Edit' : 'Read', detail: path },
			createdAt: Date.now(),
		}));
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

