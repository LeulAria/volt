/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../base/browser/dom.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { darkModeColor } from '../../common/scratchBoard/scratchColor.js';
import { Vec } from '../../common/scratchBoard/scratchMath.js';
import { isLinear, SCRATCH_BACKGROUNDS, ScratchGrid, ScratchTheme } from '../../common/scratchBoard/scratchTypes.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { IScratchBoardFiles } from './scratchBoardFiles.js';
import type { IScratchCanvasHost, ScratchCanvas } from './scratchCanvas.js';
import { scratchIcon, ScratchIconName } from './scratchIcons.js';

const MOD = isMacintosh ? '⌘' : 'Ctrl+';
const SHIFT = isMacintosh ? '⇧' : 'Shift+';
const ALT = isMacintosh ? '⌥' : 'Alt+';

type Run = () => void;

/** The document menus build icons in; set by each menu before it builds its items. */
let menuDocument: Document | undefined;

function icon(name: ScratchIconName): () => SVGElement {
	const doc = menuDocument;
	return () => scratchIcon(doc ?? (globalThis as { document?: Document }).document!, name, { size: 16 });
}

function swatchIcon(color: string): () => HTMLElement {
	return () => {
		const dot = $('span.sx-menu-swatch');
		dot.style.background = color;
		return dot;
	};
}

function item(id: string, label: string, run: Run, extra: Partial<IVoltMenuItem<Run>> = {}): IVoltMenuItem<Run> {
	return { id, label, data: run, ...extra };
}

function backgroundItems(canvas: ScratchCanvas): IVoltMenuItem<Run>[] {
	const current = canvas.scene?.settings.background;
	const names = [
		localize('voltScratch.bg.white', "White"),
		localize('voltScratch.bg.paper', "Paper"),
		localize('voltScratch.bg.sky', "Sky"),
		localize('voltScratch.bg.cream', "Cream"),
		localize('voltScratch.bg.blush', "Blush"),
		localize('voltScratch.bg.lavender', "Lavender"),
		localize('voltScratch.bg.mint', "Mint"),
	];
	return SCRATCH_BACKGROUNDS.map((color, i) => item(`bg-${color}`, names[i] ?? color, () => canvas.setSettings({ background: color }), {
		icon: swatchIcon(canvas.isDarkBoard ? darkModeColor(color) : color),
		checked: current === color,
	}));
}

function gridItems(canvas: ScratchCanvas): IVoltMenuItem<Run>[] {
	const current = canvas.scene?.settings.grid;
	const grid = (id: ScratchGrid, label: string, i: ScratchIconName) => item(`grid-${id}`, label, () => canvas.setSettings({ grid: id }), { checked: current === id, icon: icon(i) });
	return [
		grid('none', localize('voltScratch.grid.none', "None"), 'grid-none'),
		grid('dots', localize('voltScratch.grid.dots', "Dots"), 'grid-dots'),
		grid('lines', localize('voltScratch.grid.lines', "Lines"), 'grid-3x3'),
	];
}

function themeItems(canvas: ScratchCanvas): IVoltMenuItem<Run>[] {
	const current = canvas.scene?.settings.theme;
	const theme = (id: ScratchTheme, label: string, i: ScratchIconName) => item(`theme-${id}`, label, () => canvas.setSettings({ theme: id }), { checked: current === id, icon: icon(i) });
	return [
		theme('auto', localize('voltScratch.theme.auto', "Match Volt"), 'palette'),
		theme('light', localize('voltScratch.theme.light', "Light"), 'sun'),
		theme('dark', localize('voltScratch.theme.dark', "Dark"), 'moon'),
	];
}

function show(accessor: ServicesAccessor, anchor: HTMLElement, sections: IVoltMenuSection<Run>[], label: string, onHide?: () => void, width = 260): void {
	const contextViewService = accessor.get(IContextViewService);
	showVoltMenu<Run>(contextViewService, {
		anchor,
		position: 'below',
		align: 'left',
		gap: 6,
		width,
		ariaLabel: label,
		sections,
		onPick: picked => picked.data(),
		onHide,
	});
}

