/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { providerSpeed, VoltVoiceProvider } from '../../../../platform/voltVoiceChat/common/voltVoiceChat.js';

/** Realtime audio both ways: mono 16-bit little-endian PCM at 24 kHz. */
export const REALTIME_SAMPLE_RATE = 24000;

export interface IRealtimeTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: {
		readonly type: 'object';
		readonly properties: Record<string, unknown>;
		readonly required?: readonly string[];
	};
}

export interface IRealtimeSessionConfig {
	readonly provider: VoltVoiceProvider;
	readonly instructions: string;
	readonly voice: string;
	readonly speed: number;
	/** BCP 47 (`en-US`), or undefined to detect. */
	readonly language?: string;
	readonly tools: readonly IRealtimeTool[];
}

/**
 * The `session.update` for a provider. xAI's Voice Agent API and OpenAI's realtime API share the
 * event protocol but not the session shape: xAI keeps `voice` and `turn_detection` at the top and
 * transcribes with `grok-transcribe`; OpenAI nests them under `audio`.
 */
export function sessionUpdate(config: IRealtimeSessionConfig): Record<string, unknown> {
	const format = { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE };
	const tools = config.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }));
	const speed = providerSpeed(config.provider, config.speed);
	if (config.provider === 'openai') {
		return {
			type: 'session.update',
			session: {
				type: 'realtime',
				instructions: config.instructions,
				audio: {
					input: {
						format,
						transcription: { model: 'gpt-4o-mini-transcribe', ...(config.language ? { language: config.language.split('-')[0] } : {}) },
						turn_detection: { type: 'server_vad', silence_duration_ms: 600 },
					},
					output: { format, voice: config.voice, speed },
				},
				tools,
				tool_choice: 'auto',
			},
		};
	}
	return {
		type: 'session.update',
		session: {
			instructions: config.instructions,
			voice: config.voice,
			turn_detection: { type: 'server_vad' },
			audio: {
				input: { format, transcription: { model: 'grok-transcribe', ...(config.language ? { language_hint: config.language } : {}) } },
				output: { format, speed },
			},
			tools,
		},
	};
}

/** What the client acts on, from any of the providers' server events. */
export type RealtimeEvent =
	| { readonly type: 'ready' }
	| { readonly type: 'userSpeechStarted' }
	| { readonly type: 'userSpeechStopped' }
	/** `final`: the transcript for this item is complete; else the text so far (whole, not a delta). */
	| { readonly type: 'userTranscript'; readonly itemId: string; readonly text: string; readonly final: boolean }
	| { readonly type: 'assistantTranscript'; readonly itemId: string; readonly delta?: string; readonly text?: string }
	| { readonly type: 'audio'; readonly itemId: string; readonly base64: string }
	| { readonly type: 'responseStarted'; readonly responseId: string }
	| { readonly type: 'responseDone'; readonly responseId: string; readonly cancelled: boolean }
	| { readonly type: 'functionCall'; readonly callId: string; readonly name: string; readonly arguments: string }
	| { readonly type: 'error'; readonly message: string; readonly code?: string };

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/**
 * Reads one server event. User transcripts arrive as OpenAI deltas (accumulated by the caller via
 * `userTranscriptDelta`) or xAI's cumulative `.updated`; both end with `.completed`.
 */
