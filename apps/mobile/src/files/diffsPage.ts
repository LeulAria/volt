/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltPalette } from '@volt/client-core';
import { DIFFS_JS } from './diffsBundle';
import { GEIST_MONO_TTF_BASE64 } from './monacoBundle';

/** What the page is for, fixed when it is built; the text arrives later through `window.volt.load`. */
export interface IDiffsBoot {
	readonly mode: 'diff' | 'file';
	/** Every unchanged line shown (the whole file with the changes marked) instead of folded stretches. */
	readonly full?: boolean;
	readonly wrap: boolean;
}

/** JSON that is safe inside a <script> element. */
function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

function rgba(color: string): [number, number, number, number] {
	const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(color);
	if (m) {
		return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
	}
	let hex = color.replace('#', '');
	if (hex.length <= 4) {
		hex = [...hex].map(c => c + c).join('');
	}
	return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1];
}

/**
 * `color` (any alpha) laid over `under`, as an opaque #RRGGBB: the number column is sticky, so
 * a see-through tint would let the code scrolling under it show.
 */
function over(color: string, under: string, alpha = 1): string {
	const [r, g, b, a] = rgba(color);
	const bg = rgba(under);
	const k = a * alpha;
	return `#${[r, g, b].map((c, i) => Math.round(c * k + bg[i] * (1 - k)).toString(16).padStart(2, '0')).join('')}`;
}

/** The palette's syntax colours → Highlights' token types (the same roles as client-core's Monaco rules). */
const SYNTAX: Readonly<Partial<Record<keyof IVoltPalette['syntax'], readonly string[]>>> = {
	plain: ['embedded', 'primary', 'text.jsx'],
	comment: ['comment', 'comment.doc', 'hint', 'predictive'],
	string: ['string', 'string.special', 'text.literal', 'link_uri'],
	regex: ['string.regex'],
	keyword: ['keyword', 'keyword.control', 'keyword.declaration', 'keyword.import', 'keyword.jsdoc', 'title', 'punctuation.list_marker', 'selector.pseudo'],
	operator: ['keyword.operator', 'operator'],
	number: ['number'],
	constant: ['boolean', 'constant', 'constant.builtin', 'enum', 'variant', 'label', 'variable.special', 'string.escape', 'string.special.symbol'],
	function: ['function', 'function.definition', 'function.method', 'constructor'],
	type: ['type', 'type.builtin', 'type.class', 'type.jsdoc', 'namespace', 'tag.component.jsx'],
	property: ['property', 'property.json_key'],
	variable: ['variable', 'variable.parameter', 'variable.jsdoc'],
	punct: ['punctuation', 'punctuation.bracket', 'punctuation.delimiter', 'punctuation.special', 'punctuation.markup', 'punctuation.bracket.html', 'punctuation.delimiter.html', 'punctuation.bracket.jsx', 'punctuation.delimiter.jsx'],
	tag: ['tag', 'tag.jsx', 'link_text', 'selector', 'selector.class', 'selector.id'],
	attr: ['attribute', 'attribute.jsx'],
	meta: ['preproc', 'tag.doctype'],
	inserted: ['diff.plus'],
	deleted: ['diff.minus'],
};

/** Volt Dark/Light (or the chosen Volt theme) as a Zed theme, the form Highlights reads. */
function zedTheme(p: IVoltPalette): object {
	const bg = p.codeBg;
	const syntax: Record<string, { color: string; font_style?: string; font_weight?: number }> = {};
	for (const [kind, tokens] of Object.entries(SYNTAX) as [keyof IVoltPalette['syntax'], readonly string[]][]) {
		for (const token of tokens) {
			syntax[token] = { color: over(p.syntax[kind], bg) };
		}
	}
	syntax['comment'].font_style = 'italic';
	syntax['comment.doc'].font_style = 'italic';
	syntax['title'].font_weight = 600;
	syntax['emphasis'] = { color: over(p.syntax.plain, bg), font_style: 'italic' };
	syntax['emphasis.strong'] = { color: over(p.syntax.plain, bg), font_weight: 600 };
	return {
		name: 'volt',
		appearance: p.scheme,
		style: {
			'editor.foreground': over(p.syntax.plain, bg),
			'editor.background': bg,
			'created': p.diffAddedFg,
			'deleted': p.diffRemovedFg,
			'modified': p.warning,
			syntax,
		},
	};
}

