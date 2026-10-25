/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { describeComments, describeForAgent } from '../../common/scratchBoard/scratchDescribe.js';
import { readingOrder } from '../../common/scratchBoard/scratchDiagram.js';
import { geometricBounds } from '../../common/scratchBoard/scratchGeometry.js';
import { boundsIntersect, unionBounds } from '../../common/scratchBoard/scratchMath.js';
import type { ScratchScene } from '../../common/scratchBoard/scratchScene.js';
import { IScratchAgentRun, IScratchBounds, IScratchImageElement, IScratchRect, ScratchElement } from '../../common/scratchBoard/scratchTypes.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { voltButtonClasses } from '../chrome/voltButton.js';
import { AgentModelPicker } from '../picker/agentModelPicker.js';
import { IScratchAgentBridge, IScratchAttachment } from './scratchAgentBridge.js';
import { IScratchBoardService } from './scratchBoardService.js';
import { IScratchSessionLinks } from './scratchSessionLinks.js';
import type { ScratchCanvas } from './scratchCanvas.js';
import type { IScratchComment } from './scratchComments.js';
import { scratchIcon, ScratchIconName } from './scratchIcons.js';

const MOD = isMacintosh ? '⌘' : 'Ctrl+';
const SENDABLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** The small bar above a selection: comment on it, hand it to an agent, copy it as an image. */
export class ScratchSelectionBar extends Disposable {

	private readonly element: HTMLElement;

	constructor(parent: HTMLElement, private readonly canvas: ScratchCanvas) {
		super();
		this.element = append(parent, $('.sx-selection-bar.sx-panel.sx-chrome-item'));
		this.element.hidden = true;
		const doc = parent.ownerDocument;
		// Volt's own button: comments wait on the board and go to an agent together.
		const comment = append(this.element, $('button.sx-selection-comment')) as HTMLButtonElement;
		comment.type = 'button';
		comment.classList.add(...voltButtonClasses('primary'), 'volt-button-small');
		comment.appendChild(scratchIcon(doc, 'message-circle', { size: 13, strokeWidth: 2.1 }));
		append(comment, $('span')).textContent = localize('voltScratch.comment', "Comment");
		append(comment, $('kbd')).textContent = 'C';
		this._register(addDisposableListener(comment, 'click', () => this.canvas.commentOnSelection()));
		const ask = append(this.element, $('button.sx-icon-button')) as HTMLButtonElement;
		ask.type = 'button';
		ask.setAttribute('aria-label', localize('voltScratch.askAgent', "Ask Agent"));
		ask.appendChild(scratchIcon(doc, 'agent-spark', { size: 14 }));
		// allow-any-unicode-next-line
		setAgentTooltip(ask, localize('voltScratch.askAgent', "Ask Agent"), `${MOD}↵`, undefined, 'above');
		this._register(addDisposableListener(ask, 'click', () => this.canvas.openComposer(false)));
		append(this.element, $('.sx-divider'));
		const copy = append(this.element, $('button.sx-icon-button')) as HTMLButtonElement;
		copy.type = 'button';
		copy.setAttribute('aria-label', localize('voltScratch.copyPng', "Copy as PNG"));
		copy.appendChild(scratchIcon(doc, 'copy', { size: 14 }));
		setAgentTooltip(copy, localize('voltScratch.copyPng', "Copy as PNG"), isMacintosh ? '⇧⌘C' : 'Ctrl+Shift+C', undefined, 'above');
		this._register(addDisposableListener(copy, 'click', () => void this.canvas.copySelectionAsPng()));
		this._register(addDisposableListener(this.element, 'pointerdown', e => e.stopPropagation()));
	}

	layout(bounds: IScratchBounds | undefined, selected: readonly ScratchElement[]): void {
		if (!bounds || !selected.length || selected.every(el => el.locked)) {
			this.element.hidden = true;
			return;
		}
		this.element.hidden = false;
		const { width } = this.canvas.viewportSize;
		const w = this.element.offsetWidth || 160;
		const x = Math.max(8, Math.min(width - w - 8, (bounds.minX + bounds.maxX) / 2 - w / 2));
		// Above the selection, clear of the rotation handle; below it when the top is under the bars
		// (and the properties bar under them).
		let y = bounds.minY - 76;
		if (y < this.canvas.chromeTop) {
			y = bounds.maxY + 18;
		}
		this.element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
	}
}


