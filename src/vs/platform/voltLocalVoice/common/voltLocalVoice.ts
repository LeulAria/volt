/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Voices from speech models that run on this computer, on the sherpa-onnx runtime: Supertonic
 * (made in a fraction of a second) and Kokoro (more expressive, made slower than it plays on
 * most machines). Nothing ships with Volt: each is downloaded into `~/.volt/voices` on request.
 */
export const IVoltLocalVoiceService = createDecorator<IVoltLocalVoiceService>('voltLocalVoiceService');
export const VOLT_LOCAL_VOICE_CHANNEL_NAME = 'voltLocalVoice';

export type LocalVoiceModelId = 'supertonic' | 'kokoro';
export type LocalVoiceAccent = 'us' | 'gb';

export interface ILocalVoice {
	/** What the voice setting holds and a request names: `<model>:<id>`, as in `kokoro:af_heart`. */
	readonly ref: string;
	readonly model: LocalVoiceModelId;
	/** The model's own name for the voice, such as `af_heart`. */
	readonly id: string;
	readonly name: string;
	readonly accent: LocalVoiceAccent;
	readonly female: boolean;
	/** The voice's index in the model's voice table. */
	readonly speaker: number;
}

function kokoro(accent: LocalVoiceAccent, female: boolean, first: number, names: string): ILocalVoice[] {
	const prefix = `${accent === 'us' ? 'a' : 'b'}${female ? 'f' : 'm'}_`;
	return names.split(' ').map((name, index) => ({ ref: `kokoro:${prefix}${name.toLowerCase()}`, model: 'kokoro', id: prefix + name.toLowerCase(), name, accent, female, speaker: first + index }));
}

/** Supertonic names its ten voices F1 to F5 and M1 to M5; these are Volt's names for them, in the voice table's order. */
function supertonic(female: boolean, first: number, names: string): ILocalVoice[] {
	return names.split(' ').map((name, index) => {
		const id = `${female ? 'f' : 'm'}${index + 1}`;
		return { ref: `supertonic:${id}`, model: 'supertonic', id, name, accent: 'us', female, speaker: first + index };
	});
}

export const LOCAL_VOICES: readonly ILocalVoice[] = [
	...supertonic(true, 0, 'Juno Wren Mira Tess Ivy'),
	...supertonic(false, 5, 'Cole Reed Dax Finn Bram'),
	// Kokoro v1.0's English voices, in the order of the model's voice table.
	...kokoro('us', true, 0, 'Alloy Aoede Bella Heart Jessica Kore Nicole Nova River Sarah Sky'),
	...kokoro('us', false, 11, 'Adam Echo Eric Fenrir Liam Michael Onyx Puck Santa'),
	...kokoro('gb', true, 20, 'Alice Emma Isabella Lily'),
	...kokoro('gb', false, 24, 'Daniel Fable George Lewis'),
];

/** The voice picked when a model's download finishes. */
export const DEFAULT_LOCAL_VOICES: Record<LocalVoiceModelId, string> = { supertonic: 'supertonic:f1', kokoro: 'kokoro:af_heart' };

/** The downloaded voice a setting names, if it names one. */
export function localVoice(setting: string | undefined): ILocalVoice | undefined {
	return setting ? LOCAL_VOICES.find(voice => voice.ref === setting) : undefined;
}

export interface ILocalVoiceDownload {
	readonly url: string;
	readonly bytes: number;
	/** `sha256-<hex>` or npm's `sha512-<base64>`. */
	readonly integrity: string;
}

export interface ILocalVoiceModel extends ILocalVoiceDownload {
	readonly id: LocalVoiceModelId;
	/** The folder the archive unpacks to, kept as the model's folder under `~/.volt/voices`. */
	readonly folder: string;
	/** A file that is there when the model is. */
	readonly probe: string;
	/** What the model speaks at: mono, this many samples a second. */
	readonly sampleRate: number;
}

