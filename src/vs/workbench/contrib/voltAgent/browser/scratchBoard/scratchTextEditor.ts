/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { looksLikeMarkdown } from '../../common/scratchBoard/scratchHtml.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { scratchIcon, ScratchIconName } from './scratchIcons.js';
import { liftNestedBlocks, markdownToRichHtml, normalizeRichDom, pastedHtmlToRich, setRichHtml, trustedRichHtml, wrapLooseInline } from './scratchRichText.js';

export type ScratchTextFormat =
	| 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link'
	| 'h1' | 'h2' | 'h3' | 'paragraph' | 'bullets' | 'numbers' | 'checklist' | 'quote' | 'codeblock';

export interface IScratchTextTarget {
	readonly elementId: string;
	/** Rich text elements edit their body; shapes, connectors and icons edit a label. */
	readonly kind: 'rich' | 'label';
	readonly host: HTMLElement;
	readonly initialHtml: string;
}

export interface IScratchTextEditorHost {
	commit(target: IScratchTextTarget, html: string): void;
	/** Size or content changed while typing: move the selection outline. */
	didInput(target: IScratchTextTarget): void;
	/** Asks for a link URL (keeps the text selection while asking). */
	askLink(current: string | undefined): Promise<string | undefined>;
}

/**
 * Edits text in place: the element's own node becomes contenteditable, so what you type is laid
 * out exactly as it will be shown. Supports the usual shortcuts and markdown as you type.
 */
export class ScratchTextEditor extends Disposable {

	private target: IScratchTextTarget | undefined;
	private readonly session = this._register(new DisposableStore());
	private committing = false;

	constructor(private readonly host: IScratchTextEditorHost) {
		super();
		this._register(toDisposable(() => this.commit()));
	}

	get active(): IScratchTextTarget | undefined {
		return this.target;
	}

	isEditing(elementId: string): boolean {
		return this.target?.elementId === elementId;
	}

	start(target: IScratchTextTarget, caret: { readonly x: number; readonly y: number } | 'end' | 'all' = 'end'): void {
		this.commit();
		this.target = target;
		const node = target.host;
		const doc = node.ownerDocument;
		setRichHtml(node, target.initialHtml);
		if (!node.firstChild) {
			// An empty paragraph gives the caret a line to sit on, with the right font metrics.
			const p = doc.createElement('p');
			p.appendChild(doc.createElement('br'));
			node.appendChild(p);
		}
		node.contentEditable = 'true';
		node.spellcheck = true;
		node.classList.add('sx-editing-text');
		node.setAttribute('role', 'textbox');
		node.setAttribute('aria-multiline', 'true');
		node.setAttribute('aria-label', localize('voltScratch.textEditor', "Text"));
		try {
			doc.execCommand('defaultParagraphSeparator', false, 'p');
			doc.execCommand('styleWithCSS', false, 'false');
		} catch {
			// Older engines ignore these.
		}
		node.focus({ preventScroll: true });
		this.placeCaret(node, caret);

		this.session.add(addDisposableListener(node, 'keydown', e => this.onKeyDown(e)));
		this.session.add(addDisposableListener(node, 'input', e => this.onInput(e as InputEvent)));
		this.session.add(addDisposableListener(node, 'paste', e => this.onPaste(e)));
		this.session.add(addDisposableListener(node, 'pointerdown', e => {
			// Clicks inside the text place the caret; they never start a canvas gesture.
			e.stopPropagation();
			this.maybeToggleCheck(e);
		}));
		this.session.add(addDisposableListener(node, 'dblclick', e => e.stopPropagation()));
		this.session.add(addDisposableListener(node, 'wheel', e => {
			// Let the board pan and zoom, not the text scroll.
			e.preventDefault();
		}, { passive: false }));
	}