/** A tint's colour without its alpha: the library mixes it into the background itself (20% dark, 12% light). */
function opaque(color: string): string {
	const [r, g, b] = rgba(color);
	return `rgb(${r}, ${g}, ${b})`;
}

/**
 * The page's colours and font. Row tints are the colours the library mixes into the code
 * background (so the sticky number column stays opaque), the palette's tint without its alpha.
 */
function themeCss(p: IVoltPalette): string {
	const bg = p.codeBg;
	const added = opaque(p.diffAdded);
	const removed = opaque(p.diffRemoved);
	const vars: Record<string, string> = {
		'--diffs-font-family': '"Geist Mono", ui-monospace, Menlo, monospace',
		'--diffs-header-font-family': '-apple-system, system-ui, sans-serif',
		'--diffs-font-size': '12.5px',
		'--diffs-line-height': '20px',
		'--diffs-tab-size': '4',
		'--diffs-font-features': '"liga" 0, "calt" 0',
		'--diffs-min-number-column-width': '3ch',
		'--diffs-gap-inline': '8px',
		'--diffs-addition-color-override': p.diffAddedFg,
		'--diffs-deletion-color-override': p.diffRemovedFg,
		'--diffs-modified-color-override': p.warning,
		'--diffs-bg-context-override': bg,
		'--diffs-bg-context-gutter-override': bg,
		'--diffs-bg-buffer-override': bg,
		'--diffs-bg-addition-override': added,
		'--diffs-bg-addition-number-override': added,
		'--diffs-bg-deletion-override': removed,
		'--diffs-bg-deletion-number-override': removed,
		'--diffs-bg-separator-override': over(p.fill, bg),
		'--diffs-fg-number-override': over(p.fgQuaternary, bg),
		'--diffs-fg-number-addition-override': p.diffAddedFg,
		'--diffs-fg-number-deletion-override': p.diffRemovedFg,
		'--diffs-bg-selection-override': opaque(p.info),
		'--diffs-bg-selection-number-override': opaque(p.info),
	};
	return `:root { ${Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(' ')} }`;
}

/** Inside the viewer's Shadow DOM: the folded stretches' labels in the palette's muted text (sizes untouched: the virtualizer estimates them). */
function unsafeCss(p: IVoltPalette): string {
	return `[data-separator-content], [data-expand-button] { color: ${over(p.fgTertiary, p.codeBg)}; }`;
}

let payload: string | undefined;

/**
 * @pierre/diffs with Highlights and Geist Mono, as one script the app injects once the small
 * viewer page has loaded (like Monaco's, to keep the bundle out of React Native's props). Built once.
 */
export function diffsPayload(): string {
	payload ??= `(function () {
	const style = document.createElement('style');
	style.textContent = ${JSON.stringify(`@font-face { font-family: 'Geist Mono'; src: url(data:font/ttf;base64,${GEIST_MONO_TTF_BASE64}) format('truetype'); font-weight: 100 900; font-display: block; }`)};
	document.head.appendChild(style);
})();
${DIFFS_JS}
;window.__voltStart && window.__voltStart();
true;`;
	return payload;
}

/**
 * The viewer page: a scroll root and the boot script, waiting for {@link diffsPayload}. Calls to
 * `window.volt` (load, wrap) queue until it runs. `load({ name, before, after })` shows a diff in
 * one column (unchanged stretches folded with expand controls, or all of them with `full`),
 * `load({ name, text, line })` a file. It talks to the app through ReactNativeWebView.postMessage:
 * `ready`, `diff` (the counts), `rendered` (first lines on screen), `highlighted`, `error`.
 */
