/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IVoltSpeechEndpoint, IVoltSpeechService, IVoltSpeechStartOptions, pcm16Bytes, rmsLevel, VOLT_SPEECH_SAMPLE_RATE } from '../../../../../platform/voltSpeech/common/voltSpeech.js';
import { secretKeyForProfile } from '../../../../services/voltRuntime/common/profiles.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { AGENT_VOICE_DEFAULT_REALTIME_MODEL, AGENT_VOICE_ENDPOINT_SETTING, AGENT_VOICE_ENGINE_SETTING, AGENT_VOICE_MODEL_SETTING, AGENT_VOICE_REALTIME_MODEL_SETTING, AgentVoiceEngine } from '../../common/agentComposerSettings.js';

export type AgentDictationState = 'idle' | 'starting' | 'listening' | 'transcribing';

const AUDIO_BLOCK_FRAMES = 2048;
const TRANSCRIBE_TIMEOUT_MS = 60_000;

interface IDictationAudio {
	readonly stream: MediaStream;
	readonly context: AudioContext;
	readonly source: MediaStreamAudioSourceNode;
	readonly processor: ScriptProcessorNode;
	readonly mute: GainNode;
}

interface IDictationSession {
	readonly id: string;
	/** Started with the shortcut: releasing the keys ends it. */
	readonly holdToTalk: boolean;
	audio?: IDictationAudio;
}

/**
 * Dictation into the agent composer: the microphone at 16 kHz goes to the speech service in the
 * main process, which streams partial text back until a final transcript. Only one dictation runs
 * at a time; `message` carries the last problem or the "nothing heard" note while idle.
 */