/** The speech models, fastest first. Both are 8-bit builds packaged for sherpa-onnx. */
export const LOCAL_VOICE_MODELS: Record<LocalVoiceModelId, ILocalVoiceModel> = {
	supertonic: {
		id: 'supertonic',
		folder: 'sherpa-onnx-supertonic-tts-int8-2026-03-06',
		probe: 'vector_estimator.int8.onnx',
		url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-tts-int8-2026-03-06.tar.bz2',
		bytes: 84692981,
		integrity: 'sha256-8c74359f63edd5045d47747f65331f0f6dbcbc91d7e898dd756d631295fe3259',
		sampleRate: 44100,
	},
	kokoro: {
		id: 'kokoro',
		folder: 'kokoro-int8-multi-lang-v1_0',
		probe: 'model.int8.onnx',
		url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2',
		bytes: 132353410,
		integrity: 'sha256-72c347230107ef8a31098ec4d468a605244beef5f1ed00db97efa13518800653',
		sampleRate: 24000,
	},
};

export const LOCAL_VOICE_MODEL_IDS = Object.keys(LOCAL_VOICE_MODELS) as LocalVoiceModelId[];

export function isLocalVoiceModel(value: unknown): value is LocalVoiceModelId {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOCAL_VOICE_MODELS, value);
}

/**
 * The downloaded voice to speak with: the one `setting` names when its model is there, else the
 * default voice of the fastest model that is.
 */
export function pickLocalVoice(setting: string | undefined, ready: readonly LocalVoiceModelId[]): ILocalVoice | undefined {
	const named = localVoice(setting);
	if (named && ready.includes(named.model)) {
		return named;
	}
	const model = LOCAL_VOICE_MODEL_IDS.find(id => ready.includes(id));
	return model ? localVoice(DEFAULT_LOCAL_VOICES[model]) : undefined;
}

export const LOCAL_VOICE_RUNTIME_VERSION = '2.0.1';

/** sherpa-onnx's Node addon per `platform-arch`, from npm. */
const RUNTIMES: Record<string, { readonly bytes: number; readonly integrity: string }> = {
	'darwin-arm64': { bytes: 10013200, integrity: 'sha512-agXmbbwiVPUSMViMhWhYAt59iG21ui7x6HxQFU35XzHOfQe9x6Pg9V160Pzak/66x0ePMjixsLUtMaaUrLfCwQ==' },
	'darwin-x64': { bytes: 11167483, integrity: 'sha512-SBnHa3LDOSI/5/rpBHGxKQDFq+yIdxowYY0InLzfojTUx+yGgqu7cYBrRxjzvHOiOKi0O4rmlFVZboyhIqpDgA==' },
	'linux-x64': { bytes: 11005484, integrity: 'sha512-w5mRRrIvPvcNWac7rQ8AN/t/cwElPGoRpH+ceCRBV7XfjCIQ9Rcr3Ig/kXcJLNOxgK4bGmef+Y47lIWiesDODw==' },
	'linux-arm64': { bytes: 13822449, integrity: 'sha512-5CJvLjFYIg23oELCsT7l07fMLT3PdquZ3tqh7KZK3Pzi+c2YiPKRe1DDUxoNdtCaw3ZiS4aQSQPBblB9JStuDA==' },
	'win32-x64': { bytes: 8779375, integrity: 'sha512-7vwdAw9PGEb0JLSpK7UFxAdp1vabBHK9Nhw2jFRBWSFgtslUPHIB0T6syJfRgiUGyCeNW9fJvcFAk2F2u7hBEw==' },
	'win32-arm64': { bytes: 8486399, integrity: 'sha512-Mb9iqy2Zp7GC5a99dk5E8EQJsEBnapf+IcwHLVCgtIf5mxYHO9Q8YptnAoOHZOD0Zi+R+MblFyG9qv0Q6tin4Q==' },
};

