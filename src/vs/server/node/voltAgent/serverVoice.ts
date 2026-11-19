/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { AgentServerProtocol } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { isVoiceProvider, IVoltVoiceCall, VoltVoiceProvider } from '../../../platform/voltVoiceChat/common/voltVoiceChat.js';
import { VoltVoiceChatService } from '../../../platform/voltVoiceChat/node/voltVoiceChatService.js';
import { IAgentHistoryService } from '../../../workbench/services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolService } from '../../../workbench/services/voltRuntime/common/hostTools.js';
import { IAgentOrchestratorService } from '../../../workbench/services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../workbench/services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../workbench/services/voltRuntime/common/sessionContext.js';
import { sessionUpdate } from '../../../workbench/contrib/voltVoiceChat/common/realtimeProtocol.js';
import { greetingInstructions } from '../../../workbench/contrib/voltVoiceChat/common/voiceAgent.js';
import { IVoiceCallSettings, VoiceCallBrain } from '../../../workbench/contrib/voltVoiceChat/common/voiceCallBrain.js';
import {
	VOICE_CHAT_CUSTOM_URL_SETTING, VOICE_CHAT_LANGUAGE_SETTING, VOICE_CHAT_PROVIDER_SETTING, VOICE_CHAT_SPEED_SETTING, VOICE_CHAT_VOICE_SETTING,
} from '../../../workbench/contrib/voltVoiceChat/common/voltVoiceChat.js';

/** A call hangs up on the server when its phone stops reporting (a closed app, a lost network). */
const SILENT_CALL_MS = 120_000;

/** What `voice.event` carries to the phone that runs the call. */
export type ServerVoiceEvent =
	| { readonly callId: string; readonly kind: 'note'; readonly text: string }
	| { readonly callId: string; readonly kind: 'chat'; readonly chatId: string }
	| { readonly callId: string; readonly kind: 'ended' };

interface IServerCall {
	readonly brain: VoiceCallBrain;
	readonly provider: VoltVoiceProvider;
	settings: IVoiceCallSettings;
	readonly projectId?: string;
	heardAt: number;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Voice chat for paired phones (`voice.*`): the phone streams the audio to the voice provider
 * itself; the agent server mints its secret, builds the session (instructions and tools), runs the
 * tools against the chats, keeps the call's record, and sends `voice.event` notes for the voice
 * to speak when the chat's agent finishes. The same `VoiceCallBrain` the desktop runs.
 */
export class ServerVoice extends Disposable {

	private readonly calls = this._register(new DisposableMap<string, IServerCall & { dispose(): void }>());

	constructor(
		private readonly protocol: AgentServerProtocol,
		private readonly voiceService: Omit<VoltVoiceChatService, '_serviceBrand'>,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(protocol.registerMethods('voice', {
			keyStatus: () => this.voiceService.keyStatus(),
			start: (_ctx, options) => this.start((options ?? {}) as Record<string, unknown>),
			connected: (_ctx, callId) => this.withCall(callId, call => call.brain.connected()),
			turn: (_ctx, callId, role, said, itemId) => this.withCall(callId, call => {
				const spoken = text(said);
				if (spoken && (role === 'user' || role === 'assistant')) {
					call.heardAt = Date.now();
					call.brain.addTurn({ role, text: spoken, ...(typeof itemId === 'string' ? { id: itemId } : {}) });
				}
			}),
			heard: (_ctx, callId) => this.withCall(callId, call => {
				call.heardAt = Date.now();
				call.brain.heard();
			}),
			tool: (_ctx, callId, name, args) => this.withCall(callId, call => call.brain.runTool(String(name ?? ''), typeof args === 'string' ? args : JSON.stringify(args ?? {}))),
			settings: (_ctx, callId, next) => this.withCall(callId, async call => {
				const patch = (next ?? {}) as Partial<IVoiceCallSettings>;
				call.settings = {
					voice: text(patch.voice) ?? call.settings.voice,
					speed: typeof patch.speed === 'number' ? patch.speed : call.settings.speed,
					language: text(patch.language) ?? call.settings.language,
				};
				return sessionUpdate(await call.brain.sessionConfig(call.provider, call.settings, 'phone', code => code));
			}),
			end: (_ctx, callId, status, error) => this.withCall(callId, async call => {
				await call.brain.end(status === 'failed' ? 'failed' : 'ended', text(error));
				this.calls.deleteAndDispose(String(callId));
			}),
			calls: async (_ctx, chatId) => (await this.voiceService.listCalls(text(chatId))).map(call => this.current(call)),
			call: async (_ctx, callId) => {
				const call = await this.voiceService.getCall(String(callId ?? ''));
				return call ? this.current(call) : undefined;
			},
		}));
		const sweep = setInterval(() => this.sweep(), 30_000);
		this._register({ dispose: () => clearInterval(sweep) });
	}

