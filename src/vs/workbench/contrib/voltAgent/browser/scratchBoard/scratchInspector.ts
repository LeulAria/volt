/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { darkModeColor, isValidColor, normalizeColor } from '../../common/scratchBoard/scratchColor.js';
import { ScratchPatch } from '../../common/scratchBoard/scratchFactory.js';
import {
	hasLabel, IScratchStyleDefaults, isLinear, isRichText, ScratchArrowhead, ScratchArrowType, ScratchElement, ScratchFillStyle,
	ScratchFontFamily, ScratchPenKind, ScratchRoundness, ScratchStrokeStyle, ScratchTextAlign, SCRATCH_FILL_COLORS, SCRATCH_FONT_SIZES,
	SCRATCH_NOTE_COLORS, SCRATCH_STROKE_COLORS, SCRATCH_STROKE_WIDTHS,
} from '../../common/scratchBoard/scratchTypes.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { showVoltMenu } from '../ui/menu/voltMenu.js';
import type { ScratchCanvas } from './scratchCanvas.js';
import { ScratchTool } from './scratchCanvasState.js';
import { scratchIcon, ScratchIconName } from './scratchIcons.js';

const MOD = isMacintosh ? '⌘' : 'Ctrl+';
const SHIFT = isMacintosh ? '⇧' : 'Shift+';

/** The palette grid in the custom colour picker: hue columns, light to dark rows (Open Color). */
const PALETTE: readonly (readonly string[])[] = [
	['#ffffff', '#f8f9fa', '#e9ecef', '#ced4da', '#868e96', '#495057', '#343a40', '#1e1e1e'],
	['#fff5f5', '#ffc9c9', '#ff8787', '#fa5252', '#e03131', '#c92a2a', '#a61e1e', '#7d1313'],
	['#fff0f6', '#fcc2d7', '#f783ac', '#e64980', '#c2255c', '#a61e4d', '#861640', '#5c0f2c'],
	['#f8f0fc', '#eebefa', '#da77f2', '#be4bdb', '#9c36b5', '#862e9c', '#6b2580', '#4b1a5a'],
	['#f3f0ff', '#d0bfff', '#9775fa', '#7950f2', '#6741d9', '#5f3dc4', '#4c32a0', '#35236f'],
	['#e7f5ff', '#a5d8ff', '#4dabf7', '#228be6', '#1971c2', '#1864ab', '#124f87', '#0b3760'],
	['#e3fafc', '#99e9f2', '#3bc9db', '#15aabf', '#0c8599', '#0b7285', '#095a69', '#063f4a'],
	['#ebfbee', '#b2f2bb', '#69db7c', '#40c057', '#2f9e44', '#2b8a3e', '#226e32', '#174c22'],
	['#fff9db', '#ffec99', '#ffd43b', '#fab005', '#f08c00', '#e67700', '#b85f00', '#7f4200'],
	['#fff4e6', '#ffd8a8', '#ffa94d', '#fd7e14', '#e8590c', '#d9480f', '#ad3a0c', '#782808'],
];

interface IContext {
	readonly elements: readonly ScratchElement[];
	readonly tool: ScratchTool;
	readonly style: IScratchStyleDefaults;
}

type GroupId = 'color' | 'stroke' | 'arrow' | 'text' | 'opacity' | 'arrange';

/** One button on the bar and the popover it opens. */
interface IGroup {
	readonly id: GroupId;
	readonly label: string;
	/** The button's face: an icon, or the colours as a dot. */
	readonly face: (doc: Document) => Element;
	readonly build: (pop: HTMLElement) => void;
}

interface IAction {
	readonly icon: ScratchIconName;
	readonly label: string;
	readonly shortcut?: string;
	readonly run: () => void;
}

interface IChoice<T> {
	readonly id: T;
	readonly icon: ScratchIconName;
	readonly label: string;
}

/**
 * The properties of what is selected (or of the tool about to draw), as one row under the board's
 * menu: a button per kind of setting, each opening its choices below it, then the quick actions.
 */
export class ScratchInspector extends Disposable {

	private readonly element: HTMLElement;
	private readonly body: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly triggers = new Map<GroupId, HTMLButtonElement>();
	private groups = new Map<GroupId, IGroup>();
	private popover: HTMLElement | undefined;
	private openGroup: GroupId | undefined;
	private readonly popoverStore = this._register(new DisposableStore());
	private readonly contentStore = this._register(new DisposableStore());
	/** The colour row whose full palette is open. */
	private expanded: string | undefined;
	private refreshQueued = false;
	private refreshPending = false;

