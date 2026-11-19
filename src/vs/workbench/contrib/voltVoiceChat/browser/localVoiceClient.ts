/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILocalVoice, IVoltLocalVoiceService, LOCAL_VOICE_MODELS, pickLocalVoice, readyLocalVoiceModels } from '../../../../platform/voltLocalVoice/common/voltLocalVoice.js';
import { SpeechTurnDetector } from '../../../../platform/voltSpeech/common/speechTurnDetector.js';
import { IVoltSpeechService, pcm16Bytes, rmsLevel, VOLT_SPEECH_SAMPLE_RATE } from '../../../../platform/voltSpeech/common/voltSpeech.js';
import { localSpeechPieces, speakableMarkdown, splitSpeech } from '../../voltAgent/common/agentReadAloud.js';
import { IRealtimeSessionConfig, RealtimeEvent } from '../common/realtimeProtocol.js';
import { isLocalGoodbye, LOCAL_GREETING, localToolWords } from '../common/localVoiceLine.js';
import { RealtimeClientState } from './realtimeVoiceClient.js';

/** What the call service drives: the realtime socket, or this computer's own line. */
export interface IVoiceLine extends IDisposable {
	readonly onEvent: Event<RealtimeEvent>;
	readonly onDidChangeState: Event<RealtimeClientState>;
	readonly onLevel: Event<number>;
	readonly state: RealtimeClientState;
	setMuted(muted: boolean): void;
	updateSession(config: IRealtimeSessionConfig): void;
	sendToolResult(callId: string, output: unknown): void;
	requestResponse(instructions?: string): void;
	addNote(text: string, speak: boolean, spoken?: string): void;
}

export interface ILocalVoiceLineOptions {
	/** Read Aloud's voice: a downloaded voice's ref (`supertonic:f1`); a system voice's name is used only without a download. */
	readonly voice: string | undefined;
	readonly speed: number;
	/** A BCP 47 tag for dictation. */
	readonly locale: string;
}

/** 128 ms blocks at 16 kHz. */
const MIC_BLOCK = 2048;
const MIC_BLOCK_MS = MIC_BLOCK / VOLT_SPEECH_SAMPLE_RATE * 1000;
const SPEECH_GAP = 0.12;
/** The engine is asked to stay this long, this often, while the call is up: an answer after minutes of work still starts at once. */
const ENGINE_HOLD_MS = 120_000;
const ENGINE_HOLD_EVERY_MS = 60_000;
/** Lines made before they are needed. */
const STOCK_LINES = [LOCAL_GREETING, 'On it.'];
/** How long to wait for a transcript after the caller stopped talking. */
const TRANSCRIPT_TIMEOUT_MS = 20_000;

interface IUtterance {
	readonly id: string;
	readonly started: Promise<boolean>;
	/** Audio heard before the engine was ready. */
	readonly early: string[];
	heardSpeech: boolean;
	committed: boolean;
	timer?: number;
}

interface ISaying {
	readonly id: string;
	cancel(): void;
}

/**
 * A voice call that never leaves the computer: dictation hears the caller one utterance at a time
 * (a pause ends it), each utterance goes to the chat's agent as a task (the call service runs
 * `send_task` as if a voice model had called it), and what the agent answers is read out with
 * Read Aloud's voice. It takes turns: while it speaks it does not listen.
 */
export class LocalVoiceClient extends Disposable implements IVoiceLine {

	private readonly _onEvent = this._register(new Emitter<RealtimeEvent>());
	readonly onEvent = this._onEvent.event;
	private readonly _onDidChangeState = this._register(new Emitter<RealtimeClientState>());
	readonly onDidChangeState = this._onDidChangeState.event;
	private readonly _onLevel = this._register(new Emitter<number>());
	readonly onLevel = this._onLevel.event;

	private _state: RealtimeClientState = 'connecting';
	private muted = false;
	private speed: number;
	private voice: string | undefined;
	private holdTimer: number | undefined;
	private mic: { stream: MediaStream; context: AudioContext; source: MediaStreamAudioSourceNode; processor: ScriptProcessorNode; sink: GainNode } | undefined;
	private utterance: IUtterance | undefined;
	private readonly detector = new SpeechTurnDetector();
	/** Tool calls this line made up, by id, so their results can be put into words. */
	private readonly toolCalls = new Map<string, string>();
	/** Words waiting for `requestResponse`. */
	private pendingWords: string | undefined;
	private readonly queue: { readonly text: string; readonly unlessHeard: boolean }[] = [];
	/** The caller has spoken on this call. */
	private heardCaller = false;
	private saying: ISaying | undefined;
	private output: AudioContext | undefined;
	private analyser: AnalyserNode | undefined;
	private levelTimer: number | undefined;

