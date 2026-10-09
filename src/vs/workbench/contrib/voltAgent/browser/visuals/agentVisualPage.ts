/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { voltChartsRuntime } from './voltChartsRuntime.js';

/**
 * Agent pages (render_html) are stored as the agent wrote them. Each time one is shown, Volt
 * wraps it: theme variables, a base stylesheet, a small bridge, and the Volt Charts engine
 * (`window.VoltCharts`), injected at the start of `<head>` so the page's own styles and scripts
 * come after and win.
 */

/** The reply column at the default chat width; agents preview and pages are measured at it. */
export const VISUAL_COLUMN_WIDTH = 728;
export const VISUAL_MIN_HEIGHT = 80;
export const VISUAL_MAX_HEIGHT = 2000;
export const VISUAL_MAX_HTML_CHARS = 600_000;

/**
 * Names agents already know from shadcn and T3 Code, mapped onto the editor theme. Every
 * `--vscode-*` color is there too, and both follow the user's theme live.
 */
const BASE_CSS = `:root{
--background:var(--volt-surface,var(--vscode-sideBar-background,var(--vscode-editor-background)));
--foreground:var(--vscode-foreground);
--muted:color-mix(in srgb,var(--vscode-foreground) 8%,transparent);
--muted-foreground:var(--vscode-descriptionForeground);
--card:var(--vscode-editorWidget-background);
--card-foreground:var(--vscode-foreground);
--popover:var(--vscode-editorHoverWidget-background,var(--vscode-editorWidget-background));
--popover-foreground:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground));
--secondary:var(--vscode-button-secondaryBackground);
--secondary-foreground:var(--vscode-button-secondaryForeground);
--border:var(--vscode-widget-border,color-mix(in srgb,var(--vscode-foreground) 12%,transparent));
--input:var(--vscode-input-background);
--ring:var(--vscode-focusBorder);
--primary:var(--vscode-button-background);
--primary-foreground:var(--vscode-button-foreground);
--accent:var(--volt-chart-accent,var(--vscode-textLink-foreground));
--accent-foreground:var(--vscode-button-foreground);
--destructive:var(--volt-chart-red,var(--vscode-errorForeground));
--warning:var(--volt-chart-yellow,var(--vscode-editorWarning-foreground));
--success:var(--volt-chart-green,var(--vscode-charts-green));
--info:var(--volt-chart-blue,var(--vscode-editorInfo-foreground));
--code-background:var(--vscode-textCodeBlock-background);
--code-foreground:var(--vscode-textPreformat-foreground);
--chart-1:var(--volt-chart-accent,var(--vscode-textLink-foreground));
--chart-2:var(--volt-chart-orange,var(--vscode-charts-orange));
--chart-3:var(--volt-chart-green,var(--vscode-charts-green));
--chart-4:var(--volt-chart-purple,var(--vscode-charts-purple));
--chart-5:var(--volt-chart-yellow,var(--vscode-charts-yellow));
--chart-6:var(--volt-chart-teal,var(--vscode-charts-blue));
--chart-7:var(--volt-chart-pink,var(--vscode-charts-purple));
--chart-8:var(--volt-chart-red,var(--vscode-charts-red));
--radius:8px;
--font-sans:var(--vscode-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif);
--font-mono:var(--vscode-editor-font-family,ui-monospace,Menlo,monospace);
}
html{background:transparent;color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
body{margin:0;padding:0;background:transparent;color:var(--foreground);font-family:var(--font-sans);font-size:14px}
code,kbd,pre,samp{font-family:var(--font-mono)}
a{color:var(--accent)}`;

/**
 * The bridge: `window.volt.open(href)` (and openFile / openSession) asks Volt to open a chat, a
 * file or a link; theme changes arrive as messages; `[data-volt-chart]` elements and
 * `<script type="application/volt-chart+json">` blocks render once the page has loaded.
 */
function bootstrapScript(preview: boolean, kind: 'light' | 'dark'): string {
	return `(function(){var preview=${preview ? 'true' : 'false'},api=null;try{if(typeof acquireVsCodeApi==='function'){api=acquireVsCodeApi();}}catch(e){}
function post(m){if(api){api.postMessage(m);}}
function str(v){return typeof v==='string'?v:JSON.stringify(v);}
var data,dataRead=false;function readData(){if(!dataRead){var el=document.getElementById('volt-data');if(el){dataRead=true;try{data=JSON.parse(el.textContent||'null');}catch(e){data=null;}}}return data===undefined?null:data;}
window.volt={preview:preview,theme:'${kind}',get data(){return readData();},open:function(h){post({type:'volt-open',href:String(h)});},openFile:function(p,l){post({type:'volt-open',href:'volt://file/'+encodeURI(String(p))+(l?'#L'+l:'')});},openSession:function(id){post({type:'volt-open',href:'volt://session/'+encodeURIComponent(String(id))});},
send:function(t){post({type:'volt-send',text:str(t)});},prompt:function(t){post({type:'volt-prompt',text:str(t)});},setContext:function(v){post({type:'volt-context',value:str(v)});},fullscreen:function(on){post({type:'volt-display',mode:on===false?'inline':'fullscreen'});}};
window.addEventListener('message',function(e){var d=e.data;if(d&&d.type==='volt-theme'&&typeof d.css==='string'){var s=document.getElementById('volt-visual-theme');if(s){s.textContent=d.css;}if(d.kind){window.volt.theme=d.kind;}}});
function mount(){if(preview&&document.body&&!/vscode-(light|dark|high-contrast)/.test(document.body.className)){document.body.classList.add('vscode-${kind}');}if(window.VoltCharts){window.VoltCharts.mountAll(document,{animate:!preview,onOpen:window.volt.open});}}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',mount);}else{mount();}})();`;
}

