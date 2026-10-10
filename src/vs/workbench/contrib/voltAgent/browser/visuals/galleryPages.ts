/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The two galleries Volt draws in a reply: design alternatives the user compares and picks from
 * (mockups_render), and screens of the user's own app (screens_capture). Volt writes these pages,
 * not the agent: the agent sends only each option's HTML or the screenshots, so a gallery costs it
 * a fraction of the tokens of a hand-written page, and every gallery looks and works the same.
 *
 * The page runtimes below are injected as source, `(${mockupsRuntime})(window, ...)`, the way
 * `voltChartsRuntime` is: their bodies must not reference anything outside themselves (no
 * imports, no module-level helpers, no `localize`; the host passes strings in).
 */

//#region Data

export type MockupFrameKind = 'phone' | 'tablet' | 'desktop' | 'component';
export type GalleryTheme = 'light' | 'dark';

export interface IMockupViewport {
	readonly kind: MockupFrameKind;
	readonly label: string;
	readonly width: number;
	/** 0: as tall as the content (components). */
	readonly height: number;
}

export interface IMockupOption {
	/** A letter: "A", "B", ... */
	readonly id: string;
	readonly label: string;
	readonly note?: string;
	/** Body markup, or a whole document. */
	readonly html: string;
	readonly css?: string;
}

/** What every option shares: fonts and scripts, styles, and the markup around the part that differs. */
export interface IMockupShared {
	readonly head?: string;
	readonly css?: string;
	/** Markup with `{{option}}` where each option's `html` goes. */
	readonly template?: string;
}

export interface IMockupStrings {
	readonly light: string;
	readonly dark: string;
	readonly both: string;
	readonly open: string;
	/** "Open option {0}: {1}" */
	readonly openOption: string;
	readonly choose: string;
	/** "Choose {0}" */
	readonly chooseOption: string;
	readonly chosen: string;
	readonly refine: string;
	readonly select: string;
	readonly recommended: string;
	readonly allOptions: string;
	readonly previous: string;
	readonly next: string;
	readonly fullscreen: string;
	readonly notesPlaceholder: string;
	/** "{0} selected" */
	readonly selectedCount: string;
	/** "Combine {0}" */
	readonly combineCount: string;
	readonly clear: string;
	/** "I choose option {0} "{1}" from "{2}"." */
	readonly chooseMessage: string;
	/** "Combine options {0} from "{1}" into one design." */
	readonly combineMessage: string;
	/** "Refine option {0} "{1}" from "{2}": " */
	readonly refinePrompt: string;
	/** "Selected in "{0}": {1}" */
	readonly selectedContext: string;
}

export interface IMockupsPageData extends IMockupShared {
	readonly title: string;
	readonly subtitle?: string;
	readonly viewports: readonly IMockupViewport[];
	/** Which looks the options have: both (the user flips), or only one. */
	readonly theme: GalleryTheme | 'both';
	readonly options: readonly IMockupOption[];
	/** The id of the option the agent recommends. */
	readonly recommended?: string;
	readonly strings: IMockupStrings;
}

export type ScreenFrameKind = 'phone' | 'tablet' | 'desktop' | 'window' | 'image';

export interface IScreenShotData {
	/** The variant's id. */
	readonly variant: string;
	/** A data URL. */
	readonly src: string;
	readonly width: number;
	readonly height: number;
	/** Where the image was saved. */
	readonly path?: string;
}

export interface IScreenData {
	readonly name: string;
	/** The page's path or the deep link, shown under the name. */
	readonly detail?: string;
	/** Something the user should know (HTTP 404, looks the same in light and dark). */
	readonly note?: string;
	readonly shots: readonly IScreenShotData[];
}

export interface IScreenVariant {
	readonly id: string;
	readonly label: string;
	readonly theme?: GalleryTheme;
}

export interface IScreensStrings {
	readonly all: string;
	readonly smaller: string;
	readonly larger: string;
	readonly allScreens: string;
	readonly previous: string;
	readonly next: string;
	readonly sideBySide: string;
	readonly fullscreen: string;
	readonly ask: string;
	/** "About the "{0}" screen ({1}): " */
	readonly askPrompt: string;
	readonly openFile: string;
	readonly notCaptured: string;
	/** "Looking at screen {0} "{1}" ({2}): {3}" */
	readonly lookingAt: string;
}

export interface IScreensPageData {
	readonly title: string;
	readonly subtitle?: string;
	readonly kind: ScreenFrameKind;
	readonly variants: readonly IScreenVariant[];
	readonly screens: readonly IScreenData[];
	readonly failures: readonly { readonly name: string; readonly reason: string }[];
	readonly strings: IScreensStrings;
}

//#endregion

//#region Styles

const BASE_CSS = `
.vg{display:flex;flex-direction:column;gap:12px;font-family:var(--font-sans);font-size:13px;line-height:1.45;color:var(--foreground);-webkit-user-select:none;user-select:none}
.vg *,.vg *::before,.vg *::after{box-sizing:border-box}
.vg [hidden]{display:none!important}
.vg-head{display:flex;align-items:flex-end;justify-content:space-between;gap:8px 16px;flex-wrap:wrap}
.vg-heading{min-width:0;flex:1 1 240px}
.vg-title{margin:0;font-size:14.5px;font-weight:600;letter-spacing:-.01em;line-height:1.3}
.vg-sub{margin:3px 0 0;color:var(--muted-foreground);font-size:12.5px}
.vg-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.vg-seg{display:inline-flex;gap:1px;padding:2px;border-radius:8px;background:var(--muted);border:1px solid var(--border)}
.vg-seg button{appearance:none;border:0;margin:0;background:transparent;color:var(--muted-foreground);font:inherit;font-size:12px;line-height:18px;padding:2px 9px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;transition:background .12s,color .12s}
.vg-seg button:hover{color:var(--foreground)}
.vg-seg button[aria-pressed="true"]{background:var(--background);color:var(--foreground);box-shadow:0 0 0 1px var(--border),0 1px 2px rgba(0,0,0,.14)}
.vg button:focus-visible,.vg input:focus-visible,.vg [tabindex]:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.vg-btn{appearance:none;margin:0;border:1px solid var(--border);background:transparent;color:var(--foreground);font:inherit;font-size:12px;font-weight:500;line-height:18px;padding:3px 10px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;transition:background .12s,filter .12s,opacity .12s}
.vg-btn:hover{background:var(--muted)}
.vg-btn:disabled{opacity:.45;cursor:default}
.vg-btn.primary{background:var(--primary);color:var(--primary-foreground);border-color:transparent}
.vg-btn.primary:hover:not(:disabled){filter:brightness(1.1);background:var(--primary)}
.vg-btn.icon{padding:3px;width:28px}
.vg-i{display:inline-flex;width:14px;height:14px;flex:none}
.vg-i svg{width:14px;height:14px}
.vg-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--vg-min,280px)),1fr));align-items:start}
.vg-card{position:relative;display:flex;flex-direction:column;min-width:0;border:1px solid var(--border);border-radius:11px;overflow:hidden;background:var(--card);transition:border-color .15s,box-shadow .15s}
.vg-card:hover{border-color:color-mix(in srgb,var(--ring) 45%,var(--border))}
.vg-card.selected{border-color:var(--ring);box-shadow:0 0 0 1px var(--ring)}
.vg-card.chosen{border-color:var(--success);box-shadow:0 0 0 1px var(--success)}
.vg-chip{flex:none;font-size:10.5px;font-weight:600;line-height:16px;padding:0 7px;border-radius:99px;background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);white-space:nowrap}
.vg-chip.good{background:color-mix(in srgb,var(--success) 16%,transparent);color:var(--success)}
.vg-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.vg-bar-title{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 160px;font-weight:600}
.vg-bar-title .vg-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vg-count{color:var(--muted-foreground);font-weight:400;font-size:12px;white-space:nowrap}
.vg-skeleton{position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,color-mix(in srgb,var(--foreground) 7%,transparent) 50%,transparent 70%) 0 0/200% 100%;animation:vg-shimmer 1.3s linear infinite}
@keyframes vg-shimmer{to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.vg-skeleton{animation:none}.vg *{transition:none!important}}
`;