/** The runtime download for a platform, or nothing where sherpa-onnx has no build. */
export function localVoiceRuntime(platform: string, arch: string): ILocalVoiceDownload | undefined {
	const runtime = RUNTIMES[`${platform}-${arch}`];
	if (!runtime) {
		return undefined;
	}
	const name = `sherpa-onnx-${platform === 'win32' ? 'win' : platform}-${arch}`;
	return { ...runtime, url: `https://registry.npmjs.org/${name}/-/${name}-${LOCAL_VOICE_RUNTIME_VERSION}.tgz` };
}

export type LocalVoiceStatus =
	/** No runtime for this platform, or not the desktop app. */
	| 'unsupported'
	| 'absent'
	| 'downloading'
	/** Downloaded; checking and unpacking. */
	| 'installing'
	| 'ready';

/** Where one model's download stands. */
export interface ILocalVoiceState {
	readonly model: LocalVoiceModelId;
	readonly status: LocalVoiceStatus;
	/** What the download weighs in all (with the runtime while that is missing), in bytes. */
	readonly totalBytes: number;
	/** While downloading. */
	readonly receivedBytes?: number;
	/** Why the last download failed. */
	readonly error?: string;
}

export function readyLocalVoiceModels(states: readonly ILocalVoiceState[]): LocalVoiceModelId[] {
	return states.filter(state => state.status === 'ready').map(state => state.model);
}

export interface ILocalVoiceRequest {
	/** Plain text, a few sentences at most. */
	readonly text: string;
	/** A voice's `ref` from {@link LOCAL_VOICES}. */
	readonly voice: string;
	/** 1 is the voice's own pace. */
	readonly speed: number;
}

export interface IVoltLocalVoiceService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<ILocalVoiceState>;
	/** Every model's state, in {@link LOCAL_VOICE_MODEL_IDS} order. */
	getStates(): Promise<ILocalVoiceState[]>;
	/** Downloads the model (and the runtime when missing). Resolves when its voices are ready; rejects when it fails or is cancelled. */
	install(model: LocalVoiceModelId): Promise<void>;
	cancelInstall(model: LocalVoiceModelId): Promise<void>;
	/** Deletes the model, and the runtime with the last one. */
	remove(model: LocalVoiceModelId): Promise<void>;
	/**
	 * The text spoken: mono 32-bit float samples, little-endian, at the voice's model's sample
	 * rate. Empty when the text had nothing to say. (A bare buffer: one inside an object would
	 * cross the process boundary as JSON.)
	 */
	synthesize(request: ILocalVoiceRequest): Promise<VSBuffer>;
	/**
	 * Gets the engine ready for `voice` ahead of the first words (starting it and loading the
	 * model take about a second), and keeps it for `holdMs` longer than usual: a call asks again
	 * while it is up. Does nothing when the voice's model is not downloaded.
	 */
	warm(voice: string, holdMs?: number): Promise<void>;
}

/** The engine in its own process: the model loaded once, one request at a time. */
export interface ILocalVoiceWorker {
	synthesize(request: ILocalVoiceRequest): Promise<VSBuffer>;
	/** Loads the model. */
	warm(): Promise<void>;
}

/** Speech this short is kept on disk once made, so a call's stock lines ("On it.") play at once. */
export const LOCAL_VOICE_KEPT_TEXT = 64;

/** Samples quieter than this at a clip's end are silence. */
const SILENCE = 0.004;
/** Silence kept after the last sound, in seconds. */
const TAIL = 0.12;

/** `samples` without the long silence some models leave at the end, which would delay whatever comes next. */
export function trimTail(samples: Float32Array, sampleRate: number): Float32Array {
	let last = samples.length - 1;
	while (last >= 0 && Math.abs(samples[last]) < SILENCE) {
		last--;
	}
	const keep = Math.min(samples.length, last + 1 + Math.round(TAIL * sampleRate));
	return keep < samples.length ? samples.subarray(0, keep) : samples;
}

export const LOCAL_VOICE_WORKER_CHANNEL = 'localVoiceWorker';
