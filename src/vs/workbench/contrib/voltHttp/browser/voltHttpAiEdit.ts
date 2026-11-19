/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { raceCancellation } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { showVoltMenu } from '../../voltAgent/browser/ui/menu/voltMenu.js';
import { applyHttpAiEdit, HTTP_AI_EDIT_SYSTEM_PROMPT, httpAiEditMentions, httpAiEditPrompt, IHttpAiEditMention, IHttpAiEditMessage, parseHttpAiEditAnswer } from '../common/httpAiEdit.js';
import { cloneHttp, httpRequestsOf, IHttpRequest } from '../common/httpCollection.js';
import { httpRequestBadge } from '../common/httpProtocols.js';
import { createHttpAiModelButton, httpAiModelRef } from './voltHttpAiModel.js';
import { IVoltHttpCollections } from './voltHttpCollections.js';
import { createHttpAgentIcon } from './voltHttpIcons.js';
import { HTTP_MENU_CLASS } from './voltHttpWidgets.js';

const TIMEOUT_MS = 120_000;

/** One turn of the conversation, kept on the tab so it survives the tab coming back to the front. */
export interface IHttpAiEditTurn extends IHttpAiEditMessage {
	/** What the model changed in that turn. */
	readonly changed?: readonly string[];
	/** The request before that turn's change, for Undo. */
	readonly before?: IHttpRequest;
	readonly error?: boolean;
	/** The change was taken back. */
	undone?: boolean;
}

export interface IHttpAiEditState {
	turns: IHttpAiEditTurn[];
	draft: string;
}

export interface IHttpAiEditHost {
	readonly root: URI | undefined;
	/** The request as it is now (with unsaved edits). */
	request(): IHttpRequest | undefined;
	/** Saves a change as the request's unsaved edits and redraws the request. */
	apply(mutate: (request: IHttpRequest) => void): void;
	/** The names of the variables in reach. */
	variables(): readonly string[];
	/** The panel's height changed. */
	relayout(): void;
	close(): void;
}

/** A request the user can mention: `Collection/Folder/Request`. */
interface IMentionable {
	readonly label: string;
	readonly request: IHttpRequest;
}

/**
 * "Edit with AI agent": a short conversation with a model about the request in front. The user
 * picks the model, may mention other requests with `@` (the model follows them as examples), and
 * the model answers and changes the request; each change can be undone, and the conversation goes on.
 */
export class HttpAiEditPanel extends Disposable {

	readonly element: HTMLElement;
	private readonly log: HTMLElement;
	private readonly input: HTMLTextAreaElement;
	private readonly status: HTMLElement;
	private readonly running = this._register(new MutableDisposable());
	private readonly menu = this._register(new MutableDisposable());
	private mentionables: readonly IMentionable[] = [];

