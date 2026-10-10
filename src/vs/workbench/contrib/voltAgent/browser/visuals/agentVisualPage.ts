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
--secondary:color-mix(in srgb,var(--vscode-foreground) 8%,transparent);
--secondary-foreground:var(--vscode-foreground);
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
 * Plain elements, styled like the rest of Volt, so a page written as bare HTML (headings, a table,
 * two buttons) looks finished. Every rule is inside :where(), which has no specificity, and this
 * sheet comes first: any style the page sets itself wins.
 */
const ELEMENT_CSS = `
:where(h1,h2,h3,h4,h5,h6){margin:0 0 .5em;color:var(--foreground);font-weight:600;line-height:1.25;letter-spacing:-.01em;text-wrap:balance}
:where(h1){font-size:22px}:where(h2){font-size:18px}:where(h3){font-size:15px}:where(h4){font-size:13px}
:where(h5,h6){font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted-foreground)}
:where(* + h1,* + h2,* + h3,* + h4){margin-top:1.25em}
:where(p){margin:0 0 .75em;text-wrap:pretty}
:where(small){color:var(--muted-foreground);font-size:12px}
:where(strong,b){font-weight:600}
:where(a){text-decoration:none}:where(a:hover){text-decoration:underline;text-underline-offset:2px}
:where(ul,ol){margin:0 0 .75em;padding-left:1.4em}:where(li){margin:.2em 0}:where(li)::marker{color:var(--muted-foreground)}
:where(hr){height:0;margin:16px 0;border:0;border-top:1px solid var(--border)}
:where(img,svg,video,canvas){max-width:100%}
:where(img,video){height:auto;border-radius:calc(var(--radius) - 2px)}
:where(:not(pre)>code){padding:.1em .38em;border-radius:5px;background:var(--muted);color:var(--code-foreground);font-size:.88em}
:where(pre){margin:0 0 .75em;padding:12px 14px;border-radius:var(--radius);background:var(--muted);overflow:auto;font-size:12.5px;line-height:1.55}
:where(kbd){display:inline-block;min-width:1.4em;padding:0 .4em;border-radius:5px;border:1px solid var(--border);border-bottom-width:2px;font-size:.82em;line-height:1.5;text-align:center}
:where(blockquote){margin:0 0 .75em;padding:10px 14px;border-left:3px solid var(--accent);border-radius:0 var(--radius) var(--radius) 0;background:var(--muted);color:var(--muted-foreground)}
:where(blockquote)>:where(:last-child){margin-bottom:0}
:where(mark){padding:0 .2em;border-radius:3px;background:color-mix(in srgb,var(--warning) 30%,transparent);color:inherit}
:where(table){width:100%;margin:0 0 .75em;border-collapse:collapse;border-spacing:0;font-size:13px;font-variant-numeric:tabular-nums}
:where(th,td){padding:8px 12px 8px 0;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
:where(th:last-child,td:last-child){padding-right:0}
:where(th){padding-top:4px;color:var(--muted-foreground);font-size:12px;font-weight:500;white-space:nowrap}
:where(tbody tr:last-child)>:where(td){border-bottom:0}
:where(caption){padding-bottom:8px;color:var(--muted-foreground);font-size:12px;text-align:left}
:where(details){margin:0 0 .75em;border:1px solid var(--border);border-radius:var(--radius)}
:where(summary){padding:9px 12px;cursor:pointer;font-weight:500}
:where(details[open]>summary){border-bottom:1px solid var(--border)}
:where(details)>:where(:not(summary)){margin-left:12px;margin-right:12px}
:where(details)>:where(:not(summary):first-of-type){margin-top:10px}
:where(button,input[type=button],input[type=submit],input[type=reset]){min-height:30px;padding:5px 12px;border:1px solid var(--border);border-radius:7px;background:color-mix(in srgb,var(--foreground) 6%,transparent);color:var(--foreground);font:inherit;font-size:13px;font-weight:500;line-height:18px;text-align:center;cursor:pointer;transition:background-color .12s,border-color .12s,transform .06s}
:where(button,input[type=button],input[type=submit],input[type=reset]):where(:hover){background:color-mix(in srgb,var(--foreground) 11%,transparent)}
:where(button,input[type=button],input[type=submit],input[type=reset]):where(:active){transform:scale(.98)}
:where(button,input,select,textarea,summary,a):where(:focus-visible){outline:2px solid var(--ring);outline-offset:1px}
:where(button:disabled,input:disabled,select:disabled,textarea:disabled){opacity:.5;cursor:default}
:where(button.primary,button[data-variant=primary],input[type=submit]){border-color:transparent;background:var(--primary);color:var(--primary-foreground)}
:where(button.primary,button[data-variant=primary],input[type=submit]):where(:hover){background:color-mix(in srgb,var(--primary) 88%,var(--foreground))}
:where(input:not([type]),input[type=text],input[type=search],input[type=email],input[type=url],input[type=number],input[type=password],input[type=date],input[type=time],select,textarea){box-sizing:border-box;height:30px;padding:0 10px;border:1px solid var(--border);border-radius:7px;background:var(--input,transparent);color:var(--foreground);font:inherit;font-size:13px}
:where(textarea){height:auto;min-height:72px;padding:8px 10px;line-height:1.5;resize:vertical}
:where(input,textarea)::placeholder{color:var(--muted-foreground)}
:where(input[type=checkbox],input[type=radio],input[type=range],progress,meter){accent-color:var(--accent)}
:where(label){font-size:13px}
:where(progress){height:6px}
::selection{background:color-mix(in srgb,var(--accent) 35%,transparent)}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{border:3px solid transparent;border-radius:10px;background:color-mix(in srgb,var(--foreground) 22%,transparent) padding-box}::-webkit-scrollbar-track{background:transparent}
`;

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
window.addEventListener('message',function(e){var d=e.data;if(d&&d.type==='volt-theme'&&typeof d.css==='string'){var s=document.getElementById('volt-visual-theme');if(s){s.textContent=d.css;}if(d.kind){window.volt.theme=d.kind;var c=document.getElementById('volt-visual-scheme');if(c){c.textContent=':root{color-scheme:'+d.kind+'}';}}}});
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

