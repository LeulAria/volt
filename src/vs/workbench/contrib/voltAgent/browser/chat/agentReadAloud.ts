/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { localize } from '../../../../../nls.js';
import { ILocalVoice, IVoltLocalVoiceService, LOCAL_VOICE_MODELS, localVoice, LocalVoiceModelId, pickLocalVoice, readyLocalVoiceModels } from '../../../../../platform/voltLocalVoice/common/voltLocalVoice.js';
import { localSpeechPieces, READ_ALOUD_SYSTEM_VOICE, speakableMarkdown, splitSpeech } from '../../common/agentReadAloud.js';

export interface IReadAloudOptions {
	/**
	 * The voice setting as it is: a downloaded voice as `<model>:<id>`, a system voice's name, or
	 * `system`. Missing: the first downloaded voice, as calls and Settings pick it (see {@link readAloudLocalVoice}).
	 */
	readonly voice?: string;
	readonly rate?: number;
	/** Speaks the downloaded voices. Without it (or when it fails before a word) the system's voices read. */
	readonly localVoices?: IVoltLocalVoiceService;
	/** Told why a downloaded voice could not read. */
	readonly onError?: (message: string) => void;
}

/** Silence between two pieces, in seconds: a sentence's breath. */
const LOCAL_GAP = 0.14;
/** How far ahead of the playhead the engine may work, in seconds. */
const LOCAL_LEAD = 20;

/** What a speech model's voices are called in Settings. */
export function localVoiceModelLabel(model: LocalVoiceModelId): string {
	return model === 'supertonic' ? localize('voltAgent.fastVoices', "Fast voices") : localize('voltAgent.expressiveVoices', "Expressive voices");
}

/** A downloaded voice's line in a picker, after its name: "Fast, female" or "Expressive, British, male". */
export function localVoiceDescription(voice: ILocalVoice): string {
	const who = voice.female ? localize('voltAgent.voiceFemale', "female") : localize('voltAgent.voiceMale', "male");
	if (voice.model === 'supertonic') {
		return localize('voltAgent.voiceFast', "Fast, {0}", who);
	}
	return voice.accent === 'gb' ? localize('voltAgent.voiceExpressiveGb', "Expressive, British, {0}", who) : localize('voltAgent.voiceExpressiveUs', "Expressive, American, {0}", who);
}

/** What a reply says, as markdown: its prose, without tool rows, reasoning or notices. */
export function readAloudSource(message: { readonly text?: string; readonly segments?: readonly { readonly kind: string; readonly text?: string }[] }): string {
	const prose = (message.segments ?? []).filter(segment => segment.kind === 'text' && segment.text).map(segment => segment.text);
	return prose.length ? prose.join('\n\n') : message.text ?? '';
}

/**
 * The downloaded voice that reads, for the voice setting: the one it names, else (when it names no
 * system voice) the first downloaded one, which is what Settings and calls on this computer use.
 * Undefined: a system voice reads.
 */
export async function readAloudLocalVoice(setting: string | undefined, service: IVoltLocalVoiceService): Promise<ILocalVoice | undefined> {
	if (setting === READ_ALOUD_SYSTEM_VOICE || (setting && !localVoice(setting))) {
		return undefined;
	}
	const ready = readyLocalVoiceModels(await service.getStates().catch(() => []));
	return pickLocalVoice(setting, ready);
}

export function canReadAloud(win: Window): boolean {
	return typeof win.speechSynthesis !== 'undefined' && typeof (win as Window & typeof globalThis).SpeechSynthesisUtterance !== 'undefined';
}

const pendingVoices = new WeakMap<Window, Promise<SpeechSynthesisVoice[]>>();

/**
 * The system's voices. Chromium loads them on the first ask and answers empty until
 * `voiceschanged` (2.3 s on a Mac with 180 voices), so the first ask waits for that.
 * Asking early (when a reply's Read Aloud button is drawn) makes the first click instant.
 */
export function readAloudVoices(win: Window): Promise<SpeechSynthesisVoice[]> {
	if (!canReadAloud(win)) {
		return Promise.resolve([]);
	}
	const synth = win.speechSynthesis;
	const now = synth.getVoices();
	if (now.length) {
		return Promise.resolve(now);
	}
	let pending = pendingVoices.get(win);
	if (!pending) {
		pending = new Promise<SpeechSynthesisVoice[]>(resolve => {
			const done = () => {
				synth.removeEventListener('voiceschanged', done);
				win.clearTimeout(timer);
				pendingVoices.delete(win);
				resolve(synth.getVoices());
			};
			const timer = win.setTimeout(done, 6000);
			synth.addEventListener('voiceschanged', done);
		});
		pendingVoices.set(win, pending);
	}
	return pending;
}

/**
 * Reads replies aloud: with the system's voices (the Web Speech API: nothing to download, works
 * offline) or with a downloaded voice, whose speech comes from the main process a piece at a time.
 * One reading at a time in the whole app; starting another stops the first.
 */
class AgentReadAloud {
	private readonly _onDidChange = new Emitter<void>();
	/** Fires when a reading starts, ends or is stopped. */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private current: { readonly key: unknown; stop(): void } | undefined;

	isReading(key: unknown): boolean {
		return this.current?.key === key;
	}

