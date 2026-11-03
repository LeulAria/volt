/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { createFrame, createCard, createNote } from '../../common/scratchBoard/scratchFactory.js';
import { ScratchShapeKind } from '../../common/scratchBoard/scratchTypes.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';
import type { IScratchCanvasHost, ScratchCanvas } from './scratchCanvas.js';
import { ScratchTool } from './scratchCanvasState.js';
import { scratchIcon, ScratchIconName, SHAPE_ICONS, SHAPE_LABELS } from './scratchIcons.js';
import { CODE_TEMPLATE_HTML, createChecklistBlock, createTableBlock, promptMermaid } from './scratchLibrary.js';

interface IToolSpec {
	readonly tool: ScratchTool;
	readonly shape?: ScratchShapeKind;
	readonly icon: ScratchIconName;
	readonly label: string;
	readonly key: string;
}

const TOOLS: readonly IToolSpec[] = [
	{ tool: 'hand', icon: 'hand', label: localize('voltScratch.tool.hand', "Hand"), key: 'H' },
	{ tool: 'select', icon: 'mouse-pointer-2', label: localize('voltScratch.tool.select', "Select"), key: 'V' },
	{ tool: 'shape', shape: 'rectangle', icon: 'square', label: SHAPE_LABELS.rectangle, key: 'R' },
	{ tool: 'shape', shape: 'diamond', icon: 'diamond', label: SHAPE_LABELS.diamond, key: 'D' },
	{ tool: 'shape', shape: 'ellipse', icon: 'circle', label: SHAPE_LABELS.ellipse, key: 'O' },
	{ tool: 'arrow', icon: 'move-right', label: localize('voltScratch.tool.arrow', "Arrow"), key: 'A' },
	{ tool: 'line', icon: 'minus', label: localize('voltScratch.tool.line', "Line"), key: 'L' },
	{ tool: 'draw', icon: 'pencil', label: localize('voltScratch.tool.draw', "Draw"), key: 'P' },
	{ tool: 'text', icon: 'type', label: localize('voltScratch.tool.text', "Text"), key: 'T' },
	{ tool: 'note', icon: 'sticky-note', label: localize('voltScratch.tool.note', "Sticky note"), key: 'N' },
	{ tool: 'image', icon: 'image', label: localize('voltScratch.tool.image', "Image"), key: '9' },
	{ tool: 'eraser', icon: 'eraser', label: localize('voltScratch.tool.eraser', "Eraser"), key: 'E' },
	// Comment sits in the top right, beside Library.
];

/** The side bars' distance from the board's edge, and the least room between them and the tools. */
const BAR_INSET = 12;
const BAR_GAP = 8;
const FOLD_LABELS = 'sx-fold-labels';
const FOLD_TITLE = 'sx-fold-title';
const OVERFLOWED = 'sx-overflowed';
/** On a board too narrow for the whole bar, tools move to "more" in this order (hand and select stay). */
const OVERFLOW_ORDER: readonly string[] = ['lock', 'eraser', 'image', 'shape:diamond', 'line', 'note', 'draw', 'text', 'shape:ellipse', 'arrow', 'shape:rectangle'];

function toolId(spec: Pick<IToolSpec, 'tool' | 'shape'>): string {
	return spec.shape ? `shape:${spec.shape}` : spec.tool;
}

type MoreAction =
	| { readonly kind: 'lock' }
	| { readonly kind: 'tool'; readonly tool: ScratchTool; readonly shape?: ScratchShapeKind }
	| { readonly kind: 'insert'; readonly what: 'table' | 'checklist' | 'code' | 'mermaid' | 'frame' | 'note' | 'card' }
	| { readonly kind: 'library' };

/**
 * The board's top chrome: the menu, board list toggle and title on the left; the tool bar in the
 * middle; the library and "ask about this board" on the right.
 */
export class ScratchToolbar extends Disposable {

