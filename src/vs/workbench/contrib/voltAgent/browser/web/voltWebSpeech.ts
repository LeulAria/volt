/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dictation in a browser tab: the browser's own speech recognition (the Web Speech API) stands in
// for the desktop's speech helper behind the same service, so the composer's mic, its waveform and
// the transcript cleanup work unchanged. The composer still opens the microphone for the waveform;
// the audio it pushes is not needed here, since the browser listens for itself.

import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IVoltSpeechEvent, IVoltSpeechService, IVoltSpeechStartOptions, VoltSpeechEngine } from '../../../../../platform/voltSpeech/common/voltSpeech.js';

/** The parts of the Web Speech API's recognizer this uses (not in TypeScript's DOM library). */
interface ISpeechRecognition {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	onstart: (() => void) | null;
	onresult: ((event: { readonly resultIndex: number; readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }> & { readonly isFinal: boolean }> }) => void) | null;
	onerror: ((event: { readonly error: string; readonly message?: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}

type SpeechRecognitionConstructor = new () => ISpeechRecognition;

function recognitionConstructor(): SpeechRecognitionConstructor | undefined {
	const win = mainWindow as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor; isSecureContext?: boolean };
	// Browsers only listen on secure pages (https, or this computer's own address).
	return win.isSecureContext === false ? undefined : win.SpeechRecognition ?? win.webkitSpeechRecognition;
}

/** A browser that ends listening this soon after a restart, this many times in a row, is not going to listen. */
const QUICK_END_MS = 1_500;
const MAX_QUICK_ENDS = 3;

interface IRecognitionSession {
	readonly recognition: ISpeechRecognition;
	/** Text from earlier rounds: the browser ends a round after a pause and a new one goes on listening. */
	committed: string;
	/** Text the browser has settled on in this round, result by result. */
	readonly finals: string[];
	interim: string;
	stopping: boolean;
	ended: boolean;
	roundStartedAt: number;
	quickEnds: number;
}

export class WebSpeechService extends Disposable implements IVoltSpeechService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidEvent = this._register(new Emitter<IVoltSpeechEvent>());
	readonly onDidEvent = this._onDidEvent.event;

	private readonly sessions = new Map<string, IRecognitionSession>();

	isAvailable(): boolean {
		return !!recognitionConstructor();
	}

	start(options: IVoltSpeechStartOptions): Promise<VoltSpeechEngine> {
		const Recognition = recognitionConstructor();
		if (!Recognition) {
			return Promise.reject(new Error(localize('voltWeb.speech.unavailable', "This browser can't take dictation here. Use Chrome, Edge or Safari over https or on the computer Volt runs on.")));
		}
		const recognition = new Recognition();
		recognition.lang = options.locale;
		recognition.continuous = true;
		recognition.interimResults = true;
		const session: IRecognitionSession = { recognition, committed: '', finals: [], interim: '', stopping: false, ended: false, roundStartedAt: Date.now(), quickEnds: 0 };
		this.sessions.set(options.sessionId, session);
		const text = () => [session.committed, ...session.finals, session.interim].join(' ').replace(/\s+/g, ' ').trim();
		recognition.onresult = event => {
			session.interim = '';
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i];
				const transcript = result[0]?.transcript ?? '';
				if (result.isFinal) {
					session.finals[i] = transcript;
				} else {
					session.interim += transcript;
				}
			}
			this._onDidEvent.fire({ sessionId: options.sessionId, type: 'partial', text: text() });
		};
		return new Promise<VoltSpeechEngine>((resolve, reject) => {
			let started = false;
			recognition.onstart = () => {
				started = true;
				resolve('browser');
			};
			recognition.onerror = event => {
				// Silence and our own abort end the session through onend.
				if (event.error === 'no-speech' || event.error === 'aborted') {
					return;
				}
				const message = event.error === 'not-allowed' || event.error === 'service-not-allowed'
					? localize('voltWeb.speech.denied', "The browser did not allow the microphone. Allow it in the site settings and try again.")
					: event.message || localize('voltWeb.speech.failed', "Dictation stopped: {0}", event.error);
				this.sessions.delete(options.sessionId);
				if (started) {
					this._onDidEvent.fire({ sessionId: options.sessionId, type: 'error', message });
				} else {
					reject(new Error(message));
				}
			};
			recognition.onend = () => {
				session.ended = true;
				if (this.sessions.get(options.sessionId) !== session) {
					return;
				}
				// The browser stops listening by itself after a pause: a new round goes on, keeping the
				// text so far. Pauses end nothing; only the user stops a dictation.
				if (!session.stopping && started) {
					session.quickEnds = Date.now() - session.roundStartedAt < QUICK_END_MS ? session.quickEnds + 1 : 0;
					if (session.quickEnds < MAX_QUICK_ENDS) {
						session.committed = text();
						session.finals.length = 0;
						session.interim = '';
						session.ended = false;
						session.roundStartedAt = Date.now();
						try {
							recognition.start();
							return;
						} catch {
							session.ended = true;
						}
					}
				}
				// Asked to stop, or the browser will not listen again: either way the transcript is in.
				this.sessions.delete(options.sessionId);
				this._onDidEvent.fire({ sessionId: options.sessionId, type: 'final', text: text() });
			};
			try {
				recognition.start();
			} catch (err) {
				this.sessions.delete(options.sessionId);
				reject(err);
			}
		});
	}

	pushAudio(_sessionId: string, _pcmBase64: string): Promise<void> {
		return Promise.resolve();
	}

	stop(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (session && !session.stopping) {
			session.stopping = true;
			session.recognition.stop();
		}
		return Promise.resolve();
	}

	cancel(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		this.sessions.delete(sessionId);
		if (session && !session.ended) {
			session.recognition.abort();
		}
		return Promise.resolve();
	}

	override dispose(): void {
		for (const session of this.sessions.values()) {
			session.recognition.abort();
		}
		this.sessions.clear();
		super.dispose();
	}
}
