/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { AgentVoiceDictation } from './agentVoiceDictation.js';

const METER_BARS = 5;

/** The strip above the composer while dictating: a level meter, the live transcript, and finish or cancel. */
export class AgentVoiceStrip extends Disposable {

	readonly element: HTMLElement;

	private readonly meterEl: HTMLElement;
	private readonly labelEl: HTMLElement;
	private readonly finishButton: HTMLButtonElement;
	private readonly cancelButton: HTMLButtonElement;
	private dismissed: string | undefined;

	constructor(private readonly dictation: AgentVoiceDictation) {
		super();
		this.element = $('.volt-agent-voice-strip.hidden');
		this.meterEl = append(this.element, $('.volt-agent-voice-meter'));
		for (let i = 0; i < METER_BARS; i++) {
			append(this.meterEl, $('span.volt-agent-voice-bar'));
		}
		this.labelEl = append(this.element, $('.volt-agent-voice-label'));
		this.finishButton = append(this.element, $('button.volt-agent-voice-btn.finish')) as HTMLButtonElement;
		this.finishButton.type = 'button';
		this.finishButton.appendChild(renderIcon(Codicon.check));
		setAgentTooltip(this.finishButton, localize('voltAgent.dictation.finish', "Finish and insert the text"));
		this.cancelButton = append(this.element, $('button.volt-agent-voice-btn.cancel')) as HTMLButtonElement;
		this.cancelButton.type = 'button';
		this.cancelButton.appendChild(renderIcon(Codicon.close));
		setAgentTooltip(this.cancelButton, localize('voltAgent.dictation.cancel', "Cancel dictation (Esc)"));

		this._register(this.dictation.onDidChange(() => this.render()));
		this.finishButton.addEventListener('click', () => this.dictation.toggle());
		this.cancelButton.addEventListener('click', () => {
			if (this.dictation.active) {
				this.dictation.cancel();
			} else {
				this.dismissed = this.dictation.message;
				this.render();
			}
		});
		this.render();
	}

	private render(): void {
		const active = this.dictation.active;
		const message = this.dictation.message;
		const idleMessage = !active && message && message !== this.dismissed ? message : undefined;
		this.element.classList.toggle('hidden', !active && !idleMessage);
		this.element.classList.toggle('error', !!idleMessage);
		if (!active) {
			this.labelEl.textContent = idleMessage ?? '';
			return;
		}
		this.dismissed = undefined;
		this.element.classList.toggle('transcribing', this.dictation.state === 'transcribing');
		this.element.style.setProperty('--volt-voice-level', String(Math.min(1, this.dictation.level * 4)));
		this.finishButton.hidden = this.dictation.state !== 'listening';
		this.labelEl.textContent = this.labelFor(this.dictation.state, this.dictation.partial);
	}

	private labelFor(state: string, partial: string): string {
		if (state === 'starting') {
			return localize('voltAgent.dictation.starting', "Starting the microphone...");
		}
		if (state === 'transcribing') {
			return localize('voltAgent.dictation.transcribing', "Transcribing...");
		}
		return partial || localize('voltAgent.dictation.listening', "Listening...");
	}
}