	private readonly tools = new Map<string, HTMLButtonElement>();
	private readonly lockButton: HTMLButtonElement;
	private readonly lockDivider: HTMLElement;
	/** Tools moved from the bar to "more" because the board is narrow (ids as in {@link OVERFLOW_ORDER}). */
	private overflowed: ReadonlySet<string> = new Set();
	private readonly moreButton: HTMLButtonElement;
	private readonly titleInput: HTMLInputElement;
	private readonly libraryButton: HTMLButtonElement;
	private readonly linksButton: HTMLButtonElement;
	private readonly commentButton: HTMLButtonElement;
	/** Where the comments' "(n) Send" goes, first in the top right. */
	readonly commentsSlot: HTMLElement;
	private readonly left: HTMLElement;
	private readonly bar: HTMLElement;
	private readonly right: HTMLElement;
	/** Holds the fold classes. */
	private readonly foldRoot: HTMLElement;

	constructor(
		parent: HTMLElement,
		private readonly canvas: ScratchCanvas,
		private readonly host: IScratchCanvasHost,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super();

		// Left: menu, title.
		const left = append(parent, $('.sx-top-left.sx-chrome-item'));
		const menuButton = this.iconButton(left, 'menu', localize('voltScratch.menu', "Menu"));
		this._register(addDisposableListener(menuButton, 'click', () => this.canvas.showMainMenu(menuButton)));
		this.titleInput = append(left, $('input.sx-title')) as HTMLInputElement;
		this.titleInput.type = 'text';
		this.titleInput.spellcheck = false;
		this.titleInput.setAttribute('aria-label', localize('voltScratch.boardTitle', "Board title"));
		this._register(addDisposableListener(this.titleInput, 'keydown', e => {
			if (e.key === 'Enter' || e.key === 'Escape') {
				e.preventDefault();
				if (e.key === 'Escape') {
					this.titleInput.value = this.host.boardTitle();
				}
				this.titleInput.blur();
				this.canvas.focus();
			}
			e.stopPropagation();
		}));
		this._register(addDisposableListener(this.titleInput, 'blur', () => {
			const value = this.titleInput.value.trim();
			if (value && value !== this.host.boardTitle()) {
				this.host.setBoardTitle(value);
			} else {
				this.titleInput.value = this.host.boardTitle();
			}
		}));
		this._register(addDisposableListener(this.titleInput, 'input', () => this.sizeTitle()));

		// Middle: tools.
		const bar = append(parent, $('.sx-toolbar.sx-panel.sx-chrome-item'));
		bar.setAttribute('role', 'toolbar');
		bar.setAttribute('aria-label', localize('voltScratch.tools', "Tools"));
		this.lockButton = this.toolButton(bar, 'lock-open', localize('voltScratch.tool.lock', "Keep the tool after drawing"), 'Q', 'sx-lock');
		this._register(addDisposableListener(this.lockButton, 'click', () => {
			this.canvas.state.setToolLocked(!this.canvas.state.toolLocked);
			this.canvas.focus();
		}));
		this.lockDivider = append(bar, $('.sx-divider'));
		for (const spec of TOOLS) {
			const button = this.toolButton(bar, spec.icon, spec.label, spec.key);
			this.tools.set(toolId(spec), button);
			this._register(addDisposableListener(button, 'click', () => {
				if (spec.tool === 'image') {
					this.canvas.setTool('image');
					return;
				}
				this.canvas.setTool(spec.tool, spec.shape);
			}));
		}
		append(bar, $('.sx-divider'));
		this.moreButton = this.toolButton(bar, 'ellipsis-vertical', localize('voltScratch.moreTools', "More tools"), '');
		this._register(addDisposableListener(this.moreButton, 'click', () => this.showMore()));

		// Right: connections, library, comment.
		const right = append(parent, $('.sx-top-right.sx-chrome-item'));
		this.commentsSlot = append(right, $('.sx-comments-slot'));
		// Hovering a shape shows what it is joined to (on by default; the setting is shared with the board menu).
		this.linksButton = this.labelButton(right, 'workflow', '', undefined, 'sx-icon-only');
		this.linksButton.setAttribute('aria-label', localize('voltScratch.highlightConnections', "Highlight Connections"));
		setAgentTooltip(this.linksButton, localize('voltScratch.highlightConnectionsTooltip', "Show a shape's connections on hover"), undefined, undefined, 'below');
		this._register(addDisposableListener(this.linksButton, 'click', () => {
			this.canvas.setHighlightConnections(!this.canvas.highlightConnections);
			this.canvas.focus();
		}));
		this.libraryButton = this.labelButton(right, 'library-big', localize('voltScratch.library', "Library"), 'Shift+L');
		this._register(addDisposableListener(this.libraryButton, 'click', () => {
			this.canvas.toggleLibrary();
			this.refresh();
		}));
		// Asking an agent about the board: the selection bar's Ask Agent and its shortcut (no button here).
		// The comment tool: click something or drag a box round several things, then write.
		this.commentButton = this.labelButton(right, 'message-circle', localize('voltScratch.tool.comment', "Comment"), 'C');
		this.commentButton.setAttribute('aria-pressed', 'false');
		this._register(addDisposableListener(this.commentButton, 'click', () => {
			this.canvas.setTool(this.canvas.state.tool === 'comment' ? 'select' : 'comment');
			this.canvas.focus();
		}));
		// The first refresh comes from the page once the canvas is built (it asks the page for the title).

		this.left = left;
		this.bar = bar;
		this.right = right;
		this.foldRoot = parent.parentElement ?? parent;
		// The board resizing, the title changing, comments joining the top right: fit again.
		const observer = new ResizeObserver(() => this.fit());
		for (const el of [parent, left, right]) {
			observer.observe(el);
		}
		this._register(toDisposable(() => observer.disconnect()));
	}

