/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { nodeLabel } from '../../common/scratchBoard/scratchDiagram.js';
import { geometricBounds } from '../../common/scratchBoard/scratchGeometry.js';
import { htmlToPlainText } from '../../common/scratchBoard/scratchHtml.js';
import { unionBounds, Vec } from '../../common/scratchBoard/scratchMath.js';
import { IScratchBounds, ScratchElement } from '../../common/scratchBoard/scratchTypes.js';
import { VoltAnnotationsSendButton } from '../chrome/voltAnnotations.js';
import { IVoltCommentAnchor, VoltCommentComposer } from '../chrome/voltCommentComposer.js';
import type { ScratchCanvas } from './scratchCanvas.js';
import { scratchIcon } from './scratchIcons.js';

/** A note left on the board for an agent: on some elements, or on an empty spot. */
export interface IScratchComment {
	readonly id: string;
	readonly elementIds: readonly string[];
	/** The pin's world point when it was made: where it stays if its elements go. */
	readonly at: readonly [number, number];
	readonly text: string;
	readonly created: number;
}

const COMMENTS_KEY = 'volt.scratchBoard.comments';
const PIN_SIZE = 24;
/** A pin on elements sits this far out from their corner, clear of the selection's resize handle. */
const PIN_OFFSET = 10;

interface IDraft {
	readonly elementIds: readonly string[];
	readonly at: Vec;
	/** Editing this comment; a new one otherwise. */
	readonly commentId?: string;
}

/**
 * Comments on the board, the way the design canvas and the browser do them: pin a few, they
 * wait (numbered on the board, counted at the top), and go to an agent together.
 */