export class AgentVoiceDictation extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDidCommit = this._register(new Emitter<string>());
	readonly onDidCommit = this._onDidCommit.event;

	private _state: AgentDictationState = 'idle';
	private _partial = '';
	private _level = 0;
	private _message: string | undefined;

	private session: IDictationSession | undefined;
	private generation = 0;
	private pendingStop = false;
	private transcribeTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IVoltSpeechService private readonly speech: IVoltSpeechService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@ISecretStorageService private readonly secretStorage: ISecretStorageService,
	) {
		super();
		this._register(this.speech.onDidEvent(event => {
			const session = this.session;
			if (!session || event.sessionId !== session.id) {
				return;
			}
			if (event.type === 'partial') {
				this._partial = event.text;
				this._onDidChange.fire();
			} else if (event.type === 'final') {
				this.finish(session, event.text.trim());
			} else {
				this.fail(session.id, event.message);
			}
		}));
	}

	get state(): AgentDictationState {
		return this._state;
	}

	get active(): boolean {
		return this.session !== undefined;
	}

	get partial(): string {
		return this._partial;
	}

	get level(): number {
		return this._level;
	}

	get message(): string | undefined {
		return this._message;
	}

	/** The mic button: starts a dictation, ends a listening one, abandons one that is transcribing. */
	toggle(): void {
		if (this._state === 'transcribing') {
			this.cancel();
		} else if (this.session) {
			this.stop();
		} else {
			void this.begin(false);
		}
	}

	beginHold(): void {
		if (!this.session) {
			void this.begin(true);
		}
	}

	endHold(): void {
		if (this.session?.holdToTalk) {
			this.stop();
		}
	}

	cancel(): void {
		const session = this.session;
		if (!session) {
			return;
		}
		this.generation++;
		this.pendingStop = false;
		this.clearTranscribeTimer();
		this.closeAudio(session);
		this.session = undefined;
		this._partial = '';
		this._level = 0;
		this.setState('idle');
		void this.speech.cancel(session.id).catch(err => this.logService.trace('[voice] cancel failed', err));
	}

	override dispose(): void {
		this.cancel();
		super.dispose();
	}

	private async begin(holdToTalk: boolean): Promise<void> {
		const generation = ++this.generation;
		const session: IDictationSession = { id: generateUuid(), holdToTalk };
		this.session = session;
		this.pendingStop = false;
		this._partial = '';
		this._level = 0;
		this.setState('starting');
		try {
			await this.speech.start(await this.startOptions(session.id));
			if (generation !== this.generation) {
				return;
			}
			const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
			if (generation !== this.generation) {
				stream.getTracks().forEach(track => track.stop());
				return;
			}
			this.openAudio(session, stream);
		} catch (err) {
			if (generation === this.generation) {
				this.logService.warn('[voice] dictation could not start', err);
				this.fail(session.id, describeError(err));
			}
		}
	}

	private openAudio(session: IDictationSession, stream: MediaStream): void {
		const context = new AudioContext({ sampleRate: VOLT_SPEECH_SAMPLE_RATE });
		const source = context.createMediaStreamSource(stream);
		const processor = context.createScriptProcessor(AUDIO_BLOCK_FRAMES, 1, 1);
		// The processor only runs while connected; a silent gain keeps the mic out of the speakers.
		const mute = context.createGain();
		mute.gain.value = 0;
		processor.onaudioprocess = event => this.onAudio(session.id, event.inputBuffer.getChannelData(0));
		source.connect(processor);
		processor.connect(mute);
		mute.connect(context.destination);
		session.audio = { stream, context, source, processor, mute };
		this.setState('listening');
		if (this.pendingStop) {
			this.stop();
		}
	}

	private onAudio(sessionId: string, samples: Float32Array): void {
		if (this.session?.id !== sessionId || this._state !== 'listening') {
			return;
		}
		this._level = rmsLevel(samples);
		this._onDidChange.fire();
		const pcm = encodeBase64(VSBuffer.wrap(pcm16Bytes(samples)));
		this.speech.pushAudio(sessionId, pcm).catch(err => this.logService.warn('[voice] audio was not delivered', err));
	}

	private stop(): void {
		const session = this.session;
		if (!session) {
			return;
		}
		if (this._state === 'starting') {
			this.pendingStop = true;
			return;
		}
		if (this._state !== 'listening') {
			return;
		}
		this.closeAudio(session);
		this._level = 0;
		this.setState('transcribing');
		this.transcribeTimer = setTimeout(() => this.fail(session.id, localize('voltAgent.dictation.timeout', "The transcript did not arrive. Try again.")), TRANSCRIBE_TIMEOUT_MS);
		this.speech.stop(session.id).catch(err => this.fail(session.id, describeError(err)));
	}

	private finish(session: IDictationSession, text: string): void {
		if (this.session !== session) {
			return;
		}
		this.clearTranscribeTimer();
		this.closeAudio(session);
		this.session = undefined;
		this._partial = '';
		this._level = 0;
		this.setState('idle', text ? undefined : localize('voltAgent.dictation.nothingHeard', "No speech was heard."));
		if (text) {
			this._onDidCommit.fire(text);
		}
	}

	private fail(sessionId: string, message: string): void {
		const session = this.session;
		if (!session || session.id !== sessionId) {
			return;
		}
		this.generation++;
		this.pendingStop = false;
		this.clearTranscribeTimer();
		this.closeAudio(session);
		this.session = undefined;
		this._partial = '';
		this._level = 0;
		this.setState('idle', message);
		void this.speech.cancel(sessionId).catch(err => this.logService.trace('[voice] cancel failed', err));
	}

	private closeAudio(session: IDictationSession): void {
		const audio = session.audio;
		if (!audio) {
			return;
		}
		session.audio = undefined;
		audio.processor.onaudioprocess = null;
		audio.source.disconnect();
		audio.processor.disconnect();
		audio.mute.disconnect();
		audio.stream.getTracks().forEach(track => track.stop());
		void audio.context.close();
	}

	private clearTranscribeTimer(): void {
		if (this.transcribeTimer !== undefined) {
			clearTimeout(this.transcribeTimer);
			this.transcribeTimer = undefined;
		}
	}

	/** The engine and model chosen in Settings > Voice model, with the user's OpenAI key for realtime. */
	private async startOptions(sessionId: string): Promise<IVoltSpeechStartOptions> {
		const engine = (this.configurationService.getValue<string>(AGENT_VOICE_ENGINE_SETTING) || 'auto') as AgentVoiceEngine;
		const options: IVoltSpeechStartOptions = { sessionId, locale: navigator.language || 'en-US', engine, endpoint: this.endpoint() };
		if (engine !== 'auto' && engine !== 'openai') {
			return options;
		}
		const openai = this.runtime.listProfiles().find(profile => profile.providerId === 'openai' && profile.enabled && profile.hasSecret);
		// An empty key lets the main process use its own OPENAI_API_KEY.
		const apiKey = openai ? await this.secretStorage.get(secretKeyForProfile(openai.id)) ?? '' : '';
		return {
			...options,
			realtime: {
				baseUrl: openai?.endpoint?.baseURL || 'https://api.openai.com/v1',
				apiKey,
				model: this.configurationService.getValue<string>(AGENT_VOICE_REALTIME_MODEL_SETTING) || AGENT_VOICE_DEFAULT_REALTIME_MODEL,
			},
		};
	}

	private endpoint(): IVoltSpeechEndpoint | undefined {
		const baseUrl = this.configurationService.getValue<string>(AGENT_VOICE_ENDPOINT_SETTING)?.trim();
		if (!baseUrl) {
			return undefined;
		}
		return { baseUrl, model: this.configurationService.getValue<string>(AGENT_VOICE_MODEL_SETTING) || 'whisper-1' };
	}

	private setState(state: AgentDictationState, message?: string): void {
		this._state = state;
		this._message = message;
		this._onDidChange.fire();
	}
}

function describeError(err: unknown): string {
	if (err instanceof DOMException && err.name === 'NotAllowedError') {
		return localize('voltAgent.dictation.micDenied', "Volt needs microphone access. Allow it in System Settings > Privacy & Security > Microphone.");
	}
	return err instanceof Error ? err.message : String(err);
}