export function showScratchMainMenu(accessor: ServicesAccessor, canvas: ScratchCanvas, host: IScratchCanvasHost, anchor: HTMLElement): void {
	menuDocument = canvas.element.ownerDocument;
	const dialogService = accessor.get(IDialogService);
	const files = accessor.get(IScratchBoardFiles);
	const settings = canvas.scene?.settings;
	const sections: IVoltMenuSection<Run>[] = [
		{
			id: 'board', items: [
				item('new', localize('voltScratch.newBoard', "New Board"), () => host.newBoard(), { icon: icon('file-plus') }),
				item('history', localize('voltScratch.versionHistory', "Version History"), () => host.showVersionHistory(), { icon: icon('history') }),
				item('find', localize('voltScratch.find', "Find on Board"), () => void canvas.findElements(), { icon: icon('search'), keybinding: `${MOD}F` }),
			],
		},
		{
			id: 'share', items: [
				item('ask', localize('voltScratch.askBoardMenu', "Send Board to Agent"), () => canvas.openComposer(true), { icon: icon('agent-spark') }),
				item('png', localize('voltScratch.exportPngMenu', "Export as PNG"), () => void canvas.exporter.exportImage(canvas, 'png'), { icon: icon('download'), keybinding: `${MOD}${SHIFT}E` }),
				item('svg', localize('voltScratch.exportSvgMenu', "Export as SVG"), () => void canvas.exporter.exportImage(canvas, 'svg'), { icon: icon('download') }),
				item('copy', localize('voltScratch.copyBoardPng', "Copy Board as PNG"), () => { canvas.select([]); void canvas.copySelectionAsPng(); }, { icon: icon('copy') }),
				// A .scratch file in the project, kept up to date by later edits; opening it shows the board.
				item('file', localize('voltScratch.saveAsFile', "Save as File"), () => {
					const boardId = canvas.model?.id;
					if (boardId) {
						void files.saveAs(boardId);
					}
				}, { icon: icon('file') }),
			],
		},
		{
			id: 'view', items: [
				item('fit', localize('voltScratch.zoomFitMenu', "Zoom to Fit"), () => canvas.zoomToFit(), { icon: icon('scan'), keybinding: `${SHIFT}1` }),
				item('background', localize('voltScratch.backgroundMenu', "Background"), () => undefined, { icon: icon('palette'), submenu: { width: 200, sections: [{ id: 'bg', items: backgroundItems(canvas) }] } }),
				item('grid', localize('voltScratch.gridMenu', "Grid"), () => undefined, { icon: icon('grid-3x3'), keybinding: `${MOD}'`, submenu: { width: 180, sections: [{ id: 'grid', items: gridItems(canvas) }] } }),
				item('theme', localize('voltScratch.themeMenu', "Theme"), () => undefined, { icon: icon('sun'), submenu: { width: 190, sections: [{ id: 'theme', items: themeItems(canvas) }] } }),
				// Read at the click: the settings object is replaced on every change. The menu closes so its checks stay true.
				item('snap', localize('voltScratch.snapObjects', "Snap to Objects"), () => canvas.setSnapToObjects(!canvas.scene?.settings.snapToObjects), { checked: !!settings?.snapToObjects, keybinding: `${ALT}S` }),
				item('snapGrid', localize('voltScratch.snapGrid', "Snap to Grid"), () => canvas.setSettings({ snapToGrid: !canvas.scene?.settings.snapToGrid }), { checked: !!settings?.snapToGrid }),
				item('links', localize('voltScratch.highlightConnections', "Highlight Connections"), () => canvas.setHighlightConnections(!canvas.highlightConnections), { checked: canvas.highlightConnections }),
			],
		},
		{
			id: 'help', items: [
				item('keys', localize('voltScratch.shortcuts', "Keyboard Shortcuts"), () => canvas.showShortcuts(), { icon: icon('keyboard'), keybinding: `${MOD}/` }),
				item('clear', localize('voltScratch.clearBoard', "Clear Board"), async () => {
					const { confirmed } = await dialogService.confirm({
						message: localize('voltScratch.clearConfirm', "Clear everything on this board?"),
						detail: localize('voltScratch.clearDetail', "You can undo this, and earlier versions stay in Version History."),
						primaryButton: localize('voltScratch.clearButton', "Clear Board"),
					});
					if (confirmed) {
						canvas.clearBoard();
					}
				}, { icon: icon('trash-2'), disabled: !canvas.scene?.size }),
			],
		},
	];
	show(accessor, anchor, sections, localize('voltScratch.menu', "Menu"));
}

