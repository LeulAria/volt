/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { createRequire } from 'node:module';
import { promises as fs } from 'fs';
import { dirname, join, normalize, sep } from '../../../base/common/path.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { AgentServerProtocol } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { IAgentHistoryService } from '../../../workbench/services/voltRuntime/common/history/agentHistory.js';
import { buildVisualPage } from '../../../workbench/contrib/voltAgent/browser/visuals/agentVisualPage.js';
import type * as BeautifulMermaid from '../../../workbench/contrib/voltAgent/browser/blocks/vendor/beautifulMermaid.js';

const require = createRequire(import.meta.url);

/** Where paired clients load KaTeX's stylesheet and fonts from (public files, no token). */
export const KATEX_ASSET_PATH = '/vendor/katex/';

/** The client's colors, so a page drawn here matches the app it is shown in. */
export interface IRenderTheme {
	readonly kind: 'light' | 'dark';
	readonly background: string;
	readonly foreground: string;
	readonly muted: string;
	readonly border: string;
	readonly accent: string;
	readonly surface?: string;
	readonly code?: string;
	readonly font?: string;
	readonly mono?: string;
}

export interface IRenderOptions {
	readonly theme?: Partial<IRenderTheme>;
	/** Echoed in every message the page posts, so one host can tell its frames apart. */
	readonly frame?: string;
	/** Origin the client reaches this server on (`http://host:port`), for KaTeX's stylesheet. */
	readonly origin?: string;
}

/** A complete HTML document for a WebView or an iframe's `srcdoc`. */
export interface IRenderedPage {
	readonly html: string;
	/** What the page measured on the desktop, a first guess before it reports its own height. */
	readonly height?: number;
}

const DARK: IRenderTheme = { kind: 'dark', background: '#1b1b1d', foreground: '#e8e8ea', muted: '#9a9aa2', border: '#34343a', accent: '#5aa1ff', surface: '#232327', code: '#232327' };
const LIGHT: IRenderTheme = { kind: 'light', background: '#ffffff', foreground: '#1d1d1f', muted: '#6e6e73', border: '#e2e2e6', accent: '#0a66d8', surface: '#f5f5f7', code: '#f5f5f7' };

const PALETTE: Record<'light' | 'dark', Record<string, string>> = {
	dark: { blue: '#5aa1ff', green: '#4fc27d', purple: '#b18cff', yellow: '#e5c15a', red: '#f0716b', teal: '#4cc9c0', pink: '#ef7fb6', orange: '#f29b55' },
	light: { blue: '#0a66d8', green: '#1f8a4c', purple: '#7b4fd6', yellow: '#b8860b', red: '#d1342f', teal: '#13827a', pink: '#c2407f', orange: '#cc6a1f' },
};

const MAX_MERMAID_CHARS = 50_000;
const MAX_MATH_CHARS = 10_000;

function color(value: unknown, fallback: string): string {
	return typeof value === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i.test(value.trim()) ? value.trim() : fallback;
}

