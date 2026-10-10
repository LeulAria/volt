/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, runWhenWindowIdle } from '../../../../../base/browser/dom.js';
import { allowedMarkdownHtmlAttributes, allowedMarkdownHtmlTags, MarkdownRenderOptions } from '../../../../../base/browser/markdownRenderer.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CodeWindow } from '../../../../../base/browser/window.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import type * as marked from '../../../../../base/common/marked/marked.js';
import { MarkedKatexSupport } from '../../../markdown/browser/markedKatexSupport.js';
import { ICodeCardOptions, renderCodeCard } from './agentCodeBlock.js';
import { replaceEmojiWithIcons } from './agentEmojiIcons.js';
import { IMermaidOptions, isMermaidXyChart, preloadMermaid, renderMermaidDiagram, xychartToChartSpec } from './agentMermaid.js';
import { IVisualHostContext, mountChart, renderVisualSkeleton } from '../visuals/agentVisuals.js';
import { chartLoaderShape } from '../visuals/agentDotLoader.js';

/**
 * Markdown the way Cursor's transcript draws it: KaTeX math, highlighted code cards,
 * Mermaid diagrams for ```mermaid fences, round task markers, link favicons, and emoji as line icons.
 */

let mathLoad: Promise<unknown> | undefined;
let diagramPreload: IDisposable | undefined;

/**
 * Loads KaTeX ahead of the first reply that needs it; the promise settles once math is ready. The
 * diagram renderer (1.5 MB of mermaid and elkjs) waits for an idle moment so a chat restored at
 * startup does not evaluate it mid-restore; a diagram drawn before then loads it on its own.
 */
export function preloadMarkdownExtras(win: CodeWindow): Promise<unknown> {
	mathLoad ??= MarkedKatexSupport.loadExtension(win, { throwOnError: false }).catch(() => undefined);
	diagramPreload ??= runWhenWindowIdle(win, () => void preloadMermaid(), 10_000);
	return mathLoad;
}

export function isMarkdownMathLoaded(win: CodeWindow): boolean {
	return !!MarkedKatexSupport.getExtension(win);
}

export interface IAgentMarkdownOptions extends ICodeCardOptions {
	readonly onExpandDiagram?: IMermaidOptions['onExpand'];
	/** Draws ```volt-chart fences as native charts. */
	readonly visualHost?: IVisualHostContext;
}

const CHART_FENCES = new Set(['volt-chart', 'voltchart', 'chart-json', 'volt-charts']);

/** A ```volt-chart fence once its JSON is complete; undefined while it streams or when it is not a chart. */
function parseChartFence(value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
		return undefined;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

/**
 * What a fence draws as a native chart: a ```volt-chart JSON spec, or a mermaid `xychart-beta`
 * (a data chart written as a diagram) converted to one. `pending` while a chart fence is still
 * streaming in (draw a skeleton), undefined for anything that is not a chart.
 */
export function fenceChartSpec(language: string | undefined, value: string, streaming = false): { readonly spec: unknown; readonly key: string } | 'pending' | undefined {
	const lang = (language ?? '').trim().toLowerCase();
	if (CHART_FENCES.has(lang)) {
		const spec = parseChartFence(value);
		return spec !== undefined ? { spec, key: fenceKey(value) } : (streaming || !value.trim() ? 'pending' : undefined);
	}
	if (lang === 'mermaid' && isMermaidXyChart(value)) {
		const spec = xychartToChartSpec(value);
		// Keyed by the spec, so later lines that change nothing (blank, a comment) keep the live chart.
		return spec ? { spec, key: fenceKey(JSON.stringify(spec)) } : (streaming ? 'pending' : undefined);
	}
	return undefined;
}

/** Draws a chart fence (see `fenceChartSpec`) into `host`; false when the fence is not a chart. */
export function renderFenceChart(host: HTMLElement, language: string | undefined, value: string, visualHost: IVisualHostContext | undefined, streaming = false): boolean {
	if (!visualHost) {
		return false;
	}
	const chart = fenceChartSpec(language, value, streaming);
	if (!chart) {
		return false;
	}
	host.classList.add('volt-md-chart-host');
	if (chart === 'pending') {
		renderVisualSkeleton(host, 'chart', undefined, { shape: isMermaidXyChart(value) ? 'wide' : chartLoaderShape(value), creating: true });
	} else {
		mountChart(host, chart.key, chart.spec, visualHost);
	}
	return true;
}

/** Same text, same key: a fence redrawn on every streamed frame keeps one live chart. */
function fenceKey(value: string): string {
	let hash = 0;
	for (let index = 0; index < value.length; index++) {
		hash = (hash * 31 + value.charCodeAt(index)) | 0;
	}
	return `fence:${value.length}:${hash}`;
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
			const language = (languageId ?? '').toLowerCase();
			if (renderFenceChart(host, language, value, options.visualHost)) {
				// A native chart (```volt-chart, or a mermaid xychart).
			} else if (language === 'mermaid') {
				renderMermaidDiagram(host, value, { ...options, onExpand: options.onExpandDiagram });
			} else {
				renderCodeCard(host, languageId, value, options);
			}
			return host;
		},
	};
}

/** Post-render touches that marked cannot express: task markers, link favicons, emoji icons and footnote links. */
export function decorateAgentMarkdown(root: HTMLElement, store: DisposableStore): void {
	decorateTaskLists(root);
	replaceEmojiWithIcons(root);
	decorateLinkFavicons(root, store);
	linkFootnotes(root, store);
}

/** How far a footnote jump looks: the whole reply, since a reply renders as several markdown blocks. */
function footnoteScope(from: Element): Element {
	return from.closest('.volt-agent-thread-body') ?? from.closest('.volt-agent-markdown') ?? from.ownerDocument.body;
}

/** The note a superscript ref points at, or the first ref of a note (its back arrow). */
export function footnoteTarget(from: HTMLElement): HTMLElement | undefined {
	const scope = footnoteScope(from);
	if (from.matches('sup.volt-md-footnote-ref')) {
		const n = from.textContent?.trim();
		return Array.from(scope.querySelectorAll<HTMLElement>('ol.volt-md-footnotes')).find(note => (note.getAttribute('start') ?? '1') === n)?.querySelector('li') ?? undefined;
	}
	const n = from.closest('ol.volt-md-footnotes')?.getAttribute('start') ?? '1';
	return Array.from(scope.querySelectorAll<HTMLElement>('sup.volt-md-footnote-ref')).find(ref => ref.textContent?.trim() === n);
}

const FOOTNOTE_FLASH_MS = 1600;

/** Refs jump to their note and the note's back arrow returns, both briefly tinted on arrival. */
function linkFootnotes(root: HTMLElement, store: DisposableStore): void {
	const jump = (from: HTMLElement) => {
		const target = footnoteTarget(from);
		if (!target) {
			return;
		}
		target.scrollIntoView({ block: 'center', inline: 'nearest' });
		target.classList.add('volt-md-footnote-flash');
		const win = target.ownerDocument.defaultView;
		win?.setTimeout(() => target.classList.remove('volt-md-footnote-flash'), FOOTNOTE_FLASH_MS);
	};
	for (const link of root.querySelectorAll<HTMLElement>('sup.volt-md-footnote-ref, .volt-md-footnote-back')) {
		link.setAttribute('role', 'link');
		link.tabIndex = 0;
		store.add(addDisposableListener(link, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			jump(link);
		}));
		store.add(addDisposableListener(link, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				jump(link);
			}
		}));
	}
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
