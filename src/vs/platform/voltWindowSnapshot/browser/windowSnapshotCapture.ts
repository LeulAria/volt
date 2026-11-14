/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltSnapshotComposer, IVoltSnapshotElement, IVoltWindowSnapshot, SNAPSHOT_ALLOWED_ATTRIBUTES, SNAPSHOT_BOXED_TAGS, SNAPSHOT_DROPPED_TAGS, VOLT_WINDOW_SNAPSHOT_ID, VOLT_WINDOW_SNAPSHOT_VERSION, VoltSnapshotNode } from '../common/windowSnapshot.js';

export interface IWindowSnapshotCaptureOptions {
	readonly key: string;
	readonly baseTheme: string;
	readonly sessionId?: string;
	/** The composer's editor element (`.monaco-editor`) and its draft: the snapshot keeps an empty box there and the draft as text. */
	readonly composer?: { readonly editor: HTMLElement; readonly linesElement: HTMLElement | undefined; readonly text: string; readonly placeholder: string; readonly placeholderElement?: HTMLElement };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const CLASS_IN_SELECTOR = /\.(-?[_a-zA-Z][\w-]*)/g;

/**
 * Takes a snapshot of what the window shows: `root` (the workbench element) and everything in it
 * that is on screen. Elements outside the window keep their box (so what is on screen stays where
 * it is) without their content; frames, canvases and media become empty boxes of their size.
 */
export function captureWindowSnapshot(win: Window, root: HTMLElement, options: IWindowSnapshotCaptureOptions): IVoltWindowSnapshot {
	const width = win.innerWidth;
	const height = win.innerHeight;
	const classes = new Set<string>();
	const composerEditor = options.composer?.editor;

	const box = (el: Element, rect: DOMRect, keepClass: boolean): IVoltSnapshotElement => {
		const style = el.getAttribute('style') ?? '';
		const display = win.getComputedStyle(el).display;
		const a: Record<string, string> = {
			style: `${style};width:${rect.width}px;height:${rect.height}px;min-width:0;min-height:0;overflow:hidden;display:${display === 'inline' ? 'inline-block' : display};box-sizing:border-box`,
		};
		const cls = keepClass ? el.getAttribute('class') : null;
		if (cls) {
			a.class = cls;
			addClasses(cls);
		}
		return { t: 'div', a };
	};

	const addClasses = (value: string) => {
		for (const name of value.split(/\s+/)) {
			if (name) {
				classes.add(name);
			}
		}
	};

	const visit = (el: Element): IVoltSnapshotElement | undefined => {
		const tag = el.localName;
		if (SNAPSHOT_DROPPED_TAGS.has(tag) || el.id === VOLT_WINDOW_SNAPSHOT_ID) {
			return undefined;
		}
		const rects = el.getClientRects();
		if (!rects.length && win.getComputedStyle(el).display !== 'contents') {
			return undefined; // not drawn (display: none, or detached from layout)
		}
		const rect = el.getBoundingClientRect();
		const svg = el.namespaceURI === SVG_NS;
		const outside = rects.length > 0 && (rect.bottom < 0 || rect.top > height || rect.right < 0 || rect.left > width);
		if (outside) {
			const position = win.getComputedStyle(el).position;
			return svg || position === 'absolute' || position === 'fixed' ? undefined : box(el, rect, true);
		}
		if (el === composerEditor) {
			return box(el, rect, true);
		}
		if (tag === 'input' && /^(text|search|)$/.test((el as HTMLInputElement).type)) {
			const input = el as HTMLInputElement;
			const a: Record<string, string> = { readonly: '', tabindex: '-1' };
			copyAttributes(el, a, addClasses);
			if (input.placeholder) {
				a.placeholder = input.placeholder;
			}
			if (input.value) {
				a.value = input.value;
			}
			return { t: 'input', a };
		}
		if (SNAPSHOT_BOXED_TAGS.has(tag)) {
			return svg ? undefined : box(el, rect, true);
		}
		const a: Record<string, string> = {};
		copyAttributes(el, a, addClasses);
		const c: VoltSnapshotNode[] = [];
		for (let child = el.firstChild; child; child = child.nextSibling) {
			if (child.nodeType === 3 /* text */) {
				const text = (child as Text).data;
				if (text) {
					c.push(text);
				}
			} else if (child.nodeType === 1 /* element */) {
				const node = visit(child as Element);
				if (node) {
					c.push(node);
				}
			}
		}
		const node: { -readonly [K in keyof IVoltSnapshotElement]: IVoltSnapshotElement[K] } = { t: tag };
		if (svg) {
			node.svg = 1;
		}
		if (Object.keys(a).length) {
			node.a = a;
		}
		if (c.length) {
			node.c = c;
		}
		if (el.scrollTop || el.scrollLeft) {
			node.s = [el.scrollTop, el.scrollLeft];
		}
		return node;
	};

	const tree = visit(root) ?? { t: 'div' };
	const doc = win.document;
	// Rules may name the page's own classes (`html.volt-layout-agent-window ...`); paint puts them back.
	addClasses(doc.documentElement.className);
	addClasses(doc.body.className);
	return {
		version: VOLT_WINDOW_SNAPSHOT_VERSION,
		key: options.key,
		width,
		height,
		devicePixelRatio: win.devicePixelRatio,
		baseTheme: options.baseTheme,
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		css: collectRuntimeCss(doc, classes),
		htmlClass: doc.documentElement.className,
		bodyClass: doc.body.className,
		root: tree,
		...(options.composer ? { composer: describeComposer(win, options.composer) } : {}),
		savedAt: Date.now(),
	};
}

function copyAttributes(el: Element, into: Record<string, string>, onClass: (value: string) => void): void {
	for (const attr of el.attributes) {
		const name = attr.name;
		if (!SNAPSHOT_ALLOWED_ATTRIBUTES.has(name)) {
			continue;
		}
		const value = attr.value;
		if (/url\(\s*['"]?\s*(javascript|blob):/i.test(value)) {
			continue;
		}
		into[name] = value;
		if (name === 'class') {
			onClass(value);
		}
	}
}

function describeComposer(win: Window, composer: NonNullable<IWindowSnapshotCaptureOptions['composer']>): IVoltSnapshotComposer {
	const lines = composer.linesElement ?? composer.editor;
	const rect = lines.getBoundingClientRect();
	const editorRect = composer.editor.getBoundingClientRect();
	const firstLine = lines.querySelector('.view-line span') ?? lines;
	const style = win.getComputedStyle(firstLine);
	const lineHeight = parseFloat(win.getComputedStyle(lines.querySelector('.view-line') ?? lines).height) || parseFloat(style.lineHeight) || 20;
	const placeholderStyle = composer.placeholderElement ? win.getComputedStyle(composer.placeholderElement) : undefined;
	const cursor = composer.editor.querySelector('.cursor');
	return {
		// The lines element spans the editor's width; the text area takes the editor's visible part.
		rect: [rect.left, editorRect.top, Math.max(0, editorRect.right - rect.left), editorRect.height],
		text: composer.text,
		placeholder: composer.placeholder,
		font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
		lineHeight,
		letterSpacing: style.letterSpacing,
		color: style.color,
		placeholderColor: placeholderStyle?.color ?? style.color,
		caretColor: cursor ? win.getComputedStyle(cursor).backgroundColor : style.color,
	};
}

/**
 * The style rules added at run time (theme colors, icon glyphs, token colors, Volt looks) that can
 * apply to the snapshot: a rule is kept when every class its selector names is used in it. The
 * product's own stylesheet is not copied: the window loads it before its first frame.
 */
export function collectRuntimeCss(doc: Document, classes: ReadonlySet<string>): string {
	const out: string[] = [];
	const keep = (rule: CSSRule): string | undefined => {
		if (rule instanceof CSSStyleRule) {
			return selectorApplies(rule.selectorText, classes) ? rule.cssText : undefined;
		}
		if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
			const inner = [...rule.cssRules].map(keep).filter(Boolean);
			if (!inner.length) {
				return undefined;
			}
			return rule instanceof CSSMediaRule ? `@media ${rule.conditionText}{${inner.join('')}}` : `@supports ${rule.conditionText}{${inner.join('')}}`;
		}
		if (rule instanceof CSSFontFaceRule || rule instanceof CSSKeyframesRule) {
			return rule.cssText;
		}
		return undefined;
	};
	const sheets = [...doc.styleSheets, ...(doc.adoptedStyleSheets ?? [])];
	for (const sheet of sheets) {
		if (sheet.href) {
			continue;
		}
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue;
		}
		for (const rule of rules) {
			const text = keep(rule);
			if (text) {
				out.push(text);
			}
		}
	}
	return out.join('\n');
}

/** Whether a selector list can match inside the snapshot: one of its selectors names only classes the snapshot uses, and no id. */
export function selectorApplies(selectorText: string, classes: ReadonlySet<string>): boolean {
	for (const selector of selectorText.split(',')) {
		if (selector.includes('#')) {
			continue;
		}
		let ok = true;
		for (const match of selector.matchAll(CLASS_IN_SELECTOR)) {
			if (!classes.has(match[1])) {
				ok = false;
				break;
			}
		}
		if (ok) {
			return true;
		}
	}
	return false;
}
