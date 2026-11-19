/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'fs';
import { createRequire } from 'node:module';
import { VSBuffer } from '../../../base/common/buffer.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { Server as ChildProcessServer } from '../../../base/parts/ipc/node/ipc.cp.js';
import { Server as UtilityProcessServer } from '../../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../../base/parts/sandbox/node/electronTypes.js';
import { lexiconSpeech, lexiconWords } from '../common/lexiconSpeech.js';
import { spokenCode } from '../common/spokenCode.js';
import { ILocalVoiceRequest, ILocalVoiceWorker, isLocalVoiceModel, LOCAL_VOICE_MODELS, LOCAL_VOICE_WORKER_CHANNEL, localVoice, LocalVoiceModelId, trimTail } from '../common/voltLocalVoice.js';

// The local voice process: started by VoltLocalVoiceMainService for a reading, stopped when idle.
// It loads the downloaded sherpa-onnx addon and one speech model (Kokoro holds about 500 MB).

interface ISherpaAudio {
	readonly samples: Float32Array;
	readonly sampleRate: number;
}

interface ISherpaAddon {
	createOfflineTts(config: object): unknown;
	offlineTtsGenerate(tts: unknown, request: object): ISherpaAudio;
	offlineTtsGenerateAsync?(tts: unknown, request: object): Promise<ISherpaAudio>;
	offlineTtsGenerateWithConfig?(tts: unknown, request: object): ISherpaAudio;
}

/** Supertonic's denoising steps: 5 is its makers' default; 10 is cleaner for about 100 ms more a sentence. */
const SUPERTONIC_STEPS = 10;
class LocalVoiceEngine implements ILocalVoiceWorker {

	private loaded: { readonly addon: ISherpaAddon; readonly tts: unknown; readonly words: Set<string> | undefined } | undefined;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly runtimeDir: string,
		private readonly model: LocalVoiceModelId,
		private readonly modelDir: string,
		private readonly british: boolean,
	) { }

	private load() {
		if (!this.loaded) {
			const addon = createRequire(import.meta.url)(join(this.runtimeDir, 'sherpa-onnx.node')) as ISherpaAddon;
			// More threads were no faster on an M4 Max, and they are taken from the app.
			const common = { numThreads: 2, provider: 'cpu', debug: false };
			if (this.model === 'supertonic') {
				const file = (name: string) => join(this.modelDir, name);
				const tts = addon.createOfflineTts({
					model: {
						supertonic: {
							durationPredictor: file('duration_predictor.int8.onnx'),
							textEncoder: file('text_encoder.int8.onnx'),
							vectorEstimator: file('vector_estimator.int8.onnx'),
							vocoder: file('vocoder.int8.onnx'),
							ttsJson: file('tts.json'),
							unicodeIndexer: file('unicode_indexer.bin'),
							voiceStyle: file('voice.bin'),
						},
						...common,
					},
					maxNumSentences: 1,
				});
				this.loaded = { addon, tts, words: undefined };
			} else {
				const lexicon = join(this.modelDir, this.british ? 'lexicon-gb-en.txt' : 'lexicon-us-en.txt');
				const tts = addon.createOfflineTts({
					model: {
						kokoro: {
							model: join(this.modelDir, 'model.int8.onnx'),
							voices: join(this.modelDir, 'voices.bin'),
							tokens: join(this.modelDir, 'tokens.txt'),
							lexicon,
						},
						...common,
					},
					maxNumSentences: 1,
				});
				this.loaded = { addon, tts, words: lexiconWords(readFileSync(lexicon, 'utf8')) };
			}
		}
		return this.loaded;
	}

	warm(): Promise<void> {
		const result = this.queue.then(() => { this.load(); });
		this.queue = result.catch(() => undefined);
		return result;
	}

	synthesize(request: ILocalVoiceRequest): Promise<VSBuffer> {
		const result = this.queue.then(() => this.generate(request));
		this.queue = result.catch(() => undefined);
		return result;
	}

	private async generate(request: ILocalVoiceRequest): Promise<VSBuffer> {
		const voice = localVoice(request.voice);
		if (!voice || voice.model !== this.model) {
			throw new Error(`Unknown voice ${request.voice}`);
		}
		const { addon, tts, words } = this.load();
		// File names, paths and code are put the way a developer says them; then Kokoro, which speaks
		// only its dictionary's words, gets everything else rewritten into those.
		const spoken = spokenCode(request.text);
		const text = words ? lexiconSpeech(spoken, word => words.has(word)) : spoken;
		if (!text) {
			return VSBuffer.alloc(0);
		}
		const speed = Math.max(0.5, Math.min(2, request.speed || 1));
		let audio: ISherpaAudio;
		if (this.model === 'supertonic' && addon.offlineTtsGenerateWithConfig) {
			audio = addon.offlineTtsGenerateWithConfig(tts, { text, generationConfig: { sid: voice.speaker, speed, numSteps: SUPERTONIC_STEPS, extra: { lang: 'en' } }, enableExternalBuffer: false });
		} else {
			const options = { text, sid: voice.speaker, speed, enableExternalBuffer: false };
			audio = addon.offlineTtsGenerateAsync ? await addon.offlineTtsGenerateAsync(tts, options) : addon.offlineTtsGenerate(tts, options);
		}
		const expected = LOCAL_VOICE_MODELS[this.model].sampleRate;
		if (audio.sampleRate !== expected) {
			throw new Error(`The model speaks at ${audio.sampleRate} Hz, not ${expected}`);
		}
		const samples = trimTail(audio.samples, audio.sampleRate);
		return VSBuffer.wrap(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
	}
}

const runtimeDir = process.env['VOLT_LOCAL_VOICE_RUNTIME'];
const modelDir = process.env['VOLT_LOCAL_VOICE_MODEL'];
const model = process.env['VOLT_LOCAL_VOICE_MODEL_ID'];
if (!runtimeDir || !modelDir || !isLocalVoiceModel(model)) {
	throw new Error('VOLT_LOCAL_VOICE_RUNTIME, VOLT_LOCAL_VOICE_MODEL and VOLT_LOCAL_VOICE_MODEL_ID must be set');
}

const server = isUtilityProcess(process) ? new UtilityProcessServer() : new ChildProcessServer(LOCAL_VOICE_WORKER_CHANNEL);
server.registerChannel(LOCAL_VOICE_WORKER_CHANNEL, ProxyChannel.fromService(new LocalVoiceEngine(runtimeDir, model, modelDir, process.env['VOLT_LOCAL_VOICE_ACCENT'] === 'gb'), new DisposableStore()));