function font(value: unknown, fallback: string): string {
	return typeof value === 'string' && /^[\w\s"',.-]{1,200}$/.test(value) ? value : fallback;
}

export function resolveTheme(input: Partial<IRenderTheme> | undefined): IRenderTheme {
	const base = input?.kind === 'light' ? LIGHT : DARK;
	return {
		kind: base.kind,
		background: color(input?.background, base.background),
		foreground: color(input?.foreground, base.foreground),
		muted: color(input?.muted, base.muted),
		border: color(input?.border, base.border),
		accent: color(input?.accent, base.accent),
		surface: color(input?.surface, base.surface!),
		code: color(input?.code, base.code!),
		font: font(input?.font, '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'),
		mono: font(input?.mono, 'ui-monospace, "SF Mono", Menlo, monospace'),
	};
}

/** The `--vscode-*` colors a visual page reads, from the client's theme (a page in Volt's window gets them from the webview). */
function visualThemeCss(theme: IRenderTheme): string {
	const palette = PALETTE[theme.kind];
	const vars: Record<string, string> = {
		'--vscode-foreground': theme.foreground,
		'--vscode-editor-background': theme.background,
		'--vscode-sideBar-background': theme.background,
		'--vscode-descriptionForeground': theme.muted,
		'--vscode-editorWidget-background': theme.surface!,
		'--vscode-editorHoverWidget-background': theme.surface!,
		'--vscode-widget-border': theme.border,
		'--vscode-input-background': 'transparent',
		'--vscode-focusBorder': theme.accent,
		'--vscode-button-background': theme.accent,
		'--vscode-button-foreground': '#ffffff',
		'--vscode-textLink-foreground': theme.accent,
		'--vscode-textCodeBlock-background': theme.code!,
		'--vscode-textPreformat-foreground': theme.foreground,
		'--vscode-font-family': theme.font!,
		'--vscode-editor-font-family': theme.mono!,
		'--vscode-charts-blue': palette.blue,
		'--vscode-charts-green': palette.green,
		'--vscode-charts-purple': palette.purple,
		'--vscode-charts-yellow': palette.yellow,
		'--vscode-charts-red': palette.red,
		'--vscode-charts-orange': palette.orange,
		'--vscode-errorForeground': palette.red,
		'--vscode-editorWarning-foreground': palette.yellow,
		'--vscode-editorInfo-foreground': palette.blue,
		'--volt-surface': theme.background,
		'--volt-chart-accent': theme.accent,
	};
	for (const [slot, value] of Object.entries(palette)) {
		vars[`--volt-chart-${slot}`] = value;
	}
	return `:root{${Object.entries(vars).map(([name, value]) => `${name}:${value};`).join('')}}`;
}

/**
 * Runs first in every page: the desktop bridge (`acquireVsCodeApi`) posts to the app hosting the
 * frame instead (a React Native WebView or the parent window), and the page reports its height
 * whenever it changes, so the host sizes the frame to fit with no inner scrollbar.
 */
function bridgeScript(frame: string): string {
	return `<script>(function(){var frame=${JSON.stringify(frame)};
function host(m){try{m=Object.assign({frame:frame},m);if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(JSON.stringify(m));}else if(window.parent!==window){window.parent.postMessage(m,'*');}}catch(e){}}
window.acquireVsCodeApi=function(){return{postMessage:host,setState:function(){},getState:function(){return undefined;}};};
var last=0;function size(){var b=document.body;if(!b){return;}var r=b.getBoundingClientRect(),h=Math.ceil(Math.max(r.bottom+(parseFloat(getComputedStyle(b).marginBottom)||0),b.scrollHeight));if(h>0&&Math.abs(h-last)>1){last=h;host({type:'volt-frame-height',height:h});}}
function watch(){size();try{new ResizeObserver(size).observe(document.body);}catch(e){}try{new MutationObserver(size).observe(document.body,{subtree:true,childList:true,attributes:true});}catch(e){}var n=0,t=setInterval(function(){size();if(++n>20){clearInterval(t);}},250);}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',watch);}else{watch();}window.addEventListener('load',size);
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(a&&!/^#/.test(a.getAttribute('href')||'')){e.preventDefault();host({type:'volt-open',href:a.href});}},true);
})();</script>`;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, ch => ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;');
}

/** A small page for a diagram or a formula: the client's colors, no chart engine. */
function plainPage(body: string, theme: IRenderTheme, frame: string, head = '', bodyCss = ''): string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${bridgeScript(frame)}${head}`
		+ `<style>:root{color-scheme:${theme.kind}}html,body{margin:0;padding:0;background:transparent;color:${theme.foreground};font-family:${theme.font};-webkit-text-size-adjust:100%}${bodyCss}</style>`
		+ `</head><body>${body}</body></html>`;
}

/**
 * Pages, diagrams and formulas drawn for the paired apps. The desktop draws these in its own
 * window (webviews, beautiful-mermaid, KaTeX); a phone's WebView or a browser iframe gets the
 * same output as one self-contained document, in the app's colors.
 */
export class ServerRender extends Disposable {

	private mermaid: Promise<typeof BeautifulMermaid> | undefined;
	private katex: typeof import('katex').default | undefined;

	constructor(
		protocol: AgentServerProtocol,
		private readonly history: IAgentHistoryService,
		private readonly logService: ILogService,
	) {
		super();
		this._register(protocol.registerMethods('render', {
			visual: (_ctx, ref, kind, options) => this.visual(String(ref ?? ''), kind === 'chart' ? 'chart' : 'html', (options ?? {}) as IRenderOptions),
			chart: (_ctx, spec, options) => this.chart(typeof spec === 'string' ? spec : JSON.stringify(spec ?? null), (options ?? {}) as IRenderOptions),
			mermaid: (_ctx, source, options) => this.diagram(String(source ?? ''), (options ?? {}) as IRenderOptions),
			math: (_ctx, tex, display, options) => this.math(String(tex ?? ''), display !== false, (options ?? {}) as IRenderOptions),
			mathInline: (_ctx, tex) => this.mathInline(String(tex ?? '')),
		}));
	}

	/** An agent's html_render page or render_chart dashboard, ready for a frame. */
	private async visual(ref: string, kind: 'html' | 'chart', options: IRenderOptions): Promise<IRenderedPage> {
		const attachment = await this.history.getAttachment(ref);
		if (!attachment) {
			throw new Error('That visual is no longer stored on this computer.');
		}
		const text = new TextDecoder().decode(attachment.bytes);
		return kind === 'chart' ? this.chart(text, options) : this.page(text, options);
	}

	/** A chart spec (render_chart's, or a ```volt-chart fence) drawn by Volt's chart engine. */
	private chart(spec: string, options: IRenderOptions): IRenderedPage {
		if (spec.length > 2_000_000) {
			throw new Error('The chart is too large to draw.');
		}
		return this.page(`<!doctype html><html><head><style>body{padding:2px 0}</style></head><body><script type="application/volt-chart+json">${spec.replace(/<\//g, '<\\/')}</script></body></html>`, options);
	}

	private page(source: string, options: IRenderOptions): IRenderedPage {
		const theme = resolveTheme(options.theme);
		const frame = String(options.frame ?? '');
		const page = buildVisualPage(source, { themeCss: visualThemeCss(theme), kind: theme.kind });
		// The bridge goes first: the page's own bootstrap asks for `acquireVsCodeApi` as it starts.
		const at = page.indexOf('<meta charset="utf-8">');
		const html = at < 0 ? page : page.slice(0, at) + '<meta charset="utf-8">' + bridgeScript(frame) + page.slice(at + '<meta charset="utf-8">'.length);
		return { html };
	}

	private async diagram(source: string, options: IRenderOptions): Promise<IRenderedPage & { readonly svg: string }> {
		if (source.length > MAX_MERMAID_CHARS) {
			throw new Error('The diagram is too large to draw.');
		}
		this.mermaid ??= import('../../../workbench/contrib/voltAgent/browser/blocks/vendor/beautifulMermaid.js');
		const lib = await this.mermaid;
		const theme = resolveTheme(options.theme);
		let svg = lib.renderMermaidSVG(source, {
			bg: theme.background,
			fg: theme.foreground,
			line: theme.muted,
			accent: theme.accent,
			muted: theme.muted,
			surface: theme.surface,
			border: theme.border,
			font: '-apple-system',
			padding: 8,
			transparent: true,
		});
		// The library asks Google Fonts for the font by name: the system font is already there.
		svg = svg.replace(/@import url\([^)]*\);?/g, '');
		// Fit the frame's width, but never below 60%: past that the labels are unreadable on a phone, so a wide diagram scrolls sideways instead.
		const fit = `<script>(function(){function fit(){var s=document.querySelector('.d svg');if(!s){return;}var w=s.viewBox&&s.viewBox.baseVal&&s.viewBox.baseVal.width||s.getBoundingClientRect().width,h=s.viewBox&&s.viewBox.baseVal&&s.viewBox.baseVal.height||0,a=document.documentElement.clientWidth-2,k=Math.min(1,Math.max(a/w,0.6));s.style.width=Math.round(w*k)+'px';s.style.height=h?Math.round(h*k)+'px':'auto';}document.addEventListener('DOMContentLoaded',fit);window.addEventListener('resize',fit);})();</script>`;
		const html = plainPage(`<div class="d">${svg}</div>`, theme, String(options.frame ?? ''), fit,
			'.d{overflow-x:auto;overflow-y:hidden;padding:4px 0;-webkit-overflow-scrolling:touch}.d svg{display:block;margin:0 auto;max-width:none}');
		return { html, svg };
	}

	private loadKatex(): typeof import('katex').default {
		this.katex ??= require('katex') as typeof import('katex').default;
		return this.katex;
	}

	private math(tex: string, display: boolean, options: IRenderOptions): IRenderedPage & { readonly markup: string } {
		if (tex.length > MAX_MATH_CHARS) {
			throw new Error('The formula is too long to typeset.');
		}
		const markup = this.loadKatex().renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' });
		const theme = resolveTheme(options.theme);
		const origin = typeof options.origin === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(options.origin) ? options.origin.replace(/\/+$/, '') : '';
		const head = `<link rel="stylesheet" href="${escapeHtml(origin + KATEX_ASSET_PATH)}katex.min.css">`;
		const html = plainPage(`<div class="m">${markup}</div>`, theme, String(options.frame ?? ''), head,
			'.m{overflow-x:auto;overflow-y:hidden;padding:2px 0;font-size:16px}.m .katex-display{margin:4px 0}.m .katex{font-size:1.08em}');
		return { html, markup };
	}

	/** Inline math as markup for clients that draw HTML themselves (the browser app). */
	private mathInline(tex: string): { readonly markup: string } {
		if (tex.length > MAX_MATH_CHARS) {
			throw new Error('The formula is too long to typeset.');
		}
		return { markup: this.loadKatex().renderToString(tex, { displayMode: false, throwOnError: false, output: 'html' }) };
	}

	/** Serves KaTeX's stylesheet and fonts; true when the request was for them. */
	async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (!url.pathname.startsWith(KATEX_ASSET_PATH) || req.method !== 'GET') {
			return false;
		}
		let root: string;
		try {
			root = dirname(require.resolve('katex/dist/katex.min.css'));
		} catch (err) {
			this.logService.warn('[volt agent server] KaTeX is not installed', err);
			res.writeHead(404).end();
			return true;
		}
		const file = normalize(join(root, decodeURIComponent(url.pathname.slice(KATEX_ASSET_PATH.length))));
		const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.woff') ? 'font/woff' : file.endsWith('.ttf') ? 'font/ttf' : undefined;
		if (!file.startsWith(root + sep) || !type) {
			res.writeHead(404).end();
			return true;
		}
		try {
			const data = await fs.readFile(file);
			res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800', 'Access-Control-Allow-Origin': '*' });
			res.end(data);
		} catch {
			res.writeHead(404).end();
		}
		return true;
	}
}
