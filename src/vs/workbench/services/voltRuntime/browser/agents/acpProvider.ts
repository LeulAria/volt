/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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
import { IVoltEvent } from '../../common/events.js';
import { parseTokenUsage } from '../../common/tokenUsage.js';
import { VoltMode } from '../../common/modes.js';
import { IProviderProfile } from '../../common/profiles.js';
import { IAgentMessage, IAgentProvider, IAgentSessionHandle, IAgentStartRequest, IDetectResult, IModelInfo } from '../../common/providers.js';
import { DEFAULT_ACP_CAPABILITIES } from '../../common/capabilities.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltHostToolService } from '../../common/hostTools.js';
import { formatRunPlanHint } from '../../common/runPlan.js';
import { loadWorkspaceRunPlanHint } from '../workspaceRunPlan.js';
import { accessBridgeFor } from './bridges/accessBridges.js';
import { AcpJsonRpcClient } from './acpJsonRpc.js';
import { IModelOptionDescriptor } from '../../common/modelOptions.js';
import { applyOptionsToParameterizedId, configUpdatesForOptions, descriptorsFromConfigOptions, descriptorsFromParams, flattenChoices, formatAgentModelLabel, IAcpAvailableModel, IAcpConfigOption, IAcpModelMeta, isModelConfigOption, metadataFromAcpModel, parseParameterizedModelId } from './acpModels.js';