	/**
	 * Keeps the tools on the top row, clear of both sides: the right's labels fold to icons, then
	 * the title goes. Still too narrow to centre, the tools centre in the room between the side
	 * bars, and their last tools move to "more" until they fit. Measured, so it holds for any
	 * title, any comments count and the right panel's widths.
	 */
	private fit(): void {
		const width = this.foldRoot.clientWidth;
		if (!width) {
			return;
		}
		this.foldRoot.classList.remove(FOLD_LABELS, FOLD_TITLE);
		this.bar.style.removeProperty('--sx-tools-shift');
		this.setOverflow(0);
		const centred = () => {
			const side = (width - this.bar.offsetWidth) / 2 - BAR_GAP;
			return side >= BAR_INSET + this.left.offsetWidth && side >= BAR_INSET + this.right.offsetWidth;
		};
		for (const step of [FOLD_LABELS, FOLD_TITLE]) {
			if (centred()) {
				return;
			}
			this.foldRoot.classList.add(step);
		}
		if (centred()) {
			return;
		}
		const start = BAR_INSET + this.left.offsetWidth + BAR_GAP;
		const room = width - start - this.right.offsetWidth - BAR_GAP - BAR_INSET;
		for (let count = 1; this.bar.offsetWidth > room && count <= OVERFLOW_ORDER.length; count++) {
			this.setOverflow(count);
		}
		this.bar.style.setProperty('--sx-tools-shift', `${Math.round(start + room / 2 - width / 2)}px`);
	}

	/** Moves the first `count` tools of {@link OVERFLOW_ORDER} from the bar to "more". */
	private setOverflow(count: number): void {
		this.overflowed = new Set(OVERFLOW_ORDER.slice(0, count));
		this.lockButton.classList.toggle(OVERFLOWED, this.overflowed.has('lock'));
		this.lockDivider.classList.toggle(OVERFLOWED, this.overflowed.has('lock'));
		for (const [id, button] of this.tools) {
			button.classList.toggle(OVERFLOWED, this.overflowed.has(id));
		}
		this.syncMoreButton();
	}

	/** A shape outside the bar (cylinder, cloud...) or a tool from the menu lights up "more". */
	private syncMoreButton(): void {
		const state = this.canvas.state;
		const activeId = toolId({ tool: state.tool, shape: state.tool === 'shape' ? state.shapeKind : undefined });
		const fromMore = (!this.tools.has(activeId) || this.overflowed.has(activeId)) && state.tool !== 'comment';
		this.moreButton.classList.toggle('active', fromMore);
	}