export class ScratchComments extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** Board id → its comments, oldest first (the numbers follow that order). */
	private all = new Map<string, IScratchComment[]>();
	private writing = false;
	private readonly layer: HTMLElement;
	private readonly pins = new Map<string, HTMLElement>();
	private readonly composer: VoltCommentComposer;
	private readonly sendButton: VoltAnnotationsSendButton;
	private draft: IDraft | undefined;

	constructor(
		parent: HTMLElement,
		private readonly sendSlot: HTMLElement,
		private readonly canvas: ScratchCanvas,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.load();
		this.layer = append(parent, $('.sx-comment-layer'));

		// The browser's inspect prompt as the comment box: the chip, the model, "Batch edits" and Send.
		this.composer = this._register(instantiationService.createInstance(VoltCommentComposer, parent, {
			onAdd: text => this.save(text),
			onSend: text => {
				this.save(text);
				// Sends this one with the rest of the batch; nothing queued, there is nothing to send.
				if (this.list().length) {
					this.send();
				}
			},
			onClose: () => this.close(),
			onDelete: () => {
				if (this.draft?.commentId) {
					this.remove([this.draft.commentId]);
				}
				this.close();
			},
			insets: () => ({ top: Math.max(0, this.canvas.chromeTop - 8) }),
		}));
		this._register(addDisposableListener(this.layer, 'click', e => {
			const id = (e.target as HTMLElement).closest<HTMLElement>('.sx-comment-pin')?.dataset.id;
			if (id) {
				if (this.draft?.commentId === id) {
					this.close();
				} else {
					this.reveal(id);
				}
			}
		}));
		this._register(addDisposableListener(this.layer, 'pointerdown', e => e.stopPropagation()));
		this._register(addDisposableListener(this.layer, 'wheel', e => e.stopPropagation()));

		// "(3) Send" with its caret at the top: the batch, its list, and the way to the agent.
		this.sendButton = this._register(instantiationService.createInstance(VoltAnnotationsSendButton, sendSlot, {
			items: () => this.list().map((comment, i) => ({ id: comment.id, number: i + 1, text: comment.text })),
			onSend: () => this.send(),
			onOpen: id => this.reveal(id),
			onRemove: id => this.remove([id]),
			onClear: () => this.clear(),
			countLabel: count => count === 1 ? localize('voltScratch.oneComment', "1 comment") : localize('voltScratch.comments', "{0} comments", count),
			sendHint: localize('voltScratch.sendComments', "Send the comments to an agent"),
			listHint: localize('voltScratch.showComments', "Show Comments"),
		}));
		this.sendButton.element.classList.add('sx-comments-send', 'sx-chrome-item');

		// Profile storage is shared by the windows: a board open in two shows the same pins.
		this._register(storageService.onDidChangeValue(StorageScope.PROFILE, COMMENTS_KEY, this._store)(() => {
			if (!this.writing) {
				this.load();
				this.changed();
			}
		}));
		this._register(canvas.onDidChangeModel(() => {
			this.close();
			this.changed();
		}));
		this.changed();
	}

	/** The pins' layer: the canvas puts it under the panels. */
	get layerElement(): HTMLElement {
		return this.layer;
	}

	/** The open board's comments, in pin order. */
	list(): readonly IScratchComment[] {
		const boardId = this.canvas.model?.id;
		return boardId ? this.all.get(boardId) ?? [] : [];
	}

	get isOpen(): boolean {
		return !!this.draft;
	}

	/** Opens a new comment on `elementIds` (pinned to their top right), or on the spot `at`. */
	start(elementIds: readonly string[], at?: Vec): void {
		const anchor = this.anchorOf(elementIds) ?? at;
		if (!anchor || !this.canvas.model) {
			return;
		}
		this.open({ elementIds: [...elementIds], at: anchor });
	}

	/** Brings a comment into view and opens it. */
	reveal(id: string): void {
		const comment = this.list().find(c => c.id === id);
		if (!comment) {
			return;
		}
		const live = this.liveElements(comment);
		if (live.length) {
			this.canvas.bringIntoView(live.map(el => el.id));
		} else {
			this.canvas.camera.centerOn([comment.at[0], comment.at[1]]);
		}
		this.open({ elementIds: comment.elementIds, at: [comment.at[0], comment.at[1]], commentId: id });
	}

	close(): void {
		if (!this.draft) {
			return;
		}
		this.draft = undefined;
		this.composer.hide();
		this.syncPins();
		// The selection bar comes back.
		this.canvas.requestFrame();
		this.canvas.focus();
	}

	/** After the batch went to an agent: those comments are done. */
	remove(ids: readonly string[]): void {
		const boardId = this.canvas.model?.id;
		const comments = boardId ? this.all.get(boardId) : undefined;
		if (!boardId || !comments) {
			return;
		}
		const gone = new Set(ids);
		const kept = comments.filter(c => !gone.has(c.id));
		if (kept.length === comments.length) {
			return;
		}
		this.setBoard(boardId, kept);
		if (this.draft?.commentId && gone.has(this.draft.commentId)) {
			this.close();
		}
	}

	private clear(): void {
		const boardId = this.canvas.model?.id;
		if (boardId) {
			this.setBoard(boardId, []);
		}
		this.close();
	}

	private send(): void {
		this.close();
		this.canvas.openCommentsComposer();
	}

	/** The elements a comment is on that are still on the board. */
	liveElements(comment: IScratchComment): ScratchElement[] {
		const scene = this.canvas.scene;
		return comment.elementIds.map(id => scene?.get(id)).filter((el): el is ScratchElement => !!el);
	}

	/** The pin's world point: the top right of what it is on, or where it was left. */
	pinPoint(comment: IScratchComment): Vec {
		return this.anchorOf(comment.elementIds) ?? [comment.at[0], comment.at[1]];
	}

	private anchorOf(elementIds: readonly string[]): Vec | undefined {
		const b = this.boundsOf(elementIds);
		return b ? [b.maxX, b.minY] : undefined;
	}

	private boundsOf(elementIds: readonly string[]): IScratchBounds | undefined {
		const scene = this.canvas.scene;
		const live = elementIds.map(id => scene?.get(id)).filter((el): el is ScratchElement => !!el);
		return unionBounds(live.map(el => geometricBounds(el)));
	}

	// ---- Comment box -----------------------------------------------------------------------

	private open(draft: IDraft): void {
		this.draft = draft;
		const existing = draft.commentId ? this.list().find(c => c.id === draft.commentId) : undefined;
		this.syncPins();
		this.composer.show(this.draftAnchor(draft), this.targetLabel(draft.elementIds), { text: existing?.text, deletable: !!existing });
		this.layout();
		// The selection bar steps aside while a comment is open.
		this.canvas.requestFrame();
	}

	/** Keeps the comment being written (a new one, or the open one's new words). */
	private save(text: string): void {
		const draft = this.draft;
		const boardId = this.canvas.model?.id;
		if (!draft || !boardId) {
			return;
		}
		if (!text) {
			this.close();
			return;
		}
		const comments = this.all.get(boardId) ?? [];
		if (draft.commentId) {
			this.setBoard(boardId, comments.map(c => c.id === draft.commentId ? { ...c, text } : c));
		} else {
			const comment: IScratchComment = { id: generateUuid(), elementIds: draft.elementIds, at: [draft.at[0], draft.at[1]], text, created: Date.now() };
			this.setBoard(boardId, [...comments, comment]);
			this.pins.get(comment.id)?.classList.add('sx-pin-new');
		}
		this.close();
	}

	/** What the open comment is about, on screen: its elements' box, or the spot's pin. */
	private draftAnchor(draft: IDraft): IVoltCommentAnchor {
		const b = this.boundsOf(draft.elementIds);
		if (b) {
			const [x1, y1] = this.canvas.toScreen([b.minX, b.minY]);
			const [x2, y2] = this.canvas.toScreen([b.maxX, b.maxY]);
			return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
		}
		const [sx, sy] = this.canvas.toScreen(draft.at);
		return { x: sx, y: sy - PIN_SIZE, width: PIN_SIZE, height: PIN_SIZE };
	}

	private targetLabel(elementIds: readonly string[]): string {
		const scene = this.canvas.scene;
		const live = elementIds.map(id => scene?.get(id)).filter((el): el is ScratchElement => !!el);
		if (!live.length) {
			return localize('voltScratch.commentSpot', "Spot on the board");
		}
		if (live.length > 1) {
			return localize('voltScratch.commentItems', "{0} items", live.length);
		}
		const el = live[0];
		const text = (el.type === 'arrow' || el.type === 'line' ? (el.label ? htmlToPlainText(el.label.html) : '') : el.type === 'image' || el.type === 'draw' ? '' : nodeLabel(el, htmlToPlainText)).replace(/\s+/g, ' ').trim();
		return text ? (text.length > 40 ? `${text.slice(0, 39)}…` : text) : this.canvas.kindLabel(el);
	}

	// ---- Pins ------------------------------------------------------------------------------

	private changed(): void {
		this.syncPins();
		const count = this.list().length;
		this.sendButton.setCount(count);
		// The top right makes room for "(n) Send": its neighbours fold to icons on a narrow board.
		this.sendSlot.parentElement?.classList.toggle('sx-with-comments', count > 0);
		this._onDidChange.fire();
		this.canvas.requestFrame();
	}

	/** One pin per comment (and one for an unsaved draft), numbered in order. */
	private syncPins(): void {
		const comments = this.list();
		const wanted = new Set<string>();
		const doc = this.layer.ownerDocument;
		comments.forEach((comment, i) => {
			wanted.add(comment.id);
			let pin = this.pins.get(comment.id);
			if (!pin) {
				pin = append(this.layer, $('button.sx-comment-pin.sx-chrome-item')) as HTMLButtonElement;
				(pin as HTMLButtonElement).type = 'button';
				pin.dataset.id = comment.id;
				this.pins.set(comment.id, pin);
			}
			pin.textContent = String(i + 1);
			pin.classList.toggle('open', this.draft?.commentId === comment.id);
			pin.classList.toggle('outdated', comment.elementIds.length > 0 && !this.liveElements(comment).length);
			pin.setAttribute('aria-label', localize('voltScratch.commentPin', "Comment {0}: {1}", i + 1, comment.text));
			pin.title = comment.text;
		});
		const draftKey = '__draft__';
		if (this.draft && !this.draft.commentId) {
			wanted.add(draftKey);
			let pin = this.pins.get(draftKey);
			if (!pin) {
				pin = append(this.layer, $('.sx-comment-pin.draft'));
				pin.appendChild(scratchIcon(doc, 'plus', { size: 12, strokeWidth: 2.5 }));
				this.pins.set(draftKey, pin);
			}
		}
		for (const [id, pin] of this.pins) {
			if (!wanted.has(id)) {
				pin.remove();
				this.pins.delete(id);
			}
		}
		this.layout();
	}

	/** Pins and the comment box follow the camera and what they are on; called every frame. */
	layout(): void {
		const { width, height } = this.canvas.viewportSize;
		const place = (pin: HTMLElement, world: Vec, onElements: boolean) => {
			const [sx, sy] = this.canvas.toScreen(world);
			const x = onElements ? sx + PIN_OFFSET : sx;
			const y = onElements ? sy - PIN_OFFSET : sy;
			const off = x < -PIN_SIZE || y < 0 || x > width || y > height + PIN_SIZE;
			pin.style.display = off ? 'none' : '';
			// `translate`, not `transform`: the hover `scale` would scale a transform's offset too
			// (the pin flew in from the corner and jumped on hover).
			pin.style.translate = `${Math.round(x)}px ${Math.round(y - PIN_SIZE)}px`;
		};
		for (const comment of this.list()) {
			const pin = this.pins.get(comment.id);
			if (pin) {
				place(pin, this.pinPoint(comment), this.liveElements(comment).length > 0);
			}
		}
		const draft = this.draft;
		if (!draft) {
			return;
		}
		const draftPin = this.pins.get('__draft__');
		if (draftPin) {
			const at = this.anchorOf(draft.elementIds);
			place(draftPin, at ?? draft.at, !!at);
		}
		this.composer.place(this.draftAnchor(draft));
	}

	// ---- Storage ---------------------------------------------------------------------------

	private setBoard(boardId: string, comments: IScratchComment[]): void {
		if (comments.length) {
			this.all.set(boardId, comments);
		} else {
			this.all.delete(boardId);
		}
		this.writing = true;
		try {
			if (this.all.size) {
				this.storageService.store(COMMENTS_KEY, JSON.stringify(Object.fromEntries(this.all)), StorageScope.PROFILE, StorageTarget.MACHINE);
			} else {
				this.storageService.remove(COMMENTS_KEY, StorageScope.PROFILE);
			}
		} finally {
			this.writing = false;
		}
		this.changed();
	}

	private load(): void {
		const next = new Map<string, IScratchComment[]>();
		try {
			const raw = JSON.parse(this.storageService.get(COMMENTS_KEY, StorageScope.PROFILE, '{}')) as unknown;
			if (raw && typeof raw === 'object') {
				for (const [boardId, value] of Object.entries(raw as Record<string, unknown>)) {
					const comments = Array.isArray(value) ? value.filter(isComment) : [];
					if (comments.length) {
						next.set(boardId, comments);
					}
				}
			}
		} catch {
			// A damaged value starts over.
		}
		this.all = next;
	}
}

function isComment(value: unknown): value is IScratchComment {
	const c = value as Partial<IScratchComment> | null;
	return !!c && typeof c.id === 'string' && typeof c.text === 'string' && typeof c.created === 'number'
		&& Array.isArray(c.elementIds) && c.elementIds.every(id => typeof id === 'string')
		&& Array.isArray(c.at) && c.at.length === 2 && c.at.every(n => typeof n === 'number' && Number.isFinite(n));
}
