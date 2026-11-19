/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voiceChat.css';
import { $, addDisposableListener, append, getWindow } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IVoltThreadCard, IVoltThreadCardProvider } from '../../../services/voltPlugins/browser/voltAgentWindow.js';
import { OPEN_VOICE_CALL_TRANSCRIPT_COMMAND_ID } from '../common/voltVoiceChat.js';
import { voiceIcon } from './voiceIcons.js';
import { VoiceCallService } from './voiceCallService.js';
import { callStatusText } from './voiceCallTranscript.js';

/**
 * Each call's card in the chats it reached (Cursor's VoiceCallCard): "Voice call", Connecting /
 * Ongoing · m:ss / Ended · m:ss, and View transcript. It sits after the message that was last when
 * the call reached the chat, so later turns land below it.
 */
export class VoiceCallCards extends Disposable implements IVoltThreadCardProvider {

	private readonly _onDidChange = this._register(new Emitter<string | undefined>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly service: VoiceCallService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this._register(service.onDidChangeCalls(chatId => this._onDidChange.fire(chatId)));
	}

	cards(sessionKey: string): readonly IVoltThreadCard[] {
		return this.service.callsFor(sessionKey).map(call => ({
			id: `voice-${call.id}`,
			afterMessageId: call.anchors?.[sessionKey]?.turnId,
			render: container => this.renderCard(container, call.id, sessionKey),
		}));
	}

	private renderCard(container: HTMLElement, callId: string, sessionKey: string): IDisposable {
		const store = new DisposableStore();
		const card = append(container, $('.volt-voice-card'));
		card.dataset.component = 'voice-call-card';
		card.setAttribute('role', 'button');
		card.tabIndex = 0;
		const text = append(card, $('.volt-voice-card-text'));
		const title = append(text, $('.volt-voice-card-title'));
		title.append(voiceIcon('waveform', 14));
		append(title, $('span')).textContent = localize('voiceChat.cardTitle', "Voice call");
		const status = append(text, $('.volt-voice-card-status'));
		const view = append(card, $('button.volt-voice-card-view')) as HTMLButtonElement;
		view.type = 'button';
		view.textContent = localize('voiceChat.viewTranscript', "View transcript");
		const open = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			void this.commandService.executeCommand(OPEN_VOICE_CALL_TRANSCRIPT_COMMAND_ID, { callId, sessionId: sessionKey });
		};
		store.add(addDisposableListener(card, 'click', open));
		store.add(addDisposableListener(view, 'click', open));
		store.add(addDisposableListener(card, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				open(e);
			}
		}));
		const update = () => {
			const call = this.service.callsFor(sessionKey).find(candidate => candidate.id === callId);
			if (!call) {
				return;
			}
			const state = this.service.cardStatus(call);
			card.dataset.callPhase = state.status;
			status.textContent = callStatusText(state);
		};
		update();
		const handle = getWindow(container).setInterval(update, 1000);
		store.add({ dispose: () => getWindow(container).clearInterval(handle) });
		store.add(this.service.onDidChange(update));
		return store;
	}
}
