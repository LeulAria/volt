/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltSpeechService = createDecorator<IVoltSpeechService>('voltSpeechService');
export const VOLT_SPEECH_CHANNEL_NAME = 'voltSpeech';

/** The rate the Mac's recognizer and transcription endpoints take: mono 16-bit little-endian PCM. */
export const VOLT_SPEECH_SAMPLE_RATE = 16000;

/** OpenAI realtime transcription takes 24 kHz mono 16-bit little-endian PCM only. */
export const VOLT_REALTIME_SAMPLE_RATE = 24000;

/** Where the audio goes: OpenAI's realtime API, the Mac's recognizer (on device or Apple's servers), or a transcription endpoint. */
export type VoltSpeechEngine = 'openai-realtime' | 'apple-on-device' | 'apple' | 'endpoint';

/**
 * The engine dictation asks for. `auto` streams to OpenAI when an API key is known, else uses the
 * Mac's recognizer, else the transcription endpoint.
 */
export type VoltSpeechEnginePreference = 'auto' | 'openai' | 'system' | 'endpoint';

/** How long a realtime model may wait for more audio before it emits text; higher trades latency for accuracy. */
export type VoltRealtimeDelay = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface IVoltSpeechEndpoint {
	/** An OpenAI-compatible base URL, such as `http://localhost:8000/v1`. `/audio/transcriptions` is appended. */
	readonly baseUrl: string;
	readonly model: string;
}

/** What a realtime transcription session is asked to do. */
export interface IVoltRealtimeTranscriptionConfig {
	/** `gpt-live-transcribe`, `gpt-transcribe`, `gpt-4o-transcribe`, ... */
	readonly model: string;
	/** Expected input languages as ISO 639-1 codes (`en`, `fr`). Empty lets the model detect them. */
	readonly languages?: readonly string[];
	/** A sentence about the recording's setting. */
	readonly prompt?: string;
	/** Literal terms that may be spoken: names of the project, files, and tools. */
	readonly keywords?: readonly string[];
	readonly delay?: VoltRealtimeDelay;
}

export interface IVoltRealtimeTranscription extends IVoltRealtimeTranscriptionConfig {
	/** The OpenAI API base URL, such as `https://api.openai.com/v1`. The socket goes to its `/realtime`. */
	readonly baseUrl: string;
	/**
	 * The user's own OpenAI key from Volt's secret storage. The main process keeps it in memory for this
	 * session only and sends it nowhere but the socket's `Authorization` header. Empty falls back to
	 * the main process's `OPENAI_API_KEY`.
	 */
	readonly apiKey: string;
}

export interface IVoltSpeechStartOptions {
	readonly sessionId: string;
	/** A BCP 47 tag such as `en-US`. */
	readonly locale: string;
	/** Defaults to `auto`. */
	readonly engine?: VoltSpeechEnginePreference;
	readonly endpoint?: IVoltSpeechEndpoint;
	readonly realtime?: IVoltRealtimeTranscription;
}

export interface IVoltSpeechStartResult {
	readonly engine: VoltSpeechEngine;
	/** The rate of the PCM `pushAudio` takes. */
	readonly sampleRate: number;
}

/** A streaming engine's link: `connected` once audio reaches the provider, `reconnecting` while it is being restored. */
export type VoltSpeechConnectionState = 'connected' | 'reconnecting';

/** What a dictation session reports, in order. */
export type VoltSpeechEventBody =
	/**
	 * The text of one utterance. Segments are ordered by `index` (not every index is used); each update
	 * replaces the segment's text, and a `final` segment never changes again.
	 */
	| { readonly type: 'segment'; readonly index: number; readonly text: string; readonly final: boolean }
	| { readonly type: 'connection'; readonly state: VoltSpeechConnectionState; readonly attempt?: number }
	/** Something the user should know that did not end the session, such as audio lost while offline. */
	| { readonly type: 'notice'; readonly message: string }
	/** The session is over and every segment has its last text. `message` explains an early or partial end. */
	| { readonly type: 'end'; readonly message?: string }
	/** The session failed. Segments already reported stand; unfinished ones were sent as final first. */
	| { readonly type: 'error'; readonly message: string };

export type IVoltSpeechEvent = { readonly sessionId: string } & VoltSpeechEventBody;

export interface IVoltSpeechService {
	readonly _serviceBrand: undefined;
	readonly onDidEvent: Event<IVoltSpeechEvent>;
	/**
	 * Resolves once the engine takes audio; `pushAudio` may follow at once. A realtime session is still
	 * connecting then and holds the audio until it is: a `connection` event follows. Rejects when no
	 * engine can take the audio.
	 */
	start(options: IVoltSpeechStartOptions): Promise<IVoltSpeechStartResult>;
	/** Mono 16-bit little-endian samples at the rate `start` returned, in order. */
	pushAudio(sessionId: string, pcm: VSBuffer): Promise<void>;
	/** Ends the audio. The last segments follow, then `end`. */
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

/** Root-mean-square level of 16-bit little-endian PCM bytes, 0 for silence and 1 for full scale. */
export function pcm16Rms(pcm: Uint8Array): number {
	const samples = Math.floor(pcm.byteLength / 2);
	if (!samples) {
		return 0;
	}
	const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
	let sum = 0;
	for (let i = 0; i < samples; i++) {
		const sample = view.getInt16(i * 2, true) / 0x8000;
		sum += sample * sample;
	}
	return Math.min(1, Math.sqrt(sum / samples));
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

/**
 * `https://api.openai.com/v1` → `wss://api.openai.com/v1/realtime?intent=transcription`, the socket
 * of a realtime transcription session. Throws for anything that is not an http(s) or ws(s) URL.
 */
export function realtimeTranscriptionUrl(baseUrl: string): string {
	const url = new URL(baseUrl.trim());
	if (url.protocol === 'https:' || url.protocol === 'wss:') {
		url.protocol = 'wss:';
	} else if (url.protocol === 'http:' || url.protocol === 'ws:') {
		url.protocol = 'ws:';
	} else {
		throw new Error(`The OpenAI base URL must be an http or https URL, not ${url.protocol}`);
	}
	url.pathname = `${url.pathname.replace(/\/+$/, '')}/realtime`;
	url.search = '?intent=transcription';
	url.hash = '';
	return url.toString();
}