const MOCKUPS_CSS = `
.mk-stage{position:relative;padding:14px;background:color-mix(in srgb,var(--foreground) 4%,transparent)}
.mk-panes{display:flex;gap:10px;justify-content:center;align-items:flex-start;width:100%}
.mk-pane{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:stretch;gap:6px}
.mk-pane[data-kind="phone"]{max-width:var(--mk-phone,220px)}
.mk-pane[data-kind="tablet"]{max-width:var(--mk-tablet,360px)}
.mk-device{position:relative;overflow:hidden;background:#fff;box-shadow:0 0 0 1px var(--border),0 10px 28px -12px rgba(0,0,0,.35)}
.mk-device[data-scheme="dark"]{background:#121212}
.mk-device.phone{border-radius:12% / 5.6%}
.mk-device.tablet{border-radius:6% / 4.2%}
.mk-device.desktop,.mk-device.component{border-radius:9px}
.mk-chrome{display:flex;align-items:center;gap:5px;height:20px;padding:0 9px;background:color-mix(in srgb,var(--foreground) 8%,var(--background));border-bottom:1px solid var(--border)}
.mk-chrome i{width:7px;height:7px;border-radius:50%;background:color-mix(in srgb,var(--foreground) 24%,transparent)}
.mk-screen{position:relative;overflow:hidden;width:100%}
.mk-screen iframe{position:absolute;left:0;top:0;border:0;margin:0;transform-origin:0 0;display:block;background:transparent;pointer-events:none}
.mk-detail .mk-screen iframe{pointer-events:auto}
.mk-pane-label{display:inline-flex;align-items:center;justify-content:center;gap:4px;font-size:11px;color:var(--muted-foreground)}
.mk-open{position:absolute;inset:0;border:0;margin:0;padding:0;background:transparent;cursor:zoom-in;display:flex;align-items:flex-end;justify-content:flex-end}
.mk-open>span{margin:10px;display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:7px;font-size:11.5px;font-weight:500;background:var(--popover);color:var(--popover-foreground);box-shadow:0 0 0 1px var(--border),0 6px 16px rgba(0,0,0,.2);opacity:0;transform:translateY(4px);transition:opacity .15s,transform .15s}
.vg-card:hover .mk-open>span,.mk-open:focus-visible>span{opacity:1;transform:none}
.mk-card{height:100%}
.mk-meta{flex:1;display:flex;flex-direction:column;gap:6px;padding:10px 12px 12px;border-top:1px solid var(--border)}
.mk-row{display:flex;align-items:center;gap:8px;min-width:0}
.mk-letter{flex:none;width:20px;height:20px;border-radius:6px;display:inline-grid;place-items:center;font-size:11px;font-weight:700;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
.vg-card.chosen .mk-letter{background:var(--success);color:var(--background)}
.mk-label{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mk-pick{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--muted-foreground);cursor:pointer;white-space:nowrap}
.mk-pick input{appearance:none;-webkit-appearance:none;margin:0;width:14px;height:14px;flex:none;border:1px solid color-mix(in srgb,var(--foreground) 35%,transparent);border-radius:4px;background:var(--input);cursor:pointer;display:inline-grid;place-items:center;transition:background .12s,border-color .12s}
.mk-pick input:checked{background:var(--ring);border-color:var(--ring)}
.mk-pick input:checked::after{content:"";width:4px;height:7px;margin-top:-2px;border:solid var(--primary-foreground);border-width:0 1.6px 1.6px 0;transform:rotate(45deg)}
.mk-pick:hover input{border-color:var(--ring)}
.mk-note{margin:0;color:var(--muted-foreground);font-size:12.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;-webkit-user-select:text;user-select:text}
.mk-actions{display:flex;gap:6px;margin-top:auto;padding-top:2px}
.mk-tray{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 8px 7px 14px;border-radius:10px;background:var(--popover);color:var(--popover-foreground);box-shadow:0 0 0 1px var(--border),0 10px 30px -14px rgba(0,0,0,.4)}
.mk-tray .vg-bar{flex-wrap:nowrap}
.mk-detail{display:flex;flex-direction:column;gap:10px;outline:none}
.mk-detail .mk-stage{border:1px solid var(--border);border-radius:12px;padding:18px}
.mk-detail .mk-pane[data-kind="phone"],.mk-detail .mk-pane[data-kind="tablet"]{max-width:none}
.mk-detail .mk-note{-webkit-line-clamp:unset}
.mk-foot{display:flex;gap:8px;align-items:center}
.mk-notes{flex:1;min-width:0;font:inherit;font-size:12.5px;color:var(--foreground);background:var(--input);border:1px solid var(--border);border-radius:6px;padding:4px 9px;line-height:18px;-webkit-user-select:text;user-select:text}
.mk-notes::placeholder{color:var(--muted-foreground)}
.mk-notes:focus{outline:none;border-color:var(--ring)}
`;