/**
 * Removes the page's own charset declarations (`<meta charset>`, `<meta http-equiv="Content-Type">`)
 * from its markup: Volt declares UTF-8 first. Left in place, the page's tag would sit hundreds of
 * KB in, after the injected head and far past the 1024 bytes a browser scans for it, which can make
 * a page loaded from a file (html_preview's offscreen window) decode again from the start.
 */
function stripCharsetMeta(html: string, scan: string): { html: string; scan: string } {
	const cuts: [number, number][] = [];
	for (const match of scan.matchAll(/<meta\b[^>]*?\b(?:charset\s*=|http-equiv\s*=\s*["']?content-type)[^>]*>/gi)) {
		cuts.push([match.index, match.index + match[0].length]);
	}
	if (!cuts.length) {
		return { html, scan };
	}
	let outHtml = '';
	let outScan = '';
	let at = 0;
	for (const [start, end] of cuts) {
		outHtml += html.slice(at, start);
		outScan += scan.slice(at, start);
		at = end;
	}
	return { html: outHtml + html.slice(at), scan: outScan + scan.slice(at) };
}

export function buildVisualPage(source: string, options: IVisualPageOptions): string {
	const { html, scan } = stripCharsetMeta(source, blankNonMarkup(source));
	const head = [
		'<meta charset="utf-8">',
		/<meta\s[^>]*name\s*=\s*["']?viewport/i.test(scan) ? '' : '<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<style id="volt-visual-base">${BASE_CSS}${ELEMENT_CSS}</style>`,
		// Native controls, scrollbars and form fields follow the theme (light buttons on a dark page otherwise).
		`<style id="volt-visual-scheme">:root{color-scheme:${options.kind}}</style>`,
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