export function parseServerEvent(raw: unknown, userDraft: Map<string, string>): readonly RealtimeEvent[] {
	if (!raw || typeof raw !== 'object') {
		return [];
	}
	const event = raw as Record<string, unknown>;
	const type = str(event.type);
	const itemId = str(event.item_id);
	switch (type) {
		case 'session.created':
		case 'session.updated':
			return type === 'session.updated' ? [{ type: 'ready' }] : [];
		case 'input_audio_buffer.speech_started':
			return [{ type: 'userSpeechStarted' }];
		case 'input_audio_buffer.speech_stopped':
			return [{ type: 'userSpeechStopped' }];
		case 'conversation.item.input_audio_transcription.delta': {
			const text = (userDraft.get(itemId) ?? '') + str(event.delta);
			userDraft.set(itemId, text);
			return [{ type: 'userTranscript', itemId, text, final: false }];
		}
		case 'conversation.item.input_audio_transcription.updated': {
			const text = str(event.transcript) || str(event.text) || str(event.delta);
			userDraft.set(itemId, text);
			return [{ type: 'userTranscript', itemId, text, final: false }];
		}
		case 'conversation.item.input_audio_transcription.completed': {
			userDraft.delete(itemId);
			return [{ type: 'userTranscript', itemId, text: str(event.transcript).trim(), final: true }];
		}
		case 'response.created': {
			const response = event.response as Record<string, unknown> | undefined;
			return [{ type: 'responseStarted', responseId: str(response?.id) }];
		}
		case 'response.output_audio.delta':
		case 'response.audio.delta':
			return str(event.delta) ? [{ type: 'audio', itemId, base64: str(event.delta) }] : [];
		case 'response.output_audio_transcript.delta':
		case 'response.audio_transcript.delta':
		case 'response.output_text.delta':
		case 'response.text.delta':
			return str(event.delta) ? [{ type: 'assistantTranscript', itemId, delta: str(event.delta) }] : [];
		case 'response.output_audio_transcript.done':
		case 'response.audio_transcript.done':
			return [{ type: 'assistantTranscript', itemId, text: str(event.transcript) }];
		case 'response.output_text.done':
		case 'response.text.done':
			return [{ type: 'assistantTranscript', itemId, text: str(event.text) }];
		case 'response.function_call_arguments.done':
			return [{ type: 'functionCall', callId: str(event.call_id), name: str(event.name), arguments: str(event.arguments) || '{}' }];
		case 'response.output_item.done': {
			const item = event.item as Record<string, unknown> | undefined;
			if (item?.type === 'function_call') {
				return [{ type: 'functionCall', callId: str(item.call_id), name: str(item.name), arguments: str(item.arguments) || '{}' }];
			}
			return [];
		}
		case 'response.done': {
			const response = event.response as Record<string, unknown> | undefined;
			return [{ type: 'responseDone', responseId: str(response?.id), cancelled: response?.status === 'cancelled' }];
		}
		case 'error': {
			const error = event.error as Record<string, unknown> | undefined;
			return [{ type: 'error', message: str(error?.message) || str(event.message) || 'The voice service reported an error.', code: str(error?.code) || undefined }];
		}
		default:
			return [];
	}
}

/** Base64 of 16-bit little-endian PCM from float samples in [-1, 1]. */
export function floatToPcm16Base64(samples: Float32Array): string {
	const bytes = new Uint8Array(samples.length * 2);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
	}
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
	}
	return btoa(binary);
}

/** Float samples from base64 16-bit little-endian PCM. */
export function pcm16Base64ToFloat(base64: string): Float32Array<ArrayBuffer> {
	const binary = atob(base64);
	const count = binary.length >> 1;
	const out = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		const lo = binary.charCodeAt(i * 2);
		const hi = binary.charCodeAt(i * 2 + 1);
		let value = (hi << 8) | lo;
		if (value >= 0x8000) {
			value -= 0x10000;
		}
		out[i] = value / (value < 0 ? 0x8000 : 0x7fff);
	}
	return out;
}

/** Downsamples (or passes through) mono float audio to the realtime rate by averaging. */
export function resampleTo(samples: Float32Array, fromRate: number, toRate = REALTIME_SAMPLE_RATE): Float32Array {
	if (fromRate === toRate) {
		return samples;
	}
	const ratio = fromRate / toRate;
	const length = Math.floor(samples.length / ratio);
	const out = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		const start = Math.floor(i * ratio);
		const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
		let sum = 0;
		for (let j = start; j < end; j++) {
			sum += samples[j];
		}
		out[i] = sum / (end - start);
	}
	return out;
}
