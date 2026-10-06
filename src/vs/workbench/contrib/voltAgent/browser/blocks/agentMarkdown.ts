/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener } from '../../../../../base/browser/dom.js';
import { allowedMarkdownHtmlAttributes, allowedMarkdownHtmlTags, MarkdownRenderOptions } from '../../../../../base/browser/markdownRenderer.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CodeWindow } from '../../../../../base/browser/window.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type * as marked from '../../../../../base/common/marked/marked.js';
import { MarkedKatexSupport } from '../../../markdown/browser/markedKatexSupport.js';
import { ICodeCardOptions, renderCodeCard } from './agentCodeBlock.js';
import { replaceEmojiWithIcons } from './agentEmojiIcons.js';
import { IMermaidOptions, preloadMermaid, renderMermaidDiagram } from './agentMermaid.js';

/**
 * Markdown the way Cursor's transcript draws it: KaTeX math, highlighted code cards,
 * Mermaid diagrams for ```mermaid fences, round task markers, link favicons, and emoji as line icons.
 */

let mathLoad: Promise<unknown> | undefined;

/** Loads KaTeX (and the diagram renderer) ahead of the first reply that needs them. */
export function preloadMarkdownExtras(win: CodeWindow): Promise<unknown> {
	mathLoad ??= MarkedKatexSupport.loadExtension(win, { throwOnError: false }).catch(() => undefined);
	return Promise.all([mathLoad, preloadMermaid()]);
}

export function isMarkdownMathLoaded(win: CodeWindow): boolean {
	return !!MarkedKatexSupport.getExtension(win);
}

export interface IAgentMarkdownOptions extends ICodeCardOptions {
	readonly onExpandDiagram?: IMermaidOptions['onExpand'];
}

/** Render options for MarkdownRenderer.render: math, sanitizer for KaTeX output, and Cursor code cards. */
export function agentMarkdownRenderOptions(win: CodeWindow, options: IAgentMarkdownOptions): Partial<MarkdownRenderOptions> {
	const katex = MarkedKatexSupport.getExtension(win, { throwOnError: false });
	const markedExtensions: marked.MarkedExtension[] = katex ? [katex, footnoteExtension()] : [footnoteExtension()];
	return {
		markedExtensions,
		markedOptions: { gfm: true },
		sanitizerConfig: katex ? MarkedKatexSupport.getSanitizerOptions({
			allowedTags: allowedMarkdownHtmlTags,
			allowedAttributes: allowedMarkdownHtmlAttributes,
		}) : undefined,
		codeBlockRendererSync: (languageId, value) => {
			const host = $('div.volt-md-code-host');
			if ((languageId ?? '').toLowerCase() === 'mermaid') {
				renderMermaidDiagram(host, value, { ...options, onExpand: options.onExpandDiagram });
			} else {
				renderCodeCard(host, languageId, value, options);
			}
			return host;
		},
	};
}

/** Post-render touches that marked cannot express: task markers, link favicons and emoji icons. */
export function decorateAgentMarkdown(root: HTMLElement, store: DisposableStore): void {
	decorateTaskLists(root);
	replaceEmojiWithIcons(root);
	decorateLinkFavicons(root, store);
}

/** GFM task items render a disabled checkbox; Cursor draws a round check / empty circle instead. */
function decorateTaskLists(root: HTMLElement): void {
	for (const input of root.querySelectorAll('li > input[type="checkbox"], li > p > input[type="checkbox"]')) {
		const li = input.closest('li');
		if (!li) {
			continue;
		}
		const checked = (input as HTMLInputElement).checked || input.hasAttribute('checked');
		const marker = $('span.volt-md-task-marker');
		marker.classList.toggle('checked', checked);
		marker.appendChild(renderIcon(checked ? Codicon.passFilled : Codicon.circleLarge));
		marker.setAttribute('role', 'img');
		marker.setAttribute('aria-label', checked ? 'Done' : 'Not done');
		input.replaceWith(marker);
		li.classList.add('volt-md-task-item');
		li.parentElement?.classList.add('volt-md-task-list');
	}
}