const SCREENS_CSS = `
.sc-card{padding:10px;gap:9px}
.sc-shots{display:flex;gap:8px;align-items:flex-start;justify-content:center}
.sc-shot{position:relative;flex:1 1 0;min-width:0;margin:0;padding:0;border:0;background:transparent;cursor:zoom-in;display:block;color:inherit;font:inherit;text-align:left}
.sc-shot[data-kind="phone"]{max-width:var(--sc-phone,240px)}
.sc-shot[data-kind="tablet"]{max-width:var(--sc-tablet,340px)}
.sc-frame{position:relative;overflow:hidden;background:color-mix(in srgb,var(--foreground) 6%,transparent);box-shadow:0 0 0 1px var(--border),0 8px 22px -14px rgba(0,0,0,.45)}
.sc-frame.phone{border-radius:11% / 5.1%}
.sc-frame.tablet{border-radius:5% / 3.6%}
.sc-frame.desktop,.sc-frame.window,.sc-frame.image{border-radius:8px}
.sc-frame img{display:block;width:100%;height:auto}
.sc-url{display:flex;align-items:center;gap:5px;height:20px;padding:0 8px;background:color-mix(in srgb,var(--foreground) 8%,var(--background));border-bottom:1px solid var(--border);font-size:10.5px;color:var(--muted-foreground);white-space:nowrap;overflow:hidden}
.sc-url i{flex:none;width:6px;height:6px;border-radius:50%;background:color-mix(in srgb,var(--foreground) 24%,transparent)}
.sc-url span{margin-left:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-mono)}
.sc-url-tag{margin-left:auto;flex:none;font-family:var(--font-sans);font-size:10px;font-weight:600;line-height:14px;padding:0 6px;border-radius:99px;background:color-mix(in srgb,var(--foreground) 12%,transparent);color:var(--foreground)}
.sc-tag{position:absolute;left:7px;top:7px;z-index:1;font-size:10px;font-weight:600;line-height:15px;padding:0 6px;border-radius:99px;background:rgba(0,0,0,.58);color:#fff;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);pointer-events:none}
.vg-grid .sc-shot:hover .sc-frame{box-shadow:0 0 0 1px color-mix(in srgb,var(--ring) 60%,var(--border)),0 10px 26px -14px rgba(0,0,0,.5)}
.sc-cap{display:flex;align-items:flex-start;gap:8px;min-width:0;padding:0 2px}
.sc-num{flex:none;min-width:22px;height:20px;padding:0 5px;border-radius:6px;display:inline-grid;place-items:center;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;background:color-mix(in srgb,var(--foreground) 9%,transparent);color:var(--muted-foreground)}
.sc-names{min-width:0;flex:1}
.sc-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-detail{color:var(--muted-foreground);font-size:11.5px;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-note{display:flex;gap:6px;align-items:flex-start;color:var(--warning);font-size:12px}
.sc-note .vg-i{margin-top:1px}
.sc-failures{border:1px dashed var(--border);border-radius:10px;padding:9px 12px;color:var(--muted-foreground);font-size:12.5px}
.sc-failures b{color:var(--foreground);font-weight:600}
.sc-failures ul{margin:6px 0 0;padding-left:18px}
.sc-failures li{margin:2px 0;-webkit-user-select:text;user-select:text}
.sc-failures-title{display:flex;align-items:center;gap:6px;color:var(--warning);font-weight:600}
.sc-detail-view{display:flex;flex-direction:column;gap:10px;outline:none}
.sc-detail-view .sc-stage{border:1px solid var(--border);border-radius:12px;padding:16px;background:color-mix(in srgb,var(--foreground) 4%,transparent)}
.sc-detail-view .sc-shot{cursor:default}
.sc-detail-view .sc-shot[data-kind="phone"]{max-width:380px}
.sc-detail-view .sc-shot[data-kind="tablet"]{max-width:560px}
.sc-variant-label{margin-top:6px;text-align:center;font-size:11px;color:var(--muted-foreground)}
`;

//#endregion

//#region Mockup documents

/**
 * One option as the complete document its frame loads, in `theme`: `<html class="dark"
 * data-theme="dark">`, `prefers-color-scheme` media queries and `matchMedia` answering for the
 * theme, Tailwind's `dark:` keyed to the class, links that go nowhere, and errors tagged with the
 * option so the agent knows which one broke. Injected into the gallery page (no outside refs).
 */