	constructor(
		private readonly targetWindow: Window & typeof globalThis,
		private readonly options: ILocalVoiceLineOptions,
		private readonly speech: IVoltSpeechService,
		private readonly localVoices: IVoltLocalVoiceService,
		private readonly logService: ILogService,
	) {
		super();
		this.speed = options.speed;
		this.voice = options.voice;
		// The voice's engine loads and the opening lines are made while the microphone opens.
		void this.prepareVoice(true);
		this.holdTimer = targetWindow.setInterval(() => void this.prepareVoice(false), ENGINE_HOLD_EVERY_MS);
		this._register(this.speech.onDidEvent(event => {
			const utterance = this.utterance;
			if (!utterance || event.sessionId !== utterance.id) {
				return;
			}
			if (event.type === 'partial') {
				if (event.text.trim()) {
					this._onEvent.fire({ type: 'userTranscript', itemId: utterance.id, text: event.text, final: false });
				}
			} else if (event.type === 'final') {
				this.heard(utterance, event.text.trim());
			} else {
				this.logService.warn(`[volt voice] dictation: ${event.message}`);
				this.endUtterance(utterance, false);
				this.listen();
			}
		}));
	}

	get state(): RealtimeClientState {
		return this._state;
	}

	/** Opens the mic and dictation. Rejects when either cannot start. */
	async connect(): Promise<void> {
		const mediaDevices = this.targetWindow.navigator.mediaDevices;
		if (!mediaDevices?.getUserMedia) {
			throw new Error('This browser cannot use the microphone here (it needs https or localhost).');
		}
		let stream: MediaStream;
		try {
			stream = await mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
		} catch (err) {
			throw new Error(err instanceof Error && err.name === 'NotAllowedError'
				? 'Volt is not allowed to use the microphone. Allow it in your system or browser settings.'
				: `The microphone could not start: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (this._store.isDisposed) {
			stream.getTracks().forEach(track => track.stop());
			return;
		}
		this.openMic(stream);
		// The first utterance's engine starts now, so a refused speech permission fails the call here.
		const first = this.startUtterance();
		if (!await first.started) {
			throw new Error('Dictation could not start on this computer. Check that speech recognition is allowed for Volt.');
		}
		this.setState('listening');
		this._onEvent.fire({ type: 'ready' });
		// Opening line, dropped if they speak first: it also warms the voice, whose first words take longest.
		this.say(LOCAL_GREETING, true);
	}

	/** The downloaded voice this line speaks with, if any is downloaded. */
	private async localVoice(): Promise<ILocalVoice | undefined> {
		const states = await this.localVoices.getStates().catch(() => []);
		return pickLocalVoice(this.voice, readyLocalVoiceModels(states));
	}

	private async prepareVoice(stockLines: boolean): Promise<void> {
		try {
			const voice = await this.localVoice();
			if (!voice || this._state === 'closed') {
				return;
			}
			const warm = this.localVoices.warm(voice.ref, ENGINE_HOLD_MS);
			if (stockLines) {
				for (const line of STOCK_LINES) {
					for (const piece of localSpeechPieces(speakableMarkdown(line), voice.model === 'supertonic')) {
						await this.localVoices.synthesize({ text: piece, voice: voice.ref, speed: this.speed });
					}
				}
			}
			await warm;
		} catch (err) {
			this.logService.trace('[volt voice] the voice could not be prepared', err);
		}
	}

	/** Changes the voice mid-call (a voice's ref or a system voice's name); the next thing said uses it. */
	setVoice(voice: string | undefined): void {
		this.voice = voice;
		void this.prepareVoice(true);
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
		this.mic?.stream.getAudioTracks().forEach(track => track.enabled = !muted);
	}

	updateSession(config: IRealtimeSessionConfig): void {
		if (this.speed !== config.speed) {
			this.speed = config.speed;
			void this.prepareVoice(true);
		}
	}

	sendToolResult(callId: string, output: unknown): void {
		const name = this.toolCalls.get(callId);
		this.toolCalls.delete(callId);
		if (!name) {
			return;
		}
		const words = localToolWords(name, output);
		if (name === 'end_the_call') {
			// Said at once, so the call service waits for it before hanging up.
			if (words) {
				this.say(words);
			}
			return;
		}
		this.pendingWords = words;
	}

	requestResponse(_instructions?: string): void {
		const words = this.pendingWords;
		this.pendingWords = undefined;
		if (words) {
			this.say(words);
		}
	}

	addNote(_text: string, speak: boolean, spoken?: string): void {
		if (speak && spoken) {
			this.say(spoken);
		}
	}

	close(): void {
		this.queue.length = 0;
		this.saying?.cancel();
		this.saying = undefined;
		const utterance = this.utterance;
		if (utterance) {
			this.endUtterance(utterance, false);
		}
		this.closeMic();
		if (this.holdTimer !== undefined) {
			this.targetWindow.clearInterval(this.holdTimer);
			this.holdTimer = undefined;
		}
		void this.output?.close().catch(() => undefined);
		this.output = undefined;
		if (this.levelTimer !== undefined) {
			this.targetWindow.clearInterval(this.levelTimer);
			this.levelTimer = undefined;
		}
		this.setState('closed');
	}

	override dispose(): void {
		this.close();
		super.dispose();
	}

	//#region Hearing

	private openMic(stream: MediaStream): void {
		const context = new this.targetWindow.AudioContext({ sampleRate: VOLT_SPEECH_SAMPLE_RATE });
		const source = context.createMediaStreamSource(stream);
		const processor = context.createScriptProcessor(MIC_BLOCK, 1, 1);
		// The processor only runs while connected; a silent gain keeps the mic out of the speakers.
		const sink = context.createGain();
		sink.gain.value = 0;
		processor.onaudioprocess = event => this.onAudio(event.inputBuffer.getChannelData(0));
		source.connect(processor);
		processor.connect(sink);
		sink.connect(context.destination);
		void context.resume();
		this.mic = { stream, context, source, processor, sink };
	}

	private closeMic(): void {
		const mic = this.mic;
		this.mic = undefined;
		if (!mic) {
			return;
		}
		mic.processor.onaudioprocess = null;
		mic.source.disconnect();
		mic.processor.disconnect();
		mic.stream.getTracks().forEach(track => track.stop());
		void mic.context.close().catch(() => undefined);
	}

	private onAudio(samples: Float32Array): void {
		// Turn-taking: nothing is heard while the line speaks or waits for a transcript.
		if (this._state !== 'listening' || this.muted) {
			if (this._state === 'listening') {
				this._onLevel.fire(0);
			}
			return;
		}
		const level = rmsLevel(samples);
		this._onLevel.fire(Math.min(1, level * 4));
		const utterance = this.utterance ?? this.startUtterance();
		const pcm = encodeBase64(VSBuffer.wrap(pcm16Bytes(samples)));
		if (this.isStarted(utterance)) {
			this.push(utterance, pcm);
		} else {
			utterance.early.push(pcm);
		}
		const decision = this.detector.push(level, MIC_BLOCK_MS);
		if (!utterance.heardSpeech && this.detector.hasSpeech) {
			utterance.heardSpeech = true;
			this.heardCaller = true;
			this._onEvent.fire({ type: 'userSpeechStarted' });
		}
		if (decision === 'commit') {
			this.commit(utterance);
		} else if (decision === 'discard') {
			this.endUtterance(utterance, false);
		}
	}

	private readonly startedUtterances = new WeakSet<IUtterance>();

	private isStarted(utterance: IUtterance): boolean {
		return this.startedUtterances.has(utterance);
	}

	private startUtterance(): IUtterance {
		this.detector.reset();
		const id = generateUuid();
		const early: string[] = [];
		const utterance: IUtterance = {
			id, early, heardSpeech: false, committed: false,
			started: this.speech.start({ sessionId: id, locale: this.options.locale }).then(() => {
				this.startedUtterances.add(utterance);
				// What came in while the engine started goes first, in order.
				for (const pcm of early.splice(0)) {
					this.push(utterance, pcm);
				}
				if (utterance.committed) {
					this.speech.stop(id).catch(err => this.logService.warn('[volt voice] dictation did not stop', err));
				}
				return true;
			}, err => {
				this.logService.warn('[volt voice] dictation could not start', err);
				if (this.utterance === utterance) {
					this.utterance = undefined;
				}
				return false;
			}),
		};
		this.utterance = utterance;
		return utterance;
	}

	private push(utterance: IUtterance, pcm: string): void {
		this.speech.pushAudio(utterance.id, pcm).catch(err => this.logService.trace('[volt voice] audio was not delivered', err));
	}

	/** The caller paused: the utterance is sent for its final transcript. */
	private commit(utterance: IUtterance): void {
		utterance.committed = true;
		this._onEvent.fire({ type: 'userSpeechStopped' });
		this.setState('thinking');
		utterance.timer = this.targetWindow.setTimeout(() => {
			this.logService.warn('[volt voice] no transcript came for an utterance');
			this.endUtterance(utterance, false);
			this.listen();
		}, TRANSCRIPT_TIMEOUT_MS);
		if (this.isStarted(utterance)) {
			this.speech.stop(utterance.id).catch(err => this.logService.warn('[volt voice] dictation did not stop', err));
		}
	}

	private heard(utterance: IUtterance, text: string): void {
		this.endUtterance(utterance, true);
		if (!text) {
			this.listen();
			return;
		}
		this._onEvent.fire({ type: 'userTranscript', itemId: utterance.id, text, final: true });
		const callId = generateUuid();
		const name = isLocalGoodbye(text) ? 'end_the_call' : 'send_task';
		this.toolCalls.set(callId, name);
		this._onEvent.fire({ type: 'functionCall', callId, name, arguments: name === 'send_task' ? JSON.stringify({ request: text }) : '{}' });
		// Back to listening unless the tool's answer is already being said.
		this.listen();
	}

	/** Drops the utterance; `settled`: its transcript arrived, so the engine is done with it. */
	private endUtterance(utterance: IUtterance, settled: boolean): void {
		if (utterance.timer !== undefined) {
			this.targetWindow.clearTimeout(utterance.timer);
		}
		if (this.utterance === utterance) {
			this.utterance = undefined;
		}
		this.detector.reset();
		if (!settled) {
			this.speech.cancel(utterance.id).catch(() => undefined);
		}
	}

	private listen(): void {
		if (this._state === 'thinking') {
			this.setState('listening');
		}
	}

	//#endregion

	//#region Speaking

	/**
	 * Queues `markdown` to be read. The line keeps listening while the voice prepares it and only
	 * goes quiet once sound starts; `unlessHeard` drops it if the caller has spoken by then.
	 */
	private say(markdown: string, unlessHeard = false): void {
		const text = speakableMarkdown(markdown);
		if (!text || this._state === 'closed') {
			return;
		}
		this.queue.push({ text, unlessHeard });
		if (!this.saying) {
			void this.drain();
		}
	}

	private async drain(): Promise<void> {
		while (this.queue.length && this._state !== 'closed') {
			const item = this.queue.shift()!;
			const id = generateUuid();
			const saying: ISaying = { id, cancel: () => { } };
			this.saying = saying;
			let begun = false;
			// Called just before the first sound: waits out a sentence the caller is in the middle of.
			const begin = async (): Promise<boolean> => {
				if (begun) {
					return true;
				}
				const until = Date.now() + 30_000;
				// Any voice counts, even before it is long enough to be an utterance, so a first word is never talked over.
				while (this.utterance && !this.utterance.committed && (this.utterance.heardSpeech || this.detector.inSpeech) && Date.now() < until && this.saying === saying) {
					await new Promise(resolve => this.targetWindow.setTimeout(resolve, 150));
				}
				if (this.saying !== saying || (item.unlessHeard && this.heardCaller)) {
					return false;
				}
				const utterance = this.utterance;
				if (utterance && !utterance.committed) {
					this.endUtterance(utterance, false);
				}
				begun = true;
				this.setState('speaking');
				this._onEvent.fire({ type: 'responseStarted', responseId: id });
				this._onEvent.fire({ type: 'assistantTranscript', itemId: id, text: item.text });
				return true;
			};
			try {
				await this.speak(saying, item.text, begin);
			} catch (err) {
				this.logService.warn('[volt voice] the line could not speak', err);
			}
			if (this.saying !== saying) {
				return;
			}
			this.saying = undefined;
			// Listening again while the next answer (if any) is prepared.
			if (this._state === 'speaking') {
				this.setState(this.utterance?.committed ? 'thinking' : 'listening');
			}
			if (begun) {
				this._onEvent.fire({ type: 'responseDone', responseId: id, cancelled: false });
			}
		}
	}

	/**
	 * A downloaded voice whenever one is there (the picked one, else the fastest model's default),
	 * checked per answer so a download that finishes mid-call takes over; the system's voice only
	 * without any.
	 */
	private async speak(saying: ISaying, text: string, begin: () => Promise<boolean>): Promise<void> {
		const voice = await this.localVoice();
		if (voice && await this.speakLocal(saying, text, voice, begin)) {
			return;
		}
		await this.speakSystem(saying, text, begin);
	}

	/** A downloaded voice, a piece at a time; false when it failed before a word. */
	private async speakLocal(saying: ISaying, text: string, voice: ILocalVoice, begin: () => Promise<boolean>): Promise<boolean> {
		const sampleRate = LOCAL_VOICE_MODELS[voice.model].sampleRate;
		const output = this.output ??= new this.targetWindow.AudioContext();
		if (!this.analyser) {
			this.analyser = output.createAnalyser();
			this.analyser.fftSize = 512;
			this.analyser.connect(output.destination);
			this.levelTimer = this.targetWindow.setInterval(() => this.emitOutputLevel(), 60);
		}
		void output.resume();
		const sources: AudioBufferSourceNode[] = [];
		let cancelled = false;
		saying.cancel = () => {
			cancelled = true;
			for (const source of sources) {
				try {
					source.stop();
				} catch {
					// Not started yet.
				}
			}
		};
		let playedUntil = 0;
		let heard = false;
		for (const chunk of localSpeechPieces(text, voice.model === 'supertonic')) {
			let bytes: Uint8Array;
			try {
				bytes = (await this.localVoices.synthesize({ text: chunk, voice: voice.ref, speed: this.speed })).buffer;
			} catch (err) {
				this.logService.warn('[volt voice] the downloaded voice failed', err);
				if (!heard) {
					return cancelled;
				}
				break;
			}
			if (cancelled) {
				return true;
			}
			const samples = new Float32Array(bytes.byteLength >> 2);
			new Uint8Array(samples.buffer).set(bytes.subarray(0, samples.byteLength));
			if (!samples.length) {
				continue;
			}
			if (!heard && !await begin()) {
				// Skipped (they spoke first) or the call moved on.
				return true;
			}
			if (cancelled) {
				return true;
			}
			const buffer = output.createBuffer(1, samples.length, sampleRate);
			buffer.copyToChannel(samples, 0);
			const source = output.createBufferSource();
			source.buffer = buffer;
			source.connect(this.analyser);
			const at = Math.max(output.currentTime + 0.03, playedUntil);
			source.start(at);
			sources.push(source);
			playedUntil = at + buffer.duration + SPEECH_GAP;
			heard = true;
		}
		// Until the last piece has played.
		const left = Math.max(0, playedUntil - SPEECH_GAP - output.currentTime);
		await new Promise<void>(resolve => {
			const timer = this.targetWindow.setTimeout(resolve, left * 1000 + 60);
			const cancel = saying.cancel;
			saying.cancel = () => {
				cancel();
				this.targetWindow.clearTimeout(timer);
				resolve();
			};
		});
		return true;
	}

	/** The system's voices (Web Speech API), with a gentle pulse for the waveform since they give no audio to measure. */
	private async speakSystem(saying: ISaying, text: string, begin: () => Promise<boolean>): Promise<void> {
		const win = this.targetWindow;
		if (typeof win.speechSynthesis === 'undefined' || !await begin()) {
			return;
		}
		return new Promise<void>(resolve => {
			const chunks = splitSpeech(text);
			const voice = this.voice ? win.speechSynthesis.getVoices().find(candidate => candidate.name === this.voice) : undefined;
			const utterances: SpeechSynthesisUtterance[] = [];
			const start = Date.now();
			const pulse = win.setInterval(() => this._onLevel.fire(0.25 + 0.2 * Math.abs(Math.sin((Date.now() - start) / 140))), 60);
			const done = () => {
				win.clearInterval(pulse);
				for (const utterance of utterances) {
					utterance.onend = null;
					utterance.onerror = null;
				}
				resolve();
			};
			saying.cancel = () => {
				win.speechSynthesis.cancel();
				done();
			};
			if (!chunks.length) {
				done();
				return;
			}
			for (const [index, chunk] of chunks.entries()) {
				const utterance = new win.SpeechSynthesisUtterance(chunk);
				if (voice) {
					utterance.voice = voice;
					utterance.lang = voice.lang;
				}
				utterance.rate = this.speed;
				utterance.onerror = done;
				if (index === chunks.length - 1) {
					utterance.onend = done;
				}
				utterances.push(utterance);
				win.speechSynthesis.speak(utterance);
			}
		});
	}

	private emitOutputLevel(): void {
		if (this._state !== 'speaking' || !this.analyser) {
			return;
		}
		const data = new Float32Array(this.analyser.fftSize);
		this.analyser.getFloatTimeDomainData(data);
		this._onLevel.fire(Math.min(1, rmsLevel(data) * 4));
	}

	//#endregion

	private setState(state: RealtimeClientState): void {
		if (this._state !== state && this._state !== 'closed') {
			this._state = state;
			this._onDidChangeState.fire(state);
		}
	}
}
