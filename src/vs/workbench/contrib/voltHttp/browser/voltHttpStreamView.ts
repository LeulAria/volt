/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer } from '../../../../base/browser/ui/list/list.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { httpProtocolInfo, HttpProtocol, IHttpMessage } from '../common/httpProtocols.js';
import { createHttpArrowIcon, createHttpCopyIcon, createHttpSearchIcon } from './voltHttpIcons.js';
import { IHttpLiveEntry, IHttpLiveSession, IVoltHttpSessions } from './voltHttpSessions.js';
import { createHttpIconButton, createHttpVariableField, formatHttpBytes, formatHttpDuration, HttpVariableLookup } from './voltHttpWidgets.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';

const ROW_HEIGHT = 26;

interface IEntryTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly time: HTMLElement;
	readonly target: HTMLElement;
	readonly text: HTMLElement;
	readonly size: HTMLElement;
}

function timeOf(at: number): string {
	const date = new Date(at);
	const two = (value: number) => String(value).padStart(2, '0');
	return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

/** A message for reading: JSON on indented lines, anything else as it came. */
function readable(entry: IHttpLiveEntry): { text: string; language: string } {
	if (entry.binary) {
		return { text: entry.data, language: 'plaintext' };
	}
	const trimmed = entry.data.trim();
	if (/^[[{"]/.test(trimmed)) {
		try {
			return { text: JSON.stringify(JSON.parse(trimmed), null, 2), language: 'json' };
		} catch { /* not JSON after all */ }
	}
	return { text: entry.data, language: /^</.test(trimmed) ? 'xml' : 'plaintext' };
}

export interface IHttpStreamPaneHost {
	createEditor(host: HTMLElement, value: string, language: string, readOnly: boolean, store: DisposableStore): CodeEditorWidget;
	layoutEditors(): void;
}

/**
 * A connection's timeline, where a request's response is for the kinds that stay open: every
 * message in and out in order, the connection's own notes between them, a filter, and the selected
 * message opened underneath.
 */
export class HttpStreamPane extends Disposable {

	readonly element: HTMLElement;
	private readonly status: HTMLElement;
	private readonly counts: HTMLElement;
	private readonly listHost: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly detail: HTMLElement;
	private readonly detailStore = this._register(new DisposableStore());
	private readonly list: WorkbenchList<IHttpLiveEntry>;
	private readonly refresh = this._register(new RunOnceScheduler(() => this.update(), 60));
	private readonly clock = this._register(new RunOnceScheduler(() => this.tick(), 1000));
	private filter = '';
	private follow = true;
	private selected: IHttpLiveEntry | undefined;
	private shown: IHttpLiveEntry[] = [];
	private width = 0;

	constructor(
		parent: HTMLElement,
		private readonly key: string,
		private readonly protocol: HttpProtocol,
		private readonly host: IHttpStreamPaneHost,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoltHttpSessions private readonly sessions: IVoltHttpSessions,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super();
		this.element = append(parent, $('.volt-http-stream'));
		const bar = append(this.element, $('.volt-http-stream-bar'));
		this.status = append(bar, $('span.volt-http-pill'));
		this.counts = append(bar, $('span.volt-http-stream-counts'));
		append(bar, $('.volt-http-spacer'));
		const search = append(bar, $('.volt-http-stream-filter'));
		search.appendChild(createHttpSearchIcon(13));
		const input = append(search, $('input')) as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.placeholder = localize('voltHttp.streamFilter', "Filter messages");
		input.setAttribute('aria-label', localize('voltHttp.streamFilter', "Filter messages"));
		this._register(addDisposableListener(input, EventType.INPUT, () => {
			this.filter = input.value.trim().toLowerCase();
			this.update();
		}));
		const follow = createHttpIconButton(bar, Codicon.arrowDown, localize('voltHttp.streamFollow', "Keep the newest message in view"), button => {
			this.follow = !this.follow;
			button.classList.toggle('checked', this.follow);
			button.setAttribute('aria-pressed', String(this.follow));
			if (this.follow) {
				this.update();
			}
		});
		follow.classList.add('checked');
		follow.setAttribute('aria-pressed', 'true');
		createHttpIconButton(bar, Codicon.clearAll, localize('voltHttp.streamClear', "Clear messages"), () => {
			this.selected = undefined;
			this.sessions.clear(this.key);
		});

		this.listHost = append(this.element, $('.volt-http-stream-list'));
		this.empty = append(this.element, $('.volt-http-empty.center.volt-http-stream-empty'));
		this.detail = append(this.element, $('.volt-http-stream-detail'));

		const renderer: IListRenderer<IHttpLiveEntry, IEntryTemplate> = {
			templateId: 'entry',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-stream-row'));
				return { row, icon: append(row, $('span.volt-http-stream-icon')), time: append(row, $('span.volt-http-stream-time')), target: append(row, $('span.volt-http-stream-target')), text: append(row, $('span.volt-http-stream-text')), size: append(row, $('span.volt-http-stream-size')) };
			},
			renderElement: (entry, _index, template) => {
				template.row.className = `volt-http-stream-row ${entry.direction}`;
				clearNode(template.icon);
				template.icon.appendChild(entry.direction === 'out' ? createHttpArrowIcon('up') : entry.direction === 'in' ? createHttpArrowIcon('down') : renderIcon(entry.direction === 'error' ? Codicon.error : Codicon.circleSmallFilled));
				template.time.textContent = timeOf(entry.at);
				template.target.textContent = entry.target ?? '';
				template.target.classList.toggle('none', !entry.target);
				// One line: a long message shows whole in the pane underneath.
				template.text.textContent = entry.binary ? localize('voltHttp.streamBinary', "Binary ({0})", formatHttpBytes(Math.floor(entry.data.length * 3 / 4))) : entry.data.slice(0, 400).replace(/\s+/g, ' ');
				template.size.textContent = entry.size !== undefined && (entry.direction === 'in' || entry.direction === 'out') ? formatHttpBytes(entry.size) : '';
			},
			disposeTemplate: () => { },
		};
		this.list = this._register(instantiationService.createInstance(WorkbenchList<IHttpLiveEntry>, 'VoltHttpStream', this.listHost, { getHeight: () => ROW_HEIGHT, getTemplateId: () => 'entry' }, [renderer], {
			accessibilityProvider: {
				getAriaLabel: entry => `${entry.direction === 'out' ? 'sent' : entry.direction === 'in' ? 'received' : entry.direction} ${entry.target ?? ''} ${entry.data.slice(0, 200)}`,
				getWidgetAriaLabel: () => localize('voltHttp.streamMessages', "Messages"),
			},
			multipleSelectionSupport: false,
			identityProvider: { getId: entry => String(entry.seq) },
		}));
		this._register(this.list.onDidChangeSelection(event => {
			this.selected = event.elements[0];
			this.renderDetail();
		}));
		this._register(this.list.onDidScroll(() => {
			// Scrolling up to read stops the following; reaching the end starts it again.
			const atEnd = this.list.scrollTop + this.list.renderHeight >= this.list.scrollHeight - ROW_HEIGHT;
			if (atEnd !== this.follow && this.shown.length * ROW_HEIGHT > this.list.renderHeight) {
				this.follow = atEnd;
				follow.classList.toggle('checked', atEnd);
				follow.setAttribute('aria-pressed', String(atEnd));
			}
		}));
		this._register(this.sessions.onDidChange(changed => {
			if (changed === this.key && !this.refresh.isScheduled()) {
				this.refresh.schedule();
			}
		}));
		this.update();
	}

	private get session(): IHttpLiveSession | undefined {
		return this.sessions.sessionOf(this.key);
	}

	private tick(): void {
		this.renderStatus();
		if (this.session?.status === 'open') {
			this.clock.schedule();
		}
	}

	private renderStatus(): void {
		const session = this.session;
		this.status.className = 'volt-http-pill';
		if (!session) {
			this.status.classList.add('idle');
			this.status.textContent = localize('voltHttp.streamIdle', "Not connected");
			this.counts.textContent = '';
			return;
		}
		if (session.status === 'connecting') {
			this.status.classList.add('info');
			// allow-any-unicode-next-line
			this.status.textContent = localize('voltHttp.streamConnecting', "Connecting…");
		} else if (session.status === 'open') {
			this.status.classList.add('ok');
			this.status.textContent = localize('voltHttp.streamOpen', "Connected");
		} else {
			this.status.classList.add(session.error ? 'error' : 'idle');
			this.status.textContent = session.error ? localize('voltHttp.streamFailed', "Failed") : this.protocol === 'grpc' ? localize('voltHttp.streamDone', "Finished") : localize('voltHttp.streamClosed', "Disconnected");
		}
		const parts: string[] = [];
		if (session.openedAt) {
			parts.push(formatHttpDuration((session.closedAt ?? Date.now()) - session.openedAt));
		}
		parts.push(localize('voltHttp.streamCounts', "{0} in, {1} out", session.received, session.sent));
		if (session.dropped) {
			parts.push(localize('voltHttp.streamDropped', "{0} older lines dropped", session.dropped));
		}
		this.counts.textContent = parts.join('  ·  ');
	}

	private update(): void {
		const session = this.session;
		this.renderStatus();
		if (session?.status === 'open' && !this.clock.isScheduled()) {
			this.clock.schedule();
		}
		const entries = session?.entries ?? [];
		const filter = this.filter;
		this.shown = filter ? entries.filter(entry => entry.data.toLowerCase().includes(filter) || (entry.target ?? '').toLowerCase().includes(filter)) : [...entries];
		const top = this.list.scrollTop;
		this.list.splice(0, this.list.length, this.shown);
		const none = !this.shown.length;
		this.listHost.classList.toggle('hidden', none);
		this.empty.classList.toggle('hidden', !none);
		if (none) {
			const info = httpProtocolInfo(this.protocol);
			this.empty.textContent = filter && entries.length
				? localize('voltHttp.streamNoMatch', "No message matches the filter")
				: session?.status === 'connecting'
					// allow-any-unicode-next-line
					? localize('voltHttp.streamWaiting', "Connecting…")
					: this.protocol === 'grpc'
						? localize('voltHttp.streamHintGrpc', "Select a method and press Invoke. The call's messages show here.")
						: info.sends
							? localize('voltHttp.streamHint', "Connect, then send messages from the Message tab. Everything sent and received shows here.")
							: localize('voltHttp.streamHintListen', "Connect to follow the stream. Every event shows here as it arrives.");
		}
		if (this.selected) {
			const at = this.shown.findIndex(entry => entry.seq === this.selected!.seq);
			if (at >= 0) {
				this.list.setSelection([at]);
			} else {
				this.selected = undefined;
				this.renderDetail();
			}
		}
		if (this.follow && !this.selected) {
			this.list.scrollTop = this.list.scrollHeight;
		} else {
			this.list.scrollTop = top;
		}
	}

	private renderDetail(): void {
		this.detailStore.clear();
		clearNode(this.detail);
		const entry = this.selected;
		this.element.classList.toggle('with-detail', !!entry);
		if (entry) {
			const head = append(this.detail, $('.volt-http-stream-detail-head'));
			const title = append(head, $('span.volt-http-stream-detail-title'));
			title.textContent = [entry.direction === 'out' ? localize('voltHttp.streamSent', "Sent") : entry.direction === 'in' ? localize('voltHttp.streamReceived', "Received") : localize('voltHttp.streamNote', "Connection"), entry.target, timeOf(entry.at)].filter(Boolean).join('  ·  ');
			append(head, $('.volt-http-spacer'));
			const { text, language } = readable(entry);
			createHttpIconButton(head, () => createHttpCopyIcon(14), localize('voltHttp.streamCopy', "Copy message"), () => void this.clipboardService.writeText(text));
			createHttpIconButton(head, Codicon.close, localize('voltHttp.streamCloseDetail', "Close"), () => {
				this.selected = undefined;
				this.list.setSelection([]);
				this.renderDetail();
			});
			this.host.createEditor(append(this.detail, $('.volt-http-code.flush')), text, language, true, this.detailStore);
		}
		this.layout(this.width);
		this.host.layoutEditors();
	}

	layout(width: number): void {
		this.width = width;
		if (width && this.listHost.clientHeight) {
			this.list.layout(this.listHost.clientHeight, width);
		}
	}
}

export interface IHttpComposerState {
	target: string;
	body: string;
}

export interface IHttpComposerOptions {
	readonly protocol: HttpProtocol;
	readonly key: string;
	/** What is typed but not sent yet: kept on the tab while another one is in front. */
	readonly draft: IHttpComposerState;
	/** The request's own messages: sent in order when the connection opens. */
	readonly messages: readonly IHttpMessage[];
	readonly variables: HttpVariableLookup;
	readonly host: IHttpStreamPaneHost;
	readonly onMessagesChange: (messages: IHttpMessage[]) => void;
	/** Connects first when the tab is not connected. */
	readonly ensureConnected: () => Promise<boolean>;
}

/**
 * The Message tab of a kind that sends: where the next message is written (with its event or
 * topic), and the messages kept with the request, which go out by themselves on connect.
 */
export class HttpMessageComposer extends Disposable {

	private readonly kept: WorkbenchList<IHttpMessage>;
	private readonly keptHost: HTMLElement;
	private readonly keptLabel: HTMLElement;
	private messages: IHttpMessage[];
	private readonly editor: CodeEditorWidget;
	private width = 0;

	constructor(
		parent: HTMLElement,
		private readonly options: IHttpComposerOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoltHttpSessions private readonly sessions: IVoltHttpSessions,
	) {
		super();
		const info = httpProtocolInfo(options.protocol);
		const draft = options.draft;
		this.messages = options.messages.map(message => ({ ...message }));
		const element = append(parent, $('.volt-http-composer'));
		const store = this._store;

		const targetLabel = info.target === 'topic' ? localize('voltHttp.composerTopic', "Topic") : localize('voltHttp.composerEvent', "Event");
		let targetField: ReturnType<typeof createHttpVariableField> | undefined;
		const row = append(element, $('.volt-http-composer-row'));
		if (info.target) {
			const box = append(row, $('.volt-http-composer-target'));
			targetField = createHttpVariableField(box, {
				value: draft.target,
				placeholder: info.target === 'topic' ? localize('voltHttp.composerTopicPlaceholder', "Topic to publish to") : localize('voltHttp.composerEventPlaceholder', "Event name (message)"),
				ariaLabel: targetLabel,
				variables: options.variables,
				onChange: value => draft.target = value,
			}, store);
		} else {
			append(row, $('span.volt-http-sublabel.inline')).textContent = localize('voltHttp.composerMessage', "Message");
		}
		append(row, $('.volt-http-spacer'));
		const beautify = append(row, $('button.volt-http-link')) as HTMLButtonElement;
		beautify.type = 'button';
		beautify.textContent = localize('voltHttp.beautifyLink', "Beautify");
		const keep = append(row, $('button.volt-http-link')) as HTMLButtonElement;
		keep.type = 'button';
		keep.textContent = localize('voltHttp.composerKeep', "Send on Connect");
		setAgentTooltip(keep, localize('voltHttp.composerKeepTitle', "Keep this message with the request: it is sent each time the connection opens"));
		const send = store.add(createVoltButton(row, 'primary'));
		// One tooltip, Volt's: a title given to the button itself would show a second card beside it.
		setAgentTooltip(send.element, localize('voltHttp.composerSendTitle', "Send the message (Cmd/Ctrl+Enter)"));
		send.label = info.target === 'topic' ? localize('voltHttp.composerPublish', "Publish") : info.target === 'event' ? localize('voltHttp.composerEmit', "Emit") : localize('voltHttp.send', "Send");
		send.element.classList.add('volt-button-small', 'volt-http-composer-send');

		this.editor = options.host.createEditor(append(element, $('.volt-http-code')), draft.body, /^\s*[[{]/.test(draft.body) || !draft.body ? 'json' : 'plaintext', false, store);
		store.add(this.editor.onDidChangeModelContent(() => draft.body = this.editor.getValue()));
		const error = append(element, $('.volt-http-composer-error'));

		const current = (): IHttpMessage | undefined => {
			const body = this.editor.getValue();
			const target = targetField?.value.trim() ?? '';
			if (info.target === 'topic' && !target) {
				error.textContent = localize('voltHttp.composerNeedsTopic', "Enter the topic to publish to.");
				targetField?.input.focus();
				return undefined;
			}
			if (!body.trim() && !target) {
				this.editor.focus();
				return undefined;
			}
			error.textContent = '';
			return { ...(target ? { target } : {}), body };
		};
		const sendNow = async () => {
			const message = current();
			if (!message || !await options.ensureConnected()) {
				return;
			}
			try {
				await this.sessions.send(options.key, { data: message.body, ...(message.target ? { target: message.target } : {}) });
			} catch (err) {
				error.textContent = err instanceof Error ? err.message : String(err);
			}
		};
		store.add(send.onDidClick(() => void sendNow()));
		store.add(addDisposableListener(element, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
				event.preventDefault();
				event.stopPropagation();
				void sendNow();
			}
		}, true));
		beautify.addEventListener('click', () => {
			try {
				this.editor.setValue(JSON.stringify(JSON.parse(this.editor.getValue()), null, 2));
			} catch { /* not JSON */ }
		});
		keep.addEventListener('click', () => {
			const message = current();
			if (message) {
				this.messages.push(message);
				this.commit();
			}
		});

		this.keptLabel = append(element, $('.volt-http-sublabel'));
		this.keptLabel.textContent = localize('voltHttp.composerKept', "Sent on connect");
		this.keptHost = append(element, $('.volt-http-composer-kept'));
		const renderer: IListRenderer<IHttpMessage, { target: HTMLElement; text: HTMLElement; actions: HTMLElement }> = {
			templateId: 'kept',
			renderTemplate: container => {
				const line = append(container, $('.volt-http-stream-row.kept'));
				return { target: append(line, $('span.volt-http-stream-target')), text: append(line, $('span.volt-http-stream-text')), actions: append(line, $('span.volt-http-row-actions')) };
			},
			renderElement: (message, index, template) => {
				template.target.textContent = message.target ?? '';
				template.target.classList.toggle('none', !message.target);
				template.text.textContent = message.body.slice(0, 300).replace(/\s+/g, ' ');
				clearNode(template.actions);
				createHttpIconButton(template.actions, Codicon.close, localize('voltHttp.composerRemove', "Remove"), () => {
					this.messages.splice(index, 1);
					this.commit();
				});
			},
			disposeTemplate: () => { },
		};
		this.kept = store.add(instantiationService.createInstance(WorkbenchList<IHttpMessage>, 'VoltHttpKeptMessages', this.keptHost, { getHeight: () => ROW_HEIGHT, getTemplateId: () => 'kept' }, [renderer], {
			accessibilityProvider: { getAriaLabel: message => `${message.target ?? ''} ${message.body.slice(0, 120)}`, getWidgetAriaLabel: () => localize('voltHttp.composerKept', "Sent on connect") },
			multipleSelectionSupport: false,
		}));
		// A kept message opens in the editor to send again or change.
		store.add(this.kept.onDidOpen(event => {
			if (event.element) {
				this.editor.setValue(event.element.body);
				if (targetField) {
					targetField.value = event.element.target ?? '';
					draft.target = targetField.value;
				}
			}
		}));
		this.showKept();
	}

	private commit(): void {
		this.options.onMessagesChange(this.messages.map(message => ({ ...message })));
		this.showKept();
		this.options.host.layoutEditors();
	}

	private showKept(): void {
		const count = this.messages.length;
		this.keptLabel.classList.toggle('hidden', !count);
		this.keptHost.classList.toggle('hidden', !count);
		this.keptHost.style.height = `${Math.min(count, 4) * ROW_HEIGHT}px`;
		this.kept.splice(0, this.kept.length, this.messages);
		this.layout(this.width);
	}

	layout(width: number): void {
		this.width = width;
		if (width && this.messages.length) {
			this.kept.layout(Math.min(this.messages.length, 4) * ROW_HEIGHT, width);
		}
	}

	focus(): void {
		this.editor.focus();
	}
}
