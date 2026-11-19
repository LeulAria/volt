/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voiceChat.css';
import { $, addDisposableListener, append, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IVoltLocalVoiceService } from '../../../../platform/voltLocalVoice/common/voltLocalVoice.js';
import { IVoltVoiceChatService } from '../../../../platform/voltVoiceChat/common/voltVoiceChat.js';
import { agentReadAloud, localVoiceDescription } from '../../voltAgent/browser/chat/agentReadAloud.js';
import { IVoltAgentWindowService, IVoltComposerTray, IVoltComposerTrayHost } from '../../../services/voltPlugins/browser/voltAgentWindow.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { OPEN_VOICE_CALL_TRANSCRIPT_COMMAND_ID } from '../common/voltVoiceChat.js';
import { voiceIcon } from './voiceIcons.js';
import { IVoiceCallState, VoiceCallService } from './voiceCallService.js';
import { showVoiceSettingsMenu } from './voiceSettings.js';
import { VoicePreviewPlayer } from './voicePreview.js';

/** `m:ss` with unbounded minutes. */
export function formatCallClock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Bars of the line's loudness, newest on the right; a dotted line while quiet. */
class CallWaveform extends Disposable {

	readonly element: HTMLElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly levels: number[] = [];
	private frame: number | undefined;
	private live = false;

	constructor(parent: HTMLElement, service: VoiceCallService) {
		super();
		this.element = append(parent, $('span.volt-voice-waveform'));
		this.element.dataset.component = 'voice-call-waveform';
		this.canvas = append(this.element, $('canvas')) as HTMLCanvasElement;
		this._register(service.onLevel(level => {
			this.levels.push(service.state.muted && service.state.activity !== 'speaking' ? 0 : level);
			if (this.levels.length > 400) {
				this.levels.splice(0, this.levels.length - 400);
			}
			this.schedule();
		}));
		this._register({ dispose: () => this.frame !== undefined && getWindow(this.element).cancelAnimationFrame(this.frame) });
	}

	setLive(live: boolean): void {
		this.live = live;
		this.element.classList.toggle('live', live);
		this.element.setAttribute('role', live ? 'img' : 'progressbar');
		this.element.setAttribute('aria-label', live ? localize('voiceChat.line', "Voice chat audio") : localize('voiceChat.connecting', "Connecting…"));
		this.element.toggleAttribute('aria-busy', !live);
		this.schedule();
	}

	private schedule(): void {
		if (this.frame === undefined) {
			this.frame = getWindow(this.element).requestAnimationFrame(() => {
				this.frame = undefined;
				this.draw();
			});
		}
	}

	private draw(): void {
		const window = getWindow(this.element);
		const ratio = window.devicePixelRatio || 1;
		const width = this.element.clientWidth;
		const height = 20;
		if (!width) {
			return;
		}
		if (this.canvas.width !== Math.round(width * ratio)) {
			this.canvas.width = Math.round(width * ratio);
			this.canvas.height = Math.round(height * ratio);
			this.canvas.style.width = `${width}px`;
			this.canvas.style.height = `${height}px`;
		}
		const context = this.canvas.getContext('2d');
		if (!context) {
			return;
		}
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);
		context.fillStyle = window.getComputedStyle(this.element).color;
		const pitch = 5;
		const bars = Math.floor(width / pitch);
		for (let i = 0; i < bars; i++) {
			const level = this.live ? this.levels[this.levels.length - bars + i] ?? 0 : 0;
			// Fade both ends, as Cursor's line does.
			const edge = Math.min(1, Math.min(i, bars - 1 - i) / 8);
			const barHeight = Math.max(2, Math.min(height, Math.pow(level, 0.7) * height * 1.6));
			context.globalAlpha = 0.35 + 0.65 * edge;
			const x = i * pitch + 1;
			const y = (height - barHeight) / 2;
			context.beginPath();
			context.roundRect?.(x, y, 2, barHeight, 1);
			if (!context.roundRect) {
				context.rect(x, y, 2, barHeight);
			}
			context.fill();
		}
	}
}

/**
 * The call's bar above the composer (Cursor's VoiceCallTray): "Voice chat" and its clock, the
 * line's waveform, Mute, Settings, View transcript and Hang up. On another chat's composer it is
 * the return row ("Voice chat with …", Return); a call that failed to start shows why.
 */
export class VoiceCallTray extends Disposable implements IVoltComposerTray {

	readonly element: HTMLElement;
	private sessionKey: string | undefined;
	private readonly view = this._register(new DisposableStore());
	private readonly menu = this._register(new MutableDisposable());
	private readonly clockTimer = this._register(new MutableDisposable());
	private shown: string | undefined;

