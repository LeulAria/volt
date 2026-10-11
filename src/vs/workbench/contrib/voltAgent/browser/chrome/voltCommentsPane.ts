/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/voltCommentsPane.css';
import { $, addDisposableListener, append, isHTMLElement } from '../../../../../base/browser/dom.js';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { Checkbox } from '../../../../../base/browser/ui/toggle/toggle.js';
import { Action } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { defaultCheckboxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { setAgentTooltip } from './agentTooltip.js';
import { createVoltButton } from './voltButton.js';

export type VoltCommentStatus = 'open' | 'sent' | 'resolved';

/** One comment as the list shows it: a design canvas pin or a browser comment. */
export interface IVoltCommentItem {
	readonly id: string;
	readonly number: number;
	/** What it points at ("Dashboard > Region 241x149", "div, button.primary"). */
	readonly where: string;
	readonly text: string;
	/** The agent's answer, under the text. */
	readonly reply?: string;
	readonly status: VoltCommentStatus;
	readonly author?: 'user' | 'agent';
	/** Ticked to go with the next send, when the host keeps that state; else the pane does. */
	readonly picked?: boolean;
}

export interface IVoltCommentsPaneOptions {
	/** The workbench list id (keyboard and focus contexts). */
	readonly listId: string;
	/** The head's title; "Comments" when unset. */
	readonly title?: string;
	/** The head folds the list away (the canvas sidebar gives its agent the room). */
	readonly collapsible?: boolean;
	onOpen(id: string): void;
	onSend(ids: readonly string[]): void;
	onSetStatus(id: string, status: 'open' | 'resolved'): void;
	onDelete(id: string): void;
	onArchiveResolved(): void;
	onShowResolved?(show: boolean): void;
	/** The host keeps which comments are ticked (items carry `picked`). */
	onPick?(id: string, picked: boolean): void;
	/** A close button in the head (the browser's comments panel). */
	onClose?(): void;
}

/** Open comments of the user's can go with the next send; a checkbox picks which. */
export function isSendableComment(item: IVoltCommentItem): boolean {
	return item.status === 'open' && item.author !== 'agent';
}

const ROW_HEIGHT = 54;
const REPLY_HEIGHT = 18;

class CommentDelegate implements IListVirtualDelegate<IVoltCommentItem> {
	getHeight(item: IVoltCommentItem): number {
		return ROW_HEIGHT + (item.reply ? REPLY_HEIGHT : 0);
	}
	getTemplateId(): string {
		return 'comment';
	}
	hasDynamicHeight(): boolean {
		return true;
	}
}

interface ICommentTemplate {
	readonly row: HTMLElement;
	readonly check: Checkbox;
	readonly pin: HTMLElement;
	readonly where: HTMLElement;
	readonly state: HTMLElement;
	readonly text: HTMLElement;
	readonly reply: HTMLElement;
	readonly actions: ActionBar;
	readonly store: DisposableStore;
	readonly elementStore: DisposableStore;
}

class CommentRenderer implements IListRenderer<IVoltCommentItem, ICommentTemplate> {
	readonly templateId = 'comment';

	constructor(private readonly pane: VoltCommentsPane) { }

	renderTemplate(container: HTMLElement): ICommentTemplate {
		const store = new DisposableStore();
		const row = append(container, $('.volt-comments-row'));
		const checkSlot = append(row, $('.volt-comments-check'));
		const check = store.add(new Checkbox(localize('voltComments.pick', "Send with the next message"), true, defaultCheckboxStyles));
		checkSlot.appendChild(check.domNode);
		const pin = append(row, $('span.volt-comments-pin'));
		const body = append(row, $('.volt-comments-body'));
		const top = append(body, $('.volt-comments-top'));
		const where = append(top, $('span.volt-comments-where'));
		const state = append(top, $('span.volt-comments-state'));
		const text = append(body, $('.volt-comments-text'));
		const reply = append(body, $('.volt-comments-reply'));
		const actions = store.add(new ActionBar(append(row, $('.volt-comments-actions'))));
		return { row, check, pin, where, state, text, reply, actions, store, elementStore: store.add(new DisposableStore()) };
	}

	renderElement(item: IVoltCommentItem, _index: number, template: ICommentTemplate): void {
		template.elementStore.clear();
		const sendable = isSendableComment(item);
		template.row.classList.toggle('sendable', sendable);
		template.row.classList.toggle('resolved', item.status === 'resolved');
		template.check.checked = sendable && this.pane.isPicked(item.id);
		template.check.domNode.parentElement!.hidden = !sendable;
		template.elementStore.add(template.check.onChange(() => this.pane.setPicked(item.id, template.check.checked)));

		template.pin.className = `volt-comments-pin ${item.author === 'agent' ? 'agent' : item.status}`;
		if (item.author === 'agent') {
			template.pin.replaceChildren(renderIcon(Codicon.sparkle));
		} else if (item.status === 'resolved') {
			template.pin.replaceChildren(renderIcon(Codicon.check));
		} else {
			template.pin.textContent = String(item.number);
		}
		template.where.textContent = item.where;
		template.state.textContent = item.status === 'sent'
			? localize('voltComments.sent', "Sent")
			: item.status === 'resolved' ? localize('voltComments.resolved', "Resolved") : '';
		template.state.hidden = item.status === 'open';
		template.text.textContent = item.text;
		template.reply.textContent = item.reply ?? '';
		template.reply.hidden = !item.reply;

		template.actions.clear();
		const action = (id: string, label: string, icon: ThemeIcon, run: () => void) => template.elementStore.add(new Action(id, label, ThemeIcon.asClassName(icon), true, async () => run()));
		template.actions.push([
			item.status === 'resolved'
				? action('voltComments.reopen', localize('voltComments.reopen', "Reopen"), Codicon.discard, () => this.pane.options.onSetStatus(item.id, 'open'))
				: action('voltComments.resolve', localize('voltComments.resolve', "Resolve"), Codicon.check, () => this.pane.options.onSetStatus(item.id, 'resolved')),
			action('voltComments.delete', localize('voltComments.delete', "Delete"), Codicon.trash, () => this.pane.options.onDelete(item.id)),
		], { icon: true, label: false });
	}

	disposeElement(_item: IVoltCommentItem, _index: number, template: ICommentTemplate): void {
		template.elementStore.clear();
	}

	disposeTemplate(template: ICommentTemplate): void {
		template.store.dispose();
	}
}

/**
 * The comments of a design canvas or a browser tab: a workbench list with a checkbox on each open
 * comment (the ones ticked go with the next send), Resolve / Reopen / Delete on hover, a Resolved
 * toggle and an archive for resolved ones in the head, and Send under the list.
 */
export class VoltCommentsPane extends Disposable {

	readonly element: HTMLElement;
	private readonly head: HTMLElement;
	private readonly countEl: HTMLElement;
	private readonly body: HTMLElement;
	private readonly emptyEl: HTMLElement;
	private readonly foot: HTMLElement;
	private readonly list: WorkbenchList<IVoltCommentItem>;
	private readonly resolvedCheck: Checkbox;
	private readonly resolvedToggle: HTMLElement;
	private readonly archiveButton: HTMLButtonElement;
	private readonly sendButton: ReturnType<typeof createVoltButton>;
	private items: readonly IVoltCommentItem[] = [];
	/** Open comments the user unticked; everything else open goes with Send. */
	private readonly unpicked = new Set<string>();
	private _collapsed = false;

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	/** The list grew or shrank, or the head folded it: the host lays its column out again. */
	readonly onDidChangeHeight: Event<void> = this._onDidChangeHeight.event;

	constructor(
		container: HTMLElement,
		readonly options: IVoltCommentsPaneOptions,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.element = append(container, $('.volt-comments-pane'));
		this.head = append(this.element, $('.volt-comments-head'));
		if (options.collapsible) {
			this.head.classList.add('collapsible');
			this.head.tabIndex = 0;
			this.head.setAttribute('role', 'button');
			this.head.setAttribute('aria-expanded', 'true');
			append(this.head, $('span.volt-comments-twistie')).appendChild(renderIcon(Codicon.chevronDown));
			this._register(addDisposableListener(this.head, 'click', e => {
				if (isHTMLElement(e.target) && e.target.closest('.volt-comments-head-tools')) {
					return;
				}
				this.setCollapsed(!this._collapsed);
			}));
			this._register(addDisposableListener(this.head, 'keydown', e => {
				if ((e.key === 'Enter' || e.key === ' ') && e.target === this.head) {
					e.preventDefault();
					this.setCollapsed(!this._collapsed);
				}
			}));
		}
		append(this.head, $('span.volt-comments-title')).textContent = options.title ?? localize('voltComments.title', "Comments");
		this.countEl = append(this.head, $('span.volt-comments-count'));
		append(this.head, $('span.volt-comments-grow'));
		const tools = append(this.head, $('.volt-comments-head-tools'));
		this.archiveButton = append(tools, $('button.volt-comments-icon-button')) as HTMLButtonElement;
		this.archiveButton.type = 'button';
		this.archiveButton.appendChild(renderIcon(Codicon.archive));
		setAgentTooltip(this.archiveButton, localize('voltComments.archiveResolved', "Archive Resolved"));
		this._register(addDisposableListener(this.archiveButton, 'click', e => {
			e.stopPropagation();
			options.onArchiveResolved();
		}));
		this.resolvedToggle = append(tools, $('.volt-comments-resolved'));
		this.resolvedCheck = this._register(new Checkbox(localize('voltComments.showResolved', "Resolved"), false, defaultCheckboxStyles));
		this.resolvedToggle.appendChild(this.resolvedCheck.domNode);
		const resolvedLabel = append(this.resolvedToggle, $('span.volt-comments-resolved-label'));
		resolvedLabel.textContent = localize('voltComments.showResolved', "Resolved");
		this._register(addDisposableListener(resolvedLabel, 'click', e => {
			e.stopPropagation();
			this.resolvedCheck.checked = !this.resolvedCheck.checked;
			this.onShowResolved();
		}));
		this._register(this.resolvedCheck.onChange(() => this.onShowResolved()));
		if (options.onClose) {
			const close = append(tools, $('button.volt-comments-icon-button')) as HTMLButtonElement;
			close.type = 'button';
			close.appendChild(renderIcon(Codicon.close));
			setAgentTooltip(close, localize('voltComments.close', "Close"));
			this._register(addDisposableListener(close, 'click', e => {
				e.stopPropagation();
				options.onClose?.();
			}));
		}

		this.body = append(this.element, $('.volt-comments-body-slot'));
		this.emptyEl = append(this.body, $('.volt-comments-empty'));
		this.emptyEl.textContent = localize('voltComments.empty', "No comments yet.");
		this.list = this._register(instantiationService.createInstance(
			WorkbenchList<IVoltCommentItem>,
			options.listId,
			this.body,
			new CommentDelegate(),
			[new CommentRenderer(this)],
			{
				identityProvider: { getId: item => item.id },
				accessibilityProvider: {
					getAriaLabel: item => `${item.number}. ${item.where}: ${item.text}${item.reply ? `. ${item.reply}` : ''}`,
					getWidgetAriaLabel: () => options.title ?? localize('voltComments.title', "Comments"),
				},
				keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: item => item.text },
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				setRowLineHeight: false,
				supportDynamicHeights: true,
			},
		));
		this._register(this.list.onDidChangeContentHeight(() => this._onDidChangeHeight.fire()));
		this._register(this.list.onDidOpen(event => {
			const target = event.browserEvent?.target;
			// The checkbox and the row buttons act on their own; a click on the rest opens the comment.
			if (isHTMLElement(target) && target.closest('.volt-comments-check, .volt-comments-actions')) {
				return;
			}
			if (event.element) {
				options.onOpen(event.element.id);
			}
		}));

		this.foot = append(this.element, $('.volt-comments-foot'));
		this.sendButton = this._register(createVoltButton(this.foot, 'primary'));
		this._register(this.sendButton.onDidClick(() => {
			const ids = this.pickedIds();
			if (ids.length) {
				options.onSend(ids);
			}
		}));
		this.render();
	}

	get showResolved(): boolean {
		return this.resolvedCheck.checked;
	}

	get collapsed(): boolean {
		return this._collapsed;
	}

	/** The list's full height (rows, or the empty line), before the host caps it. */
	get contentHeight(): number {
		return this.list.length ? this.list.contentHeight : 40;
	}

	setItems(items: readonly IVoltCommentItem[]): void {
		this.items = items;
		for (const id of [...this.unpicked]) {
			if (!items.some(item => item.id === id && isSendableComment(item))) {
				this.unpicked.delete(id);
			}
		}
		this.render();
	}

	isPicked(id: string): boolean {
		return this.items.find(item => item.id === id)?.picked ?? !this.unpicked.has(id);
	}

	setPicked(id: string, picked: boolean): void {
		if (this.options.onPick) {
			this.options.onPick(id, picked);
			return;
		}
		if (picked) {
			this.unpicked.delete(id);
		} else {
			this.unpicked.add(id);
		}
		this.syncFoot();
	}

	/** The open comments ticked to go with the next send. */
	pickedIds(): string[] {
		return this.items.filter(item => isSendableComment(item) && this.isPicked(item.id)).map(item => item.id);
	}

	/** Focuses and shows comment `id`, as when its pin is clicked on the page. */
	reveal(id: string): void {
		const index = this.visibleItems().findIndex(item => item.id === id);
		if (index >= 0) {
			this.setCollapsed(false);
			this.list.setFocus([index]);
			this.list.setSelection([index]);
			this.list.reveal(index);
		}
	}

	setCollapsed(collapsed: boolean): void {
		if (this._collapsed === collapsed) {
			return;
		}
		this._collapsed = collapsed;
		this.element.classList.toggle('collapsed', collapsed);
		this.head.setAttribute('aria-expanded', String(!collapsed));
		this._onDidChangeHeight.fire();
	}

	/** Lays the list out at `height` (the host decides how much of its column the comments get). */
	layout(height: number, width: number): void {
		const next = `${Math.max(0, height)}px`;
		if (this.body.style.height !== next) {
			this.body.style.height = next;
		}
		this.list.layout(Math.max(0, height), width);
	}

	/** Lays the list out to fill `height` with the head and Send. */
	fill(height: number, width: number): void {
		const head = this.head.offsetHeight;
		const foot = this.foot.hidden ? 0 : this.foot.offsetHeight;
		this.layout(height - head - foot, width);
	}

	focus(): void {
		this.list.domFocus();
	}

	private visibleItems(): IVoltCommentItem[] {
		const show = this.resolvedCheck.checked;
		return this.items.filter(item => show || item.status !== 'resolved');
	}

	private onShowResolved(): void {
		this.render();
		this.options.onShowResolved?.(this.resolvedCheck.checked);
	}

	private render(): void {
		const rows = this.visibleItems();
		this.countEl.textContent = String(this.items.filter(item => item.status !== 'resolved').length);
		this.list.splice(0, this.list.length, rows);
		this.emptyEl.hidden = rows.length > 0;
		const resolved = this.items.filter(item => item.status === 'resolved').length;
		this.archiveButton.hidden = !resolved;
		this.archiveButton.setAttribute('aria-label', localize('voltComments.archiveCount', "Archive {0} Resolved", resolved));
		this.syncFoot();
		this._onDidChangeHeight.fire();
	}

	private syncFoot(): void {
		const picked = this.pickedIds().length;
		this.sendButton.label = picked === 1
			? localize('voltComments.sendOne', "Send 1 Comment to Agent")
			: localize('voltComments.sendMany', "Send {0} Comments to Agent", picked);
		this.sendButton.enabled = picked > 0;
		this.foot.hidden = !this.items.some(isSendableComment);
	}
}