	constructor(
		parent: HTMLElement,
		private readonly state: IHttpAiEditState,
		private readonly host: IHttpAiEditHost,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltHttpCollections private readonly collections: IVoltHttpCollections,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super();
		const root = this.element = append(parent, $('.volt-http-ai-edit'));
		this._register(toDisposable(() => root.remove()));

		const head = append(root, $('.volt-http-ai-edit-head'));
		append(head, $('span.volt-http-ai-edit-icon')).appendChild(createHttpAgentIcon(14));
		append(head, $('span.volt-http-ai-edit-title')).textContent = localize('voltHttp.aiEditTitle', "Edit with AI");
		const model = createHttpAiModelButton(head, instantiationService, this._store, localize('voltHttp.aiEditModel', "The model that edits the request"));
		append(head, $('.volt-http-spacer'));
		const clear = append(head, $('button.volt-http-icon-button')) as HTMLButtonElement;
		clear.type = 'button';
		setAgentTooltip(clear, localize('voltHttp.aiEditClear', "Start a new conversation"));
		clear.setAttribute('aria-label', localize('voltHttp.aiEditClear', "Start a new conversation"));
		clear.appendChild(renderIcon(Codicon.clearAll));
		this._register(addDisposableListener(clear, EventType.CLICK, () => {
			this.running.clear();
			this.state.turns = [];
			this.renderLog();
		}));
		const close = append(head, $('button.volt-http-icon-button')) as HTMLButtonElement;
		close.type = 'button';
		setAgentTooltip(close, localize('voltHttp.aiEditClose', "Close"));
		close.setAttribute('aria-label', localize('voltHttp.aiEditClose', "Close"));
		close.appendChild(renderIcon(Codicon.close));
		this._register(addDisposableListener(close, EventType.CLICK, () => this.host.close()));

		this.log = append(root, $('.volt-http-ai-edit-log'));
		this.log.setAttribute('role', 'log');
		this.log.setAttribute('aria-live', 'polite');

		const box = append(root, $('.volt-http-ai-edit-box'));
		const input = this.input = append(box, $('textarea.volt-http-ai-edit-input')) as HTMLTextAreaElement;
		input.rows = 2;
		input.spellcheck = false;
		input.placeholder = localize('voltHttp.aiEditPlaceholder', "Describe a change or paste cURL; @ to mention a request");
		input.setAttribute('aria-label', localize('voltHttp.aiEditInput', "What the AI should do with this request"));
		input.value = state.draft;
		const send = this._register(createVoltButton(box, 'primary'));
		send.element.classList.add('volt-button-small', 'volt-http-ai-edit-send');
		send.label = localize('voltHttp.aiEditSend', "Send");
		this.status = append(root, $('.volt-http-ai-status'));
		this.status.setAttribute('role', 'status');

		this._register(addDisposableListener(input, EventType.INPUT, () => {
			this.state.draft = input.value;
			// A fresh `@` (at the start or after a space) opens the list of requests to mention.
			const at = input.selectionStart ?? input.value.length;
			if (input.value[at - 1] === '@' && (at === 1 || /\s/.test(input.value[at - 2]))) {
				void this.showMentions(at);
			}
		}));
		this._register(addDisposableListener(input, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
				event.preventDefault();
				event.stopPropagation();
				void this.send();
			} else if (event.key === 'Escape' && this.running.value) {
				event.preventDefault();
				this.running.clear();
			}
		}));
		this._register(send.onDidClick(() => this.running.value ? this.running.clear() : void this.send()));
		this.setBusy = busy => {
			send.label = busy ? localize('voltHttp.aiEditStop', "Stop") : localize('voltHttp.aiEditSend', "Send");
			root.classList.toggle('busy', busy);
			model.disabled = busy;
		};
		this.renderLog();
		void this.loadMentionables();
	}

	private setBusy: (busy: boolean) => void;

	focus(): void {
		this.input.focus();
	}

	private async loadMentionables(): Promise<void> {
		const own = this.host.request();
		const out: IMentionable[] = [];
		for (const entry of await this.collections.collections(this.host.root)) {
			if (entry.error) {
				continue;
			}
			const name = entry.collection.format === 'postman' ? entry.collection.name : basename(entry.uri);
			for (const { request, ancestors } of httpRequestsOf(entry.collection.items)) {
				if (request.id !== own?.id) {
					out.push({ label: [name, ...ancestors.map(folder => folder.name), request.name].join('/'), request });
				}
			}
		}
		this.mentionables = out;
	}

	private async showMentions(at: number): Promise<void> {
		if (!this.mentionables.length) {
			await this.loadMentionables();
		}
		if (!this.mentionables.length || this._store.isDisposed) {
			return;
		}
		this.menu.value = showVoltMenu<string>(this.contextViewService, {
			anchor: this.input,
			className: HTTP_MENU_CLASS,
			align: 'left',
			width: 360,
			ariaLabel: localize('voltHttp.aiEditMention', "Mention a request"),
			search: { placeholder: localize('voltHttp.aiEditMentionSearch', "Search requests") },
			sections: [{ id: 'requests', items: this.mentionables.map(item => ({ id: item.label, label: item.request.name || item.label, subtitle: item.label, badge: httpRequestBadge(item.request), data: item.label })) }],
			onPick: item => {
				// The `@` typed stays; the label goes after it.
				const value = this.input.value;
				this.input.value = `${value.slice(0, at)}${item.data} ${value.slice(at)}`;
				this.state.draft = this.input.value;
				const caret = at + item.data.length + 1;
				this.input.focus();
				this.input.setSelectionRange(caret, caret);
			},
		});
	}

	private renderLog(): void {
		clearNode(this.log);
		this.log.classList.toggle('empty', !this.state.turns.length);
		if (!this.state.turns.length) {
			append(this.log, $('.volt-http-ai-edit-hint')).textContent = localize('voltHttp.aiEditHint', "For example: \"POST to /users with a JSON body of name and email, bearer {{token}}\", or \"add a test that the id is a number\".");
		}
		for (const turn of this.state.turns) {
			const row = append(this.log, $(`.volt-http-ai-edit-turn.${turn.role}`));
			row.classList.toggle('error', !!turn.error);
			append(row, $('.volt-http-ai-edit-text')).textContent = turn.text;
			if (turn.changed?.length) {
				const meta = append(row, $('.volt-http-ai-edit-meta'));
				append(meta, $('span')).textContent = turn.undone
					? localize('voltHttp.aiEditUndone', "Undone")
					: localize('voltHttp.aiEditChanged', "Changed {0}", turn.changed.join(', '));
				if (turn.before && !turn.undone) {
					const undo = append(meta, $('button.volt-http-link')) as HTMLButtonElement;
					undo.type = 'button';
					undo.textContent = localize('voltHttp.aiEditUndo', "Undo");
					undo.addEventListener('click', () => {
						const before = turn.before!;
						this.host.apply(request => Object.assign(request, cloneHttp(before)));
						turn.undone = true;
						this.renderLog();
					});
				}
			}
		}
		this.log.scrollTop = this.log.scrollHeight;
		this.host.relayout();
	}

	private async send(): Promise<void> {
		const text = this.input.value.trim();
		const request = this.host.request();
		if (!text || !request || this.running.value) {
			return;
		}
		const ref = httpAiModelRef(this.instantiationService);
		if (!ref) {
			this.status.classList.add('error');
			this.status.textContent = localize('voltHttp.aiEditNoModel', "No model is set up. Add one in Settings, Providers & Models.");
			return;
		}
		const mentions: IHttpAiEditMention[] = httpAiEditMentions(text, this.mentionables.map(item => item.label))
			.map(label => this.mentionables.find(item => item.label === label)!)
			.map(item => ({ label: item.label, request: item.request }));
		const prompt = httpAiEditPrompt(request, this.state.turns.filter(turn => !turn.error), text, mentions, this.host.variables());
		this.state.turns.push({ role: 'user', text });
		this.input.value = '';
		this.state.draft = '';
		this.renderLog();

		const cancel = new CancellationTokenSource();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			cancel.cancel();
		}, TIMEOUT_MS);
		const started = Date.now();
		const targetWindow = getWindow(this.element);
		const tick = () => {
			const seconds = Math.floor((Date.now() - started) / 1000);
			// allow-any-unicode-next-line
			this.status.textContent = seconds < 2 ? localize('voltHttp.aiEditThinking', "Working…") : localize('voltHttp.aiEditThinkingFor', "Working… {0}s", seconds);
		};
		const ticker = targetWindow.setInterval(tick, 1000);
		this.running.value = toDisposable(() => {
			targetWindow.clearInterval(ticker);
			clearTimeout(timer);
			cancel.dispose(true);
			this.setBusy(false);
		});
		this.status.classList.remove('error');
		this.setBusy(true);
		tick();
		const { answer, failure } = await this.ask(ref, prompt, cancel.token);
		const cancelled = cancel.token.isCancellationRequested;
		this.running.clear();
		if (this._store.isDisposed) {
			return;
		}
		this.status.textContent = '';
		if (cancelled || failure || !answer.trim()) {
			const message = failure ?? (timedOut
				? localize('voltHttp.aiEditTimedOut', "The model took too long. Try again, or pick a faster model.")
				: cancelled ? localize('voltHttp.aiEditStopped', "Stopped.") : localize('voltHttp.aiEditEmpty', "The model did not answer. Try again, or pick another model."));
			this.state.turns.push({ role: 'assistant', text: message, error: true });
			this.renderLog();
			return;
		}
		const parsed = parseHttpAiEditAnswer(answer);
		let changed: string[] = [];
		const current = this.host.request();
		const before = current ? cloneHttp(current) : undefined;
		if (parsed.request && current) {
			this.host.apply(next => changed = applyHttpAiEdit(next, parsed.request!));
		}
		const reply = parsed.reply || (changed.length ? localize('voltHttp.aiEditDone', "Done.") : localize('voltHttp.aiEditNoChange', "Nothing to change."));
		this.state.turns.push({ role: 'assistant', text: reply, ...(changed.length ? { changed, ...(before ? { before } : {}) } : {}) });
		this.renderLog();
		this.input.focus();
	}

	/** The model's whole answer: an agent answers in one tool-less call, a chat model streams. Never throws. */
	private async ask(ref: string, prompt: string, token: CancellationToken): Promise<{ readonly answer: string; readonly failure?: string }> {
		try {
			if (this.runtime.resolveCatalogItem(ref)?.kind === 'agent') {
				const text = await raceCancellation(this.runtime.generateText(prompt, { ref, systemPrompt: HTTP_AI_EDIT_SYSTEM_PROMPT, timeoutMs: TIMEOUT_MS - 5000 }), token);
				if (text === undefined && !token.isCancellationRequested) {
					return { answer: '', failure: localize('voltHttp.aiEditAgentFailed', "{0} did not answer. Check that it is signed in, or pick another model.", this.runtime.resolveCatalogItem(ref)?.label ?? ref) };
				}
				return { answer: text ?? '' };
			}
			let answer = '';
			for await (const event of this.runtime.streamModel(ref, [{ role: 'system', content: HTTP_AI_EDIT_SYSTEM_PROMPT }, { role: 'user', content: prompt }], this.runtime.getModelOptions(ref), token, 'code')) {
				if (token.isCancellationRequested) {
					break;
				}
				if (event.type === 'text.delta' && event.delta) {
					answer += event.delta;
				} else if (event.type === 'error') {
					return { answer, failure: event.message };
				}
			}
			return { answer };
		} catch (err) {
			return { answer: '', failure: err instanceof Error ? err.message : String(err) };
		}
	}
}
