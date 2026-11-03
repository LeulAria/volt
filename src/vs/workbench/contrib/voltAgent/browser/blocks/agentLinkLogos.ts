/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentLinkLogos.css';
import { $, append } from '../../../../../base/browser/dom.js';
import { createCSSRule } from '../../../../../base/browser/domStylesheets.js';
import { ILinkBrand, linkBrandForHref } from './agentLinkBrands.js';

export { linkBrandForHref };

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A brand's mark as inline SVG, in its colour (or the text colour for black-and-white marks). */
export function createLinkBrandIcon(brand: ILinkBrand, size = 14): HTMLElement {
	const host = $('span.volt-link-brand-icon');
	host.classList.add(brand.id);
	if (brand.color) {
		host.style.color = brand.color;
	}
	const svg = host.ownerDocument.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	for (const path of brand.paths) {
		const node = host.ownerDocument.createElementNS(SVG_NS, 'path');
		node.setAttribute('d', path.d);
		node.setAttribute('fill', path.fill ?? 'currentColor');
		svg.appendChild(node);
	}
	host.appendChild(svg);
	return host;
}

const svgUrl = (paths: string) => `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>${paths}</svg>`)}")`;
const brandClasses = new Set<string>();

/**
 * A class that draws the brand's mark as a `::before` background, for places that only take class
 * names (Monaco's injected text in the composer). The rule is made once per brand.
 */
export function linkBrandIconClass(brand: ILinkBrand): string {
	const name = `volt-link-brand-${brand.id}`;
	if (!brandClasses.has(name)) {
		brandClasses.add(name);
		if (brand.paths.some(path => path.fill)) {
			// Several colours (YouTube's white play button): paint the SVG itself.
			const paths = brand.paths.map(path => `<path d='${path.d}' fill='${path.fill ?? brand.color ?? '#888'}'/>`).join('');
			createCSSRule(`.${name}::before`, `background: ${svgUrl(paths)} center / contain no-repeat;`);
		} else {
			const paths = brand.paths.map(path => `<path d='${path.d}'/>`).join('');
			createCSSRule(`.${name}::before`, `-webkit-mask: ${svgUrl(paths)} center / contain no-repeat; background: ${brand.color ?? 'currentColor'};`);
		}
	}
	return name;
}

/** Writes a link into `element` as its URL in link colour, led by the site's logo when it is a known site. */
export function fillBrandLink(element: HTMLElement, url: string): void {
	element.classList.add('volt-brand-link');
	const brand = linkBrandForHref(url);
	if (!brand) {
		element.append(url);
		return;
	}
	// The logo and the URL's scheme and host never wrap apart, so the logo stays on the line the URL starts on.
	const host = url.match(/^[a-z]+:\/\/[^/?#]*/i)?.[0] ?? '';
	const head = append(element, $('span.volt-brand-link-head'));
	head.append(createLinkBrandIcon(brand), host);
	element.append(url.slice(host.length));
}

/** One piece of typed text: plain text, or a link found in it. */
export type LinkTextPart = string | { readonly url: string };

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/**
 * Splits text at its http(s) links. Closing punctuation after a link (`.`, `,`, an unmatched `)`)
 * stays text, as it does when a person writes "see https://x.com/a.".
 */
export function splitTextLinks(text: string): LinkTextPart[] {
	const parts: LinkTextPart[] = [];
	let cursor = 0;
	for (const match of text.matchAll(URL_IN_TEXT)) {
		let url = match[0];
		while (/[.,;:!?*_~]$/.test(url) || (url.endsWith(')') && count(url, '(') < count(url, ')'))) {
			url = url.slice(0, -1);
		}
		if (url.length <= 'https://'.length) {
			continue;
		}
		if (match.index > cursor) {
			parts.push(text.slice(cursor, match.index));
		}
		parts.push({ url });
		cursor = match.index + url.length;
	}
	if (cursor < text.length) {
		parts.push(text.slice(cursor));
	}
	return parts;
}

function count(text: string, char: string): number {
	let n = 0;
	for (const c of text) {
		if (c === char) {
			n++;
		}
	}
	return n;
}