export function diffsPage(p: IVoltPalette, boot: IDiffsBoot): string {
	const config = { ...boot, dark: p.scheme === 'dark', theme: zedTheme(p), css: unsafeCss(p) };
	return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
${themeCss(p)}
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: ${p.codeBg}; -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; }
#root { position: fixed; inset: 0; overflow: auto; overscroll-behavior: none; -webkit-overflow-scrolling: touch; }
</style>
</head><body><div id="root"></div>
<script>
const BOOT = ${scriptJson(config)};
const T0 = performance.now();
let shown = false;
function post(m) { window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
function fail(err) {
	// Past the first lines a failure (say, a highlight) keeps the plain text: only a page that never drew reports it.
	if (!shown) { post({ type: 'error', message: String((err && err.message) || err) }); }
}
window.onerror = function (message) { fail(message); };
window.addEventListener('unhandledrejection', function (e) { fail(e.reason); });
const queue = [];
window.volt = { load: function (d) { queue.push(['load', d]); }, wrap: function (on) { queue.push(['wrap', on]); } };
window.__voltStart = function () {
	try {
		const app = start();
		window.volt = app;
		queue.splice(0).forEach(function (c) { app[c[0]](c[1]); });
	} catch (err) { fail(err); }
};
function start() {
	const D = window.VoltDiffs;
	if (!D.canUseWASM()) { throw new Error('WebAssembly is off in this web view'); }
	const theme = D.setTheme(BOOT.theme);
	D.warm().catch(function () {});
	const font = document.fonts.load('12.5px "Geist Mono"').catch(function () {});
	let wrap = BOOT.wrap;
	let loadedAt = 0;
	let highlighted = false;
	const root = document.getElementById('root');
	function options() {
		return {
			theme: theme,
			themeType: BOOT.dark ? 'dark' : 'light',
			preferredHighlighter: 'highlights',
			diffStyle: 'unified',
			diffIndicators: 'bars',
			lineDiffType: 'word-alt',
			overflow: wrap ? 'wrap' : 'scroll',
			disableFileHeader: true,
			hunkSeparators: 'line-info-basic',
			expandUnchanged: !!BOOT.full,
			layout: { paddingTop: 4, paddingBottom: 48, gap: 0 },
			unsafeCSS: BOOT.css,
			onPostRender: function (node, instance, phase) {
				if (phase === 'unmount') { return; }
				if (!shown) {
					shown = true;
					requestAnimationFrame(function () { post({ type: 'rendered', ms: Math.round(performance.now() - loadedAt), sinceBoot: Math.round(performance.now() - T0) }); });
				}
				if (!highlighted && node.shadowRoot && node.shadowRoot.querySelector('[data-line] span[style] + span[style]')) {
					highlighted = true;
					post({ type: 'highlighted', ms: Math.round(performance.now() - loadedAt) });
				}
			},
		};
	}
	const viewer = new D.CodeView(options());
	viewer.setup(root);
	post({ type: 'ready', ms: Math.round(performance.now() - T0) });
	// Highlights colours a 10k-line file in tens of milliseconds; past this the lines draw plain
	// first and the colours follow a frame later, so a huge file never waits for them.
	const PLAIN_FIRST = 8000;
	function later(fn) { requestAnimationFrame(function () { setTimeout(fn, 0); }); }
	return {
		load: function (data) {
			loadedAt = performance.now();
			font.then(function () {
				try {
					if (BOOT.mode === 'diff') {
						const t = performance.now();
						const diff = D.fileDiff(data.name, data.before, data.after);
						post({ type: 'diff', additions: diff.additions, deletions: diff.deletions, hunks: diff.hunks, ms: Math.round(performance.now() - t) });
						if (!diff.hunks) { shown = true; return; }
						const big = Math.max(diff.metadata.additionLines.length, diff.metadata.deletionLines.length) > PLAIN_FIRST;
						viewer.setItems([{ id: 'diff', type: 'diff', fileDiff: big ? Object.assign({}, diff.metadata, { lang: 'text' }) : diff.metadata }]);
						if (big) { later(function () { viewer.updateItem({ id: 'diff', type: 'diff', fileDiff: diff.metadata, version: 2 }); }); }
					} else {
						const file = { name: data.name, contents: data.text };
						const big = data.text.length > PLAIN_FIRST * 40;
						viewer.setItems([{ id: 'file', type: 'file', file: big ? Object.assign({ lang: 'text' }, file) : file }]);
						if (big) { later(function () { viewer.updateItem({ id: 'file', type: 'file', file: file, version: 2 }); }); }
						if (data.line) {
							viewer.setSelectedLines({ id: 'file', range: { start: data.line, end: data.line } });
							viewer.scrollTo({ type: 'line', id: 'file', lineNumber: data.line, align: 'center', behavior: 'instant' });
						}
					}
				} catch (err) { fail(err); }
			});
		},
		wrap: function (on) {
			wrap = on;
			viewer.setOptions(options());
		},
	};
}
</script></body></html>`;
}
