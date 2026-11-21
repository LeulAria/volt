/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltSpeechService = createDecorator<IVoltSpeechService>('voltSpeechService');
export const VOLT_SPEECH_CHANNEL_NAME = 'voltSpeech';

/** The audio the renderer sends: mono 16-bit little-endian PCM at this rate. */
export const VOLT_SPEECH_SAMPLE_RATE = 16000;

/** `browser`: the Web Speech API, for Volt's workbench in a browser tab. */
export type VoltSpeechEngine = 'apple-on-device' | 'apple' | 'endpoint' | 'browser';

export interface IVoltSpeechEndpoint {
	/** An OpenAI-compatible base URL, such as `http://localhost:8000/v1`. `/audio/transcriptions` is appended. */
	readonly baseUrl: string;
	readonly model: string;
}

export interface IVoltSpeechStartOptions {
	readonly sessionId: string;
	/** A BCP 47 tag such as `en-US`. */
	readonly locale: string;
	readonly endpoint?: IVoltSpeechEndpoint;
}

export type IVoltSpeechEvent = { readonly sessionId: string } & (
	| { readonly type: 'partial'; readonly text: string }
	| { readonly type: 'final'; readonly text: string; readonly message?: string }
	| { readonly type: 'error'; readonly message: string }
);

export interface IVoltSpeechService {
	readonly _serviceBrand: undefined;
	readonly onDidEvent: Event<IVoltSpeechEvent>;
	/** False where no engine can listen at all (a browser without speech recognition); missing means it can try. */
	isAvailable?(): boolean;
	/** Resolves once the engine is running; `pushAudio` may follow. Rejects when no engine can take the audio. */
	start(options: IVoltSpeechStartOptions): Promise<VoltSpeechEngine>;
	/** `pcmBase64`: 16 kHz mono 16-bit little-endian samples. */
	pushAudio(sessionId: string, pcmBase64: string): Promise<void>;
	/** Ends the audio. A `final` event follows with the whole transcript. */
	stop(sessionId: string): Promise<void>;
	/** Drops the session without a transcript. */
	cancel(sessionId: string): Promise<void>;
}

/** Float samples in [-1, 1] to 16-bit little-endian PCM bytes. */
export function pcm16Bytes(samples: Float32Array): Uint8Array {
	const bytes = new Uint8Array(samples.length * 2);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(i * 2, Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), true);
	}
	return bytes;
}

/** Root-mean-square level of a block, 0 for silence and 1 for full scale. */
export function rmsLevel(samples: Float32Array): number {
	if (!samples.length) {
		return 0;
	}
	let sum = 0;
	for (let i = 0; i < samples.length; i++) {
		sum += samples[i] * samples[i];
	}
	return Math.min(1, Math.sqrt(sum / samples.length));
}

/** What {@link SpeechGate} makes of one block of audio. */
export type SpeechGateDecision = 'voice' | 'hangover' | 'silence';

/** Voice is this many times louder than the room; quiet speakers still clear the floor. */
const GATE_SPEECH_FACTOR = 3;
const GATE_MIN_THRESHOLD = 0.006;
const GATE_MAX_THRESHOLD = 0.08;
/** Audio kept after the voice stops, so word endings and the pause between sentences go through. */
const GATE_HANGOVER_MS = 1_000;

/**
 * Voice activity for dictation: an energy threshold over an adaptive noise floor. Only voice and a
 * short hangover after it reach the recognizer, so silence costs nothing (no upload to a paid
 * transcription endpoint, no recognizer time) and a dictation can sit through long pauses.
 */
export class SpeechGate {

	private noiseFloor = 0.003;
	private sinceVoiceMs = 0;
	private _heardVoice = false;

	/** Some block so far held voice, not only room noise. */
	get heardVoice(): boolean {
		return this._heardVoice;
	}

	/** How long no voice was heard: since the last voice, or since the start. */
	get silentMs(): number {
		return this.sinceVoiceMs;
	}

	push(rms: number, durationMs: number): SpeechGateDecision {
		const threshold = Math.min(GATE_MAX_THRESHOLD, Math.max(GATE_MIN_THRESHOLD, this.noiseFloor * GATE_SPEECH_FACTOR));
		if (rms >= threshold) {
			this._heardVoice = true;
			this.sinceVoiceMs = 0;
			// A steady noise louder than the first guess still lifts the floor, slowly.
			this.noiseFloor += (Math.min(rms, GATE_MAX_THRESHOLD) - this.noiseFloor) * 0.002;
			return 'voice';
		}
		this.sinceVoiceMs += durationMs;
		this.noiseFloor += (Math.min(rms, GATE_MAX_THRESHOLD) - this.noiseFloor) * 0.05;
		return this._heardVoice && this.sinceVoiceMs <= GATE_HANGOVER_MS ? 'hangover' : 'silence';
	}
}

/** A RIFF/WAVE file around 16-bit mono PCM, for uploads to a transcription endpoint. */
export function wavFromPcm16(pcm: Uint8Array, sampleRate: number): Uint8Array<ArrayBuffer> {
	const header = new DataView(new ArrayBuffer(44));
	const writeText = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) {
			header.setUint8(offset + i, text.charCodeAt(i));
		}
	};
	writeText(0, 'RIFF');
	header.setUint32(4, 36 + pcm.byteLength, true);
	writeText(8, 'WAVE');
	writeText(12, 'fmt ');
	header.setUint32(16, 16, true);
	header.setUint16(20, 1, true);
	header.setUint16(22, 1, true);
	header.setUint32(24, sampleRate, true);
	header.setUint32(28, sampleRate * 2, true);
	header.setUint16(32, 2, true);
	header.setUint16(34, 16, true);
	writeText(36, 'data');
	header.setUint32(40, pcm.byteLength, true);
	const wav = new Uint8Array(44 + pcm.byteLength);
	wav.set(new Uint8Array(header.buffer), 0);
	wav.set(pcm, 44);
	return wav;
}

/** `http://host/v1/` → `http://host/v1/audio/transcriptions`. Throws for anything that is not an http(s) URL. */
export function transcriptionUrl(baseUrl: string): string {
	const url = new URL(baseUrl.trim());
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`The transcription endpoint must be an http or https URL, not ${url.protocol}`);
	}
	url.pathname = `${url.pathname.replace(/\/+$/, '')}/audio/transcriptions`;
	return url.toString();
}