	constructor(
		parent: HTMLElement,
		private readonly canvas: ScratchCanvas,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super();
		this.element = append(parent, $('.sx-inspector.sx-chrome-item'));
		this.element.setAttribute('role', 'toolbar');
		this.element.setAttribute('aria-label', localize('voltScratch.properties', "Properties"));
		this.body = append(this.element, $('.sx-inspector-body'));
		this._register(canvas.state.onDidChangeSelection(() => this.refresh()));
		this._register(canvas.state.onDidChangeStyle(() => this.refresh()));
		this._register(canvas.onDidChangeScene(change => {
			if (!change.live && [...change.updated].some(id => canvas.state.selection.has(id))) {
				this.refresh();
			}
		}));
		this._register(addDisposableListener(this.element, 'wheel', e => e.stopPropagation()));
		this._register(addDisposableListener(this.element, 'pointerdown', e => e.stopPropagation()));
		this._register(toDisposable(() => this.closePopover()));
	}

	get visible(): boolean {
		return this.element.classList.contains('visible');
	}

	refresh(): void {
		if (this.refreshQueued) {
			return;
		}
		this.refreshQueued = true;
		getWindow(this.element).requestAnimationFrame(() => {
			this.refreshQueued = false;
			// A slider being dragged (or stepped with the keys) would be rebuilt under the pointer;
			// the bar catches up when it lets go.
			const active = this.element.ownerDocument.activeElement;
			if (active?.classList.contains('sx-slider') && this.popover?.contains(active)) {
				this.refreshPending = true;
				return;
			}
			this.render();
		});
	}

	/** Escape: an open popover closes first. */
	dismiss(): boolean {
		if (!this.popover) {
			return false;
		}
		this.closePopover();
		this.canvas.focus();
		return true;
	}

	private context(): IContext | undefined {
		const elements = this.canvas.selectedElements();
		const tool = this.canvas.state.tool;
		const drawingTool = tool !== 'select' && tool !== 'hand' && tool !== 'eraser' && tool !== 'laser' && tool !== 'image' && tool !== 'comment';
		if (!elements.length && !drawingTool) {
			return undefined;
		}
		if (elements.length && elements.every(el => el.locked)) {
			return undefined;
		}
		return { elements, tool, style: this.canvas.state.style };
	}

