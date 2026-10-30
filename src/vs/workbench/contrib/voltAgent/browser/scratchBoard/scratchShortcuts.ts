/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { scratchIcon } from './scratchIcons.js';

const MOD = isMacintosh ? '⌘' : 'Ctrl';
const SHIFT = isMacintosh ? '⇧' : 'Shift';
const ALT = isMacintosh ? '⌥' : 'Alt';

/** The keyboard cheat sheet (Cmd+/ or ?), laid out in columns like Excalidraw's. */
export function showScratchShortcuts(_accessor: ServicesAccessor, host: HTMLElement): void {
	if (host.querySelector('.sx-shortcuts')) {
		return;
	}
	const groups: { title: string; rows: [string, string[]][] }[] = [
		{
			title: localize('voltScratch.keys.tools', "Tools"), rows: [
				[localize('voltScratch.tool.select', "Select"), ['V', '1']],
				[localize('voltScratch.tool.hand', "Hand"), ['H']],
				[localize('voltScratch.shape.rectangle', "Rectangle"), ['R', '2']],
				[localize('voltScratch.shape.diamond', "Diamond"), ['D', '3']],
				[localize('voltScratch.shape.ellipse', "Ellipse"), ['O', '4']],
				[localize('voltScratch.tool.arrow', "Arrow"), ['A', '5']],
				[localize('voltScratch.tool.line', "Line"), ['L', '6']],
				[localize('voltScratch.tool.draw', "Draw"), ['P', '7']],
				[localize('voltScratch.tool.text', "Text"), ['T', '8']],
				[localize('voltScratch.tool.image', "Image"), ['9']],
				[localize('voltScratch.tool.eraser', "Eraser"), ['E', '0']],
				[localize('voltScratch.tool.note', "Sticky note"), ['N']],
				[localize('voltScratch.tool.card', "Markdown card"), ['M']],
				[localize('voltScratch.tool.frame', "Frame"), ['F']],
				[localize('voltScratch.tool.laser', "Laser pointer"), ['K']],
				[localize('voltScratch.keys.lockTool', "Keep tool"), ['Q']],
				[localize('voltScratch.library', "Library"), [`${SHIFT} L`]],
			],
		},
		{
			title: localize('voltScratch.keys.view', "View"), rows: [
				[localize('voltScratch.keys.pan', "Move the board"), [localize('voltScratch.keys.space', "Space + drag"), localize('voltScratch.keys.scroll', "Scroll")]],
				[localize('voltScratch.keys.zoom', "Zoom"), [`${MOD} +`, `${MOD} -`, localize('voltScratch.keys.pinch', "Pinch")]],
				[localize('voltScratch.zoomReset', "Reset zoom"), [`${SHIFT} 0`]],
				[localize('voltScratch.zoomFit', "Zoom to fit"), [`${SHIFT} 1`]],
				[localize('voltScratch.keys.zoomSel', "Zoom to selection"), [`${SHIFT} 2`]],
				[localize('voltScratch.find', "Find on Board"), [`${MOD} F`]],
				[localize('voltScratch.keys.grid', "Toggle grid"), [`${MOD} '`]],
				[localize('voltScratch.snapObjects', "Snap to Objects"), [`${ALT} S`]],
				[localize('voltScratch.keys.noSnap', "Move without snapping"), [`${MOD} + drag`]],
				[localize('voltScratch.keys.theme', "Light or dark board"), [`${SHIFT} ${ALT} D`]],
			],
		},
		{
			title: localize('voltScratch.keys.edit', "Edit"), rows: [
				[localize('voltScratch.undo', "Undo"), [`${MOD} Z`]],
				[localize('voltScratch.redo', "Redo"), [`${SHIFT} ${MOD} Z`]],
				[localize('voltScratch.keys.copy', "Copy"), [`${MOD} C`]],
				[localize('voltScratch.keys.cut', "Cut"), [`${MOD} X`]],
				[localize('voltScratch.keys.paste', "Paste"), [`${MOD} V`]],
				[localize('voltScratch.keys.pastePlain', "Paste as plain text"), [`${SHIFT} ${MOD} V`]],
				[localize('voltScratch.duplicate', "Duplicate"), [`${MOD} D`, `${ALT} + drag`]],
				[localize('voltScratch.keys.delete', "Delete"), [localize('voltScratch.keys.deleteKey', "Delete"), localize('voltScratch.keys.backspace', "Backspace")]],
				[localize('voltScratch.selectAll', "Select All"), [`${MOD} A`]],
				[localize('voltScratch.keys.deselect', "Deselect"), ['Esc']],
				[localize('voltScratch.copyStyle', "Copy Style"), [`${ALT} ${MOD} C`]],
				[localize('voltScratch.pasteStyle', "Paste Style"), [`${ALT} ${MOD} V`]],
				[localize('voltScratch.copyPng', "Copy as PNG"), [`${SHIFT} ${ALT} C`, `${SHIFT} ${MOD} C`]],
				[localize('voltScratch.keys.edit2', "Edit text"), ['Enter', localize('voltScratch.keys.dbl', "Double-click")]],
				[localize('voltScratch.sendToAgent', "Send to agent"), [`${MOD} Enter`]],
			],
		},
		{
			title: localize('voltScratch.keys.arrange', "Arrange"), rows: [
				[localize('voltScratch.keys.nudge', "Move"), [localize('voltScratch.keys.arrows', "Arrows")]],
				[localize('voltScratch.keys.nudgeFar', "Move 10px"), [`${SHIFT} + ${localize('voltScratch.keys.arrows', "Arrows")}`]],
				[localize('voltScratch.keys.align', "Align to a side"), [`${SHIFT} ${MOD} + ${localize('voltScratch.keys.arrows', "Arrows")}`]],
				[localize('voltScratch.group', "Group"), [`${MOD} G`]],
				[localize('voltScratch.ungroup', "Ungroup"), [`${SHIFT} ${MOD} G`]],
				[localize('voltScratch.keys.enterGroup', "Select inside a group"), [localize('voltScratch.keys.dbl', "Double-click")]],
				[localize('voltScratch.lock', "Lock"), [`${SHIFT} ${MOD} L`]],
				[localize('voltScratch.keys.forward', "Bring forward"), [`${MOD} ]`]],
				[localize('voltScratch.keys.backward', "Send backward"), [`${MOD} [`]],
				[localize('voltScratch.toFront', "Bring to front"), [`${SHIFT} ${MOD} ]`]],
				[localize('voltScratch.toBack', "Send to back"), [`${SHIFT} ${MOD} [`]],
				[localize('voltScratch.flipH', "Flip Horizontal"), [`${SHIFT} H`]],
				[localize('voltScratch.flipV', "Flip Vertical"), [`${SHIFT} V`]],
				[localize('voltScratch.keys.fontSize', "Text bigger / smaller"), [`${SHIFT} ${MOD} >`, `${SHIFT} ${MOD} <`]],
			],
		},
		{
			title: localize('voltScratch.keys.text', "Text"), rows: [
				[localize('voltScratch.bold', "Bold"), [`${MOD} B`, '**text**']],
				[localize('voltScratch.italic', "Italic"), [`${MOD} I`, '*text*']],
				[localize('voltScratch.underline', "Underline"), [`${MOD} U`]],
				[localize('voltScratch.strike', "Strikethrough"), [`${SHIFT} ${MOD} X`, '~~text~~']],
				[localize('voltScratch.inlineCode', "Code"), [`${MOD} E`, '`code`']],
				[localize('voltScratch.link', "Link"), [`${MOD} K`]],
				[localize('voltScratch.keys.headings', "Headings"), [`${MOD} 1-3`, '# ']],
				[localize('voltScratch.bullets', "Bulleted list"), ['- ']],
				[localize('voltScratch.numbers', "Numbered list"), ['1. ']],
				[localize('voltScratch.checklist', "Checklist"), ['[] ']],
				[localize('voltScratch.quote', "Quote"), ['> ']],
				[localize('voltScratch.codeBlock', "Code block"), ['``` ']],
				[localize('voltScratch.keys.done', "Done editing"), ['Esc']],
			],
		},
	];
	const store = new DisposableStore();
	const backdrop = append(host, $('.sx-modal-backdrop.sx-shortcuts.sx-chrome-item'));
	const dialog = append(backdrop, $('.sx-modal.sx-panel.sx-shortcuts-dialog'));
	dialog.setAttribute('role', 'dialog');
	dialog.setAttribute('aria-label', localize('voltScratch.shortcuts', "Keyboard Shortcuts"));
	dialog.tabIndex = -1;
	const header = append(dialog, $('.sx-modal-header'));
	append(header, $('.sx-modal-title')).textContent = localize('voltScratch.shortcuts', "Keyboard Shortcuts");
	const close = append(header, $('button.sx-icon-button')) as HTMLButtonElement;
	close.type = 'button';
	close.setAttribute('aria-label', localize('voltScratch.close', "Close"));
	close.appendChild(scratchIcon(host.ownerDocument, 'x', { size: 14 }));
	const columns = append(dialog, $('.sx-shortcut-columns'));
	for (const group of groups) {
		const col = append(columns, $('.sx-shortcut-group'));
		append(col, $('.sx-shortcut-title')).textContent = group.title;
		for (const [label, keys] of group.rows) {
			const row = append(col, $('.sx-shortcut-row'));
			append(row, $('span.sx-shortcut-label')).textContent = label;
			const keysEl = append(row, $('span.sx-shortcut-keys'));
			keys.forEach((k, i) => {
				if (i > 0) {
					append(keysEl, $('span.sx-shortcut-or')).textContent = localize('voltScratch.keys.or', "or");
				}
				append(keysEl, $('kbd')).textContent = k;
			});
		}
	}
	const done = () => {
		store.dispose();
		backdrop.remove();
		host.focus({ preventScroll: true });
	};
	store.add(addDisposableListener(close, 'click', done));
	store.add(addDisposableListener(backdrop, 'pointerdown', e => {
		e.stopPropagation();
		if (e.target === backdrop) {
			done();
		}
	}));
	store.add(addDisposableListener(backdrop, 'wheel', e => e.stopPropagation()));
	store.add(addDisposableListener(dialog, 'keydown', e => {
		e.stopPropagation();
		if (e.key === 'Escape' || (e.key === '/' && (e.metaKey || e.ctrlKey))) {
			e.preventDefault();
			done();
		}
	}));
	dialog.focus();
}