/** Hosts whose /favicon.ico failed: streaming re-renders every frame, so never ask them again. */
const failedFavicons = new Set<string>();

/** External links lead with the site's favicon (15px, 3px radius), dropped silently when the site has none. */
function decorateLinkFavicons(root: HTMLElement, store: DisposableStore): void {
	for (const link of root.querySelectorAll('a')) {
		if (link.querySelector('img, code') || link.classList.contains('volt-agent-path-pill')) {
			continue;
		}
		const href = link.getAttribute('data-href') || link.getAttribute('href') || '';
		let url: URL;
		try {
			url = new URL(href);
		} catch {
			continue;
		}
		if (url.protocol !== 'https:' && url.protocol !== 'http:') {
			continue;
		}
		if (url.hostname === 'localhost' || /^(127\.|0\.0\.0\.0|\[::1\])/.test(url.hostname) || failedFavicons.has(url.host)) {
			continue;
		}
		link.classList.add('volt-md-link');
		const icon = $('img.volt-md-link-favicon') as HTMLImageElement;
		icon.alt = '';
		icon.width = 15;
		icon.height = 15;
		icon.decoding = 'async';
		icon.referrerPolicy = 'no-referrer';
		const host = url.host;
		store.add(addDisposableListener(icon, 'error', () => {
			failedFavicons.add(host);
			icon.remove();
		}));
		icon.src = `${url.protocol}//${url.host}/favicon.ico`;
		link.insertBefore(icon, link.firstChild);
	}
}

/**
 * GFM footnotes, which marked lacks: `[^id]` becomes a superscript number and each
 * `[^id]: text` line a numbered note with a back arrow, as Cursor shows them.
 */
export function footnoteExtension(): marked.MarkedExtension {
	const numbers = new Map<string, number>();
	const numberFor = (id: string) => {
		let n = numbers.get(id);
		if (n === undefined) {
			n = numbers.size + 1;
			numbers.set(id, n);
		}
		return n;
	};
	return {
		extensions: [
			{
				name: 'voltFootnoteDef',
				level: 'block',
				start: (src: string) => src.match(/^\[\^[^\]\s]+\]:/m)?.index,
				tokenizer(this: marked.TokenizerThis, src: string) {
					const match = /^\[\^([^\]\s]+)\]:[ \t]+([^\n]*(?:\n(?: {4}|\t)[^\n]*)*)(?:\n|$)/.exec(src);
					if (!match) {
						return undefined;
					}
					return { type: 'voltFootnoteDef', raw: match[0], id: match[1], tokens: this.lexer.inlineTokens(match[2].trim()) };
				},
				renderer(this: marked.RendererThis, token: marked.Tokens.Generic) {
					const n = numberFor(token.id);
					return `<ol class="volt-md-footnotes" start="${n}"><li>${this.parser.parseInline(token.tokens ?? [])} <span class="volt-md-footnote-back">\u21a9</span></li></ol>`;
				},
			},
			{
				name: 'voltFootnoteRef',
				level: 'inline',
				start: (src: string) => src.match(/\[\^[^\]\s]+\](?!:)/)?.index,
				tokenizer(src: string) {
					const match = /^\[\^([^\]\s]+)\](?!:)/.exec(src);
					return match ? { type: 'voltFootnoteRef', raw: match[0], id: match[1] } : undefined;
				},
				renderer(token: marked.Tokens.Generic) {
					return `<sup class="volt-md-footnote-ref">${numberFor(token.id)}</sup>`;
				},
			},
		],
	};
}

/**
 * Models often write LaTeX as \(...\) and \[...\]; marked eats those backslashes as escapes.
 * Rewrites them to $...$ / $$...$$ outside code so KaTeX draws them.
 */
export function normalizeMathDelimiters(text: string): string {
	if (!text.includes('\\(') && !text.includes('\\[')) {
		return text;
	}
	return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((part, index) => {
		if (index % 2 === 1) {
			return part;
		}
		return part
			.replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
			.replace(/\\\(([^\n]+?)\\\)/g, (_, body: string) => `$${body.trim()}$`);
	}).join('');
}
