/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voiceChat.css';
import { $, addDisposableListener, append, Dimension, getWindow } from '../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IVoltVoiceCall, IVoltVoiceTurn } from '../../../../platform/voltVoiceChat/common/voltVoiceChat.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { showVoltMenu } from '../../voltAgent/browser/ui/menu/voltMenu.js';
import { VOICE_CALL_TRANSCRIPT_EDITOR_ID, VOICE_CALL_TRANSCRIPT_INPUT_ID } from '../common/voltVoiceChat.js';
import { formatCallClock } from './voiceCallTray.js';
import { activeVoiceCallService, VoiceCallService } from './voiceCallService.js';

const SCHEME = 'volt-voice-call';

/** "Voice call · 10:30 PM" today, "Voice call · Nov 15, 10:30 PM" before, with the year when it differs. */
export function callTabLabel(startedAt: number | undefined, now = Date.now()): string {
	if (!startedAt) {
		return localize('voiceChat.tabUnknown', "Voice call");
	}
	const date = new Date(startedAt);
	const today = new Date(now);
	const sameDay = date.toDateString() === today.toDateString();
	const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
	return localize('voiceChat.tab', "Voice call · {0}", sameDay ? time : `${day}, ${time}`);
}

export class VoiceCallTranscriptInput extends EditorInput {

	static readonly TypeID = VOICE_CALL_TRANSCRIPT_INPUT_ID;

	readonly resource: URI;
	private startedAt: number | undefined;
	private readonly _onDidChangeLabelEmitter = this._register(new Emitter<void>());

	constructor(readonly callId: string, readonly sessionId: string | undefined) {
		super();
		this.resource = URI.from({ scheme: SCHEME, path: `/${callId}` });
		this._register(this._onDidChangeLabelEmitter.event(() => this._onDidChangeLabel.fire()));
		const service = activeVoiceCallService();
		if (service) {
			void service.getCall(callId).then(call => this.setStartedAt(call?.startedAt));
		}
	}

	setStartedAt(startedAt: number | undefined): void {
		if (startedAt !== this.startedAt) {
			this.startedAt = startedAt;
			this._onDidChangeLabelEmitter.fire();
		}
	}

	override get typeId(): string { return VoiceCallTranscriptInput.TypeID; }
	override get editorId(): string { return VOICE_CALL_TRANSCRIPT_EDITOR_ID; }

	override getName(): string {
		return callTabLabel(this.startedAt);
	}

	override getIcon(): ThemeIcon {
		return Codicon.mic;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof VoiceCallTranscriptInput && other.callId === this.callId);
	}
}

export class VoiceCallTranscriptSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof VoiceCallTranscriptInput;
	}
	serialize(input: EditorInput): string {
		return input instanceof VoiceCallTranscriptInput ? JSON.stringify({ callId: input.callId, sessionId: input.sessionId }) : '';
	}
	deserialize(_instantiationService: IInstantiationService, raw: string): EditorInput | undefined {
		try {
			const value = JSON.parse(raw) as { callId?: unknown; sessionId?: unknown };
			return typeof value.callId === 'string' ? new VoiceCallTranscriptInput(value.callId, typeof value.sessionId === 'string' ? value.sessionId : undefined) : undefined;
		} catch {
			return undefined;
		}
	}
}

/**
 * A call's transcript (Cursor's "Voice call" tab): "Voice call", when it started and how it went
 * (Ongoing · m:ss, Ended · m:ss), Copy Transcript ID, and the turns as chat bubbles: what the user
 * said on the right-hand bubble style, what the voice said as plain text. Live calls update as
 * they are transcribed.
 */
export class VoiceCallTranscriptEditor extends EditorPane {

	static readonly ID = VOICE_CALL_TRANSCRIPT_EDITOR_ID;

	private root!: HTMLElement;
	private timing!: HTMLElement;
	private turnsEl!: HTMLElement;
	private scrollable!: DomScrollableElement;
	private readonly inputStore = this._register(new DisposableStore());
	private readonly clock = this._register(new MutableDisposable());
	private call: IVoltVoiceCall | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super(VoiceCallTranscriptEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.volt-voice-transcript'));
		this.root.dataset.component = 'voice-call-transcript-panel';
		const header = append(this.root, $('.volt-voice-transcript-header'));
		const titles = append(header, $('.volt-voice-transcript-titles'));
		append(titles, $('h2')).textContent = localize('voiceChat.transcriptTitle', "Voice call");
		this.timing = append(titles, $('.volt-voice-transcript-timing'));
		this.timing.dataset.component = 'voice-call-transcript-timing';
		const more = append(header, $('button.volt-voice-round.small.ghost')) as HTMLButtonElement;
		more.type = 'button';
		more.append($('span.codicon.codicon-ellipsis'));
		more.setAttribute('aria-label', localize('voiceChat.transcriptActions', "Transcript actions"));
		setAgentTooltip(more, localize('voiceChat.transcriptActions', "Transcript actions"));
		this._register(addDisposableListener(more, 'click', () => {
			const menu = showVoltMenu<string>(this.contextViewService, {
				anchor: more,
				align: 'right',
				ariaLabel: localize('voiceChat.transcriptActions', "Transcript actions"),
				sections: [{ id: 'actions', items: [{ id: 'copy', label: localize('voiceChat.copyId', "Copy Transcript ID"), icon: Codicon.symbolNumeric, data: 'copy' }] }],
				onPick: () => {
					if (this.call) {
						void this.clipboardService.writeText(this.call.id);
					}
				},
			});
			this.inputStore.add(menu);
		}));
		this.turnsEl = $('.volt-voice-transcript-turns');
		this.turnsEl.dataset.component = 'voice-call-turns';
		this.turnsEl.setAttribute('role', 'log');
		this.turnsEl.setAttribute('aria-label', localize('voiceChat.transcriptAria', "Voice chat transcript"));
		this.scrollable = this._register(new DomScrollableElement(this.turnsEl, { vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Hidden, useShadows: false }));
		append(this.root, this.scrollable.getDomNode()).classList.add('volt-voice-transcript-scroll');
	}

