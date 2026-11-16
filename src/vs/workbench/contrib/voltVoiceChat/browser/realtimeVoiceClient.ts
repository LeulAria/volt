/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IVoltVoiceSession } from '../../../../platform/voltVoiceChat/common/voltVoiceChat.js';
import { floatToPcm16Base64, IRealtimeSessionConfig, parseServerEvent, pcm16Base64ToFloat, REALTIME_SAMPLE_RATE, RealtimeEvent, resampleTo, sessionUpdate } from '../common/realtimeProtocol.js';

export type RealtimeClientState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'closed';

/** Mic blocks of 4096 frames: ~85 ms at 48 kHz. */
const MIC_BLOCK = 4096;
/** Waveform levels kept for the tray (one per ~85 ms block). */
const CONNECT_TIMEOUT_MS = 15_000;

interface IMic {
	readonly stream: MediaStream;
	readonly context: AudioContext;
	readonly source: MediaStreamAudioSourceNode;
	readonly processor: ScriptProcessorNode;
	readonly sink: GainNode;
}

/**
 * One realtime voice session in the window: the microphone streams to the provider's socket,
 * its spoken answer plays through the speakers, and the user can talk over it (the server's VAD
 * hears them; the client stops playback and tells the server how much was heard). Events come
 * out normalized (`onEvent`); tool calls are answered with `sendToolResult`.
 */
export class RealtimeVoiceClient extends Disposable {

	private readonly _onEvent = this._register(new Emitter<RealtimeEvent>());
	readonly onEvent = this._onEvent.event;
	private readonly _onDidChangeState = this._register(new Emitter<RealtimeClientState>());
	readonly onDidChangeState = this._onDidChangeState.event;
	/** Loudness 0..1 of the mic (while it is the user's turn) or of the voice (while it speaks). */
	private readonly _onLevel = this._register(new Emitter<number>());
	readonly onLevel = this._onLevel.event;

	private socket: WebSocket | undefined;
	private mic: IMic | undefined;
	private output: AudioContext | undefined;
	private playhead = 0;
	private readonly playing = new Set<AudioBufferSourceNode>();
	/** The assistant item being played and how many ms of it have been queued. */
	private playingItem: { id: string; queuedMs: number; startedAt: number } | undefined;
	private readonly userDraft = new Map<string, string>();
	private responding = false;
	/** An answer asked for while another was in flight. */
	private owed: { readonly instructions?: string } | undefined;
	private _state: RealtimeClientState = 'connecting';
	private _muted = false;
	private levelTimer: number | undefined;
	private outputAnalyser: AnalyserNode | undefined;

	constructor(private readonly targetWindow: Window & typeof globalThis) {
		super();
	}

	get state(): RealtimeClientState {
		return this._state;
	}

	get muted(): boolean {
		return this._muted;
	}

	/** Opens the mic and the socket and configures the session. Rejects when either fails. */
	async connect(session: IVoltVoiceSession, config: IRealtimeSessionConfig): Promise<void> {
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
		this.output = new this.targetWindow.AudioContext({ sampleRate: REALTIME_SAMPLE_RATE });
		this.outputAnalyser = this.output.createAnalyser();
		this.outputAnalyser.fftSize = 512;
		this.outputAnalyser.connect(this.output.destination);
		void this.output.resume();
		this.openMic(stream);
		await this.openSocket(session, config);
		this.levelTimer = this.targetWindow.setInterval(() => this.emitOutputLevel(), 60);
	}

	setMuted(muted: boolean): void {
		this._muted = muted;
		this.mic?.stream.getAudioTracks().forEach(track => track.enabled = !muted);
	}

	/** Changes voice, speed or language mid-call. */
	updateSession(config: IRealtimeSessionConfig): void {
		this.send(sessionUpdate(config));
	}