	constructor(
		private readonly host: IVoltComposerTrayHost,
		private readonly service: VoiceCallService,
		private readonly preview: VoicePreviewPlayer,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltAgentWindowService private readonly agentWindow: IVoltAgentWindowService,
		@IVoltVoiceChatService _voiceService: IVoltVoiceChatService,
		@INotificationService private readonly notificationService: INotificationService,
		@IVoltLocalVoiceService private readonly localVoiceService: IVoltLocalVoiceService,
	) {
		super();
		this.element = $('.volt-voice-tray-slot');
		this._register(service.onDidChange(() => this.render()));
		this.render();
	}

	setSession(sessionKey: string | undefined): void {
		this.sessionKey = sessionKey;
		this.render();
	}

	private kind(state: IVoiceCallState): 'none' | 'full' | 'return' | 'failed' {
		const mine = !!this.sessionKey && (state.originKey === this.sessionKey || state.chatId === this.sessionKey);
		if (state.phase === 'failed') {
			return mine || !this.sessionKey ? 'failed' : 'none';
		}
		if (state.phase === 'idle') {
			return 'none';
		}
		return mine ? 'full' : 'return';
	}

	private render(): void {
		const state = this.service.state;
		const kind = this.kind(state);
		const key = `${kind}:${state.callId}:${state.phase}`;
		if (key === this.shown) {
			this.update(state);
			return;
		}
		this.shown = key;
		this.view.clear();
		this.menu.clear();
		this.clockTimer.clear();
		this.element.replaceChildren();
		this.element.classList.toggle('hidden', kind === 'none');
		if (kind === 'full') {
			this.renderFull(state);
		} else if (kind === 'return') {
			this.renderReturn(state);
		} else if (kind === 'failed') {
			this.renderFailed(state);
		}
		this.update(state);
		this.host.layout();
	}

	private renderFull(state: IVoiceCallState): void {
		const root = append(this.element, $('.volt-voice-tray'));
		root.dataset.component = 'voice-call-tray';
		root.dataset.callPhase = state.phase;
		root.setAttribute('role', 'region');
		root.setAttribute('aria-label', localize('voiceChat.title', "Voice chat"));
		const header = append(root, $('.volt-voice-tray-header'));
		append(header, $('span.volt-voice-tray-title')).textContent = localize('voiceChat.title', "Voice chat");
		const clock = append(header, $('span.volt-voice-clock'));
		clock.dataset.component = 'voice-call-clock';
		const row = append(root, $('.volt-voice-tray-row'));
		row.dataset.component = 'voice-call-row';
		const line = append(row, $('.volt-voice-line'));
		line.dataset.component = 'voice-call-line';
		const waveform = this.view.add(new CallWaveform(line, this.service));
		const controls = append(row, $('span.volt-voice-controls'));
		const mute = this.roundButton(controls, 'mute');
		const settings = this.roundButton(controls, 'settings');
		const transcript = this.roundButton(controls, 'transcript');
		const hangUp = this.roundButton(controls, 'hangup');
		hangUp.classList.add('danger');
		append(settings, voiceIcon('gear'));
		append(transcript, voiceIcon('paragraph'));
		append(hangUp, voiceIcon('phone-disconnect'));
		this.label(settings, localize('voiceChat.settings', "Settings"));
		this.label(transcript, localize('voiceChat.viewTranscript', "View transcript"));
		this.label(hangUp, localize('voiceChat.hangUp', "Hang up"));
		this.view.add(addDisposableListener(mute, 'click', () => this.service.setMuted(!this.service.state.muted)));
		this.view.add(addDisposableListener(hangUp, 'click', () => this.service.hangUp('hang_up')));
		this.view.add(addDisposableListener(transcript, 'click', () => {
			const current = this.service.state;
			void this.commandService.executeCommand(OPEN_VOICE_CALL_TRANSCRIPT_COMMAND_ID, { callId: current.callId, sessionId: current.chatId ?? this.sessionKey });
		}));
		this.view.add(addDisposableListener(settings, 'click', () => this.toggleSettings(settings)));
		this.updateFull = current => {
			root.dataset.callPhase = current.phase;
			waveform.setLive(current.phase === 'live');
			mute.replaceChildren(voiceIcon(current.muted ? 'mic-slash' : 'mic'));
			mute.setAttribute('aria-pressed', String(current.muted));
			mute.classList.toggle('on', current.muted);
			this.label(mute, current.muted ? localize('voiceChat.unmute', "Unmute") : localize('voiceChat.mute', "Mute"));
			clock.hidden = current.phase !== 'live';
		};
		this.startClock(clock);
	}