	override async setInput(input: VoiceCallTranscriptInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputStore.clear();
		const service = activeVoiceCallService();
		if (!service) {
			this.renderUnavailable();
			return;
		}
		const load = async () => {
			const call = await service.getCall(input.callId);
			if (token.isCancellationRequested || this.input !== input) {
				return;
			}
			this.call = call;
			input.setStartedAt(call?.startedAt);
			this.render(service, call);
		};
		this.inputStore.add(service.onDidChangeCalls(() => void load()));
		this.inputStore.add(service.onDidChange(() => {
			if (service.state.callId === input.callId) {
				void load();
			}
		}));
		await load();
	}

	override clearInput(): void {
		this.inputStore.clear();
		this.clock.clear();
		super.clearInput();
	}

	private renderUnavailable(): void {
		this.timing.textContent = '';
		const empty = $('.volt-voice-transcript-empty.unavailable');
		append(empty, $('strong')).textContent = localize('voiceChat.unavailable', "Transcript unavailable");
		append(empty, $('span')).textContent = localize('voiceChat.unavailableBody', "This call's transcript is no longer available.");
		this.turnsEl.replaceChildren(empty);
		this.scrollable.scanDomNode();
	}

	private render(service: VoiceCallService, call: IVoltVoiceCall | undefined): void {
		if (!call) {
			this.renderUnavailable();
			return;
		}
		this.root.dataset.callPhase = service.cardStatus(call).status;
		const started = new Date(call.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\u202f/g, ' ');
		const tick = () => {
			const status = service.cardStatus(call);
			this.timing.textContent = `${started} · ${callStatusText(status)}`;
		};
		tick();
		const handle = getWindow(this.root).setInterval(tick, 1000);
		this.clock.value = { dispose: () => getWindow(this.root).clearInterval(handle) };
		const stick = this.scrollable.getScrollPosition().scrollTop + this.scrollable.getScrollDimensions().height >= this.scrollable.getScrollDimensions().scrollHeight - 24;
		const turns = call.turns.filter(turn => turn.role !== 'note' || turn.text);
		const live = service.cardStatus(call).status !== 'ended';
		if (!turns.length) {
			const empty = $('.volt-voice-transcript-empty');
			empty.textContent = live ? localize('voiceChat.noSpeech', "No speech transcribed yet") : localize('voiceChat.nothingSaid', "Nothing was said on this call.");
			this.turnsEl.replaceChildren(empty);
		} else {
			this.turnsEl.replaceChildren(...turns.map(turn => renderTurn(turn)));
		}
		this.scrollable.scanDomNode();
		if (stick) {
			this.scrollable.setScrollPosition({ scrollTop: this.scrollable.getScrollDimensions().scrollHeight });
		}
	}

	override layout(dimension: Dimension): void {
		this.root.style.height = `${dimension.height}px`;
		this.root.style.width = `${dimension.width}px`;
		this.scrollable.scanDomNode();
	}
}

function renderTurn(turn: IVoltVoiceTurn): HTMLElement {
	const row = $(`.volt-voice-turn.${turn.role}`);
	row.dataset.speaker = turn.role;
	if (turn.role === 'user') {
		append(row, $('.volt-voice-bubble')).textContent = turn.text;
	} else if (turn.role === 'note') {
		row.textContent = turn.text;
	} else {
		for (const paragraph of turn.text.split(/\n{2,}/)) {
			append(row, $('p')).textContent = paragraph;
		}
	}
	return row;
}

export function callStatusText(status: { readonly status: 'connecting' | 'live' | 'ended'; readonly since?: number; readonly duration?: number }): string {
	switch (status.status) {
		case 'connecting': return localize('voiceChat.connectingCard', "Connecting");
		case 'live': return localize('voiceChat.ongoing', "Ongoing · {0}", formatCallClock(status.since ? Date.now() - status.since : 0));
		case 'ended': return status.duration !== undefined ? localize('voiceChat.endedFor', "Ended · {0}", formatCallClock(status.duration)) : localize('voiceChat.ended', "Ended");
	}
}
