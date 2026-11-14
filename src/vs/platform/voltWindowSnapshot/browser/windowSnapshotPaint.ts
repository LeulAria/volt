/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs in the window's startup script, before any workbench code: no imports but the format's.
import { IVoltWindowSnapshot, SNAPSHOT_ALLOWED_ATTRIBUTES, SNAPSHOT_BOXED_TAGS, SNAPSHOT_DROPPED_TAGS, VOLT_WINDOW_SNAPSHOT_ID, VOLT_WINDOW_SNAPSHOT_INPUT_ID, VOLT_WINDOW_SNAPSHOT_SHOWN_CLASS, VoltSnapshotNode } from '../common/windowSnapshot.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const INPUT_ATTRIBUTES = new Set(['placeholder', 'value', 'readonly', 'tabindex']);

/**
 * Paints a snapshot over the window: the screen it left, drawn from its own DOM and the product's
 * stylesheet. Nothing in it reacts to the mouse (clicks reach the workbench underneath); the
 * composer gets a real text area so keys typed now are kept for the composer that takes over.
 * The workbench underneath is invisible until {@link removeWindowSnapshot}.
 *
 * Returns false when there is nothing to paint.
 */
export function paintWindowSnapshot(doc: Document, snapshot: IVoltWindowSnapshot): boolean {
	const root = buildNode(doc, snapshot.root, false);
	if (!root || typeof root === 'string') {
		return false;
	}
	const host = doc.createElement('div');
	host.id = VOLT_WINDOW_SNAPSHOT_ID;
	host.setAttribute('aria-hidden', 'true');
	// Above the workbench and its splash; clicks go through to the workbench.
	host.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483000;pointer-events:none;overflow:hidden;contain:strict';
	const style = doc.createElement('style');
	style.className = 'volt-window-snapshot-style';
	// The runtime rules the snapshot uses, and the real workbench kept invisible (a direct child of
	// <body>; the snapshot's copy sits in the host) until it takes over: two translucent sidebars
	// drawn on top of each other would look darker than one.
	style.textContent = `${snapshot.css}\nbody.${VOLT_WINDOW_SNAPSHOT_SHOWN_CLASS} > .monaco-workbench { opacity: 0 !important; }`;
	doc.head.appendChild(style);
	host.appendChild(root);
	doc.body.appendChild(host);
	doc.body.classList.add(VOLT_WINDOW_SNAPSHOT_SHOWN_CLASS);
	for (const name of snapshot.htmlClass.split(/\s+/)) {
		if (name) {
			doc.documentElement.classList.add(name);
		}
	}
	restoreScroll(root, snapshot.root);
	const composer = snapshot.composer;
	if (composer) {
		const input = doc.createElement('textarea');
		input.id = VOLT_WINDOW_SNAPSHOT_INPUT_ID;
		input.spellcheck = false;
		input.value = composer.text;
		input.dataset.draft = composer.text;
		input.placeholder = composer.placeholder;
		const [left, top, width, height] = composer.rect;
		input.style.cssText = `position:absolute;z-index:2147483647;left:${left}px;top:${top}px;width:${width}px;height:${height}px;margin:0;padding:0;border:0;outline:none;resize:none;overflow:hidden;background:transparent;pointer-events:auto;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;font:${composer.font};line-height:${composer.lineHeight}px;letter-spacing:${composer.letterSpacing};color:${composer.color};caret-color:${composer.caretColor};`;
		const placeholderStyle = doc.createElement('style');
		placeholderStyle.textContent = `#${VOLT_WINDOW_SNAPSHOT_INPUT_ID}::placeholder { color: ${composer.placeholderColor}; opacity: 1; }`;
		placeholderStyle.dataset.voltSnapshot = '1';
		doc.head.appendChild(placeholderStyle);
		host.appendChild(input);
		input.addEventListener('keydown', e => {
			// Enter sends once the composer is up: remembered, the text stays.
			if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) {
				e.preventDefault();
				input.dataset.send = '1';
			}
		});
		input.focus();
		input.setSelectionRange(composer.text.length, composer.text.length);
	}
	return true;
}