	private placeCaret(node: HTMLElement, caret: { readonly x: number; readonly y: number } | 'end' | 'all'): void {
		const doc = node.ownerDocument;
		const selection = getWindow(node).getSelection();
		if (!selection) {
			return;
		}
		const range = doc.createRange();
		if (caret === 'all') {
			range.selectNodeContents(node);
		} else if (caret === 'end') {
			range.selectNodeContents(node);
			range.collapse(false);
		} else {
			const position = (doc as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null }).caretPositionFromPoint?.(caret.x, caret.y);
			if (position && node.contains(position.offsetNode)) {
				range.setStart(position.offsetNode, position.offset);
				range.collapse(true);
			} else {
				range.selectNodeContents(node);
				range.collapse(false);
			}
		}
		selection.removeAllRanges();
		selection.addRange(range);
	}

	/** Ends editing and hands the cleaned text to the host. */
	commit(): void {
		const target = this.target;
		if (!target || this.committing) {
			return;
		}
		this.committing = true;
		try {
			const node = target.host;
			const clone = node.cloneNode(true) as HTMLElement;
			stripZeroWidth(clone);
			const html = normalizeRichDom(clone);
			this.session.clear();
			node.contentEditable = 'false';
			node.removeAttribute('contenteditable');
			node.removeAttribute('role');
			node.removeAttribute('aria-multiline');
			node.removeAttribute('aria-label');
			node.classList.remove('sx-editing-text');
			this.target = undefined;
			const selection = getWindow(node).getSelection();
			if (selection && node.contains(selection.anchorNode)) {
				selection.removeAllRanges();
			}
			this.host.commit(target, html);
		} finally {
			this.committing = false;
		}
	}

	format(format: ScratchTextFormat): void {
		const target = this.target;
		if (!target) {
			return;
		}
		const doc = target.host.ownerDocument;
		target.host.focus({ preventScroll: true });
		switch (format) {
			case 'bold': doc.execCommand('bold'); break;
			case 'italic': doc.execCommand('italic'); break;
			case 'underline': doc.execCommand('underline'); break;
			case 'strike': doc.execCommand('strikeThrough'); break;
			case 'code': this.toggleInlineCode(); break;
			case 'link': void this.editLink(); break;
			case 'h1': this.toggleBlock('h1'); break;
			case 'h2': this.toggleBlock('h2'); break;
			case 'h3': this.toggleBlock('h3'); break;
			case 'quote': this.toggleBlock('blockquote'); break;
			case 'codeblock': this.toggleBlock('pre'); break;
			case 'paragraph': doc.execCommand('formatBlock', false, 'p'); break;
			case 'bullets': this.toggleList('ul', false); break;
			case 'numbers': this.toggleList('ol', false); break;
			case 'checklist': this.toggleList('ul', true); break;
		}
		this.afterChange();
	}

	isActive(format: ScratchTextFormat): boolean {
		const target = this.target;
		if (!target) {
			return false;
		}
		const doc = target.host.ownerDocument;
		const block = this.currentBlock();
		try {
			switch (format) {
				case 'bold': return doc.queryCommandState('bold');
				case 'italic': return doc.queryCommandState('italic');
				case 'underline': return doc.queryCommandState('underline');
				case 'strike': return doc.queryCommandState('strikeThrough');
				case 'code': return !!this.closestInHost('code');
				case 'link': return !!this.closestInHost('a');
				case 'h1': case 'h2': case 'h3': return block?.tagName.toLowerCase() === format;
				case 'quote': return !!this.closestInHost('blockquote');
				case 'codeblock': return !!this.closestInHost('pre');
				case 'bullets': { const li = this.closestInHost('li'); return !!li && li.parentElement?.tagName === 'UL' && !li.hasAttribute('data-checked'); }
				case 'numbers': { const li = this.closestInHost('li'); return !!li && li.parentElement?.tagName === 'OL'; }
				case 'checklist': return !!this.closestInHost('li')?.hasAttribute('data-checked');
				default: return false;
			}
		} catch {
			return false;
		}
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (e.isComposing || e.keyCode === 229) {
			// An input method is composing (Japanese, Chinese...): its keys are its own.
			e.stopPropagation();
			return;
		}
		const mod = isMacintosh ? e.metaKey : e.ctrlKey;
		const key = e.key.toLowerCase();
		const handled = (run: () => void) => {
			e.preventDefault();
			e.stopPropagation();
			run();
		};
		if (e.key === 'Escape' || (mod && e.key === 'Enter')) {
			handled(() => this.commit());
			return;
		}
		if (mod && !e.altKey) {
			if (key === 'b' && !e.shiftKey) { handled(() => this.format('bold')); return; }
			if (key === 'i' && !e.shiftKey) { handled(() => this.format('italic')); return; }
			if (key === 'u' && !e.shiftKey) { handled(() => this.format('underline')); return; }
			if (key === 'x' && e.shiftKey) { handled(() => this.format('strike')); return; }
			if (key === 'e' && !e.shiftKey) { handled(() => this.format('code')); return; }
			if (key === 'k' && !e.shiftKey) { handled(() => this.format('link')); return; }
			if (e.shiftKey && (e.code === 'Digit7' || key === '7')) { handled(() => this.format('numbers')); return; }
			if (e.shiftKey && (e.code === 'Digit8' || key === '8')) { handled(() => this.format('bullets')); return; }
			if (e.shiftKey && (e.code === 'Digit9' || key === '9')) { handled(() => this.format('checklist')); return; }
			if (e.altKey === false && e.shiftKey === false && (key === '1' || key === '2' || key === '3')) {
				handled(() => this.format(`h${key}` as ScratchTextFormat));
				return;
			}
			if (e.shiftKey && (key === '0' || e.code === 'Digit0')) { handled(() => this.format('paragraph')); return; }
			if (key === 'a' || key === 'z' || key === 'y' || key === 'c' || key === 'v' || key === 'x') {
				// The text's own select-all, undo, clipboard; never the board's.
				e.stopPropagation();
				return;
			}
		}
		if (e.key === 'Tab') {
			const li = this.closestInHost('li');
			if (li) {
				handled(() => {
					li.ownerDocument.execCommand(e.shiftKey ? 'outdent' : 'indent');
					this.afterChange();
				});
				return;
			}
			handled(() => this.target?.host.ownerDocument.execCommand('insertText', false, '\t'));
			return;
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			const li = this.closestInHost('li');
			if (li && isEmptyNode(li)) {
				// Enter on an empty item leaves the list, like every notes app.
				handled(() => {
					const ordered = li.parentElement?.tagName === 'OL';
					this.listCommand(ordered);
					this.afterChange();
				});
				return;
			}
			const pre = this.closestInHost('pre');
			if (pre) {
				handled(() => {
					pre.ownerDocument.execCommand('insertText', false, '\n');
					this.afterChange();
				});
				return;
			}
		}
		if (e.key === 'Backspace' && !mod) {
			const block = this.currentBlock();
			const selection = getWindow(this.target!.host).getSelection();
			if (block && selection?.isCollapsed && caretAtStart(block, selection) && /^(H1|H2|H3|BLOCKQUOTE|PRE)$/.test(block.tagName)) {
				// Backspace at the start of a heading turns it back into text first.
				handled(() => {
					block.ownerDocument.execCommand('formatBlock', false, 'p');
					this.afterChange();
				});
				return;
			}
		}
		// Everything else is typing: keep it away from the board's shortcuts.
		e.stopPropagation();
	}

	private onInput(e: InputEvent): void {
		if (e.inputType === 'insertText' && e.data === ' ') {
			this.applyBlockShortcut();
		} else if (e.inputType === 'insertText' && e.data && /[*_`~]/.test(e.data)) {
			this.applyInlineShortcut(e.data);
		} else if (e.inputType === 'insertParagraph') {
			// A new checklist item starts unchecked.
			const li = this.closestInHost('li');
			if (li?.hasAttribute('data-checked') && isEmptyNode(li)) {
				li.setAttribute('data-checked', 'false');
			}
		}
		this.afterChange();
	}

	private afterChange(): void {
		if (this.target) {
			this.host.didInput(this.target);
		}
	}

	private onPaste(e: ClipboardEvent): void {
		const data = e.clipboardData;
		if (!data || !this.target) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		const doc = this.target.host.ownerDocument;
		const text = data.getData('text/plain');
		const html = data.getData('text/html');
		if (this.closestInHost('pre') || this.closestInHost('code')) {
			// Code stays code: no markdown, no formatting, line breaks as they are.
			if (text) {
				doc.execCommand('insertText', false, text);
			}
			this.afterChange();
			return;
		}
		let rich: string | undefined;
		if (text && looksLikeMarkdown(text)) {
			rich = markdownToRichHtml(text, doc);
		} else if (html) {
			rich = pastedHtmlToRich(html, doc);
		}
		if (rich) {
			// The window enforces Trusted Types on insertHTML.
			doc.execCommand('insertHTML', false, trustedRichHtml(rich) as unknown as string);
		} else if (text) {
			doc.execCommand('insertText', false, text);
		}
		this.afterChange();
	}

	private maybeToggleCheck(e: PointerEvent): void {
		const li = (e.target as HTMLElement | null)?.closest?.('li[data-checked]') as HTMLElement | null;
		if (!li || !this.target?.host.contains(li)) {
			return;
		}
		const rect = li.getBoundingClientRect();
		const scale = rect.width / Math.max(1, li.offsetWidth);
		// The box is drawn in the item's left gutter (CSS: 1.5em).
		const gutter = parseFloat(getWindow(li).getComputedStyle(li).paddingLeft) || 24;
		if (e.clientX < rect.left || e.clientX > rect.left + gutter * scale) {
			return;
		}
		e.preventDefault();
		li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
		this.afterChange();
	}

	private currentBlock(): HTMLElement | undefined {
		const target = this.target;
		const selection = target && getWindow(target.host).getSelection();
		let node: Node | null | undefined = selection?.anchorNode;
		while (node && node !== target?.host) {
			if (node.nodeType === Node.ELEMENT_NODE && /^(P|LI|H1|H2|H3|BLOCKQUOTE|PRE|DIV)$/.test((node as Element).tagName)) {
				return node as HTMLElement;
			}
			node = node.parentNode;
		}
		return undefined;
	}

	private closestInHost(selector: string): HTMLElement | undefined {
		const target = this.target;
		const selection = target && getWindow(target.host).getSelection();
		let node: Node | null | undefined = selection?.anchorNode;
		if (node && node.nodeType !== Node.ELEMENT_NODE) {
			node = node.parentNode;
		}
		const found = (node as Element | null | undefined)?.closest?.(selector) as HTMLElement | null | undefined;
		return found && target?.host.contains(found) ? found : undefined;
	}

	private toggleBlock(tag: 'h1' | 'h2' | 'h3' | 'blockquote' | 'pre'): void {
		const doc = this.target!.host.ownerDocument;
		const block = this.currentBlock();
		const inside = tag === 'blockquote' ? this.closestInHost('blockquote') : tag === 'pre' ? this.closestInHost('pre') : block?.tagName.toLowerCase() === tag ? block : undefined;
		doc.execCommand('formatBlock', false, inside ? 'p' : tag);
	}

	/**
	 * Chrome's list commands nest the list they make from a paragraph inside that <p>; the list is
	 * lifted out right away so blocks stay siblings (and the next shortcut sees its own line).
	 */
	private listCommand(ordered: boolean): void {
		const host = this.target!.host;
		host.ownerDocument.execCommand(ordered ? 'insertOrderedList' : 'insertUnorderedList');
		const selection = getWindow(host).getSelection();
		const caret = selection?.rangeCount ? { node: selection.anchorNode, offset: selection.anchorOffset } : undefined;
		const lifted = liftNestedBlocks(host);
		if ((wrapLooseInline(host, true) || lifted) && caret?.node && host.contains(caret.node)) {
			selection!.collapse(caret.node, caret.offset);
		}
	}

	private toggleList(kind: 'ul' | 'ol', checklist: boolean): void {
		const li = this.closestInHost('li');
		const inKind = li && li.parentElement?.tagName.toLowerCase() === kind;
		const isChecklist = !!li?.hasAttribute('data-checked');
		if (inKind && isChecklist === checklist) {
			// Same list again: back to text.
			this.listCommand(kind === 'ol');
			return;
		}
		if (!inKind) {
			this.listCommand(kind === 'ol');
		}
		const list = this.closestInHost(kind);
		const selection = getWindow(this.target!.host).getSelection();
		if (list && selection?.rangeCount) {
			// Only the selected lines: Chrome may have merged them into a list next door, which stays as it was.
			const range = selection.getRangeAt(0);
			for (const item of Array.from(list.children)) {
				if (item.tagName !== 'LI' || !range.intersectsNode(item)) {
					continue;
				}
				if (checklist) {
					if (!item.hasAttribute('data-checked')) {
						item.setAttribute('data-checked', 'false');
					}
				} else {
					item.removeAttribute('data-checked');
				}
			}
		}
	}

	private toggleInlineCode(): void {
		const target = this.target!;
		const doc = target.host.ownerDocument;
		const selection = getWindow(target.host).getSelection();
		const existing = this.closestInHost('code');
		if (existing && !existing.closest('pre')) {
			// Unwrap.
			const parent = existing.parentNode;
			while (existing.firstChild) {
				parent?.insertBefore(existing.firstChild, existing);
			}
			existing.remove();
			return;
		}
		if (!selection || !selection.rangeCount) {
			return;
		}
		const range = selection.getRangeAt(0);
		if (range.collapsed) {
			const code = doc.createElement('code');
			code.textContent = '\u200b';
			range.insertNode(code);
			range.setStart(code.firstChild!, 1);
			range.collapse(true);
		} else {
			const code = doc.createElement('code');
			code.appendChild(doc.createTextNode(range.toString()));
			range.deleteContents();
			range.insertNode(code);
			range.setStartAfter(code);
			range.collapse(true);
		}
		selection.removeAllRanges();
		selection.addRange(range);
	}

	private async editLink(): Promise<void> {
		const target = this.target;
		if (!target) {
			return;
		}
		const win = getWindow(target.host);
		const selection = win.getSelection();
		const saved = selection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
		const anchor = this.closestInHost('a') as HTMLAnchorElement | undefined;
		const url = await this.host.askLink(anchor?.getAttribute('href') ?? undefined);
		if (!this.target || this.target !== target) {
			return;
		}
		target.host.focus({ preventScroll: true });
		if (saved && selection) {
			selection.removeAllRanges();
			selection.addRange(saved);
		}
		const doc = target.host.ownerDocument;
		if (url === undefined) {
			return;
		}
		if (!url) {
			doc.execCommand('unlink');
		} else if (saved && saved.collapsed && !anchor) {
			doc.execCommand('insertText', false, url);
			const sel = win.getSelection();
			if (sel && sel.rangeCount) {
				const r = sel.getRangeAt(0);
				r.setStart(r.startContainer, Math.max(0, r.startOffset - url.length));
				sel.removeAllRanges();
				sel.addRange(r);
				doc.execCommand('createLink', false, url);
				sel.collapseToEnd();
			}
		} else {
			doc.execCommand('createLink', false, url);
		}
		this.afterChange();
	}

	/** "# ", "- ", "1. ", "[] ", "> ", "``` " at the start of a line. */
	private applyBlockShortcut(): void {
		const target = this.target!;
		const block = this.currentBlock();
		const selection = getWindow(target.host).getSelection();
		if (!block || !selection || !selection.isCollapsed || block.tagName === 'PRE') {
			return;
		}
		const before = textBeforeCaret(block, selection).replace(/\u00a0/g, ' ');
		const match = /^(#{1,3}|[-*+]|1[.)]|\[\s?\]|\[x\]|>|```)\s$/i.exec(before);
		if (!match) {
			return;
		}
		const marker = match[1];
		const doc = target.host.ownerDocument;
		// Remove the marker and the space.
		const range = doc.createRange();
		range.setStart(block, 0);
		range.setEnd(selection.anchorNode!, selection.anchorOffset);
		selection.removeAllRanges();
		selection.addRange(range);
		doc.execCommand('delete');
		if (marker.startsWith('#')) {
			doc.execCommand('formatBlock', false, `h${marker.length}`);
		} else if (marker === '>') {
			doc.execCommand('formatBlock', false, 'blockquote');
		} else if (marker === '```') {
			doc.execCommand('formatBlock', false, 'pre');
		} else if (/^1/.test(marker)) {
			if (block.tagName !== 'LI') {
				this.listCommand(true);
			}
		} else if (marker.startsWith('[')) {
			if (block.tagName !== 'LI') {
				this.listCommand(false);
			}
			const li = this.closestInHost('li');
			li?.setAttribute('data-checked', /x/i.test(marker) ? 'true' : 'false');
		} else if (block.tagName !== 'LI') {
			this.listCommand(false);
		}
	}

	/** **bold**, *italic*, _italic_, `code`, ~~strike~~ as they are closed. */
	private applyInlineShortcut(typed: string): void {
		const target = this.target!;
		const selection = getWindow(target.host).getSelection();
		const node = selection?.anchorNode;
		if (!selection || !selection.isCollapsed || !node || node.nodeType !== Node.TEXT_NODE || this.closestInHost('code') || this.closestInHost('pre')) {
			return;
		}
		const text = (node.textContent ?? '').slice(0, selection.anchorOffset);
		const patterns: { re: RegExp; tag: string }[] = typed === '*'
			? [{ re: /\*\*([^*\s][^*]*?[^*\s]|[^*\s])\*\*$/, tag: 'strong' }, { re: /(?:^|[^*])\*([^*\s][^*]*?[^*\s]|[^*\s])\*$/, tag: 'em' }]
			: typed === '_' ? [{ re: /(?:^|\s)_([^_\s][^_]*?[^_\s]|[^_\s])_$/, tag: 'em' }]
				: typed === '`' ? [{ re: /`([^`]+)`$/, tag: 'code' }]
					: [{ re: /~~([^~]+)~~$/, tag: 's' }];
		for (const { re, tag } of patterns) {
			const m = re.exec(text);
			if (!m) {
				continue;
			}
			const inner = m[1];
			const full = m[0].replace(/^[^*_`~]/, '');
			const start = selection.anchorOffset - full.length;
			const doc = target.host.ownerDocument;
			const range = doc.createRange();
			range.setStart(node, start);
			range.setEnd(node, selection.anchorOffset);
			range.deleteContents();
			const el = doc.createElement(tag);
			el.textContent = inner;
			range.insertNode(el);
			// Keep typing outside the new mark.
			const after = doc.createTextNode('\u200b');
			el.after(after);
			const caret = doc.createRange();
			caret.setStart(after, 1);
			caret.collapse(true);
			selection.removeAllRanges();
			selection.addRange(caret);
			return;
		}
	}
}