interface IAcpSession {
	handle: IAgentSessionHandle;
	client: AcpJsonRpcClient;
	processId: string;
	configOptions?: IAcpConfigOption[];
	modes?: { id: string; name?: string }[];
	voltSessionId?: string;
	runId?: string;
	mode?: VoltMode;
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
	private runPlanHint: string | undefined;
	private readonly hintedSessions = new Set<string>();

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
		return this.probe(profile, async (client, session) => {
			const listed = await withTimeout(
				client.request<{ models?: IAcpAvailableModel[] }>('cursor/list_available_models', {}),
				MODEL_PROBE_TIMEOUT_MS,
			).catch(() => undefined);
			if (listed?.models?.length) {
				return this.collapseModels(listed.models.map(model => {
					const value = model.value ?? '';
					const { base, params } = parseParameterizedModelId(value);
					const own = descriptorsFromConfigOptions(model.configOptions);
					return this.toModelInfo(
						value,
						formatAgentModelLabel(this.label, base || model.name, model.name),
						own.length ? own : descriptorsFromParams(params),
						undefined,
						metadataFromAcpModel(model, params),
					);
				}));
			}

			const shared = descriptorsFromConfigOptions(session?.configOptions?.filter(option => !isModelConfigOption(option)));

			const modelOption = session?.configOptions?.find(isModelConfigOption);
			const choices = flattenChoices(modelOption);
			if (choices.length) {
				return this.collapseModels(choices.map(choice => this.fromParameterized(choice.value, choice.name, shared)));
			}

			return this.collapseModels((session?.models?.availableModels ?? []).map(model => {
				const own = descriptorsFromConfigOptions(model.configOptions);
				return this.fromParameterized(model.value ?? model.modelId ?? '', model.name, own.length ? own : shared, model);
			}));
		}).catch(() => []);
	}

	async start(req: IAgentStartRequest): Promise<IAgentSessionHandle> {
		const command = req.profile.command || this.defaultCommand;
		const args = req.profile.args?.length ? req.profile.args : this.defaultArgs;
		const cwd = req.cwd || req.profile.cwd || this.workspace.getWorkspace().folders[0]?.uri.fsPath;
		const processId = await this.stdio.spawn({ command, args, cwd });
		const client = new AcpJsonRpcClient(this.stdio, processId);
		this.bindClientRequests(client);

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

	/** Pushes the picked model and its options onto a freshly created session. */
	private async applySelection(session: IAcpSession, req: IAgentStartRequest): Promise<void> {
		const sessionId = session.handle.providerSessionId ?? session.handle.id;
		const modelConfigId = session.configOptions?.find(isModelConfigOption)?.id ?? 'model';
		if (req.modelId) {
			const reconstructed = applyOptionsToParameterizedId(req.modelId, req.options);
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
		const own = descriptorsFromParams(params);
		return this.toModelInfo(
			id,
			formatAgentModelLabel(this.label, base || rawName, rawName),
			own.length ? own : shared,
			undefined,
			source ? metadataFromAcpModel(source, params) : metadataFromAcpModel({ name: rawName }, params),
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
		if (!live) {
			yield { type: 'error', message: 'ACP session is not running. Reconnect the agent in Volt Settings.' };
			return;
		}

		const queue: IVoltEvent[] = [];
		let waiting: (() => void) | undefined;
		let finished = false;
		const push = (event: IVoltEvent) => {
			queue.push(event);
			waiting?.();
		};

		const notif = live.client.onNotification(note => {
			if (note.method !== 'session/update') {
				return;
			}
			for (const event of this.mapUpdate(note.params)) {
				push(event);
			}
		});

		const cancel = token.onCancellationRequested(() => {
			void live.client.notify('session/cancel', { sessionId: session.providerSessionId ?? session.id });
		});

		const prompt = live.client.request<{ stopReason?: string; usage?: unknown }>('session/prompt', {
			sessionId: session.providerSessionId ?? session.id,
			prompt: [{ type: 'text', text: await this.withHarness(session, this.withMode(msg)) }],
		}).then(result => {
			const usage = parseTokenUsage(result);
			if (usage) {
				push(usage);
			}
			push({ type: 'run.end', runId: session.id, reason: result?.stopReason === 'cancelled' ? 'abort' : 'done' });
		}).catch(err => {
			push({ type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
			push({ type: 'run.end', runId: session.id, reason: token.isCancellationRequested ? 'abort' : 'fail' });
		}).finally(() => {
			finished = true;
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
		this.hintedSessions.delete(session.id);
		live.client.dispose();
		await this.stdio.kill(live.processId);
	}

	private async withHarness(session: IAgentSessionHandle, text: string): Promise<string> {
		if (this.hintedSessions.has(session.id)) {
			return text;
		}
		this.hintedSessions.add(session.id);
		try {
			this.runPlanHint ??= await loadWorkspaceRunPlanHint(this.fileService, this.workspace);
		} catch {
			this.runPlanHint = formatRunPlanHint({ kind: 'unknown' });
		}
		return `${this.runPlanHint}\n\n${text}`;
	}

	private withMode(msg: IAgentMessage): string {
		if (msg.mode === 'agent') {
			return msg.text;
		}
		return `[Volt mode: ${msg.mode}]\n${msg.text}`;
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
			const input = this.toolInput(update);
			events.push({
				type: 'tool.start',
				callId: String(update.toolCallId ?? 'tool'),
				name: String(update.kind ?? update.title ?? 'tool'),
				title: typeof update.title === 'string' ? update.title : undefined,
				input,
				cwd: this.toolCwd(update),
			});
		} else if (kind === 'tool_call_update') {
			const status = String(update.status ?? '');
			const input = this.toolInput(update);
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

	private toolInput(update: Record<string, unknown>): string | undefined {
		const raw = update.rawInput ?? update.input ?? update.arguments;
		const location = this.toolLocation(update);
		if (typeof raw === 'string' && raw.trim()) {
			if (location && !raw.includes(location.path)) {
				return JSON.stringify({ path: location.path, line: location.line, text: raw });
			}
			return raw;
		}
		if (raw && typeof raw === 'object') {
			const o = { ...(raw as Record<string, unknown>) };
			if (location && !this.objectHasPath(o)) {
				o.path = location.path;
				if (location.line !== undefined && o.line === undefined) {
					o.line = location.line;
				}
			}
			try {
				return JSON.stringify(o);
			} catch {
				return undefined;
			}
		}
		if (location) {
			return JSON.stringify({ path: location.path, line: location.line });
		}
		const content = this.contentText(update.content);
		return content || undefined;
	}

	private toolLocation(update: Record<string, unknown>): { path: string; line?: number } | undefined {
		const locations = update.locations;
		if (!Array.isArray(locations) || !locations.length) {
			return undefined;
		}
		const first = locations[0];
		if (!first || typeof first !== 'object') {
			return undefined;
		}
		const rec = first as Record<string, unknown>;
		const path = typeof rec.path === 'string' && rec.path
			? rec.path
			: typeof rec.uri === 'string' && rec.uri ? rec.uri : undefined;
		if (!path) {
			return undefined;
		}
		const line = Number(rec.line ?? rec.lineNumber ?? rec.line_number);
		return { path, line: Number.isFinite(line) && line > 0 ? line : undefined };
	}

	private objectHasPath(o: Record<string, unknown>): boolean {
		return ['path', 'file', 'uri', 'target', 'filename', 'target_file', 'targetFile', 'file_path', 'filePath'].some(key => typeof o[key] === 'string' && o[key]);
	}

	private toolCwd(update: Record<string, unknown>): string | undefined {
		const raw = update.rawInput ?? update.input ?? update.arguments;
		if (!raw || typeof raw !== 'object') {
			return undefined;
		}
		const o = raw as Record<string, unknown>;
		for (const key of ['cwd', 'workdir', 'working_directory', 'workingDirectory']) {
			if (typeof o[key] === 'string' && o[key]) {
				return o[key] as string;
			}
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
		client.onRequest(async req => {
			try {
				if (req.method === 'fs/read_text_file' || req.method === 'fs/write_text_file') {
					const params = req.params as { path?: string; uri?: string; content?: string };
					const path = params.uri || params.path;
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
						const file = await this.fileService.readFile(uri);
						await client.respond(req.id, { content: file.value.toString() });
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

	private toUri(pathOrUri: string | undefined): URI | undefined {
		if (!pathOrUri) {
			return undefined;
		}
		return pathOrUri.includes('://') ? URI.parse(pathOrUri) : URI.file(pathOrUri);
	}
}