	private async start(options: Record<string, unknown>): Promise<unknown> {
		const chatId = text(options.chatId);
		const projectId = text(options.projectId);
		const configured = this.configurationService.getValue<string>(VOICE_CHAT_PROVIDER_SETTING);
		const provider: VoltVoiceProvider = isVoiceProvider(configured) ? configured : await this.autoProvider();
		const speed = Number(this.configurationService.getValue(VOICE_CHAT_SPEED_SETTING));
		const settings: IVoiceCallSettings = {
			voice: text(options.voice) ?? (this.configurationService.getValue<string>(VOICE_CHAT_VOICE_SETTING) || 'ara'),
			speed: typeof options.speed === 'number' ? options.speed : [0.75, 1, 1.25, 1.5, 2].includes(speed) ? speed : 1,
			language: text(options.language) ?? (this.configurationService.getValue<string>(VOICE_CHAT_LANGUAGE_SETTING) || 'auto'),
		};
		// Mint first: a missing key fails before any record is made.
		const session = await this.voiceService.mint({ provider, url: this.configurationService.getValue<string>(VOICE_CHAT_CUSTOM_URL_SETTING) || undefined });
		const callId = generateUuid();
		const brain = new VoiceCallBrain(callId, chatId, provider, settings.voice, {
			speak: note => this.publish({ callId, kind: 'note', text: note }),
			onChat: id => this.publish({ callId, kind: 'chat', chatId: id }),
			onRecord: () => { },
			save: record => this.voiceService.saveCall(record),
			earlierCalls: id => this.voiceService.listCalls(id),
			startChat: async (first, source) => {
				const project = projectId ?? this.sessionContext.activeProject?.id;
				if (!project) {
					return undefined;
				}
				const threadId = `agent-${generateUuid()}`;
				await this.sessionContext.bindSession(threadId, project);
				const result = await this.orchestrator.submit(threadId, { text: first, display: { text: first }, host: { fromThread: source } }, 'auto', generateUuid());
				return result.outcome === 'rejected' ? undefined : threadId;
			},
		}, { orchestrator: this.orchestrator, runtime: this.runtime, history: this.history, hostTools: this.hostTools, logService: this.logService });
		this.calls.set(callId, { brain, provider, settings, projectId, heardAt: Date.now(), dispose: () => brain.dispose() });
		this.logService.info(`[volt voice] phone call ${callId} started${chatId ? ` in ${chatId}` : ''}`);
		return {
			callId,
			session,
			sessionUpdate: sessionUpdate(await brain.sessionConfig(provider, settings, 'phone', code => code)),
			greeting: greetingInstructions(undefined),
			provider,
			settings,
		};
	}

	private async autoProvider(): Promise<VoltVoiceProvider> {
		const status = await this.voiceService.keyStatus().catch(() => []);
		return status.find(entry => entry.provider === 'xai' && entry.source)?.provider ?? status.find(entry => entry.provider === 'openai' && entry.source)?.provider ?? 'xai';
	}

	private async withCall<T>(callId: unknown, run: (call: IServerCall) => T | Promise<T>): Promise<T> {
		const call = this.calls.get(String(callId ?? ''));
		if (!call) {
			throw new Error('That voice call has ended.');
		}
		return run(call);
	}

	/** A saved call as the phone shows it: one this server no longer runs is ended. */
	private current(call: IVoltVoiceCall): IVoltVoiceCall {
		return call.status === 'ongoing' && !this.calls.has(call.id) ? { ...call, status: 'ended', endedAt: call.endedAt ?? call.lastHeardAt } : call;
	}

	/** Ends calls whose phone went quiet (the app was closed mid-call). */
	private sweep(): void {
		const now = Date.now();
		for (const [callId, call] of this.calls) {
			if (now - call.heardAt > SILENT_CALL_MS) {
				void call.brain.end('ended').finally(() => this.calls.deleteAndDispose(callId));
				this.publish({ callId, kind: 'ended' });
			}
		}
	}

	private publish(event: ServerVoiceEvent): void {
		this.protocol.publish('voice', event);
	}
}
