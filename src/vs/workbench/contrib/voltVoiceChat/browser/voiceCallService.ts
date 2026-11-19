/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isWeb } from '../../../../base/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { localize } from '../../../../nls.js';
import { DEFAULT_LOCAL_VOICES, ILocalVoice, IVoltLocalVoiceService, LOCAL_VOICES, pickLocalVoice, readyLocalVoiceModels } from '../../../../platform/voltLocalVoice/common/voltLocalVoice.js';
import { IVoltSpeechService } from '../../../../platform/voltSpeech/common/voltSpeech.js';
import { isVoiceProvider, IVoltVoiceCall, IVoltVoiceChatService, IVoltVoiceTurn, VoltVoiceProvider } from '../../../../platform/voltVoiceChat/common/voltVoiceChat.js';
import { IVoltAgentWindowService } from '../../../services/voltPlugins/browser/voltAgentWindow.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { IAgentOrchestratorService } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { AGENT_READ_ALOUD_VOICE_SETTING } from '../../voltAgent/common/agentReadAloud.js';
import { RealtimeEvent } from '../common/realtimeProtocol.js';
import { greetingInstructions } from '../common/voiceAgent.js';
import { IVoiceCallSettings, IVoiceSource, VoiceCallBrain } from '../common/voiceCallBrain.js';
import {
	OPEN_VOICE_CALL_TRANSCRIPT_COMMAND_ID, VOICE_CHAT_CUSTOM_URL_SETTING, VOICE_CHAT_LANGUAGE_SETTING, VOICE_CHAT_PROVIDER_SETTING, VOICE_CHAT_SPEED_SETTING, VOICE_CHAT_VOICE_SETTING, VoiceChatActiveContext,
} from '../common/voltVoiceChat.js';
import { IVoiceLine, LocalVoiceClient } from './localVoiceClient.js';
import { RealtimeVoiceClient } from './realtimeVoiceClient.js';
import { voiceLanguageLabel } from './voiceSettings.js';

export type { IVoiceCallSettings } from '../common/voiceCallBrain.js';

export type VoiceCallPhase = 'idle' | 'connecting' | 'live' | 'failed';

export interface IVoiceCallState {
	readonly phase: VoiceCallPhase;
	readonly callId?: string;
	/** The chat the call works in (undefined until a new chat's first task starts it). */
	readonly chatId?: string;
	/** The composer the call was started from (a new chat's key before it has messages). */
	readonly originKey?: string;
	readonly muted: boolean;
	readonly settings: IVoiceCallSettings;
	readonly provider?: VoltVoiceProvider;
	readonly connectedAt?: number;
	readonly turns: readonly IVoltVoiceTurn[];
	readonly error?: string;
	/** `listening`, `thinking` or `speaking` while live. */
	readonly activity?: 'listening' | 'thinking' | 'speaking';
}

/** The voice greets only when nobody spoke this long after the line opened. */
const GREETING_GRACE_MS = 15_000;
const END_SPEECH_WAIT_MS = 15_000;

/**
 * The window's voice call (one at a time, as in Cursor): its state machine (idle → connecting →
 * live → idle, or failed) and its audio (`RealtimeVoiceClient`). What the voice does in Volt (its
 * tools, the notes when the chat's agent finishes, the saved record) is the call's
 * `VoiceCallBrain`, which the agent server runs for phones too.
 */
