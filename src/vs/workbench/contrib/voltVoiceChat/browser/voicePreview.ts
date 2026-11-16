/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IVoltVoiceChatService, VoltVoiceProvider } from '../../../../platform/voltVoiceChat/common/voltVoiceChat.js';

/** Plays "This is a voice preview." in a voice (Cursor's play button per voice); one at a time. */
export class VoicePreviewPlayer extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private audio: HTMLAudioElement | undefined;
	private _playing: string | undefined;
	private generation = 0;

	constructor(@IVoltVoiceChatService private readonly voiceService: IVoltVoiceChatService) {
		super();
		this._register({ dispose: () => this.stop() });
	}

	/** The voice whose sample is loading or playing. */
	get playing(): string | undefined {
		return this._playing;
	}

	async toggle(provider: VoltVoiceProvider, voice: string, speed: number): Promise<void> {
		if (this._playing === voice) {
			this.stop();
			return;
		}
		this.stop();
		const generation = ++this.generation;
		this._playing = voice;
		this._onDidChange.fire();
		try {
			const clip = await this.voiceService.previewVoice(provider, voice, speed);
			if (generation !== this.generation) {
				return;
			}
			const audio = this.audio = new mainWindow.Audio(`data:${clip.mime};base64,${clip.base64}`);
			audio.onended = () => {
				if (this.audio === audio) {
					this.stop();
				}
			};
			await audio.play();
		} catch (err) {
			if (generation === this.generation) {
				this.stop();
			}
			throw err;
		}
	}

	stop(): void {
		this.generation++;
		this.audio?.pause();
		this.audio = undefined;
		if (this._playing !== undefined) {
			this._playing = undefined;
			this._onDidChange.fire();
		}
	}
}