	/**
	 * Gets a downloaded voice's engine ready (when the pointer reaches a Read Aloud button), so
	 * the click that follows is not the one that waits for the model to load.
	 */
	warm(options: IReadAloudOptions): void {
		const service = options.localVoices;
		if (!service || this.current) {
			return;
		}
		void readAloudLocalVoice(options.voice, service).then(local => local ? service.warm(local.ref) : undefined).catch(() => undefined);
	}

	/** Starts reading `markdown`, or stops when `key` is what is being read. */
	toggle(win: Window, key: unknown, markdown: string, options: IReadAloudOptions): void {
		if (this.isReading(key)) {
			this.stop();
			return;
		}
		void this.read(win, key, markdown, options);
	}

	async read(win: Window, key: unknown, markdown: string, options: IReadAloudOptions): Promise<void> {
		this.stop();
		const text = speakableMarkdown(markdown);
		if (!text) {
			return;
		}
		const reading = { key, stop: () => { } };
		this.current = reading;
		this._onDidChange.fire();
		const local = options.localVoices ? await readAloudLocalVoice(options.voice, options.localVoices) : undefined;
		if (this.current !== reading) {
			return;
		}
		if (local && options.localVoices) {
			const spoke = await this.readLocal(win, reading, text, local, options.localVoices, options);
			if (spoke || this.current !== reading) {
				return;
			}
		}
		await this.readSystem(win, reading, text, options);
	}

	private finish(reading: { readonly key: unknown }): void {
		if (this.current === reading) {
			this.current = undefined;
			this._onDidChange.fire();
		}
	}

	private async readSystem(win: Window, reading: { readonly key: unknown; stop(): void }, text: string, options: IReadAloudOptions): Promise<void> {
		const chunks = splitSpeech(text);
		if (!canReadAloud(win) || !chunks.length) {
			this.finish(reading);
			return;
		}
		// Chromium drops utterances that nothing holds on to before they end, so the reading keeps them.
		const utterances: SpeechSynthesisUtterance[] = [];
		reading.stop = () => {
			for (const utterance of utterances) {
				utterance.onend = null;
				utterance.onerror = null;
			}
			win.speechSynthesis.cancel();
		};
		const voice = options.voice ? (await readAloudVoices(win)).find(candidate => candidate.name === options.voice) : undefined;
		if (this.current !== reading) {
			return;
		}
		const Utterance = (win as Window & typeof globalThis).SpeechSynthesisUtterance;
		for (const [index, chunk] of chunks.entries()) {
			const utterance = new Utterance(chunk);
			if (voice) {
				utterance.voice = voice;
				utterance.lang = voice.lang;
			}
			utterance.rate = options.rate ?? 1;
			utterance.onerror = () => this.finish(reading);
			if (index === chunks.length - 1) {
				utterance.onend = () => this.finish(reading);
			}
			utterances.push(utterance);
			win.speechSynthesis.speak(utterance);
		}
	}

	/**
	 * Plays `text` in a downloaded voice: each piece is asked for while the one before plays.
	 * False when the engine failed before anything was heard, so another voice can read instead.
	 */
	private async readLocal(win: Window, reading: { readonly key: unknown; stop(): void }, text: string, voice: ILocalVoice, service: IVoltLocalVoiceService, options: IReadAloudOptions): Promise<boolean> {
		const sampleRate = LOCAL_VOICE_MODELS[voice.model].sampleRate;
		const context = new (win as Window & typeof globalThis).AudioContext();
		const end: { timer?: number } = {};
		reading.stop = () => {
			win.clearTimeout(end.timer);
			void context.close().catch(() => undefined);
		};
		const pause = (ms: number) => new Promise<void>(resolve => win.setTimeout(resolve, ms));
		let playedUntil = 0;
		let heard = false;
		for (const chunk of localSpeechPieces(text, voice.model === 'supertonic')) {
			while (this.current === reading && playedUntil - context.currentTime > LOCAL_LEAD) {
				await pause(500);
			}
			if (this.current !== reading) {
				return true;
			}
			let bytes: Uint8Array;
			try {
				bytes = (await service.synthesize({ text: chunk, voice: voice.ref, speed: options.rate ?? 1 })).buffer;
			} catch (error) {
				if (this.current !== reading) {
					return true;
				}
				options.onError?.(error instanceof Error ? error.message : String(error));
				if (!heard) {
					reading.stop();
					return false;
				}
				break;
			}
			if (this.current !== reading) {
				return true;
			}
			// Copied: the bytes may sit at an odd offset in a larger message.
			const samples = new Float32Array(bytes.byteLength >> 2);
			new Uint8Array(samples.buffer).set(bytes.subarray(0, samples.byteLength));
			if (!samples.length) {
				continue;
			}
			const buffer = context.createBuffer(1, samples.length, sampleRate);
			buffer.copyToChannel(samples, 0);
			const source = context.createBufferSource();
			source.buffer = buffer;
			source.connect(context.destination);
			const at = Math.max(context.currentTime + 0.03, playedUntil);
			source.start(at);
			playedUntil = at + buffer.duration + LOCAL_GAP;
			heard = true;
		}
		end.timer = win.setTimeout(() => {
			if (this.current === reading) {
				reading.stop();
				this.finish(reading);
			}
		}, Math.max(0, (playedUntil - LOCAL_GAP - context.currentTime) * 1000) + 50);
		return true;
	}

	stop(): void {
		const reading = this.current;
		if (!reading) {
			return;
		}
		this.current = undefined;
		reading.stop();
		this._onDidChange.fire();
	}
}

export const agentReadAloud = new AgentReadAloud();