interface IComposerState {
	readonly ids: readonly string[];
	readonly whole: boolean;
	/** The user took the board off (the card's X): only their words go; a drawing lands in a free spot. */
	readonly detached: boolean;
	/** The board's comments, sent together: their elements, numbered pins on the render. */
	readonly comments?: readonly IScratchComment[];
}

/**
 * Hands part of the board (or all of it, or its comments) to an agent: a render of it, its text,
 * its diagram as Mermaid and any images, with the user's instruction, on the model they pick, in
 * the chat's project (see ScratchCanvas.agentProjectId). The elements sent get a dashed outline that follows the chat.
 */
export class ScratchComposer extends Disposable {

	private readonly element: HTMLElement;
	private readonly scopeLabel: HTMLElement;
	private readonly preview: HTMLElement;
	private readonly attachButton: HTMLButtonElement;
	private readonly textarea: HTMLTextAreaElement;
	private readonly pickers: HTMLElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly previewStore = this._register(new DisposableStore());
	private readonly previewUrl = this._register(new MutableDisposable());
	private readonly previewScheduler: RunOnceScheduler;
	private openState: IComposerState | undefined;
	private modelRef: string | undefined;
	private sending = false;

	constructor(
		parent: HTMLElement,
		private readonly canvas: ScratchCanvas,
		@IScratchAgentBridge private readonly agents: IScratchAgentBridge,
		@IScratchBoardService private readonly boards: IScratchBoardService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IScratchSessionLinks private readonly links: IScratchSessionLinks,
	) {
		super();
		const doc = parent.ownerDocument;
		this.element = append(parent, $('.sx-composer.sx-panel.sx-chrome-item'));
		this.element.hidden = true;
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', localize('voltScratch.composer', "Ask an agent"));
		const header = append(this.element, $('.sx-composer-header'));
		const title = append(header, $('.sx-composer-title'));
		title.appendChild(scratchIcon(doc, 'agent-spark', { size: 13 }));
		append(title, $('span')).textContent = localize('voltScratch.composerTitle', "Ask an agent");
		this.scopeLabel = append(header, $('.sx-composer-scope'));
		const close = append(header, $('button.sx-icon-button')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('voltScratch.close', "Close"));
		close.appendChild(scratchIcon(doc, 'x', { size: 14 }));
		this._register(addDisposableListener(close, 'click', () => this.close()));
		this.preview = append(this.element, $('.sx-composer-preview'));
		// Taken off, the board can come back.
		this.attachButton = append(this.element, $('button.sx-composer-attach')) as HTMLButtonElement;
		this.attachButton.type = 'button';
		this.attachButton.hidden = true;
		this._register(addDisposableListener(this.attachButton, 'click', () => this.attach()));
		this.textarea = append(this.element, $('textarea.sx-composer-input')) as HTMLTextAreaElement;
		this.textarea.rows = 2;
		this.textarea.setAttribute('aria-label', localize('voltScratch.composerInput', "Instruction"));
		this._register(addDisposableListener(this.textarea, 'input', () => this.autosize()));
		this._register(addDisposableListener(this.textarea, 'keydown', e => {
			e.stopPropagation();
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.send();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this.close();
			}
		}));
		// One row like the chat's composer: the model on the left, the round send on the right.
		const footer = append(this.element, $('.sx-composer-footer'));
		this.pickers = append(footer, $('.sx-composer-pickers'));
		// The chat composer's own send button (agentEditor.css .volt-agent-send).
		this.sendButton = append(footer, $('button.volt-agent-send.sx-composer-send')) as HTMLButtonElement;
		this.sendButton.type = 'button';
		this.sendButton.setAttribute('aria-label', localize('voltScratch.send', "Send"));
		this.sendButton.appendChild(scratchIcon(doc, 'chat-send', { size: 13 }));
		// allow-any-unicode-next-line
		setAgentTooltip(this.sendButton, localize('voltScratch.sendTip', "Start a chat with this"), '↵', undefined, 'above');
		this._register(addDisposableListener(this.sendButton, 'click', () => void this.send()));
		this._register(addDisposableListener(this.element, 'pointerdown', e => e.stopPropagation()));
		this._register(addDisposableListener(this.element, 'wheel', e => e.stopPropagation()));
		this.previewScheduler = this._register(new RunOnceScheduler(() => this.renderThumbnail(), 150));
		// Another board: what was about to be sent is not on screen any more.
		this._register(canvas.onDidChangeModel(() => this.close()));
		this._register(canvas.state.onDidChangeSelection(() => {
			const state = this.openState;
			if (state && !state.whole && !state.detached && !state.comments && !this.sending) {
				// The selection changed under an open composer: follow it.
				const ids = canvas.selectedWithContents().map(el => el.id);
				if (!ids.length) {
					this.close();
				} else {
					this.openState = { ids, whole: false, detached: false };
					this.renderScope();
				}
			}
		}));
	}

	get isOpen(): boolean {
		return !!this.openState;
	}

	/**
	 * Opens for the selection, or the whole board when nothing is selected (or `whole`). An empty
	 * board opens with nothing attached: the agent draws from the words alone.
	 */
	open(whole = false): void {
		const selected = this.canvas.selectedWithContents();
		const all = this.canvas.scene?.getElements() ?? [];
		const useWhole = whole || !selected.length;
		const ids = (useWhole ? all : selected).map(el => el.id);
		this.show({ ids, whole: useWhole, detached: !ids.length });
	}

	/** Opens with the board's comments: each goes with its number, on a render of what they are on. */
	openComments(): void {
		const comments = this.canvas.comments.list();
		if (!comments.length) {
			return;
		}
		const ids = new Set<string>();
		for (const comment of comments) {
			for (const el of this.canvas.comments.liveElements(comment)) {
				ids.add(el.id);
			}
		}
		this.show({ ids: [...ids], whole: false, detached: false, comments });
	}

	private show(state: IComposerState): void {
		if (!this.canvas.model) {
			return;
		}
		this.openState = state;
		this.modelRef ??= this.agents.defaultModelRef(undefined);
		this.element.hidden = false;
		// Rises from below each time it opens (its position is a transform, so the animation uses `translate`).
		this.element.classList.remove('sx-composer-in');
		void this.element.offsetWidth;
		this.element.classList.add('sx-composer-in');
		this.renderScope();
		this.renderFooter();
		this.autosize();
		this.canvas.requestFrame();
		this.textarea.focus();
	}

	close(): void {
		if (!this.openState) {
			return;
		}
		this.openState = undefined;
		this.element.hidden = true;
		this.renderStore.clear();
		this.previewStore.clear();
		this.previewUrl.clear();
		this.canvas.requestFrame();
		this.canvas.focus();
	}

	/** A click on the board closes an untouched composer; one with text stays. */
	dismissIfIdle(): void {
		if (this.openState && !this.textarea.value.trim() && !this.sending) {
			this.close();
		}
	}

	private elements(): ScratchElement[] {
		const scene = this.canvas.scene;
		return (this.openState?.ids ?? []).map(id => scene?.get(id)).filter((el): el is ScratchElement => !!el);
	}

	/** What the attach button would bring back: the selection, else the board. */
	private attachable(): { readonly ids: readonly string[]; readonly whole: boolean } | undefined {
		const selected = this.canvas.selectedWithContents();
		if (selected.length) {
			return { ids: selected.map(el => el.id), whole: false };
		}
		const all = this.canvas.scene?.getElements() ?? [];
		return all.length ? { ids: all.map(el => el.id), whole: true } : undefined;
	}

	private detach(): void {
		if (this.openState && !this.openState.comments) {
			this.openState = { ids: [], whole: this.openState.whole, detached: true };
			this.renderScope();
			this.canvas.requestFrame();
			this.textarea.focus();
		}
	}

	private attach(): void {
		const target = this.attachable();
		if (this.openState && target) {
			this.openState = { ...target, detached: false };
			this.renderScope();
			this.canvas.requestFrame();
			this.textarea.focus();
		}
	}

	private marks(): { readonly at: readonly [number, number]; readonly label: string }[] {
		return (this.openState?.comments ?? []).map((comment, i) => ({ at: this.canvas.comments.pinPoint(comment), label: String(i + 1) }));
	}

	private renderScope(): void {
		const state = this.openState;
		this.previewStore.clear();
		this.preview.replaceChildren();
		if (!state) {
			return;
		}
		const doc = this.preview.ownerDocument;
		const elements = this.elements();
		const comments = state.comments ?? [];
		this.element.classList.toggle('detached', state.detached);
		this.textarea.placeholder = state.detached
			? localize('voltScratch.composerPlaceholderEmpty', "What should the agent make? It draws on a free spot of this board, e.g. \"Sketch a sign-up flow\"")
			: comments.length
				? localize('voltScratch.composerPlaceholderComments', "Anything to add? The comments go with it")
				: localize('voltScratch.composerPlaceholder', "What should the agent do with this? e.g. \"Build this UI\", \"Review this architecture\"");
		const attachable = state.detached ? this.attachable() : undefined;
		this.attachButton.hidden = !attachable;
		if (attachable) {
			this.attachButton.replaceChildren(scratchIcon(doc, 'plus', { size: 12, strokeWidth: 2.25 }));
			append(this.attachButton, $('span')).textContent = attachable.whole
				? localize('voltScratch.attachBoard', "Attach the board")
				: localize('voltScratch.attachSelection', "Attach the selection");
		}
		if (state.detached) {
			this.scopeLabel.textContent = localize('voltScratch.scopeNothing', "Nothing attached");
			this.preview.hidden = true;
			return;
		}
		this.preview.hidden = false;
		const images = elements.filter(el => el.type === 'image').length;
		this.scopeLabel.textContent = comments.length
			? (comments.length === 1 ? localize('voltScratch.oneComment', "1 comment") : localize('voltScratch.comments', "{0} comments", comments.length))
			: state.whole
				? localize('voltScratch.scopeBoard', "Whole board · {0} items", elements.length)
				: elements.length === 1 ? localize('voltScratch.scopeOne', "1 item") : localize('voltScratch.scopeMany', "{0} items", elements.length);
		if (elements.length) {
			const thumb = append(this.preview, $('.sx-composer-thumb'));
			append(thumb, $('.sx-composer-thumb-loading'));
		}
		const chips = append(this.preview, $('.sx-composer-chips'));
		const chip = (icon: ScratchIconName, text: string) => {
			const c = append(chips, $('span.sx-composer-chip'));
			c.appendChild(scratchIcon(doc, icon, { size: 12 }));
			append(c, $('span')).textContent = text;
		};
		if (comments.length) {
			chip('message-circle', comments.length === 1 ? localize('voltScratch.oneComment', "1 comment") : localize('voltScratch.comments', "{0} comments", comments.length));
		}
		if (elements.length) {
			chip('image', localize('voltScratch.chipRender', "Render of the {0}", state.whole ? localize('voltScratch.board', "board") : localize('voltScratch.selection', "selection")));
		}
		const texts = elements.filter(el => el.type === 'text' || el.type === 'note' || el.type === 'card').length;
		if (texts) {
			chip('type', texts === 1 ? localize('voltScratch.chipText', "1 text") : localize('voltScratch.chipTexts', "{0} texts", texts));
		}
		if (images) {
			chip('paperclip', images === 1 ? localize('voltScratch.chipImage', "1 image") : localize('voltScratch.chipImages', "{0} images", images));
		}
		if (elements.some(el => el.type === 'arrow' && (el.startBinding || el.endBinding))) {
			chip('workflow', localize('voltScratch.chipDiagram', "Diagram as Mermaid"));
		}
		if (!comments.length) {
			// Take the board off: ask for something new instead.
			const detach = append(this.preview, $('button.sx-composer-detach')) as HTMLButtonElement;
			detach.type = 'button';
			detach.setAttribute('aria-label', localize('voltScratch.detach', "Remove the board from this message"));
			detach.appendChild(scratchIcon(doc, 'x', { size: 12, strokeWidth: 2.25 }));
			setAgentTooltip(detach, localize('voltScratch.detach', "Remove the board from this message"), undefined, undefined, 'above');
			this.previewStore.add(addDisposableListener(detach, 'click', () => this.detach()));
		}
		if (elements.length) {
			this.previewScheduler.schedule();
		}
	}

	/** The thumbnail, once the selection settles (a marquee drag changes it every frame). */
	private renderThumbnail(): void {
		const thumb = this.preview.querySelector('.sx-composer-thumb');
		const elements = this.elements();
		if (!thumb || !elements.length) {
			return;
		}
		const ids = this.openState?.ids.join(',');
		void this.canvas.exporter.renderPng(this.canvas, elements, { scale: 1, maxSide: 640, asShown: true, marks: this.marks() }).then(blob => {
			if (!blob || !this.openState || this.openState.ids.join(',') !== ids || !thumb.isConnected) {
				return;
			}
			const url = URL.createObjectURL(blob);
			this.previewUrl.value = toDisposable(() => URL.revokeObjectURL(url));
			const img = this.preview.ownerDocument.createElement('img');
			img.src = url;
			img.alt = '';
			thumb.replaceChildren(img);
		});
	}

	private renderFooter(): void {
		this.renderStore.clear();
		this.pickers.replaceChildren();
		const modelButton = append(this.pickers, $('button.volt-agent-model.sx-composer-model')) as HTMLButtonElement;
		modelButton.type = 'button';
		modelButton.setAttribute('aria-haspopup', 'dialog');
		modelButton.setAttribute('aria-label', localize('voltScratch.model', "Model"));
		const picker = this.renderStore.add(this.instantiationService.createInstance(AgentModelPicker, {
			binding: {
				get: () => this.modelRef,
				set: ref => { this.modelRef = ref; },
				autoLabel: localize('voltScratch.modelDefault', "Default model"),
				autoDescription: localize('voltScratch.modelDefaultDesc', "The model new chats start on"),
			},
			position: AnchorPosition.ABOVE,
			onDidChange: () => paint(),
		}));
		const paint = () => {
			modelButton.replaceChildren();
			picker.renderTrigger(modelButton);
			modelButton.appendChild(renderIcon(Codicon.chevronDown));
		};
		paint();
		this.renderStore.add(addDisposableListener(modelButton, 'click', () => picker.show(modelButton, () => paint())));
	}

	private autosize(): void {
		const t = this.textarea;
		t.style.height = 'auto';
		t.style.height = `${Math.min(180, Math.max(44, t.scrollHeight))}px`;
	}

	/** Below the selection when there is room, else above; centred at the bottom for the whole board. */
	layout(selection: IScratchBounds | undefined): void {
		const state = this.openState;
		if (!state) {
			return;
		}
		const { width, height } = this.canvas.viewportSize;
		const w = this.element.offsetWidth || 440;
		const h = this.element.offsetHeight || 220;
		let x: number, y: number;
		if (state.whole || state.detached || state.comments || !selection) {
			x = width / 2 - w / 2;
			y = height - h - 72;
		} else {
			x = (selection.minX + selection.maxX) / 2 - w / 2;
			y = selection.maxY + 20;
			if (y + h > height - 16) {
				y = selection.minY - h - 20;
			}
			if (y < this.canvas.chromeTop) {
				y = Math.max(this.canvas.chromeTop, height - h - 72);
			}
		}
		x = Math.max(12, Math.min(width - w - 12, x));
		y = Math.max(12, Math.min(height - h - 12, y));
		this.element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
	}

	private async attachments(elements: readonly ScratchElement[]): Promise<{ readonly attachments: IScratchAttachment[]; readonly renderName: string | undefined; readonly imageNames: Map<string, string> }> {
		const attachments: IScratchAttachment[] = [];
		const imageNames = new Map<string, string>();
		if (!elements.length) {
			return { attachments, renderName: undefined, imageNames };
		}
		const whole = !!this.openState?.whole;
		const render = await this.canvas.exporter.renderPng(this.canvas, elements, { scale: 2, maxSide: 2400, marks: this.marks() });
		let renderName: string | undefined;
		if (render) {
			renderName = whole ? 'scratch-board.png' : 'scratch-selection.png';
			attachments.push({ name: renderName, mime: 'image/png', bytes: new Uint8Array(await render.arrayBuffer()) });
		}
		let n = 0;
		for (const el of readingOrder(elements.filter((e): e is IScratchImageElement => e.type === 'image'))) {
			const buffer = await this.boards.readAsset(el.assetId);
			if (!buffer) {
				continue;
			}
			n++;
			if (SENDABLE.has(el.mime)) {
				const ext = el.mime.split('/')[1].replace('jpeg', 'jpg');
				const name = `scratch-image-${n}.${ext}`;
				attachments.push({ name, mime: el.mime, bytes: buffer.buffer });
				imageNames.set(el.id, name);
			}
		}
		return { attachments, renderName, imageNames };
	}

	/** Where a drawing asked for with nothing attached goes: the middle of the view if it is free, else right of the board. */
	private freeSpot(scene: ScratchScene): IScratchRect {
		const view = this.canvas.camera.visibleBounds();
		const width = Math.min(640, (view.maxX - view.minX) * 0.6);
		const height = Math.min(420, (view.maxY - view.minY) * 0.5);
		const cx = (view.minX + view.maxX) / 2;
		const cy = (view.minY + view.maxY) / 2;
		const box: IScratchBounds = { minX: cx - width / 2, minY: cy - height / 2, maxX: cx + width / 2, maxY: cy + height / 2 };
		const taken = [...scene.getElements().map(el => geometricBounds(el)), ...this.canvas.reservedSpots()];
		if (!taken.some(b => boundsIntersect(b, box))) {
			return { x: box.minX, y: box.minY, width, height };
		}
		const all = unionBounds(taken)!;
		return { x: all.maxX + 160, y: all.minY, width, height };
	}

	private async send(): Promise<void> {
		const state = this.openState;
		const scene = this.canvas.scene;
		const boardId = this.canvas.model?.id;
		if (!state || !scene || !boardId || this.sending) {
			return;
		}
		const elements = this.elements();
		const comments = state.comments ?? [];
		if (!elements.length && !state.detached && !comments.length) {
			this.close();
			return;
		}
		const note = this.textarea.value.trim();
		if (state.detached && !note) {
			// Nothing attached and nothing asked: there is nothing to send.
			this.textarea.focus();
			return;
		}
		this.sending = true;
		this.element.classList.add('sending');
		this.sendButton.disabled = true;
		try {
			const { attachments, renderName, imageNames } = await this.attachments(elements);
			const boardTitle = this.canvas.boardTitle;
			const commentList = comments.map((comment, i) => `${i + 1}. ${comment.text.trim()}`).join('\n');
			let context = elements.length
				? describeForAgent(elements, { boardTitle, renderName, imageNames, whole: state.whole })
				: state.detached
					// allow-any-unicode-next-line
					? `Scratch board “${boardTitle || 'Untitled'}”: nothing on it was sent with this message. A drawing that answers it lands in the free space kept for it on the board.`
					// allow-any-unicode-next-line
					: `Scratch board “${boardTitle || 'Untitled'}”.`;
			if (comments.length) {
				const described = describeComments(comments.map(comment => ({ text: comment.text, elements: this.canvas.comments.liveElements(comment) })));
				context += `\n\n## Comments\n\n${described}${renderName ? `\n\nThe numbers match the blue pins on ${renderName}.` : ''}`;
			}
			const instruction = comments.length
				? [note || localize('voltScratch.commentsInstruction', "Please work through these comments on my Scratch board:"), commentList].join('\n\n')
				: note || localize('voltScratch.defaultInstruction', "Here is a sketch from my Scratch board. Take a look and tell me what you see and how you would build it.");
			const first = comments.length ? (note || comments[0].text) : note;
			const title = first ? first.split('\n')[0].slice(0, 80) : localize('voltScratch.defaultTitle', "Scratch: {0}", boardTitle);
			const request = {
				instruction,
				context,
				attachments,
				modelRef: this.modelRef,
				// The chat beside the board's project, else the one the window has selected.
				projectId: this.canvas.agentProjectId,
				siblings: scene.runs.map(run => run.sessionId),
				title,
			};
			// Where the outline goes: round what was sent (and the comments' spots), or a free spot.
			const spots = comments.filter(comment => !this.canvas.comments.liveElements(comment).length).map(comment => this.canvas.comments.pinPoint(comment));
			const b = unionBounds([...elements.map(el => geometricBounds(el)), ...spots.map(([x, y]) => ({ minX: x - 40, minY: y - 40, maxX: x + 40, maxY: y + 40 }))]);
			const bounds = b ? { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY } : this.freeSpot(scene);
			const sessionId = await this.agents.send(request);
			// The chat knows its board: its toolbar in Agents leads back here.
			this.links.link(sessionId, boardId);
			this.textarea.value = '';
			this.close();
			if (comments.length) {
				this.canvas.comments.remove(comments.map(comment => comment.id));
			}
			// The chat is under way; the outline goes on the board the elements came from.
			const modelLabel = this.agents.modelLabel(this.modelRef ?? this.agents.defaultModelRef(request.projectId));
			const run: IScratchAgentRun = {
				id: generateUuid(),
				sessionId,
				elementIds: elements.map(el => el.id),
				prompt: note || commentList,
				modelLabel,
				created: Date.now(),
				bounds,
			};
			const shown = this.canvas.scene === scene;
			if (shown ? await this.canvas.whenIdle() === scene : !scene.inTransaction) {
				const selection = shown ? [...this.canvas.state.selection] : [];
				scene.transact(localize('voltScratch.sentToAgent', "Send to agent"), tx => tx.setRuns([...scene.runs, run]), { selectionBefore: selection, selectionAfter: selection });
				if (this.canvas.scene === scene) {
					this.canvas.noteRunStarted(run);
				}
			}
		} catch (err) {
			this.notificationService.error(localize('voltScratch.sendFailed', "Could not start the chat: {0}", err instanceof Error ? err.message : String(err)));
		} finally {
			this.sending = false;
			this.element.classList.remove('sending');
			this.sendButton.disabled = false;
		}
	}
}