export class VoiceCallService extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	/** The calls of a chat changed (undefined: any chat's). */
	private readonly _onDidChangeCalls = this._register(new Emitter<string | undefined>());
	readonly onDidChangeCalls = this._onDidChangeCalls.event;
	private readonly _onLevel = this._register(new Emitter<number>());
	/** The line's loudness 0..1 (the user's mic, or the voice while it speaks). */
	readonly onLevel = this._onLevel.event;

	private _state: IVoiceCallState;
	private readonly brain = this._register(new MutableDisposable<VoiceCallBrain>());
	private readonly client = this._register(new MutableDisposable<IVoiceLine>());
	private readonly callStore = this._register(new DisposableStore());
	private readonly activeKey: IContextKey<boolean>;
	/** Calls by id, loaded per chat on demand. */
	private readonly calls = new Map<string, IVoltVoiceCall>();
	private readonly loadedChats = new Map<string, Promise<void>>();
	private readonly assistantDraft = new Map<string, string>();
	private greeted = false;
	private endingAfterSpeech = false;

	constructor(
		@IVoltVoiceChatService private readonly voiceService: IVoltVoiceChatService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
		@IVoltAgentWindowService private readonly agentWindow: IVoltAgentWindowService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@ICommandService private readonly commandService: ICommandService,
		@IVoltSpeechService private readonly speechService: IVoltSpeechService,
		@IVoltLocalVoiceService private readonly localVoiceService: IVoltLocalVoiceService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.activeKey = VoiceChatActiveContext.bindTo(contextKeyService);
		this._state = { phase: 'idle', muted: false, settings: this.readSettings(), turns: [] };
		this._register({ dispose: () => this.hangUp('window_closed') });
		// The voice picked anywhere (Settings, the call's menu) is the one a call on this computer speaks with next.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			const client = this.client.value;
			if (client instanceof LocalVoiceClient && e.affectsConfiguration(AGENT_READ_ALOUD_VOICE_SETTING)) {
				client.setVoice(this.configurationService.getValue<string>(AGENT_READ_ALOUD_VOICE_SETTING) || undefined);
			}
		}));
	}

	/** The downloaded voices a call on this computer can speak with, and the one it does. */
	async localVoices(): Promise<{ readonly voices: readonly ILocalVoice[]; readonly current: ILocalVoice | undefined }> {
		const ready = readyLocalVoiceModels(await this.localVoiceService.getStates().catch(() => []));
		return {
			voices: LOCAL_VOICES.filter(voice => ready.includes(voice.model)),
			current: pickLocalVoice(this.configurationService.getValue<string>(AGENT_READ_ALOUD_VOICE_SETTING) || undefined, ready),
		};
	}

	/** Changes who speaks on this computer (calls and Read Aloud share the voice). */
	async setLocalVoice(ref: string): Promise<void> {
		await this.configurationService.updateValue(AGENT_READ_ALOUD_VOICE_SETTING, ref);
	}

	get state(): IVoiceCallState {
		return this._state;
	}

	/** A call is up (connecting or live). */
	get active(): boolean {
		return this._state.phase === 'connecting' || this._state.phase === 'live';
	}

	//#region Start and end

	/** Starts a call from a chat's composer (`sessionId`), or a new chat's (undefined). */
	async start(sessionId: string | undefined): Promise<void> {
		if (this.active) {
			// The composer's waveform while a call runs: show the call.
			void this.commandService.executeCommand(OPEN_VOICE_CALL_TRANSCRIPT_COMMAND_ID, { callId: this._state.callId, sessionId: this._state.chatId ?? sessionId });
			return;
		}
		const pane = this.agentWindow.chatPane(sessionId);
		const originKey = sessionId ?? pane?.sessionKey;
		const chatId = sessionId && !(pane?.isEmpty?.() ?? false) ? sessionId : undefined;
		const settings = this.readSettings();
		const callId = generateUuid();
		this.greeted = false;
		this.endingAfterSpeech = false;
		this.assistantDraft.clear();
		const provider = await this.pickProvider();
		if (chatId) {
			await this.loadCalls(chatId);
		}
		const brain = this.brain.value = new VoiceCallBrain(callId, chatId, provider, settings.voice, {
			speak: (note, spoken) => this.client.value?.addNote(note, true, spoken),
			onChat: id => {
				this.setState({ chatId: id });
				this.fireCalls(id);
			},
			onRecord: record => {
				this.calls.set(record.id, record);
				this.setState({ turns: record.turns });
				this.fireCalls(undefined);
			},
			save: record => this.voiceService.saveCall(record),
			earlierCalls: async id => {
				await this.loadCalls(id);
				return this.callsFor(id);
			},
			startChat: async (text, source, shown) => {
				const target = this.agentWindow.chatPane(this._state.originKey) ?? this.agentWindow.chatPane();
				if (!target?.sessionKey) {
					return undefined;
				}
				target.submitPrompt(text, { text: shown }, source);
				return target.sessionKey;
			},
			submitOnScreen: (id, text, source: IVoiceSource, shown) => {
				const target = this.agentWindow.chatPane(id);
				if (!target) {
					return false;
				}
				target.submitPrompt(text, { text: shown }, source);
				return true;
			},
		}, { orchestrator: this.orchestrator, runtime: this.runtime, history: this.history, hostTools: this.hostTools, logService: this.logService });
		this.calls.set(callId, brain.record);
		this.setState({ phase: 'connecting', callId, chatId, originKey, muted: false, settings, provider, turns: [], error: undefined, connectedAt: undefined, activity: undefined });
		this.activeKey.set(true);
		this.fireCalls(chatId);

		try {
			const watch = (client: IVoiceLine) => {
				this.callStore.clear();
				this.callStore.add(client.onEvent(event => this.onEvent(event)));
				this.callStore.add(client.onLevel(level => this._onLevel.fire(level)));
				this.callStore.add(client.onDidChangeState(state => {
					if (state !== 'closed') {
						this.setState({ activity: state === 'connecting' ? undefined : state });
					}
				}));
			};
			if (provider === 'local') {
				// No socket and no key: dictation hears, the chat's agent answers, Read Aloud's voice speaks.
				const client = this.client.value = new LocalVoiceClient(mainWindow, {
					voice: this.configurationService.getValue<string>(AGENT_READ_ALOUD_VOICE_SETTING) || undefined,
					speed: settings.speed,
					locale: settings.language === 'auto' ? mainWindow.navigator.language || 'en-US' : settings.language,
				}, this.speechService, this.localVoiceService, this.logService);
				watch(client);
				void this.offerNaturalVoice();
				await client.connect();
			} else {
				const session = await this.voiceService.mint({ provider, url: this.configurationService.getValue<string>(VOICE_CHAT_CUSTOM_URL_SETTING) || undefined });
				if (this._state.callId !== callId) {
					return;
				}
				const client = this.client.value = new RealtimeVoiceClient(mainWindow);
				watch(client);
				await client.connect(session, await brain.sessionConfig(provider, settings, isWeb ? 'web' : 'desk', voiceLanguageLabel));
			}
			if (this._state.callId !== callId) {
				return;
			}
			brain.connected();
			this.setState({ phase: 'live', connectedAt: brain.record.connectedAt, activity: 'listening' });
			const greet = mainWindow.setTimeout(() => this.greet(), GREETING_GRACE_MS);
			this.callStore.add({ dispose: () => mainWindow.clearTimeout(greet) });
			const heard = mainWindow.setInterval(() => brain.heard(), 10_000);
			this.callStore.add({ dispose: () => mainWindow.clearInterval(heard) });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[volt voice] the call could not start: ${message}`);
			if (this._state.callId === callId) {
				this.fail(message);
			}
		}
	}

	/** Ends the call. Work it sent keeps running; its result lands in the chat. */
	hangUp(reason: 'hang_up' | 'voice_goodbye' | 'window_closed' | 'failed' = 'hang_up'): void {
		if (!this.active && this._state.phase !== 'failed') {
			return;
		}
		this.logService.info(`[volt voice] call ended (${reason})`);
		this.callStore.clear();
		this.client.clear();
		const brain = this.brain.value;
		if (brain) {
			void brain.end(reason === 'failed' ? 'failed' : 'ended', this._state.error).finally(() => {
				if (this.brain.value === brain) {
					this.brain.clear();
				}
			});
		}
		this.activeKey.set(false);
		if (reason !== 'failed') {
			this.setState({ phase: 'idle', activity: undefined });
		}
		this.fireCalls(undefined);
	}

	dismissFailure(): void {
		if (this._state.phase === 'failed') {
			this.setState({ phase: 'idle', error: undefined });
		}
	}

	setMuted(muted: boolean): void {
		this.client.value?.setMuted(muted);
		this.setState({ muted });
	}

	/** Voice, speed or language: saved as the default and applied to the call. */
	async setSettings(next: Partial<IVoiceCallSettings>): Promise<void> {
		const settings = { ...this._state.settings, ...next };
		if (next.voice !== undefined) {
			await this.configurationService.updateValue(VOICE_CHAT_VOICE_SETTING, next.voice);
		}
		if (next.speed !== undefined) {
			await this.configurationService.updateValue(VOICE_CHAT_SPEED_SETTING, next.speed);
		}
		if (next.language !== undefined) {
			await this.configurationService.updateValue(VOICE_CHAT_LANGUAGE_SETTING, next.language);
		}
		this.setState({ settings });
		const client = this.client.value;
		const brain = this.brain.value;
		if (client && brain && this._state.phase === 'live' && this._state.provider) {
			client.updateSession(await brain.sessionConfig(this._state.provider, settings, isWeb ? 'web' : 'desk', voiceLanguageLabel));
		}
	}

	private fail(message: string): void {
		this.setState({ phase: 'failed', error: message });
		this.hangUp('failed');
	}

	//#endregion

	//#region Records

	/** Calls that reached `chatId`, oldest first (loads them the first time). */
	callsFor(chatId: string): readonly IVoltVoiceCall[] {
		void this.loadCalls(chatId);
		return [...this.calls.values()].filter(call => call.chatIds.includes(chatId)).sort((a, b) => a.startedAt - b.startedAt);
	}

	private loadCalls(chatId: string): Promise<void> {
		let loading = this.loadedChats.get(chatId);
		if (!loading) {
			loading = this.voiceService.listCalls(chatId).then(calls => {
				for (const call of calls) {
					if (call.id !== this.brain.value?.record.id) {
						this.calls.set(call.id, call);
					}
				}
				if (calls.length) {
					this.fireCalls(chatId);
				}
			}, err => this.logService.warn('[volt voice] could not read calls', err));
			this.loadedChats.set(chatId, loading);
		}
		return loading;
	}

	async getCall(callId: string): Promise<IVoltVoiceCall | undefined> {
		return this.calls.get(callId) ?? await this.voiceService.getCall(callId).then(call => {
			if (call) {
				this.calls.set(call.id, call);
			}
			return call;
		});
	}

	/** What a card shows: the live call's phase, or a saved call's (an unheard ongoing call has ended). */
	cardStatus(call: IVoltVoiceCall): { readonly status: 'connecting' | 'live' | 'ended'; readonly since?: number; readonly duration?: number } {
		if (call.id === this._state.callId && this.active) {
			return this._state.phase === 'live' ? { status: 'live', since: this._state.connectedAt } : { status: 'connecting' };
		}
		const end = call.endedAt ?? call.lastHeardAt;
		return { status: 'ended', duration: call.connectedAt && end ? Math.max(0, end - call.connectedAt) : undefined };
	}

	private fireCalls(chatId: string | undefined): void {
		this._onDidChangeCalls.fire(chatId);
	}

	//#endregion

	//#region The line

	private onEvent(event: RealtimeEvent): void {
		const brain = this.brain.value;
		switch (event.type) {
			case 'userSpeechStarted':
				this.greeted = true;
				break;
			case 'userTranscript':
				if (event.final && event.text) {
					this.greeted = true;
					brain?.addTurn({ role: 'user', text: event.text });
				}
				break;
			case 'assistantTranscript': {
				if (event.delta) {
					this.assistantDraft.set(event.itemId, (this.assistantDraft.get(event.itemId) ?? '') + event.delta);
				}
				if (event.text !== undefined) {
					const text = (event.text || this.assistantDraft.get(event.itemId) || '').trim();
					this.assistantDraft.delete(event.itemId);
					if (text) {
						brain?.addTurn({ id: event.itemId, role: 'assistant', text });
					}
				}
				break;
			}
			case 'functionCall':
				void this.runTool(event.callId, event.name, event.arguments);
				break;
			case 'responseDone':
				if (this.endingAfterSpeech) {
					void this.endAfterSpeech();
				}
				break;
			case 'error':
				// After the line is up most errors are recoverable; the call goes on.
				this.logService.warn(`[volt voice] ${event.message}`);
				if (this._state.phase === 'connecting' || /closed/i.test(event.message)) {
					this.fail(event.message === 'The voice call ended.' ? 'Voice session ended unexpectedly.' : event.message);
				}
				break;
		}
	}

	private async runTool(toolCallId: string, name: string, args: string): Promise<void> {
		const brain = this.brain.value;
		const client = this.client.value;
		if (!brain || !client) {
			return;
		}
		const result = await brain.runTool(name, args);
		if (this.client.value !== client) {
			return;
		}
		client.sendToolResult(toolCallId, result.output);
		if (result.end) {
			this.endingAfterSpeech = true;
			if (client.state !== 'speaking') {
				void this.endAfterSpeech();
			}
		} else if (result.respond) {
			client.requestResponse(result.instructions);
		}
	}

	private greet(): void {
		if (this.greeted || this._state.phase !== 'live') {
			return;
		}
		this.greeted = true;
		this.client.value?.requestResponse(greetingInstructions(undefined));
	}

	private async endAfterSpeech(): Promise<void> {
		const client = this.client.value;
		const until = Date.now() + END_SPEECH_WAIT_MS;
		while (client && client.state === 'speaking' && Date.now() < until) {
			await new Promise(resolve => mainWindow.setTimeout(resolve, 200));
		}
		this.hangUp('voice_goodbye');
	}

	//#endregion

	/** A call on this computer without a downloaded voice speaks with the system's: offer the fast voices once per window. */
	private offeredNaturalVoice = false;
	private async offerNaturalVoice(): Promise<void> {
		const states = await this.localVoiceService.getStates().catch(() => []);
		const state = states.find(candidate => candidate.model === 'supertonic');
		if (state?.status !== 'absent' || readyLocalVoiceModels(states).length || this.offeredNaturalVoice) {
			return;
		}
		this.offeredNaturalVoice = true;
		const megabytes = Math.round(state.totalBytes / 1_000_000);
		this.notificationService.prompt(Severity.Info,
			localize('voiceChat.naturalVoiceOffer', "This call speaks with your system's voice. Download the natural voice ({0} MB) for a far better one; the call switches to it when it is ready.", megabytes),
			[{
				label: localize('voiceChat.naturalVoiceDownload', "Download Natural Voice"),
				run: () => void this.localVoiceService.install('supertonic').then(async () => {
					// As the Settings download does: Read Aloud switches to the natural voice too.
					await this.configurationService.updateValue(AGENT_READ_ALOUD_VOICE_SETTING, DEFAULT_LOCAL_VOICES.supertonic);
					this.notificationService.info(localize('voiceChat.naturalVoiceReady', "The natural voice is ready. Voice chats and Read Aloud use it now."));
				}, err => this.notificationService.error(localize('voiceChat.naturalVoiceFailed', "The natural voice could not be downloaded: {0}", err instanceof Error ? err.message : String(err)))),
			}]);
	}

	private async pickProvider(): Promise<VoltVoiceProvider> {
		const configured = this.configurationService.getValue<string>(VOICE_CHAT_PROVIDER_SETTING);
		if (isVoiceProvider(configured)) {
			return configured;
		}
		try {
			const status = await this.voiceService.keyStatus();
			// Without a key the call stays on this computer instead of failing on a missing one.
			return status.find(entry => entry.provider === 'xai' && entry.source)?.provider ?? status.find(entry => entry.provider === 'openai' && entry.source)?.provider ?? 'local';
		} catch {
			return 'local';
		}
	}

	private readSettings(): IVoiceCallSettings {
		const speed = Number(this.configurationService.getValue(VOICE_CHAT_SPEED_SETTING));
		return {
			voice: this.configurationService.getValue<string>(VOICE_CHAT_VOICE_SETTING) || 'ara',
			speed: [0.75, 1, 1.25, 1.5, 2].includes(speed) ? speed : 1,
			language: this.configurationService.getValue<string>(VOICE_CHAT_LANGUAGE_SETTING) || 'auto',
		};
	}

	private setState(patch: Partial<IVoiceCallState>): void {
		this._state = { ...this._state, ...patch };
		this._onDidChange.fire();
	}
}

let active: VoiceCallService | undefined;

/** The loaded module's call service (the transcript tab, restored before or after it loads, reads it). */
export function activeVoiceCallService(): VoiceCallService | undefined {
	return active;
}

export function setActiveVoiceCallService(service: VoiceCallService | undefined): void {
	active = service;
}
