/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/browserEditor.css';
import '../media/voltCommentComposer.css';
import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserAgentComposer } from '../preview/browserComposer.js';
import { setAgentTooltip } from './agentTooltip.js';
import { BATCH_EDITS_STORAGE_KEY } from './voltAnnotations.js';

/** What a comment is about, in px in the parent element's coordinate space. */
export interface IVoltCommentAnchor {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** Room the composer must leave free at the parent's edges (a toolbar along the top), in px. */
export interface IVoltCommentInsets {
	readonly top?: number;
	readonly right?: number;
	readonly bottom?: number;
	readonly left?: number;
}

export interface IVoltCommentComposerOptions {
	/** Keep the comment (Enter while Batch edits is on). */
	onAdd(text: string): void;
	/** Send now: Enter with Batch edits off, or Cmd/Ctrl+Enter. The surface sends this comment and whatever is queued. */
	onSend(text: string): void;
	/** Closed without adding (Escape, the X, a click outside if you implement it). */
	onClose?(): void;
	/** Shown only for an existing comment. */
	onDelete?(): void;
	/** Edges the composer stays clear of; read on every placement. */
	insets?(): IVoltCommentInsets;
	/** The model chip follows this model until the user picks another for the comment (as the browser's prompt). */
	chatModel?(): string | undefined;
}

/** The browser prompt's numbers: 8px from the stage's edges, 12px from the selection, 160-390px wide. */
const EDGE_PAD = 8;
const GAP = 12;
const MIN_WIDTH = 160;
const MAX_WIDTH = 390;
const MIN_HEIGHT = 72;

interface IBox { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/**
 * Where a `width` x `height` box goes beside `anchor`, the way the browser places its inspect prompt
 * around a selection: below, above, right, left (then the corners), each clamped inside `bounds`
 * (`pad` from its edges); the first that covers the least of the anchor and `obstacles` wins, ties
 * going to the one most centred on the anchor.
 */
export function placeBesideAnchor(
	anchor: IVoltCommentAnchor,
	size: { readonly width: number; readonly height: number },
	bounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
	obstacles: readonly IVoltCommentAnchor[] = [],
	pad = EDGE_PAD,
	gap = GAP,
): { left: number; top: number } {
	const { width, height } = size;
	const sel: IBox = { x: anchor.x, y: anchor.y, w: anchor.width, h: anchor.height };
	const clamp = (left: number, top: number) => ({
		left: Math.min(Math.max(bounds.left + pad, left), Math.max(bounds.left + pad, bounds.right - width - pad)),
		top: Math.min(Math.max(bounds.top + pad, top), Math.max(bounds.top + pad, bounds.bottom - height - pad)),
	});
	const overlap = (a: IBox, b: IBox) => {
		const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
		const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
		return x * y;
	};
	const boxes: IBox[] = [sel, ...obstacles.map(o => ({ x: o.x, y: o.y, w: o.width, h: o.height }))];
	const centred = sel.x + sel.w / 2 - width / 2;
	const candidates = [
		clamp(centred, sel.y + sel.h + gap),
		clamp(centred, sel.y - height - gap),
		clamp(sel.x + sel.w + gap, sel.y),
		clamp(sel.x - width - gap, sel.y),
		clamp(sel.x + sel.w + gap, sel.y + sel.h - height),
		clamp(sel.x - width - gap, sel.y + sel.h - height),
		clamp(centred, sel.y + sel.h + gap + 24),
	];
	let best = candidates[0];
	let bestScore = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		const rect: IBox = { x: candidate.left, y: candidate.top, w: width, h: height };
		const covered = boxes.reduce((sum, item) => sum + overlap(rect, item), 0);
		const score = covered + Math.abs(candidate.left - centred) * 0.05;
		if (score < bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	return best;
}

/**
 * The browser's inspect prompt (BrowserAgentComposer: the chip, "+", the model, "Batch edits", mic and
 * Send) as a comment box for any surface that comments on something: the Scratch board, the design
 * canvas. Placed beside what it is about like the browser places it, it fades in where it lands.
 * With Batch edits on Enter keeps the comment (onAdd); off, Enter sends it (onSend); Cmd/Ctrl+Enter
 * always sends. It hides itself after onAdd / onSend / onClose / onDelete.
 */
export class VoltCommentComposer extends Disposable {

	readonly element: HTMLElement;

	private readonly composer: BrowserAgentComposer;
	private readonly deleteButton: HTMLButtonElement;
	/** Stands in for the chip in the composer's text, so the comment is only what was typed. */
	private readonly chipMarker = `[[volt-comment-target:${generateUuid()}]]`;
	private anchor: IVoltCommentAnchor | undefined;
	private chip = '';
	private shown = false;

	constructor(
		private readonly parent: HTMLElement,
		private readonly options: IVoltCommentComposerOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		// `volt-browser-prompt` gives it the browser prompt's frame and solid fill (browserEditor.css).
		this.element = append(parent, $('.volt-comment-composer.volt-browser-prompt.hidden'));
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', localize('voltComment.aria', "Comment"));

		this.composer = this._register(instantiationService.createInstance(BrowserAgentComposer, {
			onSubmit: text => this.submit(text),
			onPrefill: () => undefined,
			batch: {
				get: () => this.storageService.getBoolean(BATCH_EDITS_STORAGE_KEY, StorageScope.PROFILE, false),
				set: on => this.storageService.store(BATCH_EDITS_STORAGE_KEY, on, StorageScope.PROFILE, StorageTarget.USER),
			},
			onLayout: () => this.relayout(),
			chatModel: options.chatModel ? () => options.chatModel?.() : undefined,
			// A comment is words for the agent: no images riding along.
			images: false,
		}));
		this.composer.setPlaceholder(localize('voltComment.placeholder', "Add a comment"));
		append(this.element, this.composer.element);

		// The X (and the bin for a saved comment) in the input row's corner.
		const tools = append(this.element, $('.volt-comment-composer-tools'));
		this.deleteButton = this.tool(tools, Codicon.trash, localize('voltComment.delete', "Delete Comment"), () => {
			this.hide();
			this.options.onDelete?.();
		});
		this.tool(tools, Codicon.close, localize('voltComment.close', "Close"), () => this.close());

		this._register(addDisposableListener(this.element, 'keydown', e => {
			// The @ panel, dictation and the editor's own keys already used it.
			if (e.defaultPrevented || e.isComposing) {
				return;
			}
			if (e.key === 'Escape') {
				if (this.composer.isPlusMenuOpen()) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this.close();
			} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				const text = this.commentText(this.composer.getSubmitText());
				this.hide();
				this.composer.clear();
				this.options.onSend(text);
			}
		}));
		// The surface under it (a board that pans and zooms) must not take these.
		for (const type of ['pointerdown', 'wheel'] as const) {
			this._register(addDisposableListener(this.element, type, e => e.stopPropagation()));
		}
	}

	get visible(): boolean {
		return this.shown;
	}

	/** Opens at `anchor` (placed below / above / right / left of it like the browser's prompt), chip = what it is about, `text` = an existing comment to edit. Focuses the input. */
	show(anchor: IVoltCommentAnchor, chip: string, options?: { readonly text?: string; readonly deletable?: boolean }): void {
		this.anchor = anchor;
		this.chip = chip;
		this.shown = true;
		this.deleteButton.classList.toggle('hidden', !options?.deletable);
		this.element.classList.toggle('deletable', !!options?.deletable);
		// Shown (and sized) before the editor fills, so it measures and takes focus.
		this.element.classList.remove('hidden', 'volt-comment-composer-in');
		this.syncWidth();
		this.composer.clear();
		this.composer.resetModel();
		this.composer.setSelectionChip(chip, this.chipMarker);
		if (options?.text) {
			this.composer.appendPlainText(options.text);
		}
		this.place(anchor);
		// A quick fade where it landed (left/top, never a transform that slides it in).
		void this.element.offsetWidth;
		this.element.classList.add('volt-comment-composer-in');
		this.composer.focus();
	}

	/** The anchor moved (camera pan/zoom): re-place without re-animating. */
	place(anchor: IVoltCommentAnchor): void {
		this.anchor = anchor;
		if (!this.shown) {
			return;
		}
		const width = this.syncWidth();
		const height = Math.max(this.composer.element.offsetHeight || MIN_HEIGHT, MIN_HEIGHT);
		const insets = this.options.insets?.() ?? {};
		const bounds = {
			left: insets.left ?? 0,
			top: insets.top ?? 0,
			right: this.parent.clientWidth - (insets.right ?? 0),
			bottom: this.parent.clientHeight - (insets.bottom ?? 0),
		};
		const { left, top } = placeBesideAnchor(anchor, { width, height }, bounds);
		const nextLeft = `${Math.round(left)}px`;
		const nextTop = `${Math.round(top)}px`;
		if (this.element.style.left !== nextLeft) {
			this.element.style.left = nextLeft;
		}
		if (this.element.style.top !== nextTop) {
			this.element.style.top = nextTop;
		}
	}

	hide(): void {
		if (!this.shown) {
			return;
		}
		this.shown = false;
		this.composer.hidePlusMenu();
		this.composer.blur();
		this.element.classList.add('hidden');
		this.element.classList.remove('volt-comment-composer-in');
	}

	private close(): void {
		this.hide();
		this.options.onClose?.();
	}

	/** Enter or Send: kept with Batch edits on, sent with it off. Only the chip left: nothing to add. */
	private submit(serialized: string): void {
		const text = this.commentText(serialized);
		if (!text) {
			// The composer empties itself after this: the chip goes back in.
			queueMicrotask(() => {
				if (this.shown) {
					this.composer.setSelectionChip(this.chip, this.chipMarker);
				}
			});
			return;
		}
		const batch = this.storageService.getBoolean(BATCH_EDITS_STORAGE_KEY, StorageScope.PROFILE, false);
		this.hide();
		if (batch) {
			this.options.onAdd(text);
		} else {
			this.options.onSend(text);
		}
	}

	private commentText(serialized: string): string {
		return serialized.split(this.chipMarker).join('').trim();
	}

	private relayout(): void {
		this.element.classList.toggle('composer-empty', this.composer.element.classList.contains('empty'));
		if (this.anchor) {
			this.place(this.anchor);
		}
	}

	/** The browser prompt's width: 390px, narrower in a small parent. */
	private syncWidth(): number {
		const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, this.parent.clientWidth - EDGE_PAD * 2));
		const next = `${width}px`;
		if (this.element.style.width !== next) {
			this.element.style.width = next;
		}
		return width;
	}

	private tool(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => void): HTMLButtonElement {
		const button = append(parent, $('button.volt-comment-composer-tool')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.appendChild(renderIcon(icon));
		setAgentTooltip(button, label);
		// Keep the text focused until the click lands.
		this._register(addDisposableListener(button, 'mousedown', e => e.preventDefault()));
		this._register(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			run();
		}));
		return button;
	}
}