export function mockupDocument(shared: IMockupShared, option: IMockupOption, theme: GalleryTheme): string {
	const fix = (text: string | undefined): string => (text ?? '').replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_match: string, want: string) => want.toLowerCase() === theme ? '(min-width: 0px)' : '(max-width: 0.001px)');
	const scriptTag = (body: string): string => '<scr' + 'ipt>' + body + '</scr' + 'ipt>';
	const shim = scriptTag(`(function(){var T=${JSON.stringify(theme)},tag=${JSON.stringify(`[option ${option.id}]`)};`
		+ 'var mm=window.matchMedia?window.matchMedia.bind(window):null;'
		+ 'window.matchMedia=function(q){var m=/prefers-color-scheme\\s*:\\s*(dark|light)/i.exec(String(q));if(!m||!mm){return mm?mm(q):null;}'
		+ 'return{matches:m[1].toLowerCase()===T,media:String(q),onchange:null,addListener:function(){},removeListener:function(){},addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return false;}};};'
		+ 'var err=console.error.bind(console);console.error=function(){err.apply(null,[tag].concat([].slice.call(arguments)));};'
		+ 'window.addEventListener("error",function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){err(tag+" Failed to load "+(t.src||t.href));return;}err(tag+" Uncaught "+((e.error&&e.error.stack)||e.message));},true);'
		+ 'document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(a){e.preventDefault();}},true);'
		+ 'document.addEventListener("submit",function(e){e.preventDefault();},true);'
		+ '})();');
	const base = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{color-scheme:${theme};-webkit-text-size-adjust:100%}html,body{margin:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,system-ui,sans-serif;background:Canvas;color:CanvasText;-webkit-font-smoothing:antialiased}</style>`;
	// After the agent's head: the Tailwind CDN reads its config then, and `dark:` follows the class.
	const tailwind = scriptTag('if(window.tailwind){try{tailwind.config=Object.assign({},tailwind.config||{},{darkMode:"class"});}catch(e){}}')
		+ (/@tailwindcss\/browser/i.test(shared.head ?? '') ? '<style type="text/tailwindcss">@custom-variant dark (&:where(.dark, .dark *));</style>' : '');
	const styles = [shared.css, option.css].filter((css): css is string => !!css && !!css.trim()).map(css => `<style>${fix(css)}</style>`).join('');
	if (/^\s*(?:<!doctype|<html)/i.test(option.html)) {
		// A whole document: theme it where it stands.
		let page = fix(option.html).replace(/<html\b([^>]*)>/i, (_match: string, attrs: string) => {
			const classes = /\sclass\s*=\s*(["'])(.*?)\1/i.exec(attrs);
			const rest = attrs.replace(/\s(?:class|data-theme)\s*=\s*(["']).*?\1/gi, '');
			return `<html${rest} class="${`${classes ? classes[2] : ''} ${theme}`.trim()}" data-theme="${theme}">`;
		});
		const head = /<head\b[^>]*>/i.exec(page);
		if (head) {
			const at = head.index + head[0].length;
			page = page.slice(0, at) + shim + page.slice(at);
		} else if (/<html\b[^>]*>/i.test(page)) {
			page = page.replace(/<html\b[^>]*>/i, match => `${match}<head>${shim}</head>`);
		} else {
			page = page.replace(/^\s*<!doctype[^>]*>/i, match => `${match}<head>${shim}</head>`);
		}
		return page.replace(/<\/head>/i, `${styles}${tailwind}</head>`);
	}
	const template = shared.template ?? '';
	const body = template.includes('{{option}}') ? template.split('{{option}}').join(option.html) : template + option.html;
	return `<!doctype html><html class="${theme}" data-theme="${theme}"><head>${base}${shim}${fix(shared.head)}${styles}${tailwind}</head><body>${fix(body)}</body></html>`;
}

//#endregion

//#region Page runtimes

interface IGalleryBridge {
	readonly theme?: string;
	send(text: string): void;
	prompt(text: string): void;
	setContext(value: string): void;
	fullscreen(on?: boolean): void;
	open(href: string): void;
}

/**
 * The mockups gallery: a card per option with its live, scaled frame(s), a light/dark/both switch
 * and a size switch, a detail view with prev/next and notes, Choose / Refine / Combine. Frames are
 * kept per look once loaded (hidden, never moved, so they do not reload when the user flips back).
 */
export function mockupsRuntime(win: Window & typeof globalThis, documentFor: (shared: IMockupShared, option: IMockupOption, theme: GalleryTheme) => string): void {
	const doc = win.document;
	const root = doc.getElementById('volt-gallery');
	const source = doc.getElementById('volt-gallery-data');
	if (!root || !source) {
		return;
	}
	const data = JSON.parse(source.textContent || '{}') as IMockupsPageData;
	const S = data.strings;
	const volt = (win as unknown as { volt?: IGalleryBridge }).volt;
	const options = data.options;

	const ICONS: Record<string, string> = {
		sun: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="2.7"/><path d="M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1"/></svg>',
		moon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M13.2 9.7A5.4 5.4 0 0 1 6.3 2.8a5.5 5.5 0 1 0 6.9 6.9Z"/></svg>',
		both: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.6"/><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2Z" fill="currentColor" stroke="none"/></svg>',
		phone: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="4.6" y="1.6" width="6.8" height="12.8" rx="1.6"/><path d="M7.1 12.1h1.8"/></svg>',
		tablet: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="2.6" y="1.6" width="10.8" height="12.8" rx="1.6"/><path d="M7.1 12.1h1.8"/></svg>',
		desktop: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="1.6" y="2.6" width="12.8" height="8.8" rx="1.2"/><path d="M5.6 14h4.8M8 11.4V14"/></svg>',
		component: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="4" width="12" height="8" rx="2" stroke-dasharray="2.2 1.6"/></svg>',
		expand: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.6 2.4h4v4M6.4 13.6h-4v-4M13.6 2.4 9.2 6.8M2.4 13.6l4.4-4.4"/></svg>',
		left: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>',
		right: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
		back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8H3.4M7.4 4 3.4 8l4 4"/></svg>',
		check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 8.6 6.4 11.8 12.8 4.6"/></svg>',
		edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M10.6 2.6 13.4 5.4 6 12.8H3.2V10z"/></svg>',
		merge: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5v3.2c0 1.6 1.3 2.3 4 2.3s4 .7 4 2.3v3.2M12 2.5v3.2c0 .8-.4 1.4-1.2 1.8M5.2 9.5c-.8.4-1.2 1-1.2 1.8v2.2"/></svg>',
	};

	const fmt = (template: string, ...args: (string | number)[]): string => template.replace(/\{(\d+)\}/g, (match, index) => String(args[Number(index)] ?? match));
	function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
		const node = doc.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		return node;
	}
	function icon(name: string): HTMLElement {
		const node = el('span', 'vg-i');
		node.innerHTML = ICONS[name] ?? '';
		node.setAttribute('aria-hidden', 'true');
		return node;
	}
	function button(label: string, className: string, iconName: string | undefined, run: () => void, iconOnly = false): HTMLButtonElement {
		const node = el('button', `vg-btn${className ? ` ${className}` : ''}${iconOnly ? ' icon' : ''}`);
		node.type = 'button';
		if (iconName) {
			node.append(icon(iconName));
		}
		if (iconOnly) {
			node.setAttribute('aria-label', label);
			node.title = label;
		} else {
			node.append(doc.createTextNode(label));
		}
		node.addEventListener('click', event => {
			event.preventDefault();
			run();
		});
		return node;
	}

	const refreshers: (() => void)[] = [];
	function segmented(items: readonly { readonly id: string; readonly label: string; readonly icon?: string }[], current: () => string, pick: (id: string) => void): HTMLElement {
		const group = el('div', 'vg-seg');
		group.setAttribute('role', 'group');
		const buttons = items.map(item => {
			const node = el('button');
			node.type = 'button';
			if (item.icon) {
				node.append(icon(item.icon));
			}
			node.append(doc.createTextNode(item.label));
			node.addEventListener('click', () => pick(item.id));
			group.append(node);
			return { node, id: item.id };
		});
		const refresh = () => buttons.forEach(entry => entry.node.setAttribute('aria-pressed', String(entry.id === current())));
		refreshers.push(refresh);
		refresh();
		return group;
	}

	const voltLight = (volt?.theme ?? (doc.body.classList.contains('vscode-light') ? 'light' : 'dark')) === 'light';
	const state = {
		look: (data.theme === 'both' ? (voltLight ? 'light' : 'dark') : data.theme) as GalleryTheme | 'both',
		viewport: 0,
		selected: new Set<string>(),
		chosen: undefined as string | undefined,
		detail: -1,
	};
	const viewport = () => data.viewports[state.viewport] ?? data.viewports[0];
	const shownThemes = (): GalleryTheme[] => state.look === 'both' ? ['light', 'dark'] : [state.look];

	interface IPane {
		readonly root: HTMLElement;
		readonly screen: HTMLElement;
		readonly frame: HTMLIFrameElement;
		readonly label: HTMLElement;
		readonly viewport: IMockupViewport;
		contentHeight: number;
	}

	const panesByScreen = new Map<Element, IPane>();
	function fit(pane: IPane): void {
		const width = pane.screen.clientWidth;
		if (!width) {
			return;
		}
		const vp = pane.viewport;
		const scale = width / vp.width;
		const height = vp.height || pane.contentHeight || 180;
		pane.frame.style.width = `${vp.width}px`;
		pane.frame.style.height = `${height}px`;
		pane.frame.style.transform = `scale(${scale})`;
		pane.screen.style.aspectRatio = '';
		pane.screen.style.height = `${Math.ceil(height * scale)}px`;
	}
	const resizes = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(entries => {
		for (const entry of entries) {
			const pane = panesByScreen.get(entry.target);
			if (pane) {
				fit(pane);
			}
		}
	}) : undefined;

	/** Components are as tall as their content: read it from the frame (same origin) as it changes. */
	function watchHeight(pane: IPane): void {
		const measure = () => {
			let height = 0;
			try {
				const inner = pane.frame.contentDocument;
				if (inner?.documentElement) {
					height = Math.ceil(Math.max(inner.documentElement.getBoundingClientRect().height, inner.body ? inner.body.getBoundingClientRect().bottom : 0));
				}
			} catch {
				// not readable: keep the default height
			}
			height = Math.max(40, Math.min(3000, height || 180));
			if (Math.abs(height - pane.contentHeight) > 1) {
				pane.contentHeight = height;
				fit(pane);
			}
		};
		measure();
		try {
			const body = pane.frame.contentDocument?.body;
			if (body && typeof win.ResizeObserver === 'function') {
				new win.ResizeObserver(measure).observe(body);
			}
		} catch {
			// not readable
		}
		win.setTimeout(measure, 250);
		win.setTimeout(measure, 1200);
	}

	function createPane(option: IMockupOption, theme: GalleryTheme, vp: IMockupViewport, interactive: boolean): IPane {
		const rootNode = el('div', 'mk-pane');
		rootNode.dataset.kind = vp.kind;
		rootNode.dataset.theme = theme;
		if (interactive && vp.height && (vp.kind === 'phone' || vp.kind === 'tablet')) {
			rootNode.style.maxWidth = `${vp.width}px`;
		}
		const device = el('div', `mk-device ${vp.kind}`);
		device.dataset.scheme = theme;
		if (vp.kind === 'desktop') {
			const chrome = el('div', 'mk-chrome');
			chrome.append(el('i'), el('i'), el('i'));
			device.append(chrome);
		}
		const screen = el('div', 'mk-screen');
		if (vp.height) {
			screen.style.aspectRatio = `${vp.width} / ${vp.height}`;
		} else {
			screen.style.height = '120px';
		}
		const frame = el('iframe');
		frame.title = `${option.id} ${option.label} (${theme === 'dark' ? S.dark : S.light})`;
		if (!interactive) {
			frame.tabIndex = -1;
			frame.setAttribute('aria-hidden', 'true');
		}
		const skeleton = el('div', 'vg-skeleton');
		screen.append(frame, skeleton);
		device.append(screen);
		const label = el('span', 'mk-pane-label');
		label.append(icon(theme === 'dark' ? 'moon' : 'sun'), doc.createTextNode(theme === 'dark' ? S.dark : S.light));
		rootNode.append(device, label);
		const pane: IPane = { root: rootNode, screen, frame, label, viewport: vp, contentHeight: 0 };
		panesByScreen.set(screen, pane);
		resizes?.observe(screen);
		frame.addEventListener('load', () => {
			skeleton.remove();
			if (!vp.height) {
				watchHeight(pane);
			} else {
				fit(pane);
			}
		});
		frame.srcdoc = documentFor(data, option, theme);
		return pane;
	}

	//#region Header

	const head = el('header', 'vg-head');
	const heading = el('div', 'vg-heading');
	heading.append(el('h2', 'vg-title', data.title));
	if (data.subtitle) {
		heading.append(el('p', 'vg-sub', data.subtitle));
	}
	const tools = el('div', 'vg-tools');
	if (data.viewports.length > 1) {
		tools.append(segmented(data.viewports.map((vp, index) => ({ id: String(index), label: vp.label, icon: vp.kind })), () => String(state.viewport), id => {
			state.viewport = Number(id);
			sync();
		}));
	}
	if (data.theme === 'both') {
		tools.append(segmented([{ id: 'light', label: S.light, icon: 'sun' }, { id: 'dark', label: S.dark, icon: 'moon' }, { id: 'both', label: S.both, icon: 'both' }], () => state.look, id => {
			state.look = id as GalleryTheme | 'both';
			sync();
		}));
	}
	head.append(heading, tools);

	//#endregion

	//#region Cards

	interface ICard {
		readonly node: HTMLElement;
		readonly panes: HTMLElement;
		readonly option: IMockupOption;
		readonly index: number;
		readonly box?: HTMLInputElement;
		readonly chosenChip: HTMLElement;
		readonly cache: Map<string, IPane>;
	}

	const grid = el('div', 'vg-grid');
	grid.style.alignItems = 'stretch';
	const cards: ICard[] = options.map((option, index) => {
		const node = el('article', 'vg-card mk-card');
		node.dataset.option = option.id;
		const stage = el('div', 'mk-stage');
		const panes = el('div', 'mk-panes');
		const open = el('button', 'mk-open');
		open.type = 'button';
		open.setAttribute('aria-label', fmt(S.openOption, option.id, option.label));
		const hint = el('span');
		hint.append(icon('expand'), doc.createTextNode(S.open));
		open.append(hint);
		open.addEventListener('click', () => openDetail(index));
		stage.append(panes, open);
		const meta = el('div', 'mk-meta');
		const row = el('div', 'mk-row');
		row.append(el('span', 'mk-letter', option.id), el('span', 'mk-label', option.label));
		if (data.recommended === option.id) {
			row.append(el('span', 'vg-chip', S.recommended));
		}
		const chosenChip = el('span', 'vg-chip good', S.chosen);
		chosenChip.hidden = true;
		row.append(chosenChip);
		let box: HTMLInputElement | undefined;
		if (options.length > 1) {
			const pick = el('label', 'mk-pick');
			box = el('input');
			box.type = 'checkbox';
			const input = box;
			input.addEventListener('change', () => {
				if (input.checked) {
					state.selected.add(option.id);
				} else {
					state.selected.delete(option.id);
				}
				syncSelection();
			});
			pick.append(input, doc.createTextNode(S.select));
			row.append(pick);
		}
		meta.append(row);
		if (option.note) {
			meta.append(el('p', 'mk-note', option.note));
		}
		const actions = el('div', 'mk-actions');
		actions.append(button(S.choose, 'primary', 'check', () => choose(option)), button(S.refine, '', 'edit', () => refine(option)));
		meta.append(actions);
		node.append(stage, meta);
		grid.append(node);
		return { node, panes, option, index, box, chosenChip, cache: new Map() };
	});

	function syncCard(card: ICard): void {
		const vp = viewport();
		const themes = shownThemes();
		for (const pane of card.cache.values()) {
			pane.root.hidden = true;
		}
		for (const theme of themes) {
			const key = `${theme}|${state.viewport}`;
			let pane = card.cache.get(key);
			if (!pane) {
				pane = createPane(card.option, theme, vp, false);
				card.cache.set(key, pane);
				// New panes only: an iframe that moves reloads. Light stays on the left.
				if (theme === 'light') {
					card.panes.prepend(pane.root);
				} else {
					card.panes.append(pane.root);
				}
			}
			pane.root.hidden = false;
			pane.label.hidden = themes.length < 2;
		}
	}

	function minWidth(): number {
		const kind = viewport().kind;
		const both = state.look === 'both';
		switch (kind) {
			case 'phone': return both ? 330 : 190;
			case 'tablet': return both ? 440 : 250;
			case 'component': return both ? 480 : 260;
			default: return both ? 520 : 300;
		}
	}

	//#endregion

	//#region Choosing

	const tray = el('div', 'mk-tray');
	const trayCount = el('span', 'vg-count');
	const trayGo = button('', 'primary', 'merge', () => {
		const picked = options.filter(option => state.selected.has(option.id));
		if (picked.length === 1) {
			choose(picked[0]);
		} else if (picked.length > 1) {
			volt?.send(fmt(S.combineMessage, picked.map(option => `${option.id} "${option.label}"`).join(', '), data.title));
		}
	});
	const trayButtons = el('div', 'vg-bar');
	trayButtons.append(button(S.clear, '', undefined, () => {
		state.selected.clear();
		for (const card of cards) {
			if (card.box) {
				card.box.checked = false;
			}
		}
		syncSelection();
	}), trayGo);
	tray.append(trayCount, trayButtons);

	function syncSelection(): void {
		const count = state.selected.size;
		tray.hidden = !count || state.detail >= 0;
		trayCount.textContent = fmt(S.selectedCount, count);
		const only = count === 1 ? options.find(option => state.selected.has(option.id)) : undefined;
		trayGo.lastChild!.textContent = only ? fmt(S.chooseOption, only.id) : fmt(S.combineCount, count);
		for (const card of cards) {
			card.node.classList.toggle('selected', state.selected.has(card.option.id));
		}
		if (count) {
			volt?.setContext(fmt(S.selectedContext, data.title, options.filter(option => state.selected.has(option.id)).map(option => `${option.id} "${option.label}"`).join(', ')));
		}
	}

	function choose(option: IMockupOption, notes?: string): void {
		state.chosen = option.id;
		for (const card of cards) {
			const chosen = card.option.id === option.id;
			card.node.classList.toggle('chosen', chosen);
			card.chosenChip.hidden = !chosen;
		}
		volt?.send(fmt(S.chooseMessage, option.id, option.label, data.title) + (notes ? `\n\n${notes}` : ''));
	}

	function refine(option: IMockupOption): void {
		volt?.prompt(fmt(S.refinePrompt, option.id, option.label, data.title));
	}

	//#endregion

	//#region Detail

	let detail: HTMLElement | undefined;
	function buildDetail(index: number): HTMLElement {
		const option = options[index];
		const node = el('section', 'mk-detail');
		node.tabIndex = -1;
		node.setAttribute('aria-label', `${option.id} ${option.label}`);
		const bar = el('div', 'vg-bar');
		const title = el('div', 'vg-bar-title');
		const name = el('span', 'vg-text', option.label);
		title.append(el('span', 'mk-letter', option.id), name, el('span', 'vg-count', `${index + 1} / ${options.length}`));
		if (data.recommended === option.id) {
			title.append(el('span', 'vg-chip', S.recommended));
		}
		const prev = button(S.previous, '', 'left', () => step(-1), true);
		const next = button(S.next, '', 'right', () => step(1), true);
		prev.disabled = next.disabled = options.length < 2;
		bar.append(button(S.allOptions, '', 'back', closeDetail), prev, next, title, button(S.fullscreen, '', 'expand', () => volt?.fullscreen(true), true));
		const stage = el('div', 'mk-stage');
		const panes = el('div', 'mk-panes');
		const themes = shownThemes();
		for (const theme of themes) {
			const pane = createPane(option, theme, viewport(), true);
			pane.label.hidden = themes.length < 2;
			panes.append(pane.root);
		}
		stage.append(panes);
		node.append(bar, stage);
		if (option.note) {
			node.append(el('p', 'mk-note', option.note));
		}
		const foot = el('div', 'mk-foot');
		const notes = el('input', 'mk-notes');
		notes.type = 'text';
		notes.placeholder = S.notesPlaceholder;
		notes.addEventListener('keydown', event => {
			if (event.key === 'Enter' && !event.isComposing) {
				event.preventDefault();
				choose(option, notes.value.trim());
			}
		});
		foot.append(notes, button(fmt(S.chooseOption, option.id), 'primary', 'check', () => choose(option, notes.value.trim())));
		node.append(foot);
		return node;
	}

	function openDetail(index: number): void {
		state.detail = (index + options.length) % options.length;
		grid.hidden = true;
		tray.hidden = true;
		detail?.remove();
		detail = buildDetail(state.detail);
		root!.append(detail);
		detail.focus({ preventScroll: true });
	}

	function closeDetail(): void {
		const index = state.detail;
		state.detail = -1;
		detail?.remove();
		detail = undefined;
		grid.hidden = false;
		syncSelection();
		cards[index]?.node.querySelector<HTMLElement>('.mk-open')?.focus({ preventScroll: true });
	}

	function step(delta: number): void {
		if (state.detail >= 0 && options.length > 1) {
			openDetail(state.detail + delta);
		}
	}

	doc.addEventListener('keydown', event => {
		if (state.detail < 0) {
			return;
		}
		const target = event.target as HTMLElement | null;
		if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
			if (event.key === 'Escape') {
				target.blur();
			}
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			closeDetail();
		} else if (event.key === 'ArrowLeft') {
			step(-1);
		} else if (event.key === 'ArrowRight') {
			step(1);
		}
	});

	//#endregion

	function sync(): void {
		refreshers.forEach(refresh => refresh());
		grid.style.setProperty('--vg-min', `${minWidth()}px`);
		cards.forEach(syncCard);
		if (state.detail >= 0) {
			openDetail(state.detail);
		}
	}

	tray.hidden = true;
	root.append(head, grid, tray);
	sync();
}

/**
 * The screens gallery: a card per screen with its shots side by side (light | dark, or per device
 * and viewport), a filter to one variant, a size switch, a detail view with prev/next, Ask (puts a
 * question about the screen in the composer) and Open (the saved image), and what was not captured.
 */
export function screensRuntime(win: Window & typeof globalThis): void {
	const doc = win.document;
	const root = doc.getElementById('volt-gallery');
	const source = doc.getElementById('volt-gallery-data');
	if (!root || !source) {
		return;
	}
	const data = JSON.parse(source.textContent || '{}') as IScreensPageData;
	const S = data.strings;
	const volt = (win as unknown as { volt?: IGalleryBridge }).volt;
	const screens = data.screens;
	const variants = data.variants;

	const ICONS: Record<string, string> = {
		sun: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="2.7"/><path d="M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1"/></svg>',
		moon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M13.2 9.7A5.4 5.4 0 0 1 6.3 2.8a5.5 5.5 0 1 0 6.9 6.9Z"/></svg>',
		grid: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>',
		minus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3.5 8h9"/></svg>',
		plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>',
		left: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>',
		right: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
		back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8H3.4M7.4 4 3.4 8l4 4"/></svg>',
		expand: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.6 2.4h4v4M6.4 13.6h-4v-4M13.6 2.4 9.2 6.8M2.4 13.6l4.4-4.4"/></svg>',
		ask: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 3.2h11v7.4H7.2L4.4 13v-2.4H2.5z"/></svg>',
		file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 2.4h4.4v4.4M13.6 2.4 8 8M6.6 3.4H2.4v10.2h10.2V9.4"/></svg>',
		warn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 2.2 14.2 13H1.8z"/><path d="M8 6.4v3M8 11.2v.2" stroke-linecap="round"/></svg>',
		both: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.6"/><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2Z" fill="currentColor" stroke="none"/></svg>',
	};

	const fmt = (template: string, ...args: (string | number)[]): string => template.replace(/\{(\d+)\}/g, (match, index) => String(args[Number(index)] ?? match));
	function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
		const node = doc.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		return node;
	}
	function icon(name: string): HTMLElement {
		const node = el('span', 'vg-i');
		node.innerHTML = ICONS[name] ?? '';
		node.setAttribute('aria-hidden', 'true');
		return node;
	}
	function button(label: string, className: string, iconName: string | undefined, run: () => void, iconOnly = false): HTMLButtonElement {
		const node = el('button', `vg-btn${className ? ` ${className}` : ''}${iconOnly ? ' icon' : ''}`);
		node.type = 'button';
		if (iconName) {
			node.append(icon(iconName));
		}
		if (iconOnly) {
			node.setAttribute('aria-label', label);
			node.title = label;
		} else {
			node.append(doc.createTextNode(label));
		}
		node.addEventListener('click', event => {
			event.preventDefault();
			run();
		});
		return node;
	}
	const refreshers: (() => void)[] = [];
	function segmented(items: readonly { readonly id: string; readonly label: string; readonly icon?: string }[], current: () => string, pick: (id: string) => void): HTMLElement {
		const group = el('div', 'vg-seg');
		group.setAttribute('role', 'group');
		const buttons = items.map(item => {
			const node = el('button');
			node.type = 'button';
			if (item.icon) {
				node.append(icon(item.icon));
			}
			node.append(doc.createTextNode(item.label));
			node.addEventListener('click', () => pick(item.id));
			group.append(node);
			return { node, id: item.id };
		});
		const refresh = () => buttons.forEach(entry => entry.node.setAttribute('aria-pressed', String(entry.id === current())));
		refreshers.push(refresh);
		refresh();
		return group;
	}
	const variantIcon = (variant: IScreenVariant | undefined) => variant?.theme === 'dark' ? 'moon' : variant?.theme === 'light' ? 'sun' : undefined;
	const variantOf = (id: string) => variants.find(variant => variant.id === id);

	const state = { filter: 'all', size: 1, detail: -1, detailVariant: 'all' };
	const SIZES = [0.72, 1, 1.45];

	function shotFigure(screen: IScreenData, shot: IScreenShotData, tagged: boolean, interactive: boolean, open?: () => void): HTMLElement {
		const node = el(interactive ? 'button' : 'div', 'sc-shot') as HTMLElement;
		if (node instanceof win.HTMLButtonElement) {
			node.type = 'button';
		}
		node.dataset.kind = data.kind;
		const variant = variantOf(shot.variant);
		node.setAttribute('aria-label', `${screen.name}${variant ? ` (${variant.label})` : ''}`);
		const frame = el('div', `sc-frame ${data.kind}`);
		const urlBar = data.kind === 'desktop' && !!screen.detail;
		if (urlBar) {
			const url = el('div', 'sc-url');
			url.append(el('i'), el('i'), el('i'), el('span', undefined, screen.detail));
			if (tagged && variant) {
				url.append(el('b', 'sc-url-tag', variant.label));
			}
			frame.append(url);
		}
		const img = el('img');
		img.decoding = 'async';
		img.alt = node.getAttribute('aria-label') ?? '';
		img.width = shot.width;
		img.height = shot.height;
		img.src = shot.src;
		img.draggable = false;
		frame.append(img);
		if (tagged && variant && !urlBar) {
			node.append(el('span', 'sc-tag', variant.label));
		}
		node.append(frame);
		if (open) {
			node.addEventListener('click', open);
		}
		return node;
	}

	function caption(screen: IScreenData, index: number): HTMLElement {
		const cap = el('div', 'sc-cap');
		const names = el('div', 'sc-names');
		names.append(el('div', 'sc-name', screen.name));
		if (screen.detail && data.kind !== 'desktop') {
			names.append(el('div', 'sc-detail', screen.detail));
		}
		cap.append(el('span', 'sc-num', String(index + 1)), names);
		return cap;
	}

	function note(screen: IScreenData): HTMLElement | undefined {
		if (!screen.note) {
			return undefined;
		}
		const node = el('div', 'sc-note');
		node.append(icon('warn'), el('span', undefined, screen.note));
		return node;
	}

	//#region Header and grid

	const head = el('header', 'vg-head');
	const heading = el('div', 'vg-heading');
	heading.append(el('h2', 'vg-title', data.title));
	if (data.subtitle) {
		heading.append(el('p', 'vg-sub', data.subtitle));
	}
	const tools = el('div', 'vg-tools');
	if (variants.length > 1) {
		tools.append(segmented([{ id: 'all', label: S.all, icon: 'grid' }, ...variants.map(variant => ({ id: variant.id, label: variant.label, icon: variantIcon(variant) }))], () => state.filter, id => {
			state.filter = id;
			renderGrid();
		}));
	}
	const smaller = button(S.smaller, '', 'minus', () => resize(-1), true);
	const larger = button(S.larger, '', 'plus', () => resize(1), true);
	const sizes = el('div', 'vg-bar');
	sizes.append(smaller, larger);
	tools.append(sizes);
	head.append(heading, tools);

	const grid = el('div', 'vg-grid');
	grid.style.alignItems = 'stretch';
	function minWidth(count: number): number {
		const per = data.kind === 'phone' ? 140 : data.kind === 'tablet' ? 190 : data.kind === 'image' ? 220 : 300;
		return Math.round(per * SIZES[state.size] * count + 8 * (count - 1) + 22);
	}
	function resize(delta: number): void {
		state.size = Math.max(0, Math.min(SIZES.length - 1, state.size + delta));
		smaller.disabled = state.size === 0;
		larger.disabled = state.size === SIZES.length - 1;
		renderGrid();
	}
	function renderGrid(): void {
		refreshers.forEach(refresh => refresh());
		const shown = state.filter === 'all' ? variants.map(variant => variant.id) : [state.filter];
		grid.style.setProperty('--vg-min', `${minWidth(Math.min(shown.length, Math.max(1, ...screens.map(screen => screen.shots.filter(shot => shown.includes(shot.variant)).length))))}px`);
		grid.style.setProperty('--sc-phone', `${Math.round(240 * SIZES[state.size])}px`);
		grid.style.setProperty('--sc-tablet', `${Math.round(340 * SIZES[state.size])}px`);
		grid.replaceChildren();
		screens.forEach((screen, index) => {
			const shots = screen.shots.filter(shot => shown.includes(shot.variant));
			if (!shots.length) {
				return;
			}
			const card = el('article', 'vg-card sc-card');
			const row = el('div', 'sc-shots');
			for (const shot of shots) {
				row.append(shotFigure(screen, shot, shots.length > 1, true, () => openDetail(index, state.filter === 'all' ? 'all' : shot.variant)));
			}
			card.append(row, caption(screen, index));
			const warning = note(screen);
			if (warning) {
				card.append(warning);
			}
			grid.append(card);
		});
	}

	let failures: HTMLElement | undefined;
	if (data.failures.length) {
		failures = el('div', 'sc-failures');
		const title = el('div', 'sc-failures-title');
		title.append(icon('warn'), doc.createTextNode(`${S.notCaptured} (${data.failures.length})`));
		const list = el('ul');
		for (const failure of data.failures) {
			const item = el('li');
			// allow-any-unicode-next-line
			item.append(el('b', undefined, failure.name), doc.createTextNode(` — ${failure.reason}`));
			list.append(item);
		}
		failures.append(title, list);
	}

	//#endregion

	//#region Detail

	let detail: HTMLElement | undefined;
	function buildDetail(index: number): HTMLElement {
		const screen = screens[index];
		const node = el('section', 'sc-detail-view');
		node.tabIndex = -1;
		node.setAttribute('aria-label', screen.name);
		// Moving between screens on top; what to look at and what to do with it below.
		const bar = el('div', 'vg-bar');
		const title = el('div', 'vg-bar-title');
		title.append(el('span', 'sc-num', String(index + 1)), el('span', 'vg-text', screen.name), el('span', 'vg-count', `${index + 1} / ${screens.length}`));
		const prev = button(S.previous, '', 'left', () => step(-1), true);
		const next = button(S.next, '', 'right', () => step(1), true);
		prev.disabled = next.disabled = screens.length < 2;
		bar.append(button(S.allScreens, '', 'back', closeDetail), prev, next, title);
		const shots = screen.shots.filter(shot => state.detailVariant === 'all' || shot.variant === state.detailVariant);
		const shown = shots.length ? shots : screen.shots.slice(0, 1);
		const labels = shown.map(shot => variantOf(shot.variant)?.label ?? '').filter(Boolean).join(', ');
		const path = shown.find(shot => shot.path)?.path;
		if (path) {
			bar.append(button(S.openFile, '', 'file', () => volt?.open(`volt://file/${encodeURI(path)}`), true));
		}
		bar.append(button(S.fullscreen, '', 'expand', () => volt?.fullscreen(true), true));
		const actions = el('div', 'vg-bar');
		const available = variants.filter(variant => screen.shots.some(shot => shot.variant === variant.id));
		if (available.length > 1) {
			actions.append(segmented([...available.map(variant => ({ id: variant.id, label: variant.label, icon: variantIcon(variant) })), { id: 'all', label: S.sideBySide, icon: 'both' }], () => state.detailVariant, id => {
				state.detailVariant = id;
				openDetail(state.detail, id);
			}));
		}
		const ask = button(S.ask, '', 'ask', () => volt?.prompt(fmt(S.askPrompt, screen.name, labels)));
		ask.style.marginLeft = 'auto';
		actions.append(ask);
		const stage = el('div', 'sc-stage');
		const row = el('div', 'sc-shots');
		for (const shot of shown) {
			const figure = el('div');
			figure.style.flex = '1 1 0';
			figure.style.minWidth = '0';
			figure.style.display = 'flex';
			figure.style.flexDirection = 'column';
			figure.style.alignItems = 'center';
			const shotNode = shotFigure(screen, shot, false, false);
			shotNode.style.width = '100%';
			figure.append(shotNode);
			if (shown.length > 1) {
				figure.append(el('div', 'sc-variant-label', variantOf(shot.variant)?.label ?? ''));
			}
			row.append(figure);
		}
		stage.append(row);
		node.append(bar, actions, stage);
		const detailLine = screen.detail && data.kind !== 'desktop' ? el('div', 'sc-detail', screen.detail) : undefined;
		if (detailLine) {
			node.append(detailLine);
		}
		const warning = note(screen);
		if (warning) {
			node.append(warning);
		}
		const files = shown.map(shot => shot.path).filter(Boolean).join(', ');
		volt?.setContext(fmt(S.lookingAt, index + 1, screen.name, labels || data.title, files));
		return node;
	}

	function openDetail(index: number, variant?: string): void {
		state.detail = (index + screens.length) % screens.length;
		if (variant) {
			state.detailVariant = variant;
		}
		grid.hidden = true;
		if (failures) {
			failures.hidden = true;
		}
		detail?.remove();
		detail = buildDetail(state.detail);
		root!.append(detail);
		detail.focus({ preventScroll: true });
	}

	function closeDetail(): void {
		state.detail = -1;
		detail?.remove();
		detail = undefined;
		grid.hidden = false;
		if (failures) {
			failures.hidden = false;
		}
	}

	function step(delta: number): void {
		if (state.detail >= 0 && screens.length > 1) {
			openDetail(state.detail + delta);
		}
	}

	doc.addEventListener('keydown', event => {
		if (state.detail < 0) {
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			closeDetail();
		} else if (event.key === 'ArrowLeft') {
			step(-1);
		} else if (event.key === 'ArrowRight') {
			step(1);
		}
	});

	//#endregion

	root.append(head, grid);
	if (failures) {
		root.append(failures);
	}
	resize(0);
}

//#endregion

//#region Pages

/** JSON that cannot end its `<script>` early. */
function jsonForScript(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** A function's source as a script body: nothing in it can end the `<script>`. */
function scriptSource(fn: (...args: never[]) => unknown): string {
	return fn.toString().replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

function galleryPage(css: string, data: unknown, run: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${css}</style></head><body><div id="volt-gallery" class="vg"></div><script type="application/json" id="volt-gallery-data">${jsonForScript(data)}</script><script>${run}</script></body></html>`;
}

/** The mockups gallery page (Volt wraps it with the theme and bridge when it is shown). */
export function buildMockupsPage(data: IMockupsPageData): string {
	return galleryPage(MOCKUPS_CSS, data, `(${scriptSource(mockupsRuntime)})(window, ${scriptSource(mockupDocument)});`);
}

/** The screens gallery page (Volt wraps it with the theme and bridge when it is shown). */
export function buildScreensPage(data: IScreensPageData): string {
	return galleryPage(SCREENS_CSS, data, `(${scriptSource(screensRuntime)})(window);`);
}

//#endregion
