/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/voltAnnotations.css';
import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IVoltMenuHandle, showVoltMenu } from '../ui/menu/voltMenu.js';
import { setAgentTooltip } from './agentTooltip.js';

/** The "Batch edits" switch (browser prompt and canvas comments), remembered across tabs and restarts. */
export const BATCH_EDITS_STORAGE_KEY = 'volt.browser.batchEdits';

/** One design annotation waiting in the batch: its number on the page and its words. */
export interface IVoltAnnotationItem {
	readonly id: string;
	readonly number: number;
	readonly text: string;
}

export interface IVoltAnnotationsMenuOptions {
	readonly anchor: HTMLElement;
	/** Read on every refresh: the batch as it is now. */
	readonly items: () => readonly IVoltAnnotationItem[];
	readonly onOpen?: (id: string) => void;
	readonly onRemove: (id: string) => void;
	readonly onClear: () => void;
	readonly onHide?: () => void;
	/** The heading: "2 edits" unless the caller counts something else. */
	readonly countLabel?: (count: number) => string;
}

/** The numbered square the batch list and the pins share. */
export function createAnnotationNumber(n: number): HTMLElement {
	const el = $('span.volt-annotation-number');
	el.textContent = String(n);
	return el;
}

export function annotationCountLabel(count: number): string {
	return count === 1 ? localize('voltAnnotations.oneEdit', "1 edit") : localize('voltAnnotations.edits', "{0} edits", count);
}

type AnnotationPick = { readonly kind: 'open' | 'remove'; readonly id: string };

/**
 * The batch as a Volt menu under the Send button's arrow: "2 edits · Clear All", then a row per
 * annotation (number, words, remove). Removing keeps the menu open; the last one closes it.
 */
export function showVoltAnnotationsMenu(contextViewService: IContextViewService, options: IVoltAnnotationsMenuOptions): IVoltMenuHandle {
	// The pick handler refreshes the menu it belongs to.
	const handle: IVoltMenuHandle = showVoltMenu<AnnotationPick>(contextViewService, {
		anchor: options.anchor,
		position: 'below',
		align: 'right',
		gap: 6,
		width: 300,
		className: 'volt-annotations-menu',
		ariaLabel: localize('voltAnnotations.menu', "Design Annotations"),
		heading: {
			title: () => (options.countLabel ?? annotationCountLabel)(options.items().length),
			action: { label: localize('voltAnnotations.clearAll', "Clear All"), run: () => options.onClear() },
		},
		sections: () => [{
			id: 'annotations',
			items: options.items().map(item => ({
				id: item.id,
				label: item.text,
				tooltip: item.text,
				icon: () => createAnnotationNumber(item.number),
				data: { kind: 'open', id: item.id },
				action: { icon: Codicon.close, tooltip: localize('voltAnnotations.remove', "Remove"), data: { kind: 'remove', id: item.id }, keepOpen: true },
			})),
		}],
		onPick: picked => {
			if (picked.data.kind === 'remove') {
				options.onRemove(picked.data.id);
				if (options.items().length) {
					handle.refresh();
				} else {
					handle.dispose();
				}
				return;
			}
			options.onOpen?.(picked.data.id);
		},
		onHide: options.onHide,
	});
	return handle;
}

export interface IVoltAnnotationsSendButtonOptions {
	readonly items: () => readonly IVoltAnnotationItem[];
	readonly onSend: () => void;
	readonly onOpen?: (id: string) => void;
	readonly onRemove: (id: string) => void;
	readonly onClear: () => void;
	/** Wording for what is batched (Scratch sends comments, not design edits). */
	readonly countLabel?: (count: number) => string;
	readonly sendHint?: string;
	readonly listHint?: string;
}

/**
 * "(2) Send | v" for a toolbar: sends the batched design annotations to the agent; the arrow lists
 * them. Hidden while the batch is empty; the count pops when an annotation joins.
 */
export class VoltAnnotationsSendButton extends Disposable {

	readonly element: HTMLElement;
	private readonly countEl: HTMLElement;
	private readonly moreButton: HTMLButtonElement;
	private count = 0;
	private menu: IVoltMenuHandle | undefined;

	constructor(
		parent: HTMLElement,
		private readonly options: IVoltAnnotationsSendButtonOptions,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super();
		this.element = append(parent, $('.volt-annotations-send.hidden'));
		const send = append(this.element, $('button.send')) as HTMLButtonElement;
		send.type = 'button';
		this.countEl = append(send, $('span.count'));
		append(send, $('span.label')).textContent = localize('voltAnnotations.send', "Send");
		setAgentTooltip(send, options.sendHint ?? localize('voltAnnotations.sendHint', "Send design annotations to agent"));
		this.moreButton = append(this.element, $('button.more')) as HTMLButtonElement;
		this.moreButton.type = 'button';
		this.moreButton.appendChild(renderIcon(Codicon.chevronDown));
		setAgentTooltip(this.moreButton, options.listHint ?? localize('voltAnnotations.list', "Show Annotations"));
		this._register(addDisposableListener(send, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.menu?.dispose();
			options.onSend();
		}));
		this._register(addDisposableListener(this.moreButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showMenu();
		}));
		this._register({ dispose: () => this.menu?.dispose() });
	}

	showMenu(): void {
		if (!this.options.items().length) {
			return;
		}
		this.menu = showVoltAnnotationsMenu(this.contextViewService, {
			anchor: this.moreButton,
			items: this.options.items,
			onOpen: this.options.onOpen,
			onRemove: this.options.onRemove,
			onClear: this.options.onClear,
			countLabel: this.options.countLabel,
			onHide: () => this.menu = undefined,
		});
	}

	/** Shows the batch's size; a bigger number than before pops. */
	setCount(count: number): void {
		const grew = count > this.count;
		this.count = count;
		this.element.classList.toggle('hidden', count === 0);
		this.countEl.textContent = String(count);
		if (count === 0) {
			this.menu?.dispose();
		} else {
			this.menu?.refresh();
		}
		if (grew) {
			// Restart the pop: drop the class, read layout, add it back.
			this.element.classList.remove('bump');
			void this.element.offsetWidth;
			this.element.classList.add('bump');
		}
	}
}