	sendToolResult(callId: string, output: unknown): void {
		this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: typeof output === 'string' ? output : JSON.stringify(output) } });
	}

	/**
	 * Asks for the next answer (after tool results, or a note the voice should speak), with
	 * `instructions` for that one answer. While an answer is still in flight it is owed and sent
	 * when that one is done, never two at once.
	 */
	requestResponse(instructions?: string): void {
		if (this.responding) {
			this.owed = { instructions: instructions ?? this.owed?.instructions };
			return;
		}
		this.responding = true;
		this.send({ type: 'response.create', ...(instructions ? { response: { instructions } } : {}) });
	}

	/** Adds a note to the conversation (an agent finished) for the voice to tell the user about. */
	addNote(text: string, speak: boolean): void {
		this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
		if (speak) {
			this.requestResponse();
		}
	}

	close(): void {
		this.stopPlayback(false);
		this.socket?.close(1000);
		this.socket = undefined;
		this.closeMic();
		void this.output?.close().catch(() => undefined);
		this.output = undefined;
		if (this.levelTimer) {
			this.targetWindow.clearInterval(this.levelTimer);
			this.levelTimer = undefined;
		}
		this.setState('closed');
	}

	override dispose(): void {
		this.close();
		super.dispose();
	}

	private openMic(stream: MediaStream): void {
		const context = new this.targetWindow.AudioContext();
		const source = context.createMediaStreamSource(stream);
		const processor = context.createScriptProcessor(MIC_BLOCK, 1, 1);
		// The processor only runs while connected to the destination; a silent gain keeps the mic out of the speakers.
		const sink = context.createGain();
		sink.gain.value = 0;
		processor.onaudioprocess = event => {
			const samples = event.inputBuffer.getChannelData(0);
			if (this._muted || this.socket?.readyState !== WebSocket.OPEN) {
				if (this._state !== 'speaking') {
					this._onLevel.fire(0);
				}
				return;
			}
			const resampled = resampleTo(samples, context.sampleRate);
			this.send({ type: 'input_audio_buffer.append', audio: floatToPcm16Base64(resampled) });
			if (this._state !== 'speaking') {
				this._onLevel.fire(rms(samples));
			}
		};
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

	private openSocket(session: IVoltVoiceSession, config: IRealtimeSessionConfig): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const fail = (message: string) => {
				if (!settled) {
					settled = true;
					reject(new Error(message));
				} else {
					this._onEvent.fire({ type: 'error', message });
					this.close();
				}
			};
			const timer = setTimeout(() => fail('The voice service did not answer.'), CONNECT_TIMEOUT_MS);
			let socket: WebSocket;
			try {
				socket = new WebSocket(session.url, session.protocols.length ? [...session.protocols] : undefined);
			} catch (err) {
				clearTimeout(timer);
				fail(`Could not open the voice connection: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			this.socket = socket;
			socket.onopen = () => {
				socket.send(JSON.stringify(sessionUpdate(config)));
			};
			socket.onmessage = message => {
				let raw: unknown;
				try {
					raw = JSON.parse(typeof message.data === 'string' ? message.data : '');
				} catch {
					return;
				}
				for (const event of parseServerEvent(raw, this.userDraft)) {
					if (event.type === 'ready' && !settled) {
						settled = true;
						clearTimeout(timer);
						this.setState('listening');
						resolve();
					}
					if (event.type === 'error' && !settled) {
						clearTimeout(timer);
						fail(event.message);
						return;
					}
					this.handle(event);
				}
			};
			socket.onerror = () => {
				// onclose follows with the reason.
			};
			socket.onclose = event => {
				clearTimeout(timer);
				if (this.socket !== socket) {
					return;
				}
				this.socket = undefined;
				fail(event.code === 1000 ? 'The voice call ended.' : `The voice connection closed${event.reason ? `: ${event.reason}` : ` (code ${event.code})`}.`);
			};
		});
	}

	private handle(event: RealtimeEvent): void {
		switch (event.type) {
			case 'userSpeechStarted':
				// Barge-in: the user talks over the voice.
				this.stopPlayback(true);
				this.setState('listening');
				break;
			case 'userSpeechStopped':
				this.setState('thinking');
				break;
			case 'responseStarted':
				this.responding = true;
				if (this._state !== 'speaking') {
					this.setState('thinking');
				}
				break;
			case 'audio':
				this.play(event.itemId, event.base64);
				break;
			case 'responseDone':
				this.responding = false;
				if (this.owed) {
					const owed = this.owed;
					this.owed = undefined;
					queueMicrotask(() => this.requestResponse(owed.instructions));
				}
				if (!this.playing.size) {
					this.setState('listening');
				}
				break;
		}
		this._onEvent.fire(event);
	}

	private play(itemId: string, base64: string): void {
		const output = this.output;
		if (!output) {
			return;
		}
		const samples = pcm16Base64ToFloat(base64);
		if (!samples.length) {
			return;
		}
		const buffer = output.createBuffer(1, samples.length, REALTIME_SAMPLE_RATE);
		buffer.copyToChannel(samples, 0);
		const node = output.createBufferSource();
		node.buffer = buffer;
		node.connect(this.outputAnalyser ?? output.destination);
		const now = output.currentTime;
		if (this.playhead < now) {
			this.playhead = now + 0.03;
		}
		node.start(this.playhead);
		if (this.playingItem?.id !== itemId) {
			this.playingItem = { id: itemId, queuedMs: 0, startedAt: this.playhead };
		}
		this.playhead += buffer.duration;
		this.playingItem.queuedMs += buffer.duration * 1000;
		this.playing.add(node);
		node.onended = () => {
			this.playing.delete(node);
			if (!this.playing.size && !this.responding && this._state === 'speaking') {
				this.setState('listening');
			}
		};
		this.setState('speaking');
	}

	/** Stops the voice; with `truncate`, tells the server how much of its answer the user heard. */
	private stopPlayback(truncate: boolean): void {
		const output = this.output;
		const item = this.playingItem;
		if (truncate && item && output && this.playing.size) {
			const heardMs = Math.max(0, Math.min(item.queuedMs, (output.currentTime - item.startedAt) * 1000));
			this.send({ type: 'conversation.item.truncate', item_id: item.id, content_index: 0, audio_end_ms: Math.round(heardMs) });
		}
		for (const node of this.playing) {
			node.onended = null;
			try {
				node.stop();
			} catch {
				// Not started yet.
			}
		}
		this.playing.clear();
		this.playingItem = undefined;
		this.playhead = 0;
	}

	private emitOutputLevel(): void {
		if (this._state !== 'speaking' || !this.outputAnalyser) {
			return;
		}
		const data = new Float32Array(this.outputAnalyser.fftSize);
		this.outputAnalyser.getFloatTimeDomainData(data);
		this._onLevel.fire(rms(data));
	}

	private send(event: Record<string, unknown>): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify(event));
		}
	}

	private setState(state: RealtimeClientState): void {
		if (this._state !== state && this._state !== 'closed') {
			this._state = state;
			this._onDidChangeState.fire(state);
		}
	}
}

function rms(samples: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < samples.length; i++) {
		sum += samples[i] * samples[i];
	}
	return Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 4);
}