	private renderReturn(state: IVoiceCallState): void {
		const root = append(this.element, $('.volt-voice-tray.return'));
		root.dataset.component = 'realtime-voice-return';
		root.setAttribute('role', 'region');
		root.setAttribute('aria-label', localize('voiceChat.title', "Voice chat"));
		const title = append(root, $('span.volt-voice-tray-title'));
		const name = (state.chatId ? this.history.get(state.chatId)?.title : undefined)?.trim() || localize('voiceChat.newAgent', "New Agent");
		append(title, $('span.text')).textContent = localize('voiceChat.with', "Voice chat with {0}", name);
		const clock = append(title, $('span.volt-voice-clock'));
		const controls = append(root, $('span.volt-voice-controls'));
		const mute = this.roundButton(controls, 'mute');
		mute.classList.add('small');
		this.view.add(addDisposableListener(mute, 'click', () => this.service.setMuted(!this.service.state.muted)));
		const back = createVoltButton(controls, 'secondary');
		back.label = localize('voiceChat.return', "Return");
		back.element.setAttribute('aria-label', localize('voiceChat.returnTo', "Return to the voice chat with {0}", name));
		this.view.add(back);
		this.view.add(back.onDidClick(() => {
			const target = this.service.state.chatId;
			if (target) {
				void this.agentWindow.openChat(target);
			}
		}));
		this.updateFull = current => {
			mute.replaceChildren(voiceIcon(current.muted ? 'mic-slash' : 'mic'));
			mute.setAttribute('aria-pressed', String(current.muted));
			this.label(mute, current.muted ? localize('voiceChat.unmute', "Unmute") : localize('voiceChat.mute', "Mute"));
			clock.hidden = current.phase !== 'live';
		};
		this.startClock(clock);
	}

	private renderFailed(state: IVoiceCallState): void {
		const root = append(this.element, $('.volt-voice-tray.failed'));
		root.dataset.component = 'voice-call-tray';
		root.dataset.callPhase = 'failed';
		root.setAttribute('role', 'alert');
		const text = append(root, $('.volt-voice-tray-text'));
		append(text, $('span.volt-voice-tray-title')).textContent = localize('voiceChat.title', "Voice chat");
		append(text, $('span.volt-voice-tray-error')).textContent = state.error ?? localize('voiceChat.failed', "The voice chat could not start.");
		const dismiss = append(root, $('button.volt-voice-round.small')) as HTMLButtonElement;
		dismiss.type = 'button';
		dismiss.appendChild(renderIcon(Codicon.close));
		this.label(dismiss, localize('voiceChat.dismiss', "Dismiss"));
		this.view.add(addDisposableListener(dismiss, 'click', () => this.service.dismissFailure()));
		this.updateFull = () => { };
	}

	private updateFull: (state: IVoiceCallState) => void = () => { };

	private update(state: IVoiceCallState): void {
		this.updateFull(state);
	}

	private startClock(clock: HTMLElement): void {
		const tick = () => {
			const since = this.service.state.connectedAt;
			clock.textContent = since ? formatCallClock(Date.now() - since) : '';
		};
		tick();
		const handle = getWindow(this.element).setInterval(tick, 1000);
		this.clockTimer.value = { dispose: () => getWindow(this.element).clearInterval(handle) };
	}

	private toggleSettings(anchor: HTMLElement): void {
		if (this.menu.value) {
			this.menu.clear();
			return;
		}
		const state = this.service.state;
		anchor.classList.add('on');
		const open = (local?: Awaited<ReturnType<VoiceCallService['localVoices']>>) => {
			this.menu.value = showVoiceSettingsMenu(this.contextViewService, {
				anchor,
				provider: state.provider ?? 'xai',
				value: local ? { ...this.service.state.settings, voice: local.current?.ref ?? '' } : this.service.state.settings,
				voices: local?.voices.map(voice => ({ id: voice.ref, label: voice.name, description: localVoiceDescription(voice) })),
				playingPreview: local ? undefined : this.preview.playing,
				onChange: next => {
					// On this computer the voice is the shared downloaded one, not the hosted call's setting.
					if (local && next.voice !== undefined) {
						void this.service.setLocalVoice(next.voice);
						return;
					}
					void this.service.setSettings(next);
				},
				onPreview: voice => {
					if (local) {
						void agentReadAloud.read(getWindow(this.element), 'voice-call-preview', localize('voiceChat.localSample', "Hi. This is how I sound on a call."), { voice, rate: this.service.state.settings.speed, localVoices: this.localVoiceService });
						return;
					}
					void this.preview.toggle(state.provider ?? 'xai', voice, this.service.state.settings.speed).catch(err => {
						this.notificationService.error(err instanceof Error ? err.message : String(err));
					});
				},
				onHide: () => {
					anchor.classList.remove('on');
					this.preview.stop();
					this.menu.clearAndLeak();
				},
			});
		};
		if (state.provider === 'local') {
			void this.service.localVoices().then(local => {
				if (anchor.isConnected && !this.menu.value) {
					open(local);
				}
			});
		} else {
			open();
		}
	}

	private roundButton(parent: HTMLElement, name: string): HTMLButtonElement {
		const button = append(parent, $(`button.volt-voice-round.${name}`)) as HTMLButtonElement;
		button.type = 'button';
		return button;
	}

	private label(button: HTMLElement, text: string): void {
		button.setAttribute('aria-label', text);
		setAgentTooltip(button, text);
	}
}