	private render(): void {
		this.renderStore.clear();
		this.body.replaceChildren();
		this.triggers.clear();
		const ctx = this.context();
		this.element.classList.toggle('visible', !!ctx);
		if (!ctx) {
			this.groups.clear();
			this.closePopover();
			return;
		}
		const doc = this.body.ownerDocument;
		const groups = this.buildGroups(ctx);
		this.groups = new Map(groups.map(g => [g.id, g]));
		for (const group of groups) {
			const button = append(this.body, $('button.sx-prop-trigger')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('aria-label', group.label);
			button.setAttribute('aria-haspopup', 'dialog');
			button.setAttribute('aria-expanded', String(this.openGroup === group.id));
			button.classList.toggle('open', this.openGroup === group.id);
			button.appendChild(group.face(doc));
			button.appendChild(scratchIcon(doc, 'chevron-down', { size: 11, strokeWidth: 2.25 })).classList.add('sx-prop-chevron');
			setAgentTooltip(button, group.label, undefined, undefined, 'below');
			this.renderStore.add(addDisposableListener(button, 'click', () => this.togglePopover(group.id)));
			this.triggers.set(group.id, button);
		}
		const actions = this.actions(ctx);
		if (actions.length) {
			if (groups.length) {
				append(this.body, $('.sx-divider'));
			}
			for (const action of actions) {
				const button = append(this.body, $('button.sx-prop-action')) as HTMLButtonElement;
				button.type = 'button';
				button.setAttribute('aria-label', action.label);
				button.appendChild(scratchIcon(doc, action.icon, { size: 15 }));
				setAgentTooltip(button, action.label, action.shortcut, undefined, 'below');
				this.renderStore.add(addDisposableListener(button, 'click', () => {
					action.run();
					this.canvas.focus();
				}));
			}
		}
		if (this.openGroup && this.groups.has(this.openGroup)) {
			this.renderPopover();
		} else {
			this.closePopover();
		}
	}

	private buildGroups(ctx: IContext): IGroup[] {
		const types = new Set<string>(ctx.elements.length ? ctx.elements.map(el => el.type) : [toolType(ctx.tool)]);
		const els = ctx.elements;
		const has = (...t: string[]) => t.some(x => types.has(x));
		const only = (...t: string[]) => [...types].every(x => t.includes(x));
		const tool = (...t: ScratchTool[]) => !els.length && t.includes(ctx.tool);
		const shapeLike = has('shape');
		const linear = has('line', 'arrow');
		const draw = has('draw');
		const textual = has('text', 'note', 'card') || els.some(el => hasLabel(el) && !!el.label);
		const value = <T,>(read: (el: ScratchElement) => T | undefined, fallback: T): T | undefined => {
			if (!els.length) {
				return fallback;
			}
			const values = els.map(read).filter((v): v is T => v !== undefined);
			if (!values.length) {
				return fallback;
			}
			return values.every(v => v === values[0]) ? values[0] : undefined;
		};
		const groups: IGroup[] = [];

		// Colours: stroke, background and its fill style, a note's or a page's colour.
		const strokeColor = value(el => el.stroke, ctx.style.stroke);
		const hasFill = has('shape', 'frame') || (linear && els.some(el => isLinear(el) && el.closed)) || tool('shape');
		const fillColor = value(el => el.type === 'note' ? undefined : el.fill, ctx.style.fill);
		const hasNote = has('note') || tool('note');
		const noteColor = value(el => el.type === 'note' ? el.fill : undefined, ctx.style.noteColor);
		const hasPage = has('card') && els.length > 0;
		const pageColor = value(el => el.type === 'card' ? el.fill : undefined, '#ffffff');
		const fillStyles = (shapeLike || tool('shape')) && fillColor !== 'transparent';
		if (!only('image')) {
			groups.push({
				id: 'color',
				label: localize('voltScratch.colors', "Colours"),
				face: doc => {
					const dot = doc.createElement('span');
					dot.className = 'sx-prop-dot';
					const inside = hasFill ? fillColor : hasNote ? noteColor : hasPage ? pageColor : strokeColor;
					if (!inside || inside === 'transparent') {
						dot.classList.add('sx-transparent');
					} else {
						dot.style.setProperty('--sx-dot-fill', this.shown(inside));
					}
					dot.style.setProperty('--sx-dot-ring', this.shown(strokeColor ?? '#868e96'));
					return dot;
				},
				build: pop => {
					this.colorRow(pop, 'stroke', localize('voltScratch.stroke', "Stroke"), SCRATCH_STROKE_COLORS.slice(0, 5), strokeColor, color => this.apply({ stroke: color }, el => el.type === 'image' ? undefined : { stroke: color }), false);
					if (hasFill) {
						this.colorRow(pop, 'fill', localize('voltScratch.background', "Background"), SCRATCH_FILL_COLORS.slice(0, 5), fillColor, color => this.apply({ fill: color }, el => el.type === 'shape' || el.type === 'frame' || isLinear(el) ? { fill: color } : undefined), true);
					}
					if (fillStyles) {
						this.choiceRow<ScratchFillStyle>(pop, localize('voltScratch.fill', "Fill"), [
							{ id: 'hachure', icon: 'fill-hachure', label: localize('voltScratch.fillHachure', "Hachure") },
							{ id: 'cross-hatch', icon: 'fill-cross-hatch', label: localize('voltScratch.fillCross', "Cross-hatch") },
							{ id: 'solid', icon: 'fill-solid', label: localize('voltScratch.fillSolid', "Solid") },
						], value(el => el.type === 'shape' ? el.fillStyle : undefined, ctx.style.fillStyle), v => this.apply({ fillStyle: v }, el => el.type === 'shape' || isLinear(el) ? { fillStyle: v } : undefined));
					}
					if (hasNote) {
						this.colorRow(pop, 'note', localize('voltScratch.noteColor', "Note"), SCRATCH_NOTE_COLORS.slice(0, 6), noteColor, color => this.apply({ noteColor: color }, el => el.type === 'note' ? { fill: color } : undefined), false);
					}
					if (hasPage) {
						this.colorRow(pop, 'page', localize('voltScratch.cardColor', "Page"), ['#ffffff', '#f8f9fa', '#fff9db', '#e7f5ff', '#ebfbee'], pageColor, color => this.apply({}, el => el.type === 'card' ? { fill: color } : undefined), false);
					}
				},
			});
		}

		// The line: width, style, sloppiness, edges, pen.
		const strokeWidths: IChoice<number>[] = [
			{ id: SCRATCH_STROKE_WIDTHS.thin, icon: 'stroke-thin', label: localize('voltScratch.thin', "Thin") },
			{ id: SCRATCH_STROKE_WIDTHS.bold, icon: 'stroke-bold', label: localize('voltScratch.bold2', "Bold") },
			{ id: SCRATCH_STROKE_WIDTHS.extraBold, icon: 'stroke-extra', label: localize('voltScratch.extraBold', "Extra bold") },
		];
		const edges: IChoice<ScratchRoundness>[] = [
			{ id: 'sharp', icon: 'edge-sharp', label: localize('voltScratch.sharp', "Sharp") },
			{ id: 'round', icon: 'edge-round', label: localize('voltScratch.round', "Round") },
		];
		const hasWidth = shapeLike || linear || draw || has('frame') || tool('shape', 'arrow', 'line', 'draw');
		const hasStyle = shapeLike || linear || tool('shape', 'arrow', 'line');
		const hasEdges = shapeLike || has('image') || tool('shape');
		const hasPen = draw || tool('draw');
		const width = value(el => el.type === 'shape' || isLinear(el) || el.type === 'draw' || el.type === 'frame' ? el.strokeWidth : undefined, ctx.style.strokeWidth);
		const edge = value(el => el.type === 'shape' || el.type === 'image' ? el.roundness : undefined, ctx.style.roundness);
		if (hasWidth || hasStyle || hasEdges || hasPen) {
			groups.push({
				id: 'stroke',
				label: hasWidth ? localize('voltScratch.strokeGroup', "Stroke") : localize('voltScratch.edges', "Edges"),
				face: doc => scratchIcon(doc, hasWidth ? (strokeWidths.find(c => c.id === width)?.icon ?? 'stroke-bold') : (edges.find(c => c.id === edge)?.icon ?? 'edge-round'), { size: 17 }),
				build: pop => {
					if (hasWidth) {
						this.choiceRow<number>(pop, localize('voltScratch.strokeWidth', "Stroke width"), strokeWidths, width, v => this.apply({ strokeWidth: v }, el => el.type === 'shape' || isLinear(el) || el.type === 'draw' || el.type === 'frame' ? { strokeWidth: v } : undefined));
					}
					if (hasStyle) {
						this.choiceRow<ScratchStrokeStyle>(pop, localize('voltScratch.strokeStyle', "Stroke style"), [
							{ id: 'solid', icon: 'style-solid', label: localize('voltScratch.solid', "Solid") },
							{ id: 'dashed', icon: 'style-dashed', label: localize('voltScratch.dashed', "Dashed") },
							{ id: 'dotted', icon: 'style-dotted', label: localize('voltScratch.dotted', "Dotted") },
						], value(el => el.type === 'shape' || isLinear(el) ? el.strokeStyle : undefined, ctx.style.strokeStyle), v => this.apply({ strokeStyle: v }, el => el.type === 'shape' || isLinear(el) ? { strokeStyle: v } : undefined));
						this.choiceRow<number>(pop, localize('voltScratch.sloppiness', "Sloppiness"), [
							{ id: 0, icon: 'sloppy-0', label: localize('voltScratch.architect', "Architect") },
							{ id: 1, icon: 'sloppy-1', label: localize('voltScratch.artist', "Artist") },
							{ id: 2, icon: 'sloppy-2', label: localize('voltScratch.cartoonist', "Cartoonist") },
						], value(el => el.type === 'shape' || isLinear(el) ? el.roughness : undefined, ctx.style.roughness), v => this.apply({ roughness: v }, el => el.type === 'shape' || isLinear(el) ? { roughness: v } : undefined));
					}
					if (hasEdges) {
						this.choiceRow<ScratchRoundness>(pop, localize('voltScratch.edges', "Edges"), edges, edge, v => this.apply({ roundness: v }, el => el.type === 'shape' || el.type === 'image' ? { roundness: v } : undefined));
					}
					if (hasPen) {
						this.choiceRow<ScratchPenKind>(pop, localize('voltScratch.pen', "Pen"), [
							{ id: 'pen', icon: 'pencil', label: localize('voltScratch.penPen', "Pen") },
							{ id: 'highlighter', icon: 'highlighter', label: localize('voltScratch.penHighlighter', "Highlighter") },
						], value(el => el.type === 'draw' ? el.pen : undefined, ctx.style.pen), v => this.apply({ pen: v }, el => el.type === 'draw' ? { pen: v } : undefined));
					}
				},
			});
		}

		// Connectors: their path and their ends.
		if (linear || tool('arrow', 'line')) {
			const types: IChoice<ScratchArrowType>[] = [
				{ id: 'sharp', icon: 'arrow-type-sharp', label: localize('voltScratch.arrowSharp', "Straight") },
				{ id: 'round', icon: 'arrow-type-round', label: localize('voltScratch.arrowCurved', "Curved") },
				{ id: 'elbow', icon: 'arrow-type-elbow', label: localize('voltScratch.arrowElbow', "Elbow") },
			];
			const arrowType = value(el => isLinear(el) ? el.arrowType : undefined, ctx.style.arrowType);
			groups.push({
				id: 'arrow',
				label: localize('voltScratch.arrowGroup', "Arrow"),
				face: doc => scratchIcon(doc, types.find(c => c.id === arrowType)?.icon ?? 'arrow-type-round', { size: 17 }),
				build: pop => {
					this.choiceRow<ScratchArrowType>(pop, localize('voltScratch.arrowType', "Arrow type"), types, arrowType, v => this.apply({ arrowType: v }, el => isLinear(el) ? { arrowType: v } : undefined));
					this.arrowheadRow(pop, value(el => isLinear(el) ? el.startArrowhead : undefined, ctx.style.startArrowhead), value(el => isLinear(el) ? el.endArrowhead : undefined, ctx.style.endArrowhead));
				},
			});
		}

		// Text: font, size, alignment.
		if (textual || tool('text', 'note', 'card')) {
			const fontOf = (el: ScratchElement) => isRichText(el) ? el.fontFamily : hasLabel(el) ? el.label?.fontFamily : undefined;
			const sizeOf = (el: ScratchElement) => isRichText(el) ? el.fontSize : hasLabel(el) ? el.label?.fontSize : undefined;
			const alignOf = (el: ScratchElement) => isRichText(el) ? el.textAlign : hasLabel(el) ? el.label?.textAlign : undefined;
			groups.push({
				id: 'text',
				label: localize('voltScratch.textGroup', "Text"),
				face: doc => scratchIcon(doc, 'case-sensitive', { size: 18 }),
				build: pop => {
					this.choiceRow<ScratchFontFamily>(pop, localize('voltScratch.font', "Font"), [
						{ id: 'hand', icon: 'text-hand', label: localize('voltScratch.fontHand', "Hand-drawn") },
						{ id: 'sans', icon: 'text-sans', label: localize('voltScratch.fontSans', "Normal") },
						{ id: 'serif', icon: 'text-serif', label: localize('voltScratch.fontSerif', "Serif") },
						{ id: 'mono', icon: 'text-mono', label: localize('voltScratch.fontMono', "Code") },
					], value(fontOf, ctx.style.fontFamily), v => this.apply({ fontFamily: v }, el => isRichText(el) ? { fontFamily: v } : hasLabel(el) && el.label ? { label: { ...el.label, fontFamily: v } } : undefined));
					this.choiceRow<number>(pop, localize('voltScratch.fontSize', "Font size"), [
						{ id: SCRATCH_FONT_SIZES.small, icon: 'font-small', label: localize('voltScratch.small', "Small") },
						{ id: SCRATCH_FONT_SIZES.medium, icon: 'font-medium', label: localize('voltScratch.medium', "Medium") },
						{ id: SCRATCH_FONT_SIZES.large, icon: 'font-large', label: localize('voltScratch.large', "Large") },
						{ id: SCRATCH_FONT_SIZES.huge, icon: 'font-huge', label: localize('voltScratch.huge', "Extra large") },
					], value(sizeOf, ctx.style.fontSize), v => this.apply({ fontSize: v }, el => isRichText(el) ? { fontSize: v } : hasLabel(el) && el.label ? { label: { ...el.label, fontSize: v } } : undefined));
					this.choiceRow<ScratchTextAlign>(pop, localize('voltScratch.align', "Text align"), [
						{ id: 'left', icon: 'text-align-start', label: localize('voltScratch.alignLeft', "Left") },
						{ id: 'center', icon: 'text-align-center', label: localize('voltScratch.alignCenter', "Center") },
						{ id: 'right', icon: 'text-align-end', label: localize('voltScratch.alignRight', "Right") },
					], value(alignOf, ctx.style.textAlign), v => this.apply({ textAlign: v }, el => isRichText(el) ? { textAlign: v } : hasLabel(el) && el.label ? { label: { ...el.label, textAlign: v } } : undefined));
				},
			});
		}

		const opacity = value(el => el.opacity, ctx.style.opacity) ?? 100;
		groups.push({
			id: 'opacity',
			label: localize('voltScratch.opacity', "Opacity"),
			face: doc => scratchIcon(doc, 'blend', { size: 16 }),
			build: pop => this.opacityRow(pop, opacity),
		});

		if (els.length) {
			groups.push({
				id: 'arrange',
				label: localize('voltScratch.arrange', "Arrange"),
				face: doc => scratchIcon(doc, 'layers', { size: 16 }),
				build: pop => {
					this.actionRow(pop, localize('voltScratch.layers', "Layers"), [
						{ icon: 'arrow-down-to-line', label: localize('voltScratch.toBack', "Send to back"), shortcut: `${MOD}${SHIFT}[`, run: () => this.canvas.arrange('back') },
						{ icon: 'arrow-down', label: localize('voltScratch.backward', "Send backward"), shortcut: `${MOD}[`, run: () => this.canvas.arrange('backward') },
						{ icon: 'arrow-up', label: localize('voltScratch.forward', "Bring forward"), shortcut: `${MOD}]`, run: () => this.canvas.arrange('forward') },
						{ icon: 'arrow-up-from-line', label: localize('voltScratch.toFront', "Bring to front"), shortcut: `${MOD}${SHIFT}]`, run: () => this.canvas.arrange('front') },
					]);
					if (els.length > 1) {
						this.actionRow(pop, localize('voltScratch.alignment', "Align"), [
							{ icon: 'align-start-vertical', label: localize('voltScratch.alignLeftEdges', "Align left"), run: () => this.canvas.align('left') },
							{ icon: 'align-center-vertical', label: localize('voltScratch.alignCenters', "Center horizontally"), run: () => this.canvas.align('center') },
							{ icon: 'align-end-vertical', label: localize('voltScratch.alignRightEdges', "Align right"), run: () => this.canvas.align('right') },
							{ icon: 'align-start-horizontal', label: localize('voltScratch.alignTop', "Align top"), run: () => this.canvas.align('top') },
							{ icon: 'align-center-horizontal', label: localize('voltScratch.alignMiddle', "Center vertically"), run: () => this.canvas.align('middle') },
							{ icon: 'align-end-horizontal', label: localize('voltScratch.alignBottom', "Align bottom"), run: () => this.canvas.align('bottom') },
						]);
					}
					if (els.length > 2) {
						this.actionRow(pop, localize('voltScratch.distribute', "Distribute"), [
							{ icon: 'align-horizontal-distribute-center', label: localize('voltScratch.distributeH', "Distribute horizontally"), run: () => this.canvas.distribute('horizontal') },
							{ icon: 'align-vertical-distribute-center', label: localize('voltScratch.distributeV', "Distribute vertically"), run: () => this.canvas.distribute('vertical') },
						]);
					}
				},
			});
		}
		return groups;
	}

	private actions(ctx: IContext): IAction[] {
		const els = ctx.elements;
		if (!els.length) {
			return [];
		}
		const grouped = els.some(el => el.groupIds.length);
		return [
			{ icon: 'copy', label: localize('voltScratch.duplicate', "Duplicate"), shortcut: `${MOD}D`, run: () => this.canvas.duplicateSelection() },
			// allow-any-unicode-next-line
			{ icon: 'trash-2', label: localize('voltScratch.delete', "Delete"), shortcut: '⌫', run: () => this.canvas.deleteSelection() },
			{ icon: 'link', label: localize('voltScratch.addLink', "Link"), shortcut: `${MOD}K`, run: () => void this.canvas.editLinkOfSelection() },
			...(els.length > 1 ? [{ icon: 'group' as ScratchIconName, label: localize('voltScratch.group', "Group"), shortcut: `${MOD}G`, run: () => this.canvas.groupSelection() }] : []),
			...(grouped ? [{ icon: 'ungroup' as ScratchIconName, label: localize('voltScratch.ungroup', "Ungroup"), shortcut: `${MOD}${SHIFT}G`, run: () => this.canvas.ungroupSelection() }] : []),
			{ icon: 'lock', label: localize('voltScratch.lock', "Lock"), shortcut: `${MOD}${SHIFT}L`, run: () => this.canvas.toggleLockSelection() },
		];
	}

	private apply(style: Partial<IScratchStyleDefaults>, patch: (el: ScratchElement) => ScratchPatch | undefined, coalesce?: string): void {
		this.canvas.applyStyle(style, patch, coalesce);
		this.refresh();
	}

	/** A colour as the board shows it. */
	private shown(color: string): string {
		return this.canvas.isDarkBoard ? darkModeColor(color) : color;
	}

	// ---- Popover ---------------------------------------------------------------------------

	private togglePopover(id: GroupId): void {
		if (this.openGroup === id) {
			this.closePopover();
			this.canvas.focus();
			return;
		}
		this.openGroup = id;
		this.expanded = undefined;
		for (const [groupId, button] of this.triggers) {
			button.classList.toggle('open', groupId === id);
			button.setAttribute('aria-expanded', String(groupId === id));
		}
		this.renderPopover();
	}

	private renderPopover(): void {
		const group = this.openGroup ? this.groups.get(this.openGroup) : undefined;
		const trigger = this.openGroup ? this.triggers.get(this.openGroup) : undefined;
		if (!group || !trigger) {
			this.closePopover();
			return;
		}
		const doc = this.element.ownerDocument;
		if (!this.popover) {
			this.popover = append(this.element.parentElement!, $('.sx-prop-pop.sx-panel.sx-chrome-item'));
			this.popover.setAttribute('role', 'dialog');
			const pop = this.popover;
			const onDown = (e: PointerEvent) => {
				const target = e.target as Node;
				if (!pop.contains(target) && !this.element.contains(target)) {
					this.closePopover();
				}
			};
			doc.addEventListener('pointerdown', onDown, true);
			this.popoverStore.add(toDisposable(() => doc.removeEventListener('pointerdown', onDown, true)));
			this.popoverStore.add(addDisposableListener(pop, 'pointerdown', e => e.stopPropagation()));
			this.popoverStore.add(addDisposableListener(pop, 'wheel', e => e.stopPropagation()));
			this.popoverStore.add(addDisposableListener(pop, 'keydown', e => {
				if (e.key === 'Escape') {
					e.stopPropagation();
					this.dismiss();
				}
			}));
		}
		this.contentStore.clear();
		this.popover.replaceChildren();
		this.popover.setAttribute('aria-label', group.label);
		group.build(this.popover);
		// Under its button, kept inside the board.
		const host = this.element.parentElement!.getBoundingClientRect();
		const a = trigger.getBoundingClientRect();
		const bar = this.element.getBoundingClientRect();
		const left = Math.max(8, Math.min(host.width - this.popover.offsetWidth - 8, a.left - host.left - 6));
		this.popover.style.left = `${Math.round(left)}px`;
		this.popover.style.top = `${Math.round(bar.bottom - host.top + 6)}px`;
	}

	private closePopover(): void {
		this.contentStore.clear();
		this.popoverStore.clear();
		this.popover?.remove();
		this.popover = undefined;
		this.expanded = undefined;
		if (this.openGroup) {
			const trigger = this.triggers.get(this.openGroup);
			trigger?.classList.remove('open');
			trigger?.setAttribute('aria-expanded', 'false');
		}
		this.openGroup = undefined;
	}

	private section(parent: HTMLElement, label: string): HTMLElement {
		const section = append(parent, $('.sx-prop'));
		append(section, $('.sx-prop-label')).textContent = label;
		return append(section, $('.sx-prop-row'));
	}

	private swatch(parent: HTMLElement, color: string, active: boolean, label: string, run: () => void): HTMLButtonElement {
		const button = append(parent, $('button.sx-swatch')) as HTMLButtonElement;
		button.type = 'button';
		button.classList.toggle('active', active);
		button.classList.toggle('sx-transparent', color === 'transparent');
		button.setAttribute('aria-label', label);
		button.setAttribute('aria-pressed', String(active));
		if (color !== 'transparent') {
			button.style.setProperty('--sx-swatch', this.shown(color));
		}
		setAgentTooltip(button, label, undefined, undefined, 'above');
		this.contentStore.add(addDisposableListener(button, 'click', run));
		return button;
	}

	private colorRow(parent: HTMLElement, key: string, label: string, colors: readonly string[], current: string | undefined, set: (color: string) => void, allowTransparent: boolean): void {
		const row = this.section(parent, label);
		for (const color of colors) {
			this.swatch(row, color, normalizeColor(color) === normalizeColor(current ?? ''), color === 'transparent' ? localize('voltScratch.transparent', "Transparent") : color, () => set(color));
		}
		const isCustom = !!current && !colors.some(c => normalizeColor(c) === normalizeColor(current));
		const custom = this.swatch(row, current && current !== 'transparent' && isCustom ? current : '#ffffff', isCustom, localize('voltScratch.customColor', "More colours"), () => {
			this.expanded = this.expanded === key ? undefined : key;
			this.renderPopover();
		});
		custom.classList.add('sx-swatch-custom');
		custom.classList.toggle('expanded', this.expanded === key);
		if (this.expanded === key) {
			this.palette(parent, current, set, allowTransparent);
		}
	}

	/** The full palette and a hex field, under the row that opened it. */
	private palette(parent: HTMLElement, current: string | undefined, set: (color: string) => void, allowTransparent: boolean): void {
		const wrap = append(parent, $('.sx-palette'));
		const grid = append(wrap, $('.sx-color-grid'));
		for (const column of PALETTE) {
			const col = append(grid, $('.sx-color-col'));
			for (const color of column) {
				this.swatch(col, color, normalizeColor(color) === normalizeColor(current ?? ''), color, () => set(color)).classList.add('sx-swatch-small');
			}
		}
		const footer = append(wrap, $('.sx-color-footer'));
		if (allowTransparent) {
			this.swatch(footer, 'transparent', current === 'transparent', localize('voltScratch.transparent', "Transparent"), () => set('transparent')).classList.add('sx-swatch-small');
		}
		append(footer, $('span.sx-hash')).textContent = '#';
		const input = append(footer, $('input.sx-hex')) as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.maxLength = 9;
		input.value = current && current !== 'transparent' ? normalizeColor(current).replace('#', '') : '';
		input.setAttribute('aria-label', localize('voltScratch.hex', "Hex colour"));
		this.contentStore.add(addDisposableListener(input, 'keydown', e => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				const raw = input.value.trim();
				const color = raw.startsWith('#') ? raw : `#${raw}`;
				if (isValidColor(color)) {
					set(normalizeColor(color));
				} else {
					input.classList.add('invalid');
				}
			} else if (e.key === 'Escape') {
				this.dismiss();
			} else {
				input.classList.remove('invalid');
			}
		}));
	}

	private choiceRow<T extends string | number>(parent: HTMLElement, label: string, options: readonly IChoice<T>[], current: T | undefined, set: (value: T) => void): void {
		const row = this.section(parent, label);
		row.setAttribute('role', 'radiogroup');
		row.setAttribute('aria-label', label);
		for (const option of options) {
			const button = append(row, $('button.sx-choice')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'radio');
			const on = option.id === current;
			button.classList.toggle('active', on);
			button.setAttribute('aria-checked', String(on));
			button.setAttribute('aria-label', option.label);
			button.appendChild(scratchIcon(parent.ownerDocument, option.icon, { size: 18 }));
			setAgentTooltip(button, option.label, undefined, undefined, 'above');
			this.contentStore.add(addDisposableListener(button, 'click', () => set(option.id)));
		}
	}

	private arrowheadRow(parent: HTMLElement, start: ScratchArrowhead | undefined, end: ScratchArrowhead | undefined): void {
		const row = this.section(parent, localize('voltScratch.arrowheads', "Arrowheads"));
		const heads: readonly { id: ScratchArrowhead; label: string }[] = [
			{ id: 'none', label: localize('voltScratch.headNone', "None") },
			{ id: 'arrow', label: localize('voltScratch.headArrow', "Arrow") },
			{ id: 'triangle', label: localize('voltScratch.headTriangle', "Triangle") },
			{ id: 'triangle-outline', label: localize('voltScratch.headTriangleOutline', "Triangle (outline)") },
			{ id: 'dot', label: localize('voltScratch.headDot', "Dot") },
			{ id: 'circle', label: localize('voltScratch.headCircle', "Circle") },
			{ id: 'bar', label: localize('voltScratch.headBar', "Bar") },
			{ id: 'diamond', label: localize('voltScratch.headDiamond', "Diamond") },
			{ id: 'diamond-outline', label: localize('voltScratch.headDiamondOutline', "Diamond (outline)") },
			{ id: 'crowfoot-one', label: localize('voltScratch.headOne', "One (ERD)") },
			{ id: 'crowfoot-many', label: localize('voltScratch.headMany', "Many (ERD)") },
			{ id: 'crowfoot-one-or-many', label: localize('voltScratch.headOneMany', "One or many (ERD)") },
		];
		const doc = parent.ownerDocument;
		const button = (which: 'start' | 'end', current: ScratchArrowhead | undefined) => {
			const b = append(row, $('button.sx-choice.sx-head-button')) as HTMLButtonElement;
			b.type = 'button';
			const name = which === 'start' ? localize('voltScratch.startHead', "Start") : localize('voltScratch.endHead', "End");
			b.setAttribute('aria-label', name);
			b.appendChild(scratchIcon(doc, `head-${current ?? 'none'}`, { size: 22, mirror: which === 'start' }));
			setAgentTooltip(b, name, undefined, undefined, 'above');
			this.contentStore.add(addDisposableListener(b, 'click', () => {
				showVoltMenu<ScratchArrowhead>(this.contextViewService, {
					anchor: b,
					position: 'below',
					align: 'left',
					gap: 4,
					width: 236,
					ariaLabel: name,
					sections: [{
						id: 'heads', items: heads.map(h => ({
							id: h.id, label: h.label, data: h.id, checked: h.id === current,
							icon: () => scratchIcon(doc, `head-${h.id}`, { size: 20, mirror: which === 'start' }),
						})),
					}],
					onPick: item => {
						const id = item.data;
						if (which === 'start') {
							this.apply({ startArrowhead: id }, el => isLinear(el) ? { startArrowhead: id } : undefined);
						} else {
							this.apply({ endArrowhead: id }, el => isLinear(el) ? { endArrowhead: id } : undefined);
						}
					},
				});
			}));
		};
		button('start', start);
		button('end', end);
	}

	private opacityRow(parent: HTMLElement, current: number): void {
		const row = this.section(parent, localize('voltScratch.opacity', "Opacity"));
		row.classList.add('sx-slider-row');
		const input = append(row, $('input.sx-slider')) as HTMLInputElement;
		input.type = 'range';
		input.min = '0';
		input.max = '100';
		input.step = '1';
		input.value = String(current);
		input.setAttribute('aria-label', localize('voltScratch.opacity', "Opacity"));
		const out = append(row, $('span.sx-slider-value'));
		const paint = () => {
			out.textContent = `${input.value}`;
			input.style.setProperty('--sx-fill', `${input.value}%`);
		};
		paint();
		this.contentStore.add(addDisposableListener(input, 'input', () => {
			paint();
			const v = Number(input.value);
			// One undo step for the whole drag.
			this.canvas.applyStyle({ opacity: v }, () => ({ opacity: v }), 'opacity');
		}));
		this.contentStore.add(addDisposableListener(input, 'pointerdown', () => input.focus()));
		this.contentStore.add(addDisposableListener(input, 'pointerup', () => input.blur()));
		this.contentStore.add(addDisposableListener(input, 'blur', () => {
			if (this.refreshPending) {
				this.refreshPending = false;
				this.refresh();
			}
		}));
		this.contentStore.add(addDisposableListener(input, 'keydown', e => {
			e.stopPropagation();
			if (e.key === 'Escape' || e.key === 'Enter') {
				input.blur();
				this.dismiss();
			}
		}));
	}

	private actionRow(parent: HTMLElement, label: string, actions: readonly IAction[]): void {
		const row = this.section(parent, label);
		for (const action of actions) {
			const button = append(row, $('button.sx-choice')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('aria-label', action.label);
			button.appendChild(scratchIcon(parent.ownerDocument, action.icon, { size: 16 }));
			setAgentTooltip(button, action.label, action.shortcut, undefined, 'above');
			this.contentStore.add(addDisposableListener(button, 'click', () => action.run()));
		}
	}
}

function toolType(tool: ScratchTool): string {
	switch (tool) {
		case 'shape': return 'shape';
		case 'arrow': return 'arrow';
		case 'line': return 'line';
		case 'draw': return 'draw';
		case 'text': return 'text';
		case 'note': return 'note';
		case 'card': return 'card';
		case 'frame': return 'frame';
		default: return 'none';
	}
}