/** Right-click: what applies to the selection, or to the board when nothing is under the pointer. */
export function showScratchContextMenu(accessor: ServicesAccessor, canvas: ScratchCanvas, at: { readonly x: number; readonly y: number }, world: Vec): void {
	const doc = canvas.element.ownerDocument;
	menuDocument = doc;
	const anchor = $('span.sx-menu-anchor');
	anchor.style.position = 'fixed';
	anchor.style.left = `${at.x}px`;
	anchor.style.top = `${at.y}px`;
	anchor.style.width = '1px';
	anchor.style.height = '1px';
	doc.body.appendChild(anchor);
	const selected = canvas.selectedElements();
	const sections: IVoltMenuSection<Run>[] = [];
	if (selected.length) {
		// Excalidraw's element menu, in its order, with the board's own actions (agent, align, link, export) in one section of their own.
		const locked = selected.every(el => el.locked);
		const grouped = selected.some(el => el.groupIds.length);
		const connectedShapes = selected.filter(el => !isLinear(el)).length > 1;
		const frames = selected.filter(el => el.type === 'frame');
		const inFrame = selected.some(el => el.type !== 'frame' && el.frameId);
		const texts = selected.some(el => el.type === 'text');
		sections.push({
			id: 'clipboard', items: [
				...(!locked ? [item('cut', localize('voltScratch.cutMenu', "Cut"), () => canvas.copyToClipboard(true), { keybinding: `${MOD}X`, icon: icon('scissors') })] : []),
				item('copy', localize('voltScratch.copyMenu', "Copy"), () => canvas.copyToClipboard(false), { keybinding: `${MOD}C`, icon: icon('copy') }),
				item('paste', localize('voltScratch.pasteMenu', "Paste"), () => void canvas.pasteFromClipboard(world), { keybinding: `${MOD}V`, icon: icon('clipboard-paste') }),
			],
		});
		if (!locked) {
			const frameItems = [
				...(!frames.length ? [item('wrapFrame', localize('voltScratch.wrapInFrameMenu', "Wrap selection in frame"), () => canvas.wrapSelectionInFrame(), { icon: icon('frame') })] : []),
				...(frames.length === 1 && selected.length === 1 ? [item('frameAll', localize('voltScratch.selectFrameContents', "Select all elements in frame"), () => canvas.selectFrameContents(), { icon: icon('square-dashed') })] : []),
				...(inFrame ? [item('unframe', localize('voltScratch.removeFromFrameMenu', "Remove from frame"), () => canvas.removeSelectionFromFrame(), { icon: icon('x') })] : []),
			];
			if (frameItems.length) {
				sections.push({ id: 'frame', items: frameItems });
			}
		}
		sections.push({
			id: 'export', items: [
				item('png', localize('voltScratch.copyPngClipboard', "Copy to clipboard as PNG"), () => void canvas.copySelectionAsPng(), { keybinding: `${SHIFT}${ALT}C`, icon: icon('image') }),
				item('svg', localize('voltScratch.copySvgClipboard', "Copy to clipboard as SVG"), () => void canvas.copySelectionAsSvg(), { icon: icon('code-xml') }),
				...(canvas.selectionHasText() ? [item('text', localize('voltScratch.copyTextClipboard', "Copy to clipboard as text"), () => void canvas.copySelectionAsText(), { icon: icon('type') })] : []),
			],
		});
		if (!locked) {
			sections.push({
				id: 'style', items: [
					item('copyStyle', localize('voltScratch.copyStyles', "Copy styles"), () => canvas.copyStyles(), { keybinding: `${ALT}${MOD}C`, icon: icon('pipette') }),
					item('pasteStyle', localize('voltScratch.pasteStyles', "Paste styles"), () => canvas.pasteStyles(), { keybinding: `${ALT}${MOD}V`, icon: icon('palette'), disabled: !canvas.hasCopiedStyle }),
				],
			});
			const groupItems = [
				...(selected.length > 1 ? [item('group', localize('voltScratch.groupSelection', "Group selection"), () => canvas.groupSelection(), { keybinding: `${MOD}G`, icon: icon('group') })] : []),
				...(texts ? [item('wrapText', localize('voltScratch.wrapTextMenu', "Wrap text in a container"), () => canvas.wrapTextInContainer(), { icon: icon('square') })] : []),
				...(grouped ? [item('ungroup', localize('voltScratch.ungroupSelection', "Ungroup selection"), () => canvas.ungroupSelection(), { keybinding: `${SHIFT}${MOD}G`, icon: icon('ungroup') })] : []),
			];
			if (groupItems.length) {
				sections.push({ id: 'group', items: groupItems });
			}
		}
		sections.push({
			id: 'library', items: [
				item('library', localize('voltScratch.addToLibrary', "Add to library"), () => void canvas.addSelectionToLibrary(), { icon: icon('library-big') }),
			],
		});
		sections.push({
			id: 'board', items: [
				// allow-any-unicode-next-line
				item('ask', localize('voltScratch.sendSelection', "Send to Agent"), () => canvas.openComposer(false), { keybinding: `${MOD}↵`, icon: icon('agent-spark') }),
				...(!locked ? [item('link', selected[0].link ? localize('voltScratch.editLink', "Edit Link") : localize('voltScratch.addLinkMenu', "Add Link"), () => void canvas.editLinkOfSelection(), { keybinding: `${MOD}K`, icon: icon('link') })] : []),
				...(!locked && selected.length > 1 ? [item('align', localize('voltScratch.alignMenu', "Align"), () => undefined, {
					icon: icon('align-center-vertical'), submenu: {
						width: 250, sections: [{
							id: 'align', items: [
								// allow-any-unicode-next-line
								item('l', localize('voltScratch.alignLeftEdges', "Align left"), () => canvas.align('left'), { keybinding: `${SHIFT}${MOD}←` }),
								item('c', localize('voltScratch.alignCenters', "Center horizontally"), () => canvas.align('center')),
								// allow-any-unicode-next-line
								item('r', localize('voltScratch.alignRightEdges', "Align right"), () => canvas.align('right'), { keybinding: `${SHIFT}${MOD}→` }),
								// allow-any-unicode-next-line
								item('t', localize('voltScratch.alignTop', "Align top"), () => canvas.align('top'), { keybinding: `${SHIFT}${MOD}↑` }),
								item('m', localize('voltScratch.alignMiddle', "Center vertically"), () => canvas.align('middle')),
								// allow-any-unicode-next-line
								item('b', localize('voltScratch.alignBottom', "Align bottom"), () => canvas.align('bottom'), { keybinding: `${SHIFT}${MOD}↓` }),
								...(selected.length > 2 ? [
									item('dh', localize('voltScratch.distributeH', "Distribute horizontally"), () => canvas.distribute('horizontal')),
									item('dv', localize('voltScratch.distributeV', "Distribute vertically"), () => canvas.distribute('vertical')),
								] : []),
							],
						}],
					},
				})] : []),
				...(!locked && connectedShapes ? [item('tidy', localize('voltScratch.tidyMenu', "Tidy Up"), () => undefined, {
					icon: icon('workflow'), submenu: {
						width: 200, sections: [{
							id: 'tidy', items: [
								item('lr', localize('voltScratch.tidyLR', "Left to right"), () => canvas.tidySelection('LR')),
								item('tb', localize('voltScratch.tidyTB', "Top to bottom"), () => canvas.tidySelection('TB')),
							],
						}],
					},
				})] : []),
				item('export', localize('voltScratch.exportSelection', "Export Selection"), () => undefined, {
					icon: icon('download'), submenu: {
						width: 190, sections: [{
							id: 'export', items: [
								item('png', 'PNG', () => void canvas.exporter.exportImage(canvas, 'png', true)),
								item('svg', 'SVG', () => void canvas.exporter.exportImage(canvas, 'svg', true)),
							],
						}],
					},
				}),
			],
		});
		if (!locked) {
			sections.push({
				id: 'arrange', items: [
					item('backward', localize('voltScratch.backward', "Send backward"), () => canvas.arrange('backward'), { keybinding: `${MOD}[`, icon: icon('arrow-down') }),
					item('forward', localize('voltScratch.forward', "Bring forward"), () => canvas.arrange('forward'), { keybinding: `${MOD}]`, icon: icon('arrow-up') }),
					item('back', localize('voltScratch.toBack', "Send to back"), () => canvas.arrange('back'), { keybinding: `${ALT}${MOD}[`, icon: icon('send-to-back') }),
					item('front', localize('voltScratch.toFront', "Bring to front"), () => canvas.arrange('front'), { keybinding: `${ALT}${MOD}]`, icon: icon('bring-to-front') }),
				],
			});
			sections.push({
				id: 'flip', items: [
					item('flipH', localize('voltScratch.flipHorizontal', "Flip horizontal"), () => canvas.flipSelection('horizontal'), { keybinding: `${SHIFT}H`, icon: icon('flip-horizontal-2') }),
					item('flipV', localize('voltScratch.flipVertical', "Flip vertical"), () => canvas.flipSelection('vertical'), { keybinding: `${SHIFT}V`, icon: icon('flip-vertical-2') }),
				],
			});
		}
		sections.push({
			id: 'lock', items: [
				...(!locked ? [item('dup', localize('voltScratch.duplicateMenu', "Duplicate"), () => canvas.duplicateSelection(), { keybinding: `${MOD}D`, icon: icon('copy') })] : []),
				item('lock', locked ? localize('voltScratch.unlockMenu', "Unlock") : localize('voltScratch.lockMenu', "Lock"), () => canvas.toggleLockSelection(), { keybinding: `${SHIFT}${MOD}L`, icon: icon(locked ? 'lock-open' : 'lock') }),
			],
		});
		if (!locked) {
			sections.push({
				id: 'delete', items: [
					// allow-any-unicode-next-line
					item('delete', localize('voltScratch.deleteMenu', "Delete"), () => canvas.deleteSelection(), { keybinding: '⌫', icon: icon('trash-2'), className: 'sx-menu-danger' }),
				],
			});
		}
	} else {
		// Excalidraw's canvas menu, plus the board's own (agent, background, zoom).
		const hasElements = !!canvas.scene?.size;
		const settings = canvas.scene?.settings;
		sections.push({
			id: 'clipboard', items: [
				item('paste', localize('voltScratch.pasteMenu', "Paste"), () => void canvas.pasteFromClipboard(world), { keybinding: `${MOD}V`, icon: icon('clipboard-paste') }),
				item('text', localize('voltScratch.addTextHere', "Add Text Here"), () => canvas.createTextAt(world), { icon: icon('type') }),
			],
		});
		if (hasElements) {
			sections.push({
				id: 'export', items: [
					item('png', localize('voltScratch.copyPngClipboard', "Copy to clipboard as PNG"), () => void canvas.copySelectionAsPng(), { keybinding: `${SHIFT}${ALT}C`, icon: icon('image') }),
					item('svg', localize('voltScratch.copySvgClipboard', "Copy to clipboard as SVG"), () => void canvas.copySelectionAsSvg(), { icon: icon('code-xml') }),
				],
			});
		}
		sections.push({
			id: 'select', items: [
				item('all', localize('voltScratch.selectAll', "Select All"), () => canvas.selectAll(), { keybinding: `${MOD}A`, icon: icon('mouse-pointer-2'), disabled: !hasElements }),
				...(canvas.hasLockedElements() ? [item('unlock', localize('voltScratch.unlockAll', "Unlock all"), () => canvas.unlockAll(), { icon: icon('lock-open') })] : []),
			],
		});
		sections.push({
			id: 'toggles', items: [
				item('grid', localize('voltScratch.toggleGrid', "Toggle grid"), () => canvas.toggleGrid(), { keybinding: `${MOD}'`, icon: icon('grid-3x3'), checked: settings?.grid !== 'none' }),
				item('snap', localize('voltScratch.snapObjects', "Snap to Objects"), () => canvas.setSnapToObjects(!canvas.scene?.settings.snapToObjects), { keybinding: `${ALT}S`, icon: icon('locate-fixed'), checked: !!settings?.snapToObjects }),
				item('theme', localize('voltScratch.toggleTheme', "Dark board"), () => canvas.toggleBoardTheme(), { keybinding: `${SHIFT}${ALT}D`, icon: icon('moon'), checked: canvas.isDarkBoard }),
			],
		});
		sections.push({
			id: 'view', items: [
				item('ask', localize('voltScratch.askBoardMenu', "Send Board to Agent"), () => canvas.openComposer(true), { icon: icon('agent-spark') }),
				item('fit', localize('voltScratch.zoomFitMenu', "Zoom to Fit"), () => canvas.zoomToFit(), { keybinding: `${SHIFT}1`, icon: icon('scan') }),
				item('background', localize('voltScratch.backgroundMenu', "Background"), () => undefined, { icon: icon('palette'), submenu: { width: 200, sections: [{ id: 'bg', items: backgroundItems(canvas) }] } }),
			],
		});
	}
	show(accessor, anchor, sections, localize('voltScratch.contextMenu', "Board actions"), () => anchor.remove(), 280);
}
