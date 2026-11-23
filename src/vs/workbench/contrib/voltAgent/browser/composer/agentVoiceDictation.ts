/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltSpeechEndpoint, IVoltSpeechService, pcm16Bytes, rmsLevel, SpeechGate, VOLT_SPEECH_SAMPLE_RATE } from '../../../../../platform/voltSpeech/common/voltSpeech.js';
import { IVoltPredictionService } from '../../../../services/voltRuntime/common/prediction.js';
import { dictationNeedsCleanup } from '../../../../services/voltRuntime/common/prediction/dictationCleanup.js';
import { AGENT_VOICE_ENDPOINT_SETTING, AGENT_VOICE_MODEL_SETTING } from '../../common/agentComposerSettings.js';

export type AgentDictationState = 'idle' | 'starting' | 'listening' | 'transcribing';

const AUDIO_BLOCK_FRAMES = 2048;
const AUDIO_BLOCK_MS = AUDIO_BLOCK_FRAMES / VOLT_SPEECH_SAMPLE_RATE * 1000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
/** 32 ms at 16 kHz: four waveform bars per audio block. */
const LEVEL_SLICE_FRAMES = 512;
/**
 * How long a send waits for the recognizer's last words once the microphone is off, when a partial
 * transcript is already on screen; past it the message goes with that partial.
 */
const SEND_FLUSH_MS = 4_000;
/** Blocks kept from before the voice starts (about a quarter second), so soft first syllables go through. */
const PREROLL_BLOCKS = 2;

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
	/** Only voice (and a moment around it) reaches the recognizer; silence is never sent. */
	readonly gate: SpeechGate;
	/** The last silent blocks, sent ahead of the voice that follows them. */
	readonly preroll: Float32Array[];
	audio?: IDictationAudio;
	/** A send is waiting on this dictation: resolved with true once its transcript is in, false when it was dropped. */
	sending?: (sent: boolean) => void;
}

/**
 * Dictation into the agent composer: the microphone at 16 kHz goes to the speech service in the
 * main process, which streams partial text back until a final transcript. The prediction model
 * then cleans the transcript up (punctuation, misheard names, spoken code, fillers) unless that is
 * turned off, or the transcript is clean already. Silence never reaches the recognizer or a model:
 * pauses cost nothing, and only the user ends a dictation (the mic, Escape, releasing the shortcut,
 * or sending). Only one dictation runs at a time; `message` carries the last problem or the
 * "nothing heard" note while idle.
 */