/** What was typed into the snapshot's composer, for the composer that takes over. */
export interface ISnapshotTypedInput {
	readonly text: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
	/** The text differs from the draft the snapshot showed. */
	readonly changed: boolean;
	/** Enter was pressed. */
	readonly send: boolean;
	/** The text area had the keyboard focus. */
	readonly focused: boolean;
}

export function readSnapshotInput(doc: Document): ISnapshotTypedInput | undefined {
	const input = doc.getElementById(VOLT_WINDOW_SNAPSHOT_INPUT_ID) as HTMLTextAreaElement | null;
	if (!input) {
		return undefined;
	}
	return {
		text: input.value,
		selectionStart: input.selectionStart,
		selectionEnd: input.selectionEnd,
		changed: input.value !== (input.dataset.draft ?? ''),
		send: input.dataset.send === '1',
		focused: doc.activeElement === input,
	};
}

/** Takes the snapshot away; the workbench underneath shows in the same frame. */
export function removeWindowSnapshot(doc: Document): boolean {
	const host = doc.getElementById(VOLT_WINDOW_SNAPSHOT_ID);
	if (!host) {
		return false;
	}
	host.remove();
	for (const style of doc.head.querySelectorAll('style.volt-window-snapshot-style, style[data-volt-snapshot]')) {
		style.remove();
	}
	doc.body.classList.remove(VOLT_WINDOW_SNAPSHOT_SHOWN_CLASS);
	return true;
}

export function isWindowSnapshotShown(doc: Document): boolean {
	return !!doc.getElementById(VOLT_WINDOW_SNAPSHOT_ID);
}

function buildNode(doc: Document, node: VoltSnapshotNode, inSvg: boolean): Element | string | undefined {
	if (typeof node === 'string') {
		return node;
	}
	const tag = String(node.t).toLowerCase();
	const svg = inSvg || node.svg === 1;
	// Checked again here: the stored file is data, never trusted to hold only what capture keeps.
	if (SNAPSHOT_DROPPED_TAGS.has(tag) || (SNAPSHOT_BOXED_TAGS.has(tag) && tag !== 'input') || !/^[a-z][a-z0-9-]*$/.test(tag)) {
		return undefined;
	}
	const el = svg ? doc.createElementNS(SVG_NS, node.t) : doc.createElement(tag);
	if (node.a) {
		for (const [name, value] of Object.entries(node.a)) {
			if (typeof value !== 'string') {
				continue;
			}
			if (SNAPSHOT_ALLOWED_ATTRIBUTES.has(name) || (tag === 'input' && INPUT_ATTRIBUTES.has(name))) {
				if (/url\(\s*['"]?\s*(javascript|blob):/i.test(value)) {
					continue;
				}
				el.setAttribute(name, value);
			}
		}
		if (tag === 'input') {
			(el as HTMLInputElement).readOnly = true;
			(el as HTMLInputElement).tabIndex = -1;
			(el as HTMLInputElement).type = 'text';
		}
	}
	if (node.c) {
		for (const child of node.c) {
			const built = buildNode(doc, child, svg && tag !== 'foreignobject');
			if (typeof built === 'string') {
				el.appendChild(doc.createTextNode(built));
			} else if (built) {
				el.appendChild(built);
			}
		}
	}
	return el;
}

/** Scroll offsets need layout: applied after the tree is in the document. */
function restoreScroll(el: Element, node: VoltSnapshotNode): void {
	if (typeof node === 'string') {
		return;
	}
	if (node.s) {
		el.scrollTop = node.s[0];
		el.scrollLeft = node.s[1];
	}
	if (!node.c?.some(child => typeof child !== 'string' && (child.s || child.c))) {
		return;
	}
	let i = 0;
	for (const child of node.c) {
		if (typeof child === 'string') {
			i++; // a text node
			continue;
		}
		const childEl = el.childNodes[i];
		// Children dropped while building would shift the indexes; they are rare (only invalid ones), so stop there.
		if (!(childEl instanceof Element) || childEl.localName.toLowerCase() !== String(child.t).toLowerCase()) {
			return;
		}
		restoreScroll(childEl, child);
		i++;
	}
}