	private iconButton(parent: HTMLElement, icon: ScratchIconName, label: string, shortcut?: string): HTMLButtonElement {
		const button = append(parent, $('button.sx-icon-button')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.appendChild(scratchIcon(parent.ownerDocument, icon, { size: 14 }));
		setAgentTooltip(button, label, shortcut, undefined, 'below');
		return button;
	}

	private labelButton(parent: HTMLElement, icon: ScratchIconName, label: string, shortcut?: string, extra = ''): HTMLButtonElement {
		const button = append(parent, $(`button.sx-label-button${extra ? `.${extra}` : ''}`)) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(scratchIcon(parent.ownerDocument, icon, { size: 14 }));
		if (label) {
			append(button, $('span')).textContent = label;
		}
		if (shortcut) {
			setAgentTooltip(button, label, shortcut, undefined, 'below');
		}
		return button;
	}

	private toolButton(parent: HTMLElement, icon: ScratchIconName, label: string, key: string, extra = ''): HTMLButtonElement {
		const button = append(parent, $(`button.sx-tool-button${extra ? `.${extra}` : ''}`)) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.appendChild(scratchIcon(parent.ownerDocument, icon, { size: 15 }));
		if (key) {
			append(button, $('span.sx-tool-key')).textContent = key;
		}
		setAgentTooltip(button, label, key || undefined, undefined, 'below');
		return button;
	}

	refresh(): void {
		const state = this.canvas.state;
		const activeId = state.tool === 'shape' ? `shape:${state.shapeKind}` : state.tool;
		for (const [id, button] of this.tools) {
			const on = id === activeId;
			button.classList.toggle('active', on);
			button.setAttribute('aria-pressed', String(on));
		}
		const commenting = state.tool === 'comment';
		this.syncMoreButton();
		this.commentButton.classList.toggle('active', commenting);
		this.commentButton.setAttribute('aria-pressed', String(commenting));
		this.lockButton.classList.toggle('active', state.toolLocked);
		this.lockButton.replaceChildren(scratchIcon(this.lockButton.ownerDocument, state.toolLocked ? 'lock' : 'lock-open', { size: 14 }));
		this.libraryButton.classList.toggle('active', this.canvas.libraryOpen);
		const links = this.canvas.highlightConnections;
		this.linksButton.classList.toggle('active', links);
		this.linksButton.setAttribute('aria-pressed', String(links));
		if (this.titleInput.ownerDocument.activeElement !== this.titleInput) {
			this.titleInput.value = this.host.boardTitle();
			this.sizeTitle();
		}
	}

	private sizeTitle(): void {
		this.titleInput.style.width = `${Math.min(320, Math.max(80, this.titleInput.value.length * 7.4 + 22))}px`;
	}

	private showMore(): void {
		const doc = this.moreButton.ownerDocument;
		const icon = (name: ScratchIconName) => () => scratchIcon(doc, name, { size: 16 });
		const state = this.canvas.state;
		// The bar's own tools that the narrow board moved here come first, in bar order.
		const barItems: IVoltMenuItem<MoreAction>[] = TOOLS.filter(spec => this.overflowed.has(toolId(spec))).map(spec => ({
			id: `bar-${toolId(spec)}`,
			label: spec.label,
			icon: icon(spec.icon),
			keybinding: spec.key,
			checked: state.tool === spec.tool && (!spec.shape || state.shapeKind === spec.shape),
			data: { kind: 'tool', tool: spec.tool, shape: spec.shape },
		}));
		if (this.overflowed.has('lock')) {
			barItems.unshift({
				id: 'lock',
				label: localize('voltScratch.tool.lock', "Keep the tool after drawing"),
				icon: icon(state.toolLocked ? 'lock' : 'lock-open'),
				keybinding: 'Q',
				checked: state.toolLocked,
				data: { kind: 'lock' },
			});
		}
		const shapeItems: IVoltMenuItem<MoreAction>[] = (['triangle', 'hexagon', 'parallelogram', 'cylinder', 'pill', 'document', 'cloud', 'star'] as const).map(shape => ({
			id: `shape-${shape}`,
			label: SHAPE_LABELS[shape],
			icon: icon(SHAPE_ICONS[shape]),
			checked: this.canvas.state.tool === 'shape' && this.canvas.state.shapeKind === shape,
			data: { kind: 'tool', tool: 'shape', shape },
		}));
		showVoltMenu<MoreAction>(this.contextViewService, {
			anchor: this.moreButton,
			position: 'below',
			align: 'right',
			gap: 6,
			width: 248,
			ariaLabel: localize('voltScratch.moreTools', "More tools"),
			sections: [
				...(barItems.length ? [{ id: 'bar', items: barItems }] : []),
				{
					id: 'tools',
					items: [
						{ id: 'frame', label: localize('voltScratch.tool.frame', "Frame"), icon: icon('frame'), keybinding: 'F', data: { kind: 'tool', tool: 'frame' }, checked: this.canvas.state.tool === 'frame' },
						{ id: 'card', label: localize('voltScratch.tool.card', "Markdown card"), icon: icon('file-text'), keybinding: 'M', data: { kind: 'tool', tool: 'card' }, checked: this.canvas.state.tool === 'card' },
						{ id: 'laser', label: localize('voltScratch.tool.laser', "Laser pointer"), icon: icon('flashlight'), keybinding: 'K', data: { kind: 'tool', tool: 'laser' }, checked: this.canvas.state.tool === 'laser' },
						{ id: 'shapes', label: localize('voltScratch.moreShapes', "More shapes"), icon: icon('shapes'), data: { kind: 'library' }, submenu: { width: 220, sections: [{ id: 'shapes', items: shapeItems }] } },
					],
				},
				{
					id: 'insert',
					title: localize('voltScratch.insertTitle', "Insert"),
					items: [
						{ id: 'table', label: localize('voltScratch.insertTable', "Table"), icon: icon('table'), data: { kind: 'insert', what: 'table' } },
						{ id: 'checklist', label: localize('voltScratch.insertChecklist', "Checklist"), icon: icon('list-checks'), data: { kind: 'insert', what: 'checklist' } },
						{ id: 'code', label: localize('voltScratch.insertCode', "Code block"), icon: icon('code-xml'), data: { kind: 'insert', what: 'code' } },
						{ id: 'mermaid', label: localize('voltScratch.insertMermaid', "Diagram from Mermaid"), icon: icon('workflow'), data: { kind: 'insert', what: 'mermaid' } },
						{ id: 'library', label: localize('voltScratch.openLibrary', "Library and icons"), icon: icon('library-big'), keybinding: 'Shift+L', data: { kind: 'library' } },
					],
				},
			],
			onPick: item => {
				const action = item.data;
				if (action.kind === 'lock') {
					this.canvas.state.setToolLocked(!this.canvas.state.toolLocked);
					this.canvas.focus();
				} else if (action.kind === 'tool') {
					this.canvas.setTool(action.tool, action.shape);
				} else if (action.kind === 'library') {
					this.canvas.toggleLibrary();
					this.refresh();
				} else {
					this.insert(action.what);
				}
			},
		});
	}

	private insert(what: 'table' | 'checklist' | 'code' | 'mermaid' | 'frame' | 'note' | 'card'): void {
		const style = this.canvas.state.style;
		switch (what) {
			case 'table': this.canvas.insertElements([createTableBlock(style)]); break;
			case 'checklist': this.canvas.insertElements([createChecklistBlock(style)]); break;
			case 'code': this.canvas.insertElements([createCard({ x: 0, y: 0, width: 520, html: CODE_TEMPLATE_HTML }, style)]); break;
			case 'mermaid': void promptMermaid(this.canvas); break;
			case 'frame': this.canvas.insertElements([createFrame({ x: 0, y: 0, width: 480, height: 320 }, style)]); break;
			case 'note': this.canvas.insertElements([createNote({ x: 0, y: 0 }, style)]); break;
			case 'card': this.canvas.insertElements([createCard({ x: 0, y: 0 }, style)]); break;
		}
	}
}