let runtimeSource: string | undefined;

/** `window.VoltCharts`, the same engine the transcript draws native charts with. */
function chartsScript(): string {
	runtimeSource ??= `window.VoltCharts=(${voltChartsRuntime.toString()})(window);`;
	return runtimeSource;
}

export interface IVisualPageOptions {
	/** `:root{...}` with the chart palette and surface (and, for previews, every `--vscode-*` color). */
	readonly themeCss: string;
	readonly kind: 'light' | 'dark';
	/** Offscreen screenshot: no animations, theme classes set by the page itself. */
	readonly preview?: boolean;
}

/** Blanks comments, raw-text elements and templates (same length), so their contents cannot receive the head injection. */
function blankNonMarkup(html: string): string {
	return html.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, match => ' '.repeat(match.length));
}

/** Escapes a script body so the page's markup cannot end it early. */
function scriptBody(source: string): string {
	return source.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/**
 * Puts the agent's `data` (any JSON) into its page as `<script id="volt-data" type="application/json">`,
 * read by the page as `window.volt.data`: the page stays a template and the data stays exact.
 */
export function withPageData(html: string, data: unknown): string {
	const tag = `<script id="volt-data" type="application/json">${scriptBody(JSON.stringify(data) ?? 'null')}</script>`;
	const scan = blankNonMarkup(html);
	const head = /<head(?:\s[^>]*)?>/i.exec(scan);
	if (head) {
		const at = head.index + head[0].length;
		return html.slice(0, at) + tag + html.slice(at);
	}
	return tag + html;
}

export function buildVisualPage(html: string, options: IVisualPageOptions): string {
	const scan = blankNonMarkup(html);
	const head = [
		/<meta\s[^>]*charset/i.test(scan.slice(0, 4096)) ? '' : '<meta charset="utf-8">',
		/<meta\s[^>]*name\s*=\s*["']?viewport/i.test(scan) ? '' : '<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<style id="volt-visual-base">${BASE_CSS}</style>`,
		`<style id="volt-visual-theme">${options.themeCss.replace(/<\//g, '<\\/')}</style>`,
		`<script>${scriptBody(bootstrapScript(!!options.preview, options.kind))}</script>`,
		`<script>${scriptBody(chartsScript())}</script>`,
	].join('');
	const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
	if (headOpen) {
		const at = headOpen.index + headOpen[0].length;
		return html.slice(0, at) + head + html.slice(at);
	}
	const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
	if (htmlOpen) {
		const at = htmlOpen.index + htmlOpen[0].length;
		return `${html.slice(0, at)}<head>${head}</head>${html.slice(at)}`;
	}
	const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
	if (doctype) {
		return `${html.slice(0, doctype[0].length)}<head>${head}</head>${html.slice(doctype[0].length)}`;
	}
	return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

const IMAGE_MIMES: Readonly<Record<string, string>> = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
	avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
};

/** Absolute local image paths in a page: `src="/abs/a.png"`, `url(/abs/b.webp)`, `'file:///abs/c.jpg'`. */
const LOCAL_IMAGE = /(["'(])((?:file:\/\/)?\/[^"'()<>\s]+\.(png|jpe?g|gif|webp|avif|svg|bmp|ico))(?=["')])/gi;

export function localImagePaths(html: string): string[] {
	const paths = new Set<string>();
	for (const match of html.matchAll(LOCAL_IMAGE)) {
		paths.add(match[2]);
	}
	return [...paths];
}

export function imageMime(path: string): string | undefined {
	return IMAGE_MIMES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
}

/** The page with each local image path replaced by its data URL (paths missing from `images` stay as they are). */
export function inlineLocalImages(html: string, images: ReadonlyMap<string, string>): string {
	return html.replace(LOCAL_IMAGE, (match, quote: string, path: string) => {
		const data = images.get(path);
		return data ? `${quote}${data}` : match;
	});
}
