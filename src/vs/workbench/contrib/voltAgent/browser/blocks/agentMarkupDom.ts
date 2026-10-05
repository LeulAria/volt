/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Builds DOM nodes from markup that Volt generates itself (diagram SVG, tokenizer HTML),
 * without `innerHTML`: the workbench enforces Trusted Types, so string-to-HTML sinks are off
 * limits. Scripts, foreign objects and event-handler attributes are dropped.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const BLOCKED_TAGS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed']);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
		if (name[0] === '#') {
			const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return ENTITIES[name.toLowerCase()] ?? match;
	});
}

/** Parses `markup` into a fragment. `svg` creates elements in the SVG namespace. */
export function markupToFragment(doc: Document, markup: string, svg: boolean): DocumentFragment {
	const fragment = doc.createDocumentFragment();
	const stack: Node[] = [fragment];
	let blockedDepth = 0;
	const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
	let last = 0;
	let match: RegExpExecArray | null;
	const appendText = (text: string) => {
		if (text && !blockedDepth) {
			stack[stack.length - 1].appendChild(doc.createTextNode(text));
		}
	};
	while ((match = re.exec(markup))) {
		appendText(decodeEntities(markup.slice(last, match.index)));
		last = re.lastIndex;
		const [, cdata, closeTag, openTag, attrs, selfClose] = match;
		if (cdata !== undefined) {
			appendText(cdata);
			continue;
		}
		if (closeTag) {
			const name = closeTag.toLowerCase();
			if (BLOCKED_TAGS.has(name)) {
				blockedDepth = Math.max(0, blockedDepth - 1);
				continue;
			}
			if (!blockedDepth && stack.length > 1) {
				stack.pop();
			}
			continue;
		}
		if (!openTag) {
			continue;
		}
		const name = openTag.toLowerCase();
		const isVoid = !!selfClose || (!svg && VOID_TAGS.has(name));
		if (BLOCKED_TAGS.has(name)) {
			if (!isVoid) {
				blockedDepth++;
			}
			continue;
		}
		if (blockedDepth) {
			continue;
		}
		const el = svg ? doc.createElementNS(SVG_NS, openTag) : doc.createElement(openTag);
		const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
		let attr: RegExpExecArray | null;
		while ((attr = attrRe.exec(attrs ?? ''))) {
			const attrName = attr[1];
			const value = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? '');
			if (/^on/i.test(attrName) || (/href$/i.test(attrName) && /^\s*javascript:/i.test(value))) {
				continue;
			}
			try {
				el.setAttribute(attrName, value);
			} catch {
				// Ignore names the DOM rejects (e.g. stray punctuation).
			}
		}
		stack[stack.length - 1].appendChild(el);
		if (!isVoid) {
			stack.push(el);
		}
	}
	appendText(decodeEntities(markup.slice(last)));
	return fragment;
}