function isEmptyNode(el: Element): boolean {
	return (el.textContent ?? '').replace(/[\u200b\s]/g, '') === '' && !el.querySelector('hr');
}

function textBeforeCaret(block: HTMLElement, selection: Selection): string {
	const range = block.ownerDocument.createRange();
	range.setStart(block, 0);
	try {
		range.setEnd(selection.anchorNode!, selection.anchorOffset);
	} catch {
		return '';
	}
	return range.toString();
}

function caretAtStart(block: HTMLElement, selection: Selection): boolean {
	return textBeforeCaret(block, selection).replace(/\u200b/g, '') === '';
}

function stripZeroWidth(root: HTMLElement): void {
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const empty: Node[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.textContent?.includes('\u200b')) {
			node.textContent = node.textContent.replace(/\u200b/g, '');
			if (!node.textContent) {
				empty.push(node);
			}
		}
	}
	for (const node of empty) {
		node.parentNode?.removeChild(node);
	}
}

interface IFormatButton {
	readonly format: ScratchTextFormat;
	readonly icon: ScratchIconName;
	readonly label: string;
	readonly shortcut: string;
}

const MOD = isMacintosh ? '⌘' : 'Ctrl+';
const SHIFT = isMacintosh ? '⇧' : 'Shift+';

/** The small bar above text being edited: marks, headings, lists. */
export class ScratchFormatBar extends Disposable {