export class AgentVoiceDictation extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDidCommit = this._register(new Emitter<string>());
	readonly onDidCommit = this._onDidCommit.event;

	private readonly _onDidFail = this._register(new Emitter<string>());
	/** Dictation stopped on a problem: the microphone, speech access, or a transcript that never came. */
	readonly onDidFail = this._onDidFail.event;

	private readonly _onDidHear = this._register(new Emitter<readonly number[]>());
	/** The microphone's loudness (RMS) in {@link LEVEL_SLICE_FRAMES} slices while listening, for the waveform. */
	readonly onDidHear = this._onDidHear.event;

	private _state: AgentDictationState = 'idle';
	private _partial = '';
	private _level = 0;
	private _message: string | undefined;

	private session: IDictationSession | undefined;
	private generation = 0;
	private pendingStop = false;
	private transcribeTimer: ReturnType<typeof setTimeout> | undefined;
	private sendTimer: ReturnType<typeof setTimeout> | undefined;
	/** The cleanup of a final transcript in flight. */
	private polishing: CancellationTokenSource | undefined;

	/** The composer's text before where the dictation goes, which the cleanup reads. Set by the composer. */
	textBefore: (() => string) | undefined;

	constructor(
		@IVoltSpeechService private readonly speech: IVoltSpeechService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IVoltPredictionService private readonly prediction: IVoltPredictionService,
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

	/** Whether dictation can run here at all; without it the composer offers no mic. */
	get available(): boolean {
		return this.speech.isAvailable?.() ?? true;
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

	/**
	 * The mic button: starts a dictation, ends a listening one, abandons one that is transcribing,
	 * and takes the transcript as heard while it is being cleaned up.
	 */
	toggle(): void {
		if (this.polishing) {
			this.polishing.cancel();
		} else if (this._state === 'transcribing') {
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
		this.stopPolishing();
		this.closeAudio(session);
		this.session = undefined;
		this._partial = '';
		this._level = 0;
		this.setState('idle');
		void this.speech.cancel(session.id).catch(err => this.logService.trace('[voice] cancel failed', err));
		session.sending?.(false);
	}

	/**
	 * Ends the dictation for a send: the microphone goes off at once, and the promise resolves once the
	 * whole transcript is in the composer (through {@link onDidCommit}), as heard, without the cleanup:
	 * the last words the recognizer still owes are not lost, and the send does not wait on a model.
	 * Resolves false when the dictation was dropped instead (Escape, or a transcript that failed with
	 * nothing heard), so the draft stays. With no dictation it resolves true at once.
	 */
	finishForSend(): Promise<boolean> {
		const session = this.session;
		if (!session) {
			return Promise.resolve(true);
		}
		if (this._state === 'starting') {
			// The microphone is not open yet, so nothing was heard: the draft goes as it is.
			this.cancel();
			return Promise.resolve(true);
		}
		const done = new Promise<boolean>(resolve => {
			const earlier = session.sending;
			session.sending = sent => {
				session.sending = undefined;
				this.clearSendTimer();
				earlier?.(sent);
				resolve(sent);
			};
		});
		if (this.polishing) {
			// Takes the transcript as heard: it settles straight away.
			this.polishing.cancel();
			return done;
		}
		this.stop();
		this.clearSendTimer();
		this.sendTimer = setTimeout(() => {
			this.sendTimer = undefined;
			// The recognizer is slow with its last words: the message goes with what is on screen. Without
			// a partial (a transcription endpoint shows none) the transcript is all there is, so it waits.
			if (this.session === session && this._partial) {
				this.logService.trace('[voice] no final transcript in time: sending the partial');
				void this.speech.cancel(session.id).catch(err => this.logService.trace('[voice] cancel failed', err));
				this.clearTranscribeTimer();
				this.settle(session, this._partial.trim());
			}
		}, SEND_FLUSH_MS);
		return done;
	}

	override dispose(): void {
		this.cancel();
		super.dispose();
	}

	private async begin(holdToTalk: boolean): Promise<void> {
		const generation = ++this.generation;
		const session: IDictationSession = { id: generateUuid(), holdToTalk, gate: new SpeechGate(), preroll: [] };
		this.session = session;
		this.pendingStop = false;
		this._partial = '';
		this._level = 0;
		this.setState('starting');
		try {
			await this.speech.start({ sessionId: session.id, locale: navigator.language || 'en-US', endpoint: this.endpoint() });
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
		const session = this.session;
		if (session?.id !== sessionId || this._state !== 'listening') {
			return;
		}
		this._level = rmsLevel(samples);
		this._onDidChange.fire();
		const slices: number[] = [];
		for (let start = 0; start < samples.length; start += LEVEL_SLICE_FRAMES) {
			slices.push(rmsLevel(samples.subarray(start, start + LEVEL_SLICE_FRAMES)));
		}
		this._onDidHear.fire(slices);
		const heardBefore = session.gate.heardVoice;
		const decision = session.gate.push(this._level, AUDIO_BLOCK_MS);
		if (decision === 'silence') {
			// The audio buffer is reused by the next callback.
			session.preroll.push(samples.slice());
			if (session.preroll.length > PREROLL_BLOCKS) {
				session.preroll.shift();
			}
			return;
		}
		if (!heardBefore) {
			// The cleanup agent boots once there is something to clean up, while the user speaks.
			this.prediction.warmUp();
		}
		for (const block of session.preroll.splice(0)) {
			this.pushAudio(sessionId, block);
		}
		this.pushAudio(sessionId, samples);
	}

	private pushAudio(sessionId: string, samples: Float32Array): void {
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
		// A send waiting on this transcript takes it as heard: no model stands between Enter and the message.
		if (!text || session.sending || !this.prediction.getSettings().voice || !dictationNeedsCleanup(text, this.textBefore?.())) {
			this.settle(session, text);
			return;
		}
		// The transcript shows while it is cleaned up, and goes in as heard when that fails or is slow.
		this._partial = text;
		this._level = 0;
		this.setState('transcribing');
		const polishing = this.polishing = new CancellationTokenSource();
		void this.prediction.polishDictation({ transcript: text, before: this.textBefore?.() }, polishing.token)
			.catch(() => undefined)
			.then(clean => {
				const tookAsHeard = polishing.token.isCancellationRequested;
				polishing.dispose();
				if (this.polishing === polishing) {
					this.polishing = undefined;
				}
				this.settle(session, clean === undefined || tookAsHeard ? text : clean.trim());
			});
	}

	/** Ends the dictation with `text` in the composer; empty means nothing was heard. */
	private settle(session: IDictationSession, text: string): void {
		if (this.session !== session) {
			return;
		}
		this.session = undefined;
		this._partial = '';
		this._level = 0;
		// Before the state change, so the composer settles the live transcript instead of removing it.
		if (text) {
			this._onDidCommit.fire(text);
		}
		this.setState('idle', text ? undefined : localize('voltAgent.dictation.nothingHeard', "No speech was heard."));
		session.sending?.(true);
	}

	private stopPolishing(): void {
		this.polishing?.dispose(true);
		this.polishing = undefined;
	}

	private fail(sessionId: string, message: string): void {
		const session = this.session;
		if (!session || session.id !== sessionId) {
			return;
		}
		if (session.sending && this._partial.trim()) {
			// A send keeps the words already on screen: they go out instead of being taken back.
			this.logService.warn('[voice] the final transcript failed: sending the partial', message);
			void this.speech.cancel(sessionId).catch(err => this.logService.trace('[voice] cancel failed', err));
			this.clearTranscribeTimer();
			this.settle(session, this._partial.trim());
			return;
		}
		this.generation++;
		this.pendingStop = false;
		this.clearTranscribeTimer();
		this.stopPolishing();
		this.closeAudio(session);
		this.session = undefined;
		this._partial = '';
		this._level = 0;
		this.setState('idle', message);
		this._onDidFail.fire(message);
		void this.speech.cancel(sessionId).catch(err => this.logService.trace('[voice] cancel failed', err));
		session.sending?.(false);
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

	private clearSendTimer(): void {
		if (this.sendTimer !== undefined) {
			clearTimeout(this.sendTimer);
			this.sendTimer = undefined;
		}
	}

	private clearTranscribeTimer(): void {
		if (this.transcribeTimer !== undefined) {
			clearTimeout(this.transcribeTimer);
			this.transcribeTimer = undefined;
		}
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