	readonly element: HTMLElement;
	private readonly buttons = new Map<ScratchTextFormat, HTMLButtonElement>();

	constructor(parent: HTMLElement, private readonly editor: ScratchTextEditor) {
		super();
		this.element = append(parent, $('.sx-format-bar.sx-panel'));
		this.element.setAttribute('role', 'toolbar');
		this.element.setAttribute('aria-label', localize('voltScratch.formatBar', "Text format"));
		this.element.hidden = true;
		const groups: IFormatButton[][] = [
			[
				{ format: 'bold', icon: 'bold', label: localize('voltScratch.bold', "Bold"), shortcut: `${MOD}B` },
				{ format: 'italic', icon: 'italic', label: localize('voltScratch.italic', "Italic"), shortcut: `${MOD}I` },
				{ format: 'underline', icon: 'underline', label: localize('voltScratch.underline', "Underline"), shortcut: `${MOD}U` },
				{ format: 'strike', icon: 'strikethrough', label: localize('voltScratch.strike', "Strikethrough"), shortcut: `${MOD}${SHIFT}X` },
				{ format: 'code', icon: 'code', label: localize('voltScratch.inlineCode', "Code"), shortcut: `${MOD}E` },
				{ format: 'link', icon: 'link', label: localize('voltScratch.link', "Link"), shortcut: `${MOD}K` },
			],
			[
				{ format: 'h1', icon: 'heading-1', label: localize('voltScratch.h1', "Heading 1"), shortcut: `${MOD}1` },
				{ format: 'h2', icon: 'heading-2', label: localize('voltScratch.h2', "Heading 2"), shortcut: `${MOD}2` },
				{ format: 'h3', icon: 'heading-3', label: localize('voltScratch.h3', "Heading 3"), shortcut: `${MOD}3` },
			],
			[
				{ format: 'bullets', icon: 'list', label: localize('voltScratch.bullets', "Bulleted list"), shortcut: `${MOD}${SHIFT}8` },
				{ format: 'numbers', icon: 'list-ordered', label: localize('voltScratch.numbers', "Numbered list"), shortcut: `${MOD}${SHIFT}7` },
				{ format: 'checklist', icon: 'list-checks', label: localize('voltScratch.checklist', "Checklist"), shortcut: `${MOD}${SHIFT}9` },
				{ format: 'quote', icon: 'text-quote', label: localize('voltScratch.quote', "Quote"), shortcut: '>' },
				{ format: 'codeblock', icon: 'code-xml', label: localize('voltScratch.codeBlock', "Code block"), shortcut: '```' },
			],
		];
		const doc = parent.ownerDocument;
		groups.forEach((group, gi) => {
			if (gi > 0) {
				append(this.element, $('.sx-divider'));
			}
			for (const spec of group) {
				const button = append(this.element, $('button.sx-tool-button.sx-format-button')) as HTMLButtonElement;
				button.type = 'button';
				button.tabIndex = -1;
				button.setAttribute('aria-label', spec.label);
				button.appendChild(scratchIcon(doc, spec.icon, { size: 15 }));
				setAgentTooltip(button, spec.label, spec.shortcut, undefined, 'above');
				// mousedown would take the text selection away before the click lands.
				this._register(addDisposableListener(button, 'pointerdown', e => {
					e.preventDefault();
					e.stopPropagation();
				}));
				this._register(addDisposableListener(button, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.editor.format(spec.format);
					this.refresh();
				}));
				this.buttons.set(spec.format, button);
			}
		});
		const onSelection = () => this.refresh();
		doc.addEventListener('selectionchange', onSelection);
		this._register(toDisposable(() => doc.removeEventListener('selectionchange', onSelection)));
	}

	refresh(): void {
		if (this.element.hidden) {
			return;
		}
		for (const [format, button] of this.buttons) {
			const on = this.editor.isActive(format);
			button.classList.toggle('active', on);
			button.setAttribute('aria-pressed', String(on));
		}
	}

	/** Shows the bar above `rect` (screen pixels within the canvas), or below when there is no room. */
	show(rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, bounds: { readonly width: number; readonly height: number }): void {
		this.element.hidden = false;
		const w = this.element.offsetWidth || 420;
		const h = this.element.offsetHeight || 36;
		let top = rect.y - h - 12;
		if (top < 64) {
			top = rect.y + rect.height + 12;
		}
		const left = Math.max(8, Math.min(bounds.width - w - 8, rect.x + rect.width / 2 - w / 2));
		this.element.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(8, Math.min(bounds.height - h - 8, top)))}px)`;
		this.refresh();
	}

	hide(): void {
		this.element.hidden = true;
	}
}
