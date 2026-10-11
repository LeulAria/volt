/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CanvasFrameKind, CanvasTheme, ICanvasAnchor, ICanvasComment, ICanvasDoc, ICanvasFrame, ICanvasLayout, ICanvasTweak } from './canvasModel.js';

/**
 * The design canvas page: an infinite, Figma-like board of live screens. Volt writes this page, the
 * agent only sends frames (canvasModel.ts). It runs in the chat (inline, a compact board with
 * "Open") and in the side panel (the full editor with frame list and comments), and both stay in
 * step through the host (canvasService.ts).
 *
 * - Camera: one transform on the world layer; wheel pans, pinch or Cmd/Ctrl+wheel zooms at the
 *   cursor, Space or the Hand tool drags, Shift+1 fits, a minimap navigates.
 * - Frames: each screen is a same-origin `srcdoc` iframe at its real viewport size, in a device
 *   (iPhone, Android, iPad, Watch, browser, desktop window) or bare. They load when they come into
 *   view and never take the pointer outside Play, so gestures never get stuck in a frame.
 * - Move: drag frames (snapping to other frames, with guides), resize from eight handles (the page
 *   reflows live: responsive testing), marquee-select, nudge with arrows, undo.
 * - Flows: arrows from the element that leads on (`data-next` in a frame, or the agent's links)
 *   to the next frame. Play makes frames interactive; clicking a hotspot flies to its target.
 * - Comment: hover highlights the element under the pointer inside the frame; click pins a
 *   comment on it, drag pins one on a region. Comments queue and go to the agent together, with
 *   selectors and markup, or one at a time. Style tweaks on the element ride along.
 *
 * `designCanvasRuntime` and `canvasFrameDocument` are injected as source (no imports, no outside
 * references; the host passes strings in).
 */

//#region Page data

export interface ICanvasStrings {
	readonly move: string;
	readonly hand: string;
	readonly comment: string;
	readonly play: string;
	/** The Play button's label. */
	readonly playShort: string;
	readonly zoomIn: string;
	readonly zoomOut: string;
	readonly fit: string;
	readonly zoom100: string;
	readonly zoomSelection: string;
	readonly light: string;
	readonly dark: string;
	readonly devices: string;
	readonly flows: string;
	readonly minimap: string;
	readonly layers: string;
	readonly comments: string;
	readonly openPanel: string;
	/** "{0} frames" */
	readonly frameCount: string;
	/** "v{0}" */
	readonly version: string;
	/** "Updated {0}" */
	readonly updated: string;
	readonly addComment: string;
	readonly commentHint: string;
	readonly add: string;
	readonly sendNow: string;
	/** "Send {0} to agent" */
	readonly sendAll: string;
	readonly cancel: string;
	readonly resolve: string;
	readonly reopen: string;
	readonly remove: string;
	readonly edit: string;
	readonly style: string;
	readonly reset: string;
	readonly text: string;
	readonly color: string;
	readonly background: string;
	readonly fontSize: string;
	readonly fontWeight: string;
	readonly radius: string;
	readonly padding: string;
	readonly parent: string;
	readonly askInChat: string;
	/** "About {0} on the canvas "{1}": " */
	readonly askPrompt: string;
	readonly nextScreen: string;
	/** "On the canvas "{0}", design the screen that follows {1} and link it: " */
	readonly nextScreenPrompt: string;
	readonly variations: string;
	/** "Make 3 variations of {0} on the canvas "{1}", in a new section: " */
	readonly variationsPrompt: string;
	readonly copyHtml: string;
	readonly copied: string;
	readonly choose: string;
	readonly chosen: string;
	readonly recommended: string;
	readonly agent: string;
	readonly you: string;
	readonly sent: string;
	readonly resolved: string;
	readonly outdated: string;
	readonly showResolved: string;
	readonly noComments: string;
	/** "{0} ready" */
	readonly ready: string;
	readonly clear: string;
	readonly notePlaceholder: string;
	readonly back: string;
	readonly playHint: string;
	readonly commentModeHint: string;
	readonly scrollHint: string;
	readonly undo: string;
	readonly redo: string;
	readonly size: string;
	readonly live: string;
	/** "Region {0}" */
	readonly region: string;
	readonly close: string;
	readonly frames: string;
	readonly custom: string;
}

export interface ICanvasPreset {
	readonly label: string;
	readonly kind: CanvasFrameKind;
	readonly width: number;
	readonly height: number;
}

export interface ICanvasPageData {
	readonly doc: ICanvasDoc;
	readonly mode: 'inline' | 'panel';
	/** The look frames open in when the canvas has none: the user's Volt theme. */
	readonly theme: CanvasTheme;
	readonly strings: ICanvasStrings;
	readonly presets: readonly ICanvasPreset[];
	/** Frame to center on first. */
	readonly focus?: string;
	/**
	 * A view in the chat's history: it keeps showing the canvas as it was at its version (the agent's
	 * later changes show further down the chat and in the canvas's tab). Comments still update.
	 */
	readonly pinned?: boolean;
}

/** What every frame shares. */
export interface ICanvasShared {
	readonly head?: string;
	readonly css?: string;
	readonly components?: Readonly<Record<string, string>>;
}

interface ICanvasBridge {
	readonly preview?: boolean;
	readonly still?: boolean;
	readonly theme?: string;
	channel?(name: string, payload: unknown): void;
}

//#endregion

//#region Styles

const CANVAS_CSS = `
html,body{margin:0;padding:0;overflow:hidden;background:transparent}
.cv{--cv-bg:color-mix(in srgb,var(--foreground) 4.5%,var(--background));--cv-dot:color-mix(in srgb,var(--foreground) 20%,transparent);--cv-glass:light-dark(#fff,#1d1d1d);--cv-glass-line:light-dark(rgb(0 0 0/.12),rgb(255 255 255/.12));--cv-hover-fill:light-dark(rgb(0 0 0/.06),rgb(255 255 255/.08));--cv-on-fill:light-dark(rgb(0 0 0/.1),rgb(255 255 255/.13));--cv-spring:cubic-bezier(.34,1.56,.64,1);--cv-line:color-mix(in srgb,var(--foreground) 11%,transparent);--cv-accent:var(--accent);--cv-agent:var(--chart-4,#a371f7);position:relative;display:flex;overflow:hidden;font:13px/1.4 var(--font-sans);color:var(--foreground);-webkit-user-select:none;user-select:none;outline:none;box-sizing:border-box}
.cv *,.cv *::before,.cv *::after{box-sizing:border-box}
.cv [hidden]{display:none!important}
.cv.inline{height:clamp(440px,72vw,620px);border:1px solid var(--border);border-radius:12px;background:var(--cv-bg);transition:border-color .18s ease,box-shadow .18s ease}
.cv.inline.engaged{border-color:color-mix(in srgb,var(--foreground) 42%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--foreground) 16%,transparent)}
.cv.panel{height:100vh;background:var(--cv-bg)}
.cv-stage{position:relative;flex:1;min-width:0;overflow:hidden}
.cv-viewport{position:absolute;inset:0;overflow:hidden;outline:none;cursor:default;background-image:radial-gradient(circle,var(--cv-dot) 1px,transparent 1.2px);touch-action:none}
.cv.tool-hand .cv-viewport,.cv.space .cv-viewport{cursor:grab}
.cv.panning .cv-viewport{cursor:grabbing}
.cv.tool-comment .cv-viewport{cursor:crosshair}
.cv-world{position:absolute;left:0;top:0;transform-origin:0 0}
.cv.moving .cv-world{will-change:transform}
.cv-frame{position:absolute;left:0;top:0;transform-origin:0 0}
.cv-frame.cv-anim{transition:transform .45s cubic-bezier(.32,.72,0,1),width .45s cubic-bezier(.32,.72,0,1),height .45s cubic-bezier(.32,.72,0,1)}
.cv-device{position:absolute;inset:0;border-radius:var(--cv-r,12px);background:#0c0c0e;box-shadow:inset 0 0 0 1.5px #3a3a40,inset 0 0 0 4px #1a1a1d,0 0 0 1px rgb(0 0 0/.3),0 40px 80px -36px rgb(0 0 0/.6)}
.cv-frame.bare .cv-device{background:transparent;box-shadow:0 0 0 1px var(--cv-line),0 24px 60px -30px rgb(0 0 0/.5)}
.cv-frame[data-kind="browser"] .cv-device,.cv-frame[data-kind="desktop"] .cv-device{background:#f3f3f4;box-shadow:0 0 0 1px rgb(0 0 0/.12),0 30px 70px -32px rgb(0 0 0/.55)}
.cv-frame[data-look="dark"][data-kind="browser"] .cv-device,.cv-frame[data-look="dark"][data-kind="desktop"] .cv-device{background:#232326;box-shadow:0 0 0 1px rgb(255 255 255/.1),0 30px 70px -32px rgb(0 0 0/.7)}
.cv-frame[data-kind="component"] .cv-device,.cv-frame[data-kind="frame"] .cv-device{background:transparent;box-shadow:0 0 0 1px var(--cv-line),0 18px 48px -26px rgb(0 0 0/.45)}
.cv-bar{position:absolute;left:0;right:0;top:0;display:flex;align-items:center;gap:10px;padding:0 12px;color:#6e6e73;font:500 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;border-bottom:1px solid rgb(0 0 0/.08)}
.cv-frame[data-look="dark"] .cv-bar{color:#98989f;border-bottom-color:rgb(255 255 255/.07)}
.cv-dots{display:flex;gap:7px;flex:none;width:52px}.cv-dots i{width:11px;height:11px;border-radius:50%;background:#ff5f57}.cv-dots i:nth-child(2){background:#febc2e}.cv-dots i:nth-child(3){background:#28c840}
.cv-url{flex:1;max-width:520px;margin:0 auto;height:24px;padding:0 12px;border-radius:7px;background:#fff;box-shadow:0 0 0 1px rgb(0 0 0/.06);line-height:24px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-frame[data-look="dark"] .cv-url{background:rgb(255 255 255/.07);box-shadow:none}
.cv-wintitle{flex:1;text-align:center;font-weight:600;color:#1d1d1f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-frame[data-look="dark"] .cv-wintitle{color:#f5f5f7}
.cv-bar-end{flex:none;width:52px}
.cv-screen{position:absolute;overflow:hidden;background:#fff;isolation:isolate}
.cv-frame[data-look="dark"] .cv-screen{background:#000}
.cv-frame[data-kind="browser"][data-look="dark"] .cv-screen,.cv-frame[data-kind="desktop"][data-look="dark"] .cv-screen{background:#141416}
.cv-iframe,.cv-img{position:absolute;left:0;top:0;border:0;margin:0;display:block;background:transparent;pointer-events:none;z-index:2;color-scheme:normal}
.cv-img{width:100%;height:auto;object-fit:cover;object-position:top}
.cv.tool-play .cv-iframe{pointer-events:auto}
.cv-iframe.cv-leaving,.cv-img.cv-leaving{z-index:1}
.cv-iframe.cv-fresh,.cv-img.cv-fresh{opacity:0;transition:opacity .22s ease}
.cv-iframe.cv-fresh.cv-shown,.cv-img.cv-fresh.cv-shown{opacity:1}
.cv-skel{position:absolute;inset:0;z-index:0;display:grid;place-items:center;background:linear-gradient(100deg,transparent 30%,color-mix(in srgb,#888 14%,transparent) 50%,transparent 70%) 0 0/200% 100%;animation:cv-shimmer 1.4s linear infinite}
.cv-skel span{font:600 22px/1.2 var(--font-sans);color:color-mix(in srgb,#888 70%,transparent);text-align:center;padding:24px;max-width:80%}
@keyframes cv-shimmer{to{background-position:-200% 0}}
.cv-status{position:absolute;z-index:5;left:0;right:0;top:0;display:flex;align-items:center;justify-content:space-between;padding:0 30px 0 44px;font:600 16px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#0b0b0c;pointer-events:none}
.cv-frame[data-look="dark"] .cv-status{color:#f5f5f7}
.cv-frame[data-kind="android"] .cv-status{padding:0 22px;font-size:14px}
.cv-frame[data-kind="tablet"] .cv-status{padding:0 24px;font-size:13px}
.cv-status-icons{display:flex;gap:6px;align-items:center}.cv-status-icons svg{fill:currentColor}
.cv-island{position:absolute;z-index:6;left:50%;top:11px;width:124px;height:36px;margin-left:-62px;border-radius:18px;background:#000;pointer-events:none}
.cv-hole{position:absolute;z-index:6;left:50%;top:12px;width:18px;height:18px;margin-left:-9px;border-radius:50%;background:#000;pointer-events:none}
.cv-home{position:absolute;z-index:6;left:50%;bottom:8px;width:136px;height:5px;margin-left:-68px;border-radius:3px;background:#0b0b0c;opacity:.85;pointer-events:none}
.cv-frame[data-look="dark"] .cv-home{background:#f5f5f7}
.cv-frame[data-kind="android"] .cv-home{width:108px;margin-left:-54px;height:4px}
.cv-frame.cv-pulse .cv-device{animation:cv-pulse 1.1s cubic-bezier(.2,.8,.2,1)}
@keyframes cv-pulse{0%{outline:3px solid color-mix(in srgb,var(--cv-accent) 85%,transparent);outline-offset:0}100%{outline:3px solid transparent;outline-offset:22px}}
.cv-frame.cv-appear .cv-device{animation:cv-appear .5s cubic-bezier(.2,.8,.2,1) both}
@keyframes cv-appear{from{opacity:0;transform:scale(.94) translateY(12px);filter:blur(6px)}}
.cv-frame.cv-gone{transition:opacity .25s;opacity:0}
.cv-sections{position:absolute;left:0;top:0}
.cv-section{position:absolute;left:0;top:0;border-radius:28px;background:color-mix(in srgb,var(--foreground) 3%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--foreground) 8%,transparent)}
.cv-overlay{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.cv-links{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.cv-links path.cv-link{fill:none;stroke:var(--cv-accent);stroke-width:1.6;stroke-linecap:round;opacity:.78}
.cv-links circle{fill:var(--cv-accent)}
.cv-links text{font:500 11px var(--font-sans);fill:var(--cv-accent);paint-order:stroke;stroke:var(--cv-bg);stroke-width:4px;stroke-linejoin:round}
.cv.tool-play .cv-links{opacity:.25}
.cv-label{position:absolute;left:0;top:0;display:flex;align-items:center;gap:6px;height:20px;font:500 11.5px/20px var(--font-sans);color:var(--muted-foreground);white-space:nowrap;pointer-events:auto;cursor:default;will-change:transform}
.cv-label-name{min-width:0;overflow:hidden;text-overflow:ellipsis}
.cv-label-size{flex:none;opacity:.6;font-variant-numeric:tabular-nums}
.cv-label.sel .cv-label-name{color:var(--cv-accent)}
.cv-badge{flex:none;font-size:10px;font-weight:600;line-height:16px;padding:0 7px;border-radius:99px;background:color-mix(in srgb,var(--cv-accent) 16%,transparent);color:var(--foreground)}
.cv-badge.good{background:color-mix(in srgb,var(--success) 20%,transparent)}
.cv-badge.live{background:color-mix(in srgb,var(--destructive) 18%,transparent)}
.cv-choose{flex:none;appearance:none;margin:0;border:0;border-radius:99px;padding:0 9px;height:20px;font:600 11px/20px var(--font-sans);background:var(--primary);color:var(--primary-foreground);cursor:pointer}
.cv-choose:hover{filter:brightness(1.1)}
.cv-choose.done{background:var(--success);color:var(--background)}
.cv-note{position:absolute;left:0;top:0;font-size:12px;line-height:1.45;color:var(--muted-foreground);white-space:normal;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;pointer-events:none}
.cv-section-label{position:absolute;left:0;top:0;font:600 12.5px/20px var(--font-sans);color:var(--foreground);opacity:.75;white-space:nowrap}
.cv-sel{position:absolute;left:0;top:0;border:1.5px solid var(--cv-accent);border-radius:3px;pointer-events:none}
.cv-sel.hover{border-width:1px;opacity:.7}
.cv-handle{position:absolute;left:0;top:0;width:10px;height:10px;margin:-5px 0 0 -5px;border:1.5px solid var(--cv-accent);border-radius:3px;background:var(--background);pointer-events:auto}
.cv-handle[data-dir="n"],.cv-handle[data-dir="s"]{cursor:ns-resize}.cv-handle[data-dir="e"],.cv-handle[data-dir="w"]{cursor:ew-resize}
.cv-handle[data-dir="ne"],.cv-handle[data-dir="sw"]{cursor:nesw-resize}.cv-handle[data-dir="nw"],.cv-handle[data-dir="se"]{cursor:nwse-resize}
.cv-dim{position:absolute;left:0;top:0;padding:1px 7px;border-radius:5px;background:var(--cv-accent);color:var(--accent-foreground);font:600 11px/17px var(--font-sans);white-space:nowrap;font-variant-numeric:tabular-nums;transform:translateX(-50%)}
.cv-guide{position:absolute;left:0;top:0;background:var(--destructive,#f43f5e)}
.cv-marquee{position:absolute;left:0;top:0;border:1px solid var(--cv-accent);background:color-mix(in srgb,var(--cv-accent) 10%,transparent);border-radius:2px}
.cv-hover{position:absolute;left:0;top:0;border:1.5px solid var(--cv-accent);border-radius:3px;background:color-mix(in srgb,var(--cv-accent) 9%,transparent);opacity:0;scale:.97;visibility:hidden;transition:opacity .14s ease,scale .14s ease,visibility 0s linear .14s}
.cv-hover.on{opacity:1;scale:1;visibility:visible;transition:opacity .16s ease,scale .34s var(--cv-spring),visibility 0s}
.cv-hover-tag{position:absolute;left:-1.5px;bottom:100%;margin-bottom:4px;padding:2px 7px;border-radius:5px;background:var(--cv-accent);color:var(--accent-foreground);font:500 11px/16px var(--font-mono);white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}
.cv-region{position:absolute;left:0;top:0;border:1.5px dashed var(--cv-accent);border-radius:4px;background:color-mix(in srgb,var(--cv-accent) 10%,transparent)}
.cv-pin{position:absolute;left:0;top:0;display:grid;place-items:center;min-width:26px;height:26px;padding:0 6px;border-radius:13px 13px 13px 3px;background:var(--cv-accent);color:var(--accent-foreground);font:700 11.5px/1 var(--font-sans);box-shadow:0 0 0 2px var(--background),0 6px 16px -4px rgb(0 0 0/.45);pointer-events:auto;cursor:pointer;transform-origin:0 100%;transition:scale .3s var(--cv-spring),opacity .18s ease;animation:cv-pin-in .42s var(--cv-spring)}
@keyframes cv-pin-in{from{opacity:0;scale:.35}}
.cv-pin.cv-out{opacity:0;scale:.5;pointer-events:none;transition:scale .18s ease,opacity .16s ease}
.cv-pin:hover,.cv-pin.open{scale:1.12}
.cv-pin.agent{background:var(--cv-agent);color:#fff}
.cv-pin.sent{background:var(--background);color:var(--cv-accent);box-shadow:0 0 0 2px var(--cv-accent),0 6px 16px -4px rgb(0 0 0/.45)}
.cv-pin.resolved{background:var(--success);color:var(--background);opacity:.85}
.cv-pin.outdated{opacity:.55;border:1.5px dashed currentColor}
.cv-pin.pending{background:var(--background);color:var(--cv-accent);box-shadow:0 0 0 2px var(--cv-accent)}
.cv-pin svg{width:12px;height:12px}
.cv-glass{background:var(--cv-glass);color:var(--foreground);box-shadow:0 0 0 1px var(--cv-glass-line),0 8px 24px light-dark(rgb(0 0 0/.12),rgb(0 0 0/.4))}
.cv-top{position:absolute;left:10px;top:10px;right:10px;display:flex;align-items:flex-start;justify-content:space-between;gap:8px;pointer-events:none;z-index:20}
.cv-top>*{pointer-events:auto}
.cv-title{display:flex;align-items:center;gap:7px;min-width:0;max-width:60%;height:34px;padding:0 4px;font-size:12px}
.cv-title b{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-ver{flex:none;font:500 11px/16px var(--font-sans);color:var(--muted-foreground)}
.cv-change{min-width:0;color:var(--muted-foreground);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-actions{display:flex;align-items:center;gap:6px}
.cv-group{display:flex;align-items:center;gap:2px;height:34px;padding:0 4px;border-radius:999px}
.cv-btn{appearance:none;margin:0;border:0;display:inline-flex;align-items:center;justify-content:center;gap:5px;min-width:28px;height:26px;padding:0 7px;border-radius:999px;background:transparent;color:color-mix(in srgb,var(--foreground) 78%,transparent);font:500 12.5px/1 var(--font-sans);cursor:pointer;white-space:nowrap;transition:background .12s,color .12s}
.cv-btn:hover{background:var(--cv-hover-fill);color:var(--foreground)}
.cv-btn svg *{stroke-width:1}
.cv-btn[aria-pressed="true"],.cv-btn.chip{background:var(--cv-on-fill);color:var(--foreground)}
.cv-btn.chip{padding:0 11px 0 9px}
.cv-btn.chip:hover{background:color-mix(in srgb,var(--foreground) 18%,transparent)}
.cv-btn.labeled{padding:0 10px 0 8px}
.cv-btn.primary{background:var(--primary);color:var(--primary-foreground);padding:0 11px}
.cv-btn.primary:hover{filter:brightness(1.1)}
.cv-btn:disabled{opacity:.4;cursor:default}
.cv-btn:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.cv-btn svg{width:15px;height:15px;flex:none}
.cv-sep{width:1px;height:16px;margin:0 4px;background:var(--cv-glass-line)}
.cv-zoom{min-width:52px;font-variant-numeric:tabular-nums;color:var(--foreground)}
.cv-toolbar{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:20}
.cv-hint{position:absolute;left:50%;bottom:60px;transform:translateX(-50%);z-index:19;padding:5px 11px;border-radius:99px;font-size:11.5px;color:var(--muted-foreground);white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .2s}
.cv-hint.on{opacity:1}
.cv-minimap{position:absolute;right:12px;bottom:12px;z-index:20;width:168px;height:112px;overflow:hidden;cursor:pointer}
.cv.inline .cv-minimap{width:132px;height:88px}
.cv-mini-frame{position:absolute;left:0;top:0;border-radius:1.5px;background:color-mix(in srgb,var(--foreground) 32%,transparent)}
.cv-mini-frame.sel{background:var(--cv-accent)}
.cv-mini-view{position:absolute;left:0;top:0;border:1.5px solid color-mix(in srgb,var(--foreground) 45%,transparent);border-radius:3px;background:color-mix(in srgb,var(--foreground) 5%,transparent)}
.cv-tray{position:absolute;left:50%;bottom:60px;transform:translateX(-50%);z-index:21;display:flex;align-items:center;gap:10px;height:34px;padding:0 4px 0 14px;border-radius:999px;white-space:nowrap;animation:cv-rise .25s cubic-bezier(.2,.8,.2,1)}
@keyframes cv-rise{from{opacity:0;translate:0 8px}}
.cv-tray-count{display:flex;align-items:center;gap:7px;font-weight:500}
.cv-tray-dot{width:8px;height:8px;border-radius:50%;background:var(--cv-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--cv-accent) 25%,transparent)}
.cv-toast{position:absolute;left:50%;top:52px;transform:translateX(-50%);z-index:25;display:flex;align-items:center;gap:8px;max-width:80%;padding:6px 12px;border-radius:99px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;animation:cv-rise .25s cubic-bezier(.2,.8,.2,1);pointer-events:none}
.cv-toast svg{width:14px;height:14px;flex:none;color:var(--cv-agent)}
.cv-selbar{position:absolute;left:0;top:0;z-index:18;display:flex;align-items:center;gap:2px;height:34px;padding:0 4px;border-radius:999px;transform:translate(-50%,-100%);white-space:nowrap}
.cv-select{appearance:none;height:26px;padding:0 26px 0 11px;border:0;border-radius:999px;background:transparent url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.4'/%3E%3C/svg%3E") no-repeat right 8px center;color:var(--foreground);font:500 12px var(--font-sans);cursor:pointer}
.cv-select:hover{background-color:var(--cv-hover-fill)}
.cv-select option{background:var(--popover);color:var(--popover-foreground,var(--foreground))}
.cv-pop{position:absolute;left:0;top:0;z-index:30;width:316px;display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:14px;animation:cv-rise .2s cubic-bezier(.2,.8,.2,1);-webkit-user-select:text;user-select:text}
.cv-pop-head{display:flex;align-items:center;gap:6px;min-width:0}
.cv-chip{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:100%;padding:2px 8px;border-radius:6px;background:color-mix(in srgb,var(--cv-accent) 14%,transparent);font:500 11.5px/18px var(--font-mono);color:var(--foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-pop-head .cv-chip{flex:1}
.cv-pop textarea{width:100%;min-height:64px;max-height:220px;resize:none;padding:8px 10px;border-radius:9px;border:1px solid var(--border);background:var(--input,transparent);color:var(--foreground);font:13px/1.45 var(--font-sans);outline:none}
.cv-pop textarea:focus{border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in srgb,var(--ring) 22%,transparent)}
.cv-pop-row{display:flex;align-items:center;gap:4px}
.cv-pop-row .cv-grow{flex:1}
.cv-pop-hint{font-size:11px;color:var(--muted-foreground)}
.cv-thread{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto}
.cv-msg{display:flex;gap:8px;align-items:flex-start}
.cv-avatar{flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font:700 10px/1 var(--font-sans);background:var(--cv-accent);color:var(--accent-foreground)}
.cv-avatar.agent{background:var(--cv-agent);color:#fff}
.cv-avatar svg{width:12px;height:12px}
.cv-msg-body{min-width:0;flex:1}
.cv-msg-who{font-size:11px;font-weight:600;color:var(--muted-foreground);display:flex;gap:6px;align-items:center}
.cv-msg-text{white-space:pre-wrap;word-break:break-word}
.cv-tweaks{display:grid;grid-template-columns:auto 1fr;gap:5px 8px;align-items:center;padding:8px;border-radius:9px;background:color-mix(in srgb,var(--foreground) 4%,transparent)}
.cv-tweaks label{font-size:11.5px;color:var(--muted-foreground)}
.cv-tweaks .cv-field{display:flex;gap:5px;align-items:center;min-width:0}
.cv-tweaks input[type=text],.cv-tweaks select{flex:1;min-width:0;height:26px;padding:0 8px;border:1px solid var(--border);border-radius:6px;background:var(--input,transparent);color:var(--foreground);font:12px var(--font-mono)}
.cv-tweaks input[type=color]{flex:none;width:26px;height:26px;padding:0;border:1px solid var(--border);border-radius:6px;background:none;cursor:pointer}
.cv-tweaks input[type=color]::-webkit-color-swatch-wrapper{padding:2px}.cv-tweaks input[type=color]::-webkit-color-swatch{border:0;border-radius:4px}
.cv-back{animation:cv-rise .2s}
@media (max-width:620px){.cv-change,.cv-viewgroup,.cv-undo,.cv-btn.labeled .cv-btn-label{display:none}.cv-btn.labeled{padding:0 7px}.cv-minimap{width:110px!important;height:74px!important}.cv-title{max-width:46%}}
@media (max-width:440px){.cv-minimap{display:none}}
@media (prefers-reduced-motion:reduce){.cv *{animation:none!important;transition:none!important}}
`;

//#endregion

//#region Frame documents

/**
 * One frame as the complete document its iframe loads, in `theme`: `<html class="dark"
 * data-theme="dark">`, `prefers-color-scheme` answering for the theme, Tailwind's `dark:` on the
 * class, the safe area of phones as `--safe-top`/`--safe-bottom`, `{{name}}` components expanded,
 * links that go nowhere, and errors tagged with the frame so the agent knows which one broke.
 */
export function canvasFrameDocument(shared: ICanvasShared, frame: ICanvasFrame, theme: CanvasTheme): string {
	const SAFE: Record<string, readonly [number, number]> = { iphone: [54, 34], android: [40, 24], tablet: [24, 20] };
	const fix = (text: string | undefined): string => (text ?? '').replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_match: string, want: string) => want.toLowerCase() === theme ? '(min-width: 0px)' : '(max-width: 0.001px)');
	const components = shared.components ?? {};
	const expand = (text: string): string => {
		let out = text;
		for (let pass = 0; pass < 4 && /\{\{[\w-]+\}\}/.test(out); pass++) {
			out = out.replace(/\{\{([\w-]+)\}\}/g, (match: string, name: string) => Object.prototype.hasOwnProperty.call(components, name) ? components[name] : match);
		}
		return out;
	};
	const scriptTag = (body: string): string => '<scr' + 'ipt>' + body + '</scr' + 'ipt>';
	const shim = scriptTag(`(function(){var T=${JSON.stringify(theme)},tag=${JSON.stringify(`[frame ${frame.id}]`)};`
		+ 'var mm=window.matchMedia?window.matchMedia.bind(window):null;'
		+ 'window.matchMedia=function(q){var m=/prefers-color-scheme\\s*:\\s*(dark|light)/i.exec(String(q));if(!m||!mm){return mm?mm(q):null;}'
		+ 'return{matches:m[1].toLowerCase()===T,media:String(q),onchange:null,addListener:function(){},removeListener:function(){},addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return false;}};};'
		+ 'var err=console.error.bind(console);console.error=function(){err.apply(null,[tag].concat([].slice.call(arguments)));};'
		+ 'window.addEventListener("error",function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){err(tag+" Failed to load "+(t.src||t.href));return;}err(tag+" Uncaught "+((e.error&&e.error.stack)||e.message));},true);'
		+ 'document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(a){e.preventDefault();}},true);'
		+ 'document.addEventListener("submit",function(e){e.preventDefault();},true);'
		+ '})();');
	const safe = SAFE[frame.kind];
	const fixed = frame.height > 0;
	const safeCss = `:root{--safe-top:${safe ? safe[0] : 0}px;--safe-bottom:${safe ? safe[1] : 0}px}`
		+ (safe && !frame.fullbleed ? ':where(body){padding-top:var(--safe-top);padding-bottom:var(--safe-bottom)}' : '');
	const base = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{color-scheme:${theme};-webkit-text-size-adjust:100%${fixed ? ';height:100%' : ''}}html,body{margin:0}body{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,system-ui,sans-serif;background:Canvas;color:CanvasText;-webkit-font-smoothing:antialiased${fixed ? ';min-height:100%' : ''}}${safeCss}</style>`;
	const tailwind = scriptTag('if(window.tailwind){try{tailwind.config=Object.assign({},tailwind.config||{},{darkMode:"class"});}catch(e){}}')
		+ (/@tailwindcss\/browser/i.test(shared.head ?? '') ? '<style type="text/tailwindcss">@custom-variant dark (&:where(.dark, .dark *));</style>' : '');
	const styles = [shared.css, frame.css].filter((css): css is string => !!css && !!css.trim()).map(css => `<style>${fix(css)}</style>`).join('');
	const html = expand(frame.html ?? '');
	if (/^\s*(?:<!doctype|<html)/i.test(html)) {
		let page = fix(html).replace(/<html\b([^>]*)>/i, (_match: string, attrs: string) => {
			const classes = /\sclass\s*=\s*(["'])(.*?)\1/i.exec(attrs);
			const rest = attrs.replace(/\s(?:class|data-theme)\s*=\s*(["']).*?\1/gi, '');
			return `<html${rest} class="${`${classes ? classes[2] : ''} ${theme}`.trim()}" data-theme="${theme}">`;
		});
		const head = /<head\b[^>]*>/i.exec(page);
		if (head) {
			const at = head.index + head[0].length;
			page = page.slice(0, at) + shim + `<style>:root{--safe-top:${safe ? safe[0] : 0}px;--safe-bottom:${safe ? safe[1] : 0}px}</style>` + page.slice(at);
		} else if (/<html\b[^>]*>/i.test(page)) {
			page = page.replace(/<html\b[^>]*>/i, match => `${match}<head>${shim}</head>`);
		} else {
			page = page.replace(/^\s*<!doctype[^>]*>/i, match => `${match}<head>${shim}</head>`);
		}
		return page.replace(/<\/head>/i, `${fix(shared.head)}${styles}${tailwind}</head>`);
	}
	return `<!doctype html><html class="${theme}" data-theme="${theme}"><head>${base}${shim}${fix(shared.head)}${styles}${tailwind}</head><body>${fix(html)}</body></html>`;
}

//#endregion

//#region Runtime

export function designCanvasRuntime(win: Window & typeof globalThis, frameDocument: (shared: ICanvasShared, frame: ICanvasFrame, theme: CanvasTheme) => string): void {
	const doc = win.document;
	const root = doc.getElementById('volt-canvas');
	const source = doc.getElementById('volt-canvas-data');
	if (!root || !source) {
		return;
	}
	const boot = JSON.parse(source.textContent || '{}') as ICanvasPageData;
	const S = boot.strings;
	const volt = (win as unknown as { volt?: ICanvasBridge }).volt;
	const inline = boot.mode === 'inline';
	// Offscreen (measuring, screenshots): no motion. A page shown again in the chat still animates.
	const still = !!volt?.preview;
	const reduced = !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	const hosted = !!volt?.channel && !volt.preview;
	let model: ICanvasDoc = boot.doc;
	let look: CanvasTheme = model.theme ?? boot.theme;

	//#region Helpers

	interface IRect { x: number; y: number; w: number; h: number }
	interface IPoint { x: number; y: number }

	const NS = 'http://www.w3.org/2000/svg';
	const MAX_LIVE = 24;
	const MIN_Z = 0.03;
	const MAX_Z = 8;
	const ICONS: Record<string, string> = {
		move: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M3.5 2.5 12.5 7l-4 1.2-1.6 4.3z"/></svg>',
		hand: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 8.5V3.6a1 1 0 0 1 2 0v4M7.5 7.5V2.6a1 1 0 0 1 2 0v5M9.5 7.6V3.6a1 1 0 0 1 2 0v5.2c0 3-1.8 4.7-4.4 4.7-1.8 0-2.9-.8-3.8-2.3L2 8.7a1 1 0 0 1 1.6-1.2l1.9 2"/></svg>',
		comment: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 2.2c3.3 0 5.8 2.2 5.8 5s-2.5 5-5.8 5c-.8 0-1.5-.1-2.2-.3L2.6 13l.9-2.6A4.6 4.6 0 0 1 2.2 7.2c0-2.8 2.5-5 5.8-5Z"/></svg>',
		play: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M4.5 2.8v10.4L13 8z"/></svg>',
		minus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3.5 8h9"/></svg>',
		plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3.5 8h9M8 3.5v9"/></svg>',
		fit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>',
		sun: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="2.7"/><path d="M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1"/></svg>',
		moon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M13.2 9.7A5.4 5.4 0 0 1 6.3 2.8a5.5 5.5 0 1 0 6.9 6.9Z"/></svg>',
		device: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="4.4" y="1.6" width="7.2" height="12.8" rx="2"/><path d="M7 3.6h2"/></svg>',
		phone: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="4.6" y="1.6" width="6.8" height="12.8" rx="1.6"/><path d="M7.1 12.1h1.8"/></svg>',
		tablet: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="2.6" y="1.6" width="10.8" height="12.8" rx="1.6"/><path d="M7.1 12.1h1.8"/></svg>',
		browser: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6"/><path d="M1.6 5.6h12.8"/></svg>',
		desktop: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="1.6" y="2.6" width="12.8" height="8.8" rx="1.2"/><path d="M5.6 14h4.8M8 11.4V14"/></svg>',
		watch: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.6" y="3.6" width="8.8" height="8.8" rx="2.4"/><path d="M5.6 3.6l.6-2h3.6l.6 2M5.6 12.4l.6 2h3.6l.6-2"/></svg>',
		component: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="4" width="12" height="8" rx="2" stroke-dasharray="2.2 1.6"/></svg>',
		frame: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M5 1.8v12.4M11 1.8v12.4M1.8 5h12.4M1.8 11h12.4"/></svg>',
		flow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="3.5" cy="4" r="1.6"/><path d="M5.1 4h2.4a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1.4M11.3 10.2 13 12l-1.7 1.8"/></svg>',
		map: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6"/><rect x="7.6" y="7.4" width="4.6" height="3.6" rx=".8"/></svg>',
		layers: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="m8 2 6 3.2-6 3.2-6-3.2z"/><path d="m2 8.4 6 3.2 6-3.2"/></svg>',
		panel: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6"/><path d="M9.6 2.6v10.8"/></svg>',
		send: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.2 7.6 13.8 2.4 10 13.8 7.6 8.6z"/><path d="m7.6 8.6 6.2-6.2"/></svg>',
		check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 8.6 6.4 11.8 12.8 4.6"/></svg>',
		trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 4.2h10.4M6.2 4.2V2.8h3.6v1.4M4.2 4.2l.7 9h6.2l.7-9"/></svg>',
		close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
		sparkle: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.2c.3 2.9 1.9 4.5 4.8 4.8-2.9.3-4.5 1.9-4.8 4.8-.3-2.9-1.9-4.5-4.8-4.8C6.1 5.7 7.7 4.1 8 1.2Zm4.6 8.6c.1 1.3.8 2 2.1 2.1-1.3.1-2 .8-2.1 2.1-.1-1.3-.8-2-2.1-2.1 1.3-.1 2-.8 2.1-2.1Z"/></svg>',
		copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5" y="5" width="8.6" height="8.6" rx="1.6"/><path d="M11 5V3.6A1.2 1.2 0 0 0 9.8 2.4H3.6a1.2 1.2 0 0 0-1.2 1.2v6.2A1.2 1.2 0 0 0 3.6 11H5"/></svg>',
		chat: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M5.5 6.5h5M5.5 8.5h3"/></svg>',
		next: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="4" width="5.4" height="8" rx="1"/><path d="M9 8h5M12 5.8 14.2 8 12 10.2"/></svg>',
		variants: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.8" y="3" width="3.6" height="10" rx=".8"/><rect x="6.2" y="3" width="3.6" height="10" rx=".8"/><rect x="10.6" y="3" width="3.6" height="10" rx=".8"/></svg>',
		up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 7l4-4 4 4"/></svg>',
		back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8H3.4M7.4 4 3.4 8l4 4"/></svg>',
		style: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h2M7.5 11.5h6"/><circle cx="11" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/></svg>',
		undo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7"/></svg>',
	};
	const STATUS_ICONS = '<svg width="17" height="11" viewBox="0 0 17 11"><rect y="7" width="3" height="4" rx="1"/><rect x="4.6" y="5" width="3" height="6" rx="1"/><rect x="9.2" y="2.5" width="3" height="8.5" rx="1"/><rect x="13.8" width="3" height="11" rx="1"/></svg>'
		+ '<svg width="15" height="11" viewBox="0 0 15 11"><path d="M7.5 2.3c2.1 0 4 .8 5.4 2.1l1.2-1.2A9.4 9.4 0 0 0 7.5.6C5 .6 2.6 1.6.9 3.2l1.2 1.2a7.7 7.7 0 0 1 5.4-2.1Zm0 3.3c1.2 0 2.3.4 3.1 1.2l1.2-1.2a6.4 6.4 0 0 0-8.6 0l1.2 1.2c.8-.8 1.9-1.2 3.1-1.2Zm0 3.2L5.7 10.6 7.5 11l1.8-.4-1.8-1.8Z"/></svg>'
		+ '<svg width="25" height="12" viewBox="0 0 25 12"><rect x=".5" y=".5" width="21" height="11" rx="3.5" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="18" height="8" rx="2"/><path d="M23 4v4a2 2 0 0 0 0-4Z" opacity=".4"/></svg>';
	/** [bezel, top bar, outer radius, screen radius, status bar] per kind. */
	const CHROME: Record<CanvasFrameKind, readonly [number, number, number, number, number]> = {
		iphone: [12, 0, 66, 54, 54],
		android: [10, 0, 50, 40, 40],
		tablet: [18, 0, 42, 24, 24],
		watch: [14, 0, 60, 46, 0],
		browser: [0, 40, 12, 0, 0],
		desktop: [0, 34, 12, 0, 0],
		component: [0, 0, 14, 14, 0],
		frame: [0, 0, 3, 3, 0],
	};

	const fmt = (template: string, ...args: (string | number)[]): string => template.replace(/\{(\d+)\}/g, (match, index) => String(args[Number(index)] ?? match));
	const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
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
		const node = el('span');
		node.style.display = 'contents';
		node.innerHTML = ICONS[name] ?? '';
		return node;
	}
	function button(label: string, iconName: string | undefined, run: (event: MouseEvent) => void, className = '', showLabel = false): HTMLButtonElement {
		const node = el('button', `cv-btn${className ? ` ${className}` : ''}`);
		node.type = 'button';
		if (iconName) {
			node.append(icon(iconName));
		}
		if (showLabel) {
			node.append(el('span', 'cv-btn-label', label));
		} else {
			node.setAttribute('aria-label', label);
		}
		node.title = label;
		node.addEventListener('pointerdown', event => event.stopPropagation());
		node.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			run(event);
		});
		return node;
	}
	function hash(text: string): string {
		let h = 0x811c9dc5;
		for (let i = 0; i < text.length; i++) {
			h ^= text.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		return (h >>> 0).toString(36);
	}
	function post(op: string, payload: Record<string, unknown> = {}): void {
		if (hosted) {
			volt?.channel?.('canvas', { op, id: model.id, ...payload });
		}
	}
	function typing(target: EventTarget | null): boolean {
		const node = target as HTMLElement | null;
		return !!node && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName));
	}

	//#endregion

	//#region Shell

	root.className = `cv ${inline ? 'inline' : 'panel'} tool-move`;
	root.tabIndex = -1;
	const stage = el('div', 'cv-stage');
	const viewport = el('div', 'cv-viewport');
	viewport.tabIndex = 0;
	viewport.setAttribute('role', 'application');
	viewport.setAttribute('aria-label', model.title);
	const world = el('div', 'cv-world');
	const sectionsLayer = el('div', 'cv-sections');
	world.append(sectionsLayer);
	const overlay = el('div', 'cv-overlay');
	const links = doc.createElementNS(NS, 'svg');
	links.setAttribute('class', 'cv-links');
	const labelsLayer = el('div');
	const selLayer = el('div');
	const guidesLayer = el('div');
	const pinsLayer = el('div');
	const hoverBox = el('div', 'cv-hover');
	const hoverTag = el('div', 'cv-hover-tag');
	hoverBox.append(hoverTag);
	const marquee = el('div', 'cv-marquee');
	marquee.hidden = true;
	const regionBox = el('div', 'cv-region');
	regionBox.hidden = true;
	overlay.append(links, labelsLayer, selLayer, guidesLayer, hoverBox, regionBox, marquee, pinsLayer);
	viewport.append(world, overlay);
	stage.append(viewport);
	root.append(stage);

	//#endregion

	//#region State

	type Tool = 'move' | 'hand' | 'comment' | 'play';
	interface ILocalRect { x: number; y: number; w: number; h: number }
	interface ITrigger { readonly to: string; readonly selector?: string; readonly label?: string; rect?: ILocalRect }
	interface IView {
		frame: ICanvasFrame;
		readonly node: HTMLElement;
		readonly device: HTMLElement;
		readonly bar: HTMLElement | undefined;
		readonly barText: HTMLElement | undefined;
		readonly screen: HTMLElement;
		readonly skeleton: HTMLElement;
		readonly label: HTMLElement;
		readonly labelName: HTMLElement;
		readonly labelSize: HTMLElement;
		readonly labelBadges: HTMLElement;
		readonly note: HTMLElement;
		content: HTMLIFrameElement | HTMLImageElement | undefined;
		leaving: HTMLElement | undefined;
		loaded: boolean;
		loading: boolean;
		contentHeight: number;
		hash: string;
		theme: CanvasTheme;
		rects: Map<string, ILocalRect | null>;
		triggers: ITrigger[];
		seen: number;
		observer: ResizeObserver | undefined;
	}

	const state = {
		tool: 'move' as Tool,
		devices: true,
		flows: true,
		minimap: true,
		layers: !inline,
		commentsOpen: !inline,
		showResolved: false,
		engaged: !inline,
		space: false,
		selected: new Set<string>(),
		hoverFrame: undefined as string | undefined,
		chosen: undefined as string | undefined,
		dragging: false,
	};
	const cam = { x: 0, y: 0, z: 1 };
	const views = new Map<string, IView>();
	const playHistory: string[] = [];
	const undoStack: ICanvasLayout[][] = [];
	const redoStack: ICanvasLayout[][] = [];
	let fitted = false;
	let scrollHinted = false;
	/** Where the pointer last was over the viewport (the comment highlight follows the camera). */
	let lastPointer: { x: number; y: number } | undefined;

	//#endregion

	//#region Geometry

	function chromeOf(v: IView): { l: number; t: number; r: number; b: number; radius: number; inner: number; bar: number; status: number } {
		const [bezel, bar, radius, inner, status] = CHROME[v.frame.kind] ?? CHROME.frame;
		const device = state.devices && bezel > 0;
		const pad = device ? bezel : 0;
		return { l: pad, t: pad + bar, r: pad, b: pad, radius: device ? radius : bezel ? Math.round(inner * 0.75) : radius, inner: device ? inner : bezel ? Math.round(inner * 0.75) : bar ? 0 : inner, bar, status };
	}
	function screenHeight(v: IView): number {
		return v.frame.height || v.contentHeight || Math.round(clamp(v.frame.width * 0.6, 160, 900));
	}
	function boxOf(v: IView): IRect {
		const c = chromeOf(v);
		return { x: v.frame.x ?? 0, y: v.frame.y ?? 0, w: v.frame.width + c.l + c.r, h: screenHeight(v) + c.t + c.b };
	}
	function screenOrigin(v: IView): IPoint {
		const c = chromeOf(v);
		return { x: (v.frame.x ?? 0) + c.l, y: (v.frame.y ?? 0) + c.t };
	}
	function toScreen(p: IPoint): IPoint {
		return { x: p.x * cam.z + cam.x, y: p.y * cam.z + cam.y };
	}
	function viewportRect(): DOMRect {
		return viewport.getBoundingClientRect();
	}
	function toWorld(clientX: number, clientY: number): IPoint {
		const r = viewportRect();
		return { x: (clientX - r.left - cam.x) / cam.z, y: (clientY - r.top - cam.y) / cam.z };
	}
	function union(rects: readonly IRect[]): IRect | undefined {
		if (!rects.length) {
			return undefined;
		}
		const x = Math.min(...rects.map(r => r.x));
		const y = Math.min(...rects.map(r => r.y));
		return { x, y, w: Math.max(...rects.map(r => r.x + r.w)) - x, h: Math.max(...rects.map(r => r.y + r.h)) - y };
	}
	function ordered(): IView[] {
		return model.frames.map(frame => views.get(frame.id)).filter((v): v is IView => !!v);
	}
	function hitFrame(p: IPoint): IView | undefined {
		const list = ordered();
		for (let i = list.length - 1; i >= 0; i--) {
			const b = boxOf(list[i]);
			if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
				return list[i];
			}
		}
		return undefined;
	}

	//#endregion

	//#region Frames

	function frameDoc(v: IView): Document | undefined {
		const content = v.content;
		if (!(content instanceof win.HTMLIFrameElement) || !v.loaded) {
			return undefined;
		}
		try {
			return content.contentDocument ?? undefined;
		} catch {
			return undefined;
		}
	}
	function sharedParts(): ICanvasShared {
		return { head: model.head, css: model.css, components: model.components };
	}
	function contentHash(frame: ICanvasFrame, theme: CanvasTheme): string {
		return hash([frame.html, frame.css, frame.url, frame.image ? frame.image.length + frame.image.slice(-64) : '', frame.kind, frame.fullbleed, frame.height === 0 ? 'auto' : 'fixed', theme, model.head, model.css, JSON.stringify(model.components ?? {})].join('\u0001'));
	}
	function urlText(frame: ICanvasFrame): string {
		if (frame.url) {
			return frame.url.replace(/^https?:\/\//, '');
		}
		return `${frame.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app'}.app`;
	}
	const phoneish = (kind: CanvasFrameKind) => kind === 'iphone' || kind === 'android' || kind === 'tablet';

	function createView(frame: ICanvasFrame): IView {
		const node = el('div', 'cv-frame');
		const device = el('div', 'cv-device');
		let bar: HTMLElement | undefined;
		let barText: HTMLElement | undefined;
		if (frame.kind === 'browser' || frame.kind === 'desktop') {
			bar = el('div', 'cv-bar');
			const dots = el('span', 'cv-dots');
			dots.append(el('i'), el('i'), el('i'));
			barText = el('span', frame.kind === 'browser' ? 'cv-url' : 'cv-wintitle');
			bar.append(dots, barText, el('span', 'cv-bar-end'));
			device.append(bar);
		}
		const screen = el('div', 'cv-screen');
		const skeleton = el('div', 'cv-skel');
		skeleton.append(el('span', undefined, frame.name));
		screen.append(skeleton);
		if (phoneish(frame.kind)) {
			const status = el('div', 'cv-status');
			status.innerHTML = `<span>9:41</span><span class="cv-status-icons">${STATUS_ICONS}</span>`;
			screen.append(status);
			if (frame.kind === 'iphone') {
				screen.append(el('div', 'cv-island'));
			} else if (frame.kind === 'android') {
				screen.append(el('div', 'cv-hole'));
			}
			screen.append(el('div', 'cv-home'));
		}
		device.append(screen);
		node.append(device);
		world.append(node);
		const label = el('div', 'cv-label');
		const labelName = el('span', 'cv-label-name');
		const labelSize = el('span', 'cv-label-size');
		const labelBadges = el('span');
		labelBadges.style.display = 'contents';
		label.append(labelName, labelSize, labelBadges);
		const note = el('div', 'cv-note');
		labelsLayer.append(label, note);
		const v: IView = {
			frame, node, device, bar, barText, screen, skeleton, label, labelName, labelSize, labelBadges, note,
			content: undefined, leaving: undefined, loaded: false, loading: false, contentHeight: 0, hash: '',
			theme: frame.theme ?? look, rects: new Map(), triggers: [], seen: 0, observer: undefined,
		};
		label.addEventListener('pointerdown', event => {
			if (event.button !== 0 || state.tool === 'hand') {
				return;
			}
			event.stopPropagation();
			engage();
			select(v.frame.id, event.shiftKey);
			startMove(event);
		});
		label.addEventListener('dblclick', event => {
			event.stopPropagation();
			zoomToFrame(v.frame.id);
		});
		dress(v);
		v.hash = contentHash(frame, v.theme);
		return v;
	}

	/** Names, badges and chrome from the frame's fields. */
	function dress(v: IView, animate = false): void {
		const frame = v.frame;
		v.node.dataset.id = frame.id;
		v.node.dataset.kind = frame.kind;
		v.node.dataset.look = v.theme;
		v.node.classList.toggle('bare', !state.devices || !(CHROME[frame.kind]?.[0] > 0));
		v.labelName.textContent = frame.name;
		if (v.barText) {
			v.barText.textContent = frame.kind === 'browser' ? urlText(frame) : frame.name;
		}
		v.labelBadges.replaceChildren();
		if (frame.recommended) {
			v.labelBadges.append(el('span', 'cv-badge', S.recommended));
		}
		if (frame.url) {
			v.labelBadges.append(el('span', 'cv-badge live', S.live));
		}
		if (model.pick) {
			const chosen = state.chosen === frame.id;
			const choose = el('button', `cv-choose${chosen ? ' done' : ''}`, chosen ? S.chosen : S.choose);
			choose.type = 'button';
			choose.addEventListener('pointerdown', event => event.stopPropagation());
			choose.addEventListener('click', event => {
				event.stopPropagation();
				state.chosen = frame.id;
				post('choose', { frame: frame.id });
				ordered().forEach(view => dress(view));
			});
			v.labelBadges.append(choose);
		}
		v.note.textContent = frame.note ?? '';
		place(v, animate);
	}

	function place(v: IView, animate = false): void {
		const b = boxOf(v);
		const c = chromeOf(v);
		v.node.classList.toggle('cv-anim', animate && !still && !reduced);
		v.node.style.transform = `translate(${b.x}px,${b.y}px)`;
		v.node.style.width = `${b.w}px`;
		v.node.style.height = `${b.h}px`;
		v.device.style.setProperty('--cv-r', `${c.radius}px`);
		if (v.bar) {
			v.bar.style.height = `${c.bar}px`;
			v.bar.style.top = `${c.t - c.bar}px`;
			v.bar.style.left = `${c.l}px`;
			v.bar.style.right = `${c.r}px`;
		}
		const h = screenHeight(v);
		Object.assign(v.screen.style, { left: `${c.l}px`, top: `${c.t}px`, width: `${v.frame.width}px`, height: `${h}px`, borderRadius: c.bar ? `0 0 ${c.radius}px ${c.radius}px` : `${c.inner}px` });
		const status = v.screen.querySelector('.cv-status') as HTMLElement | null;
		if (status) {
			status.style.height = `${c.status}px`;
		}
		if (v.content instanceof win.HTMLIFrameElement) {
			v.content.style.width = `${v.frame.width}px`;
			v.content.style.height = `${h}px`;
		} else if (v.content) {
			v.content.style.width = `${v.frame.width}px`;
		}
		v.rects.clear();
		requestRender();
	}

	const loadQueue: IView[] = [];
	let loadTimer = 0;
	function queueLoad(v: IView): void {
		if (v.loaded || v.loading || loadQueue.includes(v)) {
			return;
		}
		loadQueue.push(v);
		if (!loadTimer) {
			loadTimer = win.setTimeout(drainLoads, 0);
		}
	}
	function drainLoads(): void {
		loadTimer = 0;
		const batch = loadQueue.splice(0, 2);
		batch.forEach(load);
		if (loadQueue.length) {
			loadTimer = win.setTimeout(drainLoads, 60);
		}
	}

	function load(v: IView): void {
		if (v.loaded || v.loading || !views.has(v.frame.id)) {
			return;
		}
		v.loading = true;
		evict();
		const frame = v.frame;
		const fresh = !!v.leaving;
		let content: HTMLIFrameElement | HTMLImageElement;
		if (frame.image) {
			const img = el('img', 'cv-img');
			img.alt = frame.name;
			img.draggable = false;
			img.addEventListener('load', () => {
				if (!frame.height && img.naturalWidth) {
					v.contentHeight = Math.round(img.naturalHeight * frame.width / img.naturalWidth);
				}
				loaded(v, img);
			}, { once: true });
			img.addEventListener('error', () => loaded(v, img), { once: true });
			img.src = frame.image;
			content = img;
		} else {
			const iframe = el('iframe', 'cv-iframe');
			iframe.tabIndex = -1;
			iframe.title = frame.name;
			iframe.addEventListener('load', () => loaded(v, iframe));
			if (frame.url) {
				iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
				iframe.referrerPolicy = 'no-referrer';
				iframe.src = frame.url;
			} else {
				iframe.srcdoc = frameDocument(sharedParts(), frame, v.theme);
			}
			content = iframe;
		}
		if (fresh) {
			content.classList.add('cv-fresh');
		}
		v.content = content;
		v.screen.prepend(content);
		place(v);
	}

	function loaded(v: IView, content: HTMLIFrameElement | HTMLImageElement): void {
		if (v.content !== content) {
			return;
		}
		const first = !v.loaded;
		v.loaded = true;
		v.loading = false;
		v.skeleton.hidden = true;
		v.rects.clear();
		const idoc = frameDoc(v);
		if (idoc && first) {
			wireFrame(v, idoc);
		}
		if (content.classList.contains('cv-fresh')) {
			win.requestAnimationFrame(() => content.classList.add('cv-shown'));
			const leaving = v.leaving;
			v.leaving = undefined;
			win.setTimeout(() => leaving?.remove(), 260);
		} else if (v.leaving) {
			v.leaving.remove();
			v.leaving = undefined;
		}
		measure(v);
		collectTriggers(v);
		applyTweaks(v);
		place(v);
	}

	/** Watches a frame's document: its height (content-height frames), scroll, Play clicks, pinch. */
	function wireFrame(v: IView, idoc: Document): void {
		v.observer?.disconnect();
		v.observer = undefined;
		if (!v.frame.height && typeof win.ResizeObserver === 'function' && idoc.body) {
			const observer = new win.ResizeObserver(() => {
				if (measure(v)) {
					place(v);
				}
			});
			observer.observe(idoc.body);
			v.observer = observer;
		}
		idoc.addEventListener('scroll', () => {
			v.rects.clear();
			requestRender();
		}, true);
		idoc.addEventListener('click', event => onFrameClick(v, event), true);
		idoc.addEventListener('pointerdown', () => engage(), true);
		idoc.addEventListener('wheel', event => {
			if (event.ctrlKey || event.metaKey) {
				event.preventDefault();
				const r = (v.content as HTMLElement).getBoundingClientRect();
				zoomBy(event.deltaY, r.left + event.clientX * cam.z, r.top + event.clientY * cam.z, event.deltaMode);
			} else if (inline && !state.engaged) {
				// Play makes screens take the pointer; until the canvas is clicked the chat still scrolls.
				// The page's own window passes wheel events on to the chat.
				event.preventDefault();
				win.dispatchEvent(new win.WheelEvent('wheel', { deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode }));
			}
		}, { passive: false });
		idoc.addEventListener('keydown', event => {
			if (event.key === 'Escape') {
				setTool('move');
				viewport.focus();
			}
		});
	}

	/** Content-height frames: the document's height. True when it changed. */
	function measure(v: IView): boolean {
		if (v.frame.height) {
			return false;
		}
		const idoc = frameDoc(v);
		let height = 0;
		if (idoc?.documentElement) {
			height = Math.ceil(Math.max(idoc.documentElement.getBoundingClientRect().height, idoc.body ? idoc.body.getBoundingClientRect().bottom : 0));
		} else if (v.content instanceof win.HTMLImageElement) {
			height = v.contentHeight;
		}
		height = clamp(height || 240, 40, 4000);
		if (Math.abs(height - v.contentHeight) > 1) {
			v.contentHeight = height;
			return true;
		}
		return false;
	}

	/** Drops the iframes of frames least recently on screen, past {@link MAX_LIVE}. */
	function evict(): void {
		const live = [...views.values()].filter(v => v.loaded || v.loading);
		if (live.length < MAX_LIVE) {
			return;
		}
		live.sort((a, b) => a.seen - b.seen);
		for (const v of live.slice(0, live.length - MAX_LIVE + 1)) {
			if (state.selected.has(v.frame.id) || !v.loaded) {
				continue;
			}
			v.observer?.disconnect();
			v.observer = undefined;
			v.content?.remove();
			v.content = undefined;
			v.loaded = false;
			v.skeleton.hidden = false;
		}
	}

	/** New content for a frame: the new document loads over the old one and fades in. */
	function refresh(v: IView, pulse: boolean): void {
		v.hash = contentHash(v.frame, v.theme);
		if (v.content) {
			v.leaving?.remove();
			v.leaving = v.content;
			v.leaving.classList.add('cv-leaving');
			v.content = undefined;
			v.loaded = false;
			v.loading = false;
			v.observer?.disconnect();
			v.observer = undefined;
			v.triggers = [];
			load(v);
		}
		if (pulse && !still) {
			v.node.classList.remove('cv-pulse');
			void v.node.offsetWidth;
			v.node.classList.add('cv-pulse');
			win.setTimeout(() => v.node.classList.remove('cv-pulse'), 1200);
		}
	}

	function removeView(v: IView, animate: boolean): void {
		views.delete(v.frame.id);
		state.selected.delete(v.frame.id);
		v.observer?.disconnect();
		v.label.remove();
		v.note.remove();
		if (animate && !still) {
			v.node.classList.add('cv-gone');
			win.setTimeout(() => v.node.remove(), 260);
		} else {
			v.node.remove();
		}
	}

	//#endregion

	//#region Flows

	function slug(value: string): string {
		return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	}
	function frameRef(value: string): string | undefined {
		const key = value.trim();
		if (views.has(key)) {
			return key;
		}
		const s = slug(key);
		return views.has(s) ? s : model.frames.find(frame => frame.name.toLowerCase() === key.toLowerCase())?.id;
	}
	function localRect(v: IView, selector: string): ILocalRect | undefined {
		if (v.rects.has(selector)) {
			return v.rects.get(selector) ?? undefined;
		}
		let rect: ILocalRect | null = null;
		const target = findTarget(v, selector);
		if (target) {
			const r = target.getBoundingClientRect();
			rect = { x: r.left, y: r.top, w: r.width, h: r.height };
		}
		v.rects.set(selector, rect);
		return rect ?? undefined;
	}
	function findTarget(v: IView, selector: string | undefined, text?: string): Element | undefined {
		const idoc = frameDoc(v);
		if (!idoc) {
			return undefined;
		}
		if (selector) {
			try {
				const found = idoc.querySelector(selector);
				if (found) {
					return found;
				}
			} catch {
				// not a valid selector
			}
		}
		if (text && text.length > 2) {
			const tag = selector ? /([a-z][a-z0-9-]*)(?=[.:#[]|$)/i.exec(selector.split('>').pop()?.trim() ?? '')?.[1] : undefined;
			const pool = idoc.body ? Array.from(idoc.body.querySelectorAll(tag || '*')) : [];
			return pool.find(node => (node.textContent ?? '').replace(/\s+/g, ' ').trim() === text) ?? undefined;
		}
		return undefined;
	}
	/** `data-next` hotspots in the frame, and the agent's links that start in it. */
	function collectTriggers(v: IView): void {
		const triggers: ITrigger[] = [];
		const idoc = frameDoc(v);
		if (idoc) {
			idoc.querySelectorAll('[data-next]').forEach(node => {
				for (const ref of (node.getAttribute('data-next') || '').split(/[\s,]+/)) {
					const to = ref ? frameRef(ref) : undefined;
					if (to && to !== v.frame.id) {
						const selector = selectorOf(node);
						triggers.push({ to, selector });
					}
				}
			});
		}
		for (const link of model.links) {
			if (link.from === v.frame.id && views.has(link.to) && !triggers.some(t => t.to === link.to && (!link.trigger || t.selector === link.trigger))) {
				triggers.push({ to: link.to, selector: link.trigger, label: link.label });
			}
		}
		v.triggers = triggers;
		requestRender();
	}
	function linkTriggers(): { v: IView; t: ITrigger }[] {
		const out: { v: IView; t: ITrigger }[] = [];
		for (const v of views.values()) {
			const known = v.loaded || !!v.frame.url || !!v.frame.image ? v.triggers : model.links.filter(link => link.from === v.frame.id).map(link => ({ to: link.to, selector: link.trigger, label: link.label }));
			for (const t of known) {
				if (views.has(t.to)) {
					out.push({ v, t });
				}
			}
		}
		return out;
	}

	function renderLinks(vw: number, vh: number): void {
		if (!state.flows) {
			links.replaceChildren();
			return;
		}
		let markup = '<defs><marker id="cv-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1.5 1.5 8 5 1.5 8.5" style="fill:none;stroke:var(--cv-accent);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round"/></marker></defs>';
		for (const { v, t } of linkTriggers()) {
			const target = views.get(t.to)!;
			const a = boxOf(v);
			const b = boxOf(target);
			const origin = screenOrigin(v);
			let start: IPoint;
			const rect = t.selector && v.loaded ? localRect(v, t.selector) : undefined;
			const right = b.x + b.w / 2 >= a.x + a.w / 2;
			if (rect) {
				const sy = clamp(origin.y + rect.y + rect.h / 2, a.y + 8, a.y + a.h - 8);
				start = { x: right ? Math.min(origin.x + rect.x + rect.w, a.x + a.w) : Math.max(origin.x + rect.x, a.x), y: sy };
			} else {
				start = { x: right ? a.x + a.w : a.x, y: a.y + Math.min(a.h / 2, 160) };
			}
			const endY = clamp(start.y, b.y + 36, b.y + b.h - 36);
			const end: IPoint = { x: right ? b.x - 6 / cam.z : b.x + b.w + 6 / cam.z, y: endY };
			const s = toScreen(start);
			const e = toScreen(end);
			if ((s.x < -400 && e.x < -400) || (s.x > vw + 400 && e.x > vw + 400) || (s.y < -400 && e.y < -400) || (s.y > vh + 400 && e.y > vh + 400)) {
				continue;
			}
			const dir = right ? 1 : -1;
			const bend = Math.max(40, Math.abs(e.x - s.x) * 0.45);
			markup += `<path class="cv-link" d="M${s.x.toFixed(1)} ${s.y.toFixed(1)}C${(s.x + dir * bend).toFixed(1)} ${s.y.toFixed(1)} ${(e.x - dir * bend).toFixed(1)} ${e.y.toFixed(1)} ${e.x.toFixed(1)} ${e.y.toFixed(1)}" marker-end="url(#cv-arrow)"/>`;
			markup += `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="3.2"/>`;
			if (t.label && cam.z > 0.18) {
				const esc = t.label.replace(/[&<>"]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
				markup += `<text x="${((s.x + e.x) / 2).toFixed(1)}" y="${((s.y + e.y) / 2 - 6).toFixed(1)}" text-anchor="middle">${esc}</text>`;
			}
		}
		links.innerHTML = markup;
	}

	/** Play: a hotspot (data-next, a linked trigger) flies to the frame it leads to. */
	function onFrameClick(v: IView, event: MouseEvent): void {
		if (state.tool !== 'play') {
			return;
		}
		const target = event.target as Element | null;
		if (!target?.closest) {
			return;
		}
		const next = target.closest('[data-next]');
		let to = next ? (next.getAttribute('data-next') || '').split(/[\s,]+/).map(frameRef).find(Boolean) : undefined;
		if (!to) {
			for (const link of model.links) {
				if (link.from === v.frame.id && link.trigger) {
					try {
						if (target.closest(link.trigger)) {
							to = link.to;
							break;
						}
					} catch {
						// invalid selector
					}
				}
			}
		}
		if (to && to !== v.frame.id) {
			event.preventDefault();
			playHistory.push(v.frame.id);
			syncTop();
			zoomToFrame(to, true);
			const target2 = views.get(to);
			if (target2) {
				win.setTimeout(() => refreshPulse(target2), 380);
			}
		}
	}
	function refreshPulse(v: IView): void {
		v.node.classList.remove('cv-pulse');
		void v.node.offsetWidth;
		v.node.classList.add('cv-pulse');
		win.setTimeout(() => v.node.classList.remove('cv-pulse'), 1200);
	}

	//#endregion

	//#region Camera

	let renderFrame = 0;
	function requestRender(): void {
		if (!renderFrame) {
			renderFrame = win.requestAnimationFrame(render);
		}
	}
	let movingTimer = 0;
	function moving(): void {
		root!.classList.add('moving');
		win.clearTimeout(movingTimer);
		movingTimer = win.setTimeout(() => root!.classList.remove('moving'), 160);
	}
	function setCamera(x: number, y: number, z: number): void {
		cam.x = x;
		cam.y = y;
		cam.z = clamp(z, MIN_Z, MAX_Z);
		moving();
		requestRender();
	}
	function zoomAt(z: number, clientX: number, clientY: number): void {
		const r = viewportRect();
		const px = clientX - r.left;
		const py = clientY - r.top;
		const next = clamp(z, MIN_Z, MAX_Z);
		const wx = (px - cam.x) / cam.z;
		const wy = (py - cam.y) / cam.z;
		stopFlight();
		setCamera(px - wx * next, py - wy * next, next);
	}
	function zoomBy(deltaY: number, clientX: number, clientY: number, deltaMode = 0): void {
		const delta = clamp(deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 100 : 1), -80, 80);
		zoomAt(cam.z * Math.exp(-delta * 0.011), clientX, clientY);
	}
	function zoomStep(factor: number): void {
		const r = viewportRect();
		const target = clamp(cam.z * factor, MIN_Z, MAX_Z);
		const cx = r.width / 2;
		const cy = r.height / 2;
		const wx = (cx - cam.x) / cam.z;
		const wy = (cy - cam.y) / cam.z;
		flyTo({ x: cx - wx * target, y: cy - wy * target, z: target }, 220);
	}
	function fitCamera(rect: IRect, padding: number, maxZ: number): { x: number; y: number; z: number } {
		const r = viewportRect();
		const top = 54;
		const bottom = 60;
		const w = Math.max(40, r.width - padding * 2);
		const h = Math.max(40, r.height - top - bottom - padding);
		const z = clamp(Math.min(w / Math.max(1, rect.w), h / Math.max(1, rect.h), maxZ), MIN_Z, MAX_Z);
		return { x: r.width / 2 - (rect.x + rect.w / 2) * z, y: top + (r.height - top - bottom) / 2 - (rect.y + rect.h / 2) * z, z };
	}
	let flight = 0;
	function stopFlight(): void {
		if (flight) {
			win.cancelAnimationFrame(flight);
			flight = 0;
		}
	}
	function flyTo(target: { x: number; y: number; z: number }, ms = 460): void {
		stopFlight();
		if (still || reduced || ms <= 0) {
			setCamera(target.x, target.y, target.z);
			return;
		}
		const r = viewportRect();
		const from = { ...cam };
		const fromCenter = { x: (r.width / 2 - from.x) / from.z, y: (r.height / 2 - from.y) / from.z };
		const toCenter = { x: (r.width / 2 - target.x) / target.z, y: (r.height / 2 - target.y) / target.z };
		const t0 = win.performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - t0) / ms);
			const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
			const z = Math.exp(Math.log(from.z) + (Math.log(target.z) - Math.log(from.z)) * k);
			const cx = fromCenter.x + (toCenter.x - fromCenter.x) * k;
			const cy = fromCenter.y + (toCenter.y - fromCenter.y) * k;
			setCamera(r.width / 2 - cx * z, r.height / 2 - cy * z, z);
			flight = t < 1 ? win.requestAnimationFrame(step) : 0;
			if (t >= 1) {
				setCamera(target.x, target.y, target.z);
			}
		};
		flight = win.requestAnimationFrame(step);
	}
	function fitAll(animate = true): void {
		const all = union(ordered().map(boxOf));
		if (all) {
			const target = fitCamera(all, inline ? 28 : 64, 1);
			if (animate) {
				flyTo(target);
			} else {
				setCamera(target.x, target.y, target.z);
			}
		}
	}
	function zoomToSelection(): void {
		const rect = union([...state.selected].map(id => views.get(id)).filter((v): v is IView => !!v).map(boxOf));
		if (rect) {
			flyTo(fitCamera(rect, inline ? 24 : 48, 2));
		} else {
			fitAll();
		}
	}
	function zoomToFrame(id: string, play = false): void {
		const v = views.get(id);
		if (v) {
			const b = boxOf(v);
			flyTo(fitCamera({ x: b.x, y: b.y - 24, w: b.w, h: b.h + 24 }, play ? 24 : 40, play ? 1.5 : 2));
		}
	}
	function gridStep(): number {
		let step = 24 * cam.z;
		while (step < 12) {
			step *= 4;
		}
		return step;
	}

	//#endregion

	//#region Render

	function render(): void {
		renderFrame = 0;
		world.style.transform = `translate(${cam.x}px,${cam.y}px) scale(${cam.z})`;
		const step = gridStep();
		viewport.style.backgroundSize = `${step}px ${step}px`;
		viewport.style.backgroundPosition = `${cam.x % step}px ${cam.y % step}px`;
		const r = viewportRect();
		const vw = r.width;
		const vh = r.height;
		const now = Date.now();
		for (const v of ordered()) {
			const b = boxOf(v);
			const s = toScreen(b);
			const sw = b.w * cam.z;
			const sh = b.h * cam.z;
			const visible = s.x < vw + 300 && s.y < vh + 300 && s.x + sw > -300 && s.y + sh > -300;
			if (visible) {
				v.seen = now;
				if (!v.loaded && !v.loading && sw > 36) {
					queueLoad(v);
				}
			}
			const showLabel = visible && sw > 44;
			v.label.hidden = !showLabel;
			if (showLabel) {
				v.label.style.transform = `translate(${s.x}px,${s.y - 24}px)`;
				v.label.style.maxWidth = `${Math.max(sw, 80)}px`;
				v.label.classList.toggle('sel', state.selected.has(v.frame.id));
				v.labelSize.textContent = sw > 150 ? `${v.frame.width} \u00d7 ${v.frame.height || 'auto'}` : '';
			}
			const showNote = visible && !!v.frame.note && sw > 130;
			v.note.hidden = !showNote;
			if (showNote) {
				v.note.style.transform = `translate(${s.x}px,${s.y + sh + 10}px)`;
				v.note.style.width = `${sw}px`;
			}
		}
		renderSections();
		renderLinks(vw, vh);
		renderSelection();
		renderPins(vw, vh);
		renderHover();
		renderMinimap();
		zoomLabel.textContent = `${Math.round(cam.z * 100)}%`;
		positionSelectionBar();
		positionPopover();
	}

	const sectionNodes = new Map<string, { box: HTMLElement; label: HTMLElement }>();
	function renderSections(): void {
		const groups = new Map<string, IRect[]>();
		for (const v of ordered()) {
			if (v.frame.section) {
				groups.set(v.frame.section, [...groups.get(v.frame.section) ?? [], boxOf(v)]);
			}
		}
		for (const [name, entry] of sectionNodes) {
			if (!groups.has(name)) {
				entry.box.remove();
				entry.label.remove();
				sectionNodes.delete(name);
			}
		}
		for (const [name, rects] of groups) {
			const bounds = union(rects)!;
			let entry = sectionNodes.get(name);
			if (!entry) {
				entry = { box: el('div', 'cv-section'), label: el('div', 'cv-section-label', name) };
				sectionsLayer.append(entry.box);
				labelsLayer.prepend(entry.label);
				sectionNodes.set(name, entry);
			}
			const pad = 48;
			const top = 72;
			Object.assign(entry.box.style, { transform: `translate(${bounds.x - pad}px,${bounds.y - top}px)`, width: `${bounds.w + pad * 2}px`, height: `${bounds.h + top + pad + 28}px` });
			const s = toScreen({ x: bounds.x - pad, y: bounds.y - top });
			entry.label.style.transform = `translate(${s.x + 16}px,${s.y + 14}px)`;
			entry.label.hidden = cam.z < 0.08;
		}
	}

	let handlePool: HTMLElement[] = [];
	function renderSelection(): void {
		selLayer.replaceChildren();
		handlePool = [];
		const hover = state.hoverFrame && !state.selected.has(state.hoverFrame) && state.tool === 'move' ? views.get(state.hoverFrame) : undefined;
		const draw = (v: IView, className: string) => {
			const b = boxOf(v);
			const s = toScreen(b);
			const node = el('div', className);
			Object.assign(node.style, { transform: `translate(${s.x - 1}px,${s.y - 1}px)`, width: `${b.w * cam.z + 2}px`, height: `${b.h * cam.z + 2}px` });
			selLayer.append(node);
			return { s, w: b.w * cam.z, h: b.h * cam.z };
		};
		if (hover) {
			draw(hover, 'cv-sel hover');
		}
		const selected = [...state.selected].map(id => views.get(id)).filter((v): v is IView => !!v);
		for (const v of selected) {
			draw(v, 'cv-sel');
		}
		if (selected.length === 1 && state.tool === 'move') {
			const v = selected[0];
			const c = chromeOf(v);
			const o = toScreen(screenOrigin(v));
			const w = v.frame.width * cam.z;
			const h = screenHeight(v) * cam.z;
			// Handles sit on the screen (what resizing changes), not the bezel.
			const points: [string, number, number][] = [['nw', 0, 0], ['n', w / 2, 0], ['ne', w, 0], ['e', w, h / 2], ['se', w, h], ['s', w / 2, h], ['sw', 0, h], ['w', 0, h / 2]];
			if (w > 24 && h > 24) {
				for (const [dir, x, y] of points) {
					const handle = el('div', 'cv-handle');
					handle.dataset.dir = dir;
					handle.style.transform = `translate(${o.x + x}px,${o.y + y}px)`;
					selLayer.append(handle);
					handlePool.push(handle);
				}
			}
			if (state.dragging || resizing) {
				const dim = el('div', 'cv-dim', `${v.frame.width} \u00d7 ${v.frame.height || Math.round(screenHeight(v))}`);
				dim.style.transform = `translate(${o.x + w / 2}px,${o.y + h + (c.b * cam.z) + 10}px) translateX(-50%)`;
				selLayer.append(dim);
			}
		}
	}

	//#endregion

	//#region Selection and moving

	function select(id: string | undefined, toggle = false): void {
		if (!id) {
			state.selected.clear();
		} else if (toggle) {
			if (state.selected.has(id)) {
				state.selected.delete(id);
			} else {
				state.selected.add(id);
			}
		} else if (!state.selected.has(id)) {
			state.selected.clear();
			state.selected.add(id);
		}
		syncSelectionBar();
		post('select', { frames: [...state.selected] });
		requestRender();
	}

	function layoutOf(ids?: Iterable<string>): ICanvasLayout[] {
		const wanted = ids ? new Set(ids) : undefined;
		return model.frames.filter(frame => !wanted || wanted.has(frame.id)).map(frame => ({ id: frame.id, x: frame.x ?? 0, y: frame.y ?? 0, width: frame.width, height: frame.height }));
	}
	function setGeometry(id: string, patch: Partial<Pick<ICanvasFrame, 'x' | 'y' | 'width' | 'height'>>, animate = false): void {
		const v = views.get(id);
		if (!v) {
			return;
		}
		v.frame = { ...v.frame, ...patch };
		model = { ...model, frames: model.frames.map(frame => frame.id === id ? v.frame : frame) };
		place(v, animate);
	}
	let layoutTimer = 0;
	const pendingLayout = new Set<string>();
	function sendLayout(ids: Iterable<string>): void {
		if (boot.pinned) {
			// An old version's frames are not the canvas's frames any more: moves stay in this view.
			return;
		}
		for (const id of ids) {
			pendingLayout.add(id);
		}
		win.clearTimeout(layoutTimer);
		layoutTimer = win.setTimeout(() => {
			post('layout', { frames: layoutOf(pendingLayout) });
			pendingLayout.clear();
		}, 220);
	}
	function pushUndo(before: ICanvasLayout[]): void {
		undoStack.push(before);
		if (undoStack.length > 80) {
			undoStack.shift();
		}
		redoStack.length = 0;
	}
	function restore(layout: ICanvasLayout[]): void {
		for (const entry of layout) {
			setGeometry(entry.id, { x: entry.x, y: entry.y, width: entry.width, height: entry.height }, true);
		}
		sendLayout(layout.map(entry => entry.id));
	}
	function undo(): void {
		const prev = undoStack.pop();
		if (prev) {
			redoStack.push(layoutOf(prev.map(entry => entry.id)));
			restore(prev);
		}
	}
	function redo(): void {
		const next = redoStack.pop();
		if (next) {
			undoStack.push(layoutOf(next.map(entry => entry.id)));
			restore(next);
		}
	}

	interface IDrag {
		readonly startX: number;
		readonly startY: number;
		moved: boolean;
		readonly onMove: (dx: number, dy: number, event: PointerEvent) => void;
		readonly onEnd: (moved: boolean, event: PointerEvent) => void;
	}
	let drag: IDrag | undefined;
	function beginDrag(event: PointerEvent, onMove: IDrag['onMove'], onEnd: IDrag['onEnd']): void {
		drag = { startX: event.clientX, startY: event.clientY, moved: false, onMove, onEnd };
		try {
			viewport.setPointerCapture(event.pointerId);
		} catch {
			// not capturable
		}
	}
	viewport.addEventListener('pointermove', event => {
		if (drag) {
			const dx = event.clientX - drag.startX;
			const dy = event.clientY - drag.startY;
			if (!drag.moved && Math.hypot(dx, dy) < 3) {
				return;
			}
			drag.moved = true;
			drag.onMove(dx, dy, event);
			return;
		}
		onHover(event);
	});
	const endDrag = (event: PointerEvent) => {
		const current = drag;
		drag = undefined;
		if (current) {
			current.onEnd(current.moved, event);
		}
	};
	viewport.addEventListener('pointerup', endDrag);
	viewport.addEventListener('pointercancel', endDrag);

	function startPan(event: PointerEvent): void {
		const from = { ...cam };
		stopFlight();
		root!.classList.add('panning');
		beginDrag(event, (dx, dy) => setCamera(from.x + dx, from.y + dy, from.z), () => root!.classList.remove('panning'));
	}

	function startMove(event: PointerEvent): void {
		const ids = [...state.selected];
		const starts = ids.map(id => views.get(id)).filter((v): v is IView => !!v).map(v => ({ v, x: v.frame.x ?? 0, y: v.frame.y ?? 0 }));
		if (!starts.length) {
			return;
		}
		const before = layoutOf(ids);
		const others = ordered().filter(v => !state.selected.has(v.frame.id)).map(boxOf);
		const bounds = union(starts.map(entry => boxOf(entry.v)))!;
		state.dragging = true;
		beginDrag(event, (dx, dy, ev) => {
			let wx = dx / cam.z;
			let wy = dy / cam.z;
			const guides: { x?: number; y?: number; from: number; to: number }[] = [];
			if (!ev.altKey) {
				const snapped = snap({ x: bounds.x + wx, y: bounds.y + wy, w: bounds.w, h: bounds.h }, others);
				wx += snapped.dx;
				wy += snapped.dy;
				guides.push(...snapped.guides);
			}
			for (const entry of starts) {
				setGeometry(entry.v.frame.id, { x: Math.round(entry.x + wx), y: Math.round(entry.y + wy) });
			}
			drawGuides(guides);
		}, moved => {
			state.dragging = false;
			drawGuides([]);
			if (moved) {
				pushUndo(before);
				sendLayout(ids);
			}
			requestRender();
		});
	}

	function snap(rect: IRect, others: readonly IRect[]): { dx: number; dy: number; guides: { x?: number; y?: number; from: number; to: number }[] } {
		const threshold = 7 / cam.z;
		let bestX: { d: number; at: number; o: IRect } | undefined;
		let bestY: { d: number; at: number; o: IRect } | undefined;
		const xs = [rect.x, rect.x + rect.w / 2, rect.x + rect.w];
		const ys = [rect.y, rect.y + rect.h / 2, rect.y + rect.h];
		for (const o of others) {
			for (const at of [o.x, o.x + o.w / 2, o.x + o.w]) {
				for (const x of xs) {
					const d = at - x;
					if (Math.abs(d) < threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) {
						bestX = { d, at, o };
					}
				}
			}
			for (const at of [o.y, o.y + o.h / 2, o.y + o.h]) {
				for (const y of ys) {
					const d = at - y;
					if (Math.abs(d) < threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) {
						bestY = { d, at, o };
					}
				}
			}
		}
		const guides: { x?: number; y?: number; from: number; to: number }[] = [];
		if (bestX) {
			guides.push({ x: bestX.at, from: Math.min(rect.y, bestX.o.y), to: Math.max(rect.y + rect.h, bestX.o.y + bestX.o.h) });
		}
		if (bestY) {
			guides.push({ y: bestY.at, from: Math.min(rect.x, bestY.o.x), to: Math.max(rect.x + rect.w, bestY.o.x + bestY.o.w) });
		}
		return { dx: bestX?.d ?? 0, dy: bestY?.d ?? 0, guides };
	}
	function drawGuides(guides: readonly { x?: number; y?: number; from: number; to: number }[]): void {
		guidesLayer.replaceChildren();
		for (const guide of guides) {
			const line = el('div', 'cv-guide');
			if (guide.x !== undefined) {
				const a = toScreen({ x: guide.x, y: guide.from });
				const b = toScreen({ x: guide.x, y: guide.to });
				Object.assign(line.style, { transform: `translate(${a.x}px,${a.y}px)`, width: '1px', height: `${b.y - a.y}px` });
			} else if (guide.y !== undefined) {
				const a = toScreen({ x: guide.from, y: guide.y });
				const b = toScreen({ x: guide.to, y: guide.y });
				Object.assign(line.style, { transform: `translate(${a.x}px,${a.y}px)`, width: `${b.x - a.x}px`, height: '1px' });
			}
			guidesLayer.append(line);
		}
	}

	let resizing = false;
	function startResize(event: PointerEvent, dir: string): void {
		const v = [...state.selected].map(id => views.get(id)).find((view): view is IView => !!view);
		if (!v) {
			return;
		}
		const start = { x: v.frame.x ?? 0, y: v.frame.y ?? 0, w: v.frame.width, h: screenHeight(v) };
		const ratio = start.w / Math.max(1, start.h);
		const before = layoutOf([v.frame.id]);
		resizing = true;
		beginDrag(event, (dx, dy, ev) => {
			let w = start.w;
			let h = start.h;
			const wx = dx / cam.z;
			const wy = dy / cam.z;
			if (dir.includes('e')) {
				w = start.w + wx;
			}
			if (dir.includes('w')) {
				w = start.w - wx;
			}
			if (dir.includes('s')) {
				h = start.h + wy;
			}
			if (dir.includes('n')) {
				h = start.h - wy;
			}
			if (ev.shiftKey) {
				if (dir === 'n' || dir === 's') {
					w = h * ratio;
				} else {
					h = w / ratio;
				}
			}
			w = Math.round(clamp(w, 120, 3840));
			h = Math.round(clamp(h, 80, 4000));
			const x = dir.includes('w') ? start.x + (start.w - w) : start.x;
			const y = dir.includes('n') ? start.y + (start.h - h) : start.y;
			setGeometry(v.frame.id, { x: Math.round(x), y: Math.round(y), width: w, height: dir === 'e' || dir === 'w' ? v.frame.height : h });
			measure(v);
		}, moved => {
			resizing = false;
			if (moved) {
				pushUndo(before);
				sendLayout([v.frame.id]);
			}
			requestRender();
		});
	}

	function startMarquee(event: PointerEvent): void {
		const from = toWorld(event.clientX, event.clientY);
		const base = event.shiftKey ? new Set(state.selected) : new Set<string>();
		beginDrag(event, (_dx, _dy, ev) => {
			const to = toWorld(ev.clientX, ev.clientY);
			const rect = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
			const s = toScreen(rect);
			marquee.hidden = false;
			Object.assign(marquee.style, { transform: `translate(${s.x}px,${s.y}px)`, width: `${rect.w * cam.z}px`, height: `${rect.h * cam.z}px` });
			state.selected = new Set(base);
			for (const v of ordered()) {
				const b = boxOf(v);
				if (b.x < rect.x + rect.w && b.x + b.w > rect.x && b.y < rect.y + rect.h && b.y + b.h > rect.y) {
					state.selected.add(v.frame.id);
				}
			}
			requestRender();
		}, moved => {
			marquee.hidden = true;
			if (!moved && !event.shiftKey) {
				select(undefined);
			} else {
				syncSelectionBar();
				post('select', { frames: [...state.selected] });
			}
			requestRender();
		});
	}

	//#endregion

	//#region Pointer and keyboard

	/**
	 * Inline, the canvas only takes the wheel (and keys) after a click in it, and shows that with a
	 * brighter outline; the chat scrolls over it until then. A click anywhere else gives it back.
	 */
	function engage(): void {
		if (!state.engaged) {
			state.engaged = true;
			hint.classList.remove('on');
			root!.classList.toggle('engaged', inline);
		}
	}
	function disengage(): void {
		if (inline && state.engaged) {
			state.engaged = false;
			root!.classList.remove('engaged');
		}
	}

	viewport.addEventListener('pointerdown', event => {
		engage();
		if (event.button === 2) {
			return;
		}
		const target = event.target as Element;
		if (target.closest('.cv-pin')) {
			return;
		}
		viewport.focus({ preventScroll: true });
		if (event.button === 1 || state.space || state.tool === 'hand') {
			event.preventDefault();
			startPan(event);
			return;
		}
		const handle = target.closest('.cv-handle') as HTMLElement | null;
		if (handle && state.tool === 'move') {
			startResize(event, handle.dataset.dir ?? 'se');
			return;
		}
		const p = toWorld(event.clientX, event.clientY);
		const hit = hitFrame(p);
		if (state.tool === 'comment') {
			if (hit) {
				startComment(event, hit);
			} else {
				closePopover();
				startPan(event);
			}
			return;
		}
		if (state.tool === 'play') {
			startPan(event);
			return;
		}
		if (hit) {
			if (event.shiftKey) {
				select(hit.frame.id, true);
				return;
			}
			select(hit.frame.id);
			startMove(event);
		} else {
			startMarquee(event);
		}
	});

	viewport.addEventListener('dblclick', event => {
		if (state.tool !== 'move') {
			return;
		}
		const hit = hitFrame(toWorld(event.clientX, event.clientY));
		if (hit) {
			zoomToFrame(hit.frame.id);
		}
	});

	viewport.addEventListener('wheel', event => {
		const zoom = event.ctrlKey || event.metaKey;
		if (!zoom && inline && !state.engaged) {
			// The chat scrolls; say once how to pan the canvas instead.
			if (!scrollHinted && root.matches(':hover')) {
				scrollHinted = true;
				showHint(S.scrollHint, 2400);
			}
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		stopFlight();
		if (zoom) {
			zoomBy(event.deltaY, event.clientX, event.clientY, event.deltaMode);
			return;
		}
		const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
		const dx = (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * scale;
		const dy = (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * scale;
		setCamera(cam.x - dx, cam.y - dy, cam.z);
	}, { passive: false });

	root.addEventListener('pointerleave', () => {
		lastPointer = undefined;
		state.hoverFrame = undefined;
		showHover(false);
		requestRender();
	});
	win.addEventListener('blur', () => {
		state.space = false;
		root.classList.remove('space');
		// Focus that went into a screen (Play) is still in the canvas.
		win.setTimeout(() => {
			if (!doc.hasFocus()) {
				disengage();
			}
		}, 0);
	});

	function onHover(event: PointerEvent): void {
		// Over a pin, a popover or a label the highlight would sit under what the pointer is on.
		const over = (event.target as Element | null)?.closest?.('.cv-pin, .cv-pop, .cv-label, .cv-top, .cv-toolbar, .cv-minimap, .cv-selbar, .cv-tray');
		lastPointer = over ? undefined : { x: event.clientX, y: event.clientY };
		const hit = over ? undefined : hitFrame(toWorld(event.clientX, event.clientY));
		const id = hit?.frame.id;
		if (id !== state.hoverFrame) {
			state.hoverFrame = id;
			requestRender();
		}
		placeHover();
	}

	let hoverShown = false;
	function showHover(on: boolean): void {
		if (on !== hoverShown) {
			hoverShown = on;
			hoverBox.classList.toggle('on', on);
		}
	}
	/** Comment mode: outlines the element under the pointer, and says which it is. */
	function placeHover(): void {
		const hit = lastPointer && state.tool === 'comment' && !popover && !drag ? hitFrame(toWorld(lastPointer.x, lastPointer.y)) : undefined;
		const picked = hit && lastPointer ? pick(hit, lastPointer.x, lastPointer.y) : undefined;
		if (!hit || !picked?.rect) {
			showHover(false);
			return;
		}
		const o = toScreen(screenOrigin(hit));
		Object.assign(hoverBox.style, { translate: `${o.x + picked.rect.x * cam.z}px ${o.y + picked.rect.y * cam.z}px`, width: `${picked.rect.w * cam.z}px`, height: `${picked.rect.h * cam.z}px` });
		const label = picked.anchor.element ?? hit.frame.name;
		if (hoverTag.textContent !== label) {
			hoverTag.textContent = label;
		}
		showHover(true);
	}
	function renderHover(): void {
		if (hoverShown) {
			placeHover();
		}
	}

	doc.addEventListener('keydown', event => {
		if (typing(event.target)) {
			return;
		}
		if (inline && !state.engaged && !root.contains(doc.activeElement)) {
			return;
		}
		const mod = event.metaKey || event.ctrlKey;
		const key = event.key.toLowerCase();
		if (key === ' ' && !mod) {
			if (!state.space) {
				state.space = true;
				root.classList.add('space');
			}
			event.preventDefault();
			return;
		}
		if (mod && key === 'z') {
			event.preventDefault();
			if (event.shiftKey) {
				redo();
			} else {
				undo();
			}
			return;
		}
		if (mod && (key === '=' || key === '+')) {
			event.preventDefault();
			zoomStep(1.25);
			return;
		}
		if (mod && key === '-') {
			event.preventDefault();
			zoomStep(0.8);
			return;
		}
		if (mod && key === '0') {
			event.preventDefault();
			zoomStep(1 / cam.z);
			return;
		}
		if (mod && key === 'a') {
			event.preventDefault();
			state.selected = new Set(views.keys());
			syncSelectionBar();
			post('select', { frames: [...state.selected] });
			requestRender();
			return;
		}
		if (mod && key === 'enter') {
			event.preventDefault();
			sendAll();
			return;
		}
		if (mod || event.altKey) {
			return;
		}
		if (event.shiftKey && (event.code === 'Digit1' || key === '!')) {
			fitAll();
			return;
		}
		if (event.shiftKey && (event.code === 'Digit2' || key === '@')) {
			zoomToSelection();
			return;
		}
		if (event.shiftKey && (event.code === 'Digit0' || key === ')')) {
			zoomStep(1 / cam.z);
			return;
		}
		switch (key) {
			case 'v': setTool('move'); return;
			case 'h': setTool('hand'); return;
			case 'c': setTool('comment'); return;
			case 'p': setTool(state.tool === 'play' ? 'move' : 'play'); return;
			case 'f': fitAll(); return;
			case '=': case '+': zoomStep(1.25); return;
			case '-': case '_': zoomStep(0.8); return;
			case 'escape':
				if (popover) {
					closePopover();
				} else if (state.tool !== 'move') {
					setTool('move');
				} else {
					select(undefined);
				}
				return;
		}
		if (key.startsWith('arrow') && state.selected.size && state.tool === 'move') {
			event.preventDefault();
			const step = event.shiftKey ? 10 : 1;
			const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
			const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
			const ids = [...state.selected];
			pushUndo(layoutOf(ids));
			for (const id of ids) {
				const v = views.get(id);
				if (v) {
					setGeometry(id, { x: (v.frame.x ?? 0) + dx, y: (v.frame.y ?? 0) + dy });
				}
			}
			sendLayout(ids);
		}
	});
	doc.addEventListener('keyup', event => {
		if (event.key === ' ') {
			state.space = false;
			root.classList.remove('space');
		}
	});

	function setTool(tool: Tool): void {
		if (state.tool === tool) {
			return;
		}
		if (state.tool === 'play') {
			playHistory.length = 0;
		}
		state.tool = tool;
		root!.classList.remove('tool-move', 'tool-hand', 'tool-comment', 'tool-play');
		root!.classList.add(`tool-${tool}`);
		showHover(false);
		if (tool !== 'comment' && popover?.draft) {
			closePopover();
		}
		for (const [name, node] of toolButtons) {
			node.setAttribute('aria-pressed', String(name === tool));
		}
		playButton.setAttribute('aria-pressed', String(tool === 'play'));
		if (tool === 'comment') {
			showHint(S.commentModeHint, 2600);
		} else if (tool === 'play') {
			showHint(S.playHint, 2600);
		}
		syncTop();
		syncSelectionBar();
		requestRender();
	}

	//#endregion

	//#region Picking elements inside frames

	function describe(node: Element): string {
		const classes = Array.from(node.classList).slice(0, 2).map(name => `.${name}`).join('');
		const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
		return `${node.localName}${node.id ? `#${node.id}` : classes}${text ? ` "${text.length > 28 ? `${text.slice(0, 28)}\u2026` : text}"` : ''}`;
	}
	function selectorOf(node: Element): string {
		const parts: string[] = [];
		let current: Element | null = node;
		const owner = node.ownerDocument;
		while (current && current.localName !== 'body' && current.localName !== 'html' && parts.length < 8) {
			if (current.id && /^[A-Za-z][\w-]*$/.test(current.id)) {
				parts.unshift(`#${current.id}`);
				break;
			}
			let part = current.localName;
			const classes = Array.from(current.classList).filter(name => /^[A-Za-z_-][\w-]*$/.test(name)).slice(0, 2);
			if (classes.length) {
				part += `.${classes.join('.')}`;
			}
			const parent: Element | null = current.parentElement;
			if (parent) {
				const sameTag = Array.from(parent.children).filter(child => child.localName === current!.localName);
				let matching = sameTag;
				try {
					matching = sameTag.filter(child => child.matches(part));
				} catch {
					// keep the tag list
				}
				if (matching.length > 1) {
					part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
				}
			}
			parts.unshift(part);
			try {
				if (owner.querySelectorAll(parts.join(' > ')).length === 1) {
					return parts.join(' > ');
				}
			} catch {
				// keep going up
			}
			current = parent;
		}
		return parts.join(' > ');
	}
	function anchorFor(v: IView, node: Element, lx: number, ly: number): { anchor: ICanvasAnchor; rect: ILocalRect } {
		const idoc = node.ownerDocument;
		const r = node.getBoundingClientRect();
		const sx = idoc.defaultView?.scrollX ?? 0;
		const sy = idoc.defaultView?.scrollY ?? 0;
		const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
		return {
			anchor: {
				frame: v.frame.id,
				selector: selectorOf(node),
				element: describe(node),
				...(text ? { text: text.slice(0, 200) } : {}),
				html: node.outerHTML.replace(/\s+/g, ' ').slice(0, 900),
				x: Math.round(lx + sx),
				y: Math.round(ly + sy),
				fx: r.width ? clamp((lx - r.left) / r.width, 0, 1) : 0,
				fy: r.height ? clamp((ly - r.top) / r.height, 0, 1) : 0,
			},
			rect: { x: r.left, y: r.top, w: r.width, h: r.height },
		};
	}
	/** The element of `v` under a client point, or the spot when the frame is not readable. */
	function pick(v: IView, clientX: number, clientY: number): { anchor: ICanvasAnchor; rect?: ILocalRect; node?: Element } | undefined {
		const content = v.content as HTMLElement | undefined;
		if (!content) {
			return undefined;
		}
		const r = content.getBoundingClientRect();
		const lx = (clientX - r.left) / cam.z;
		const ly = (clientY - r.top) / cam.z;
		const idoc = frameDoc(v);
		const node = idoc?.elementFromPoint(lx, ly);
		if (!idoc || !node || node === idoc.documentElement || node === idoc.body) {
			const sx = idoc?.defaultView?.scrollX ?? 0;
			const sy = idoc?.defaultView?.scrollY ?? 0;
			return { anchor: { frame: v.frame.id, x: Math.round(lx + sx), y: Math.round(ly + sy) } };
		}
		const found = anchorFor(v, node, lx, ly);
		return { ...found, node };
	}

	//#endregion

	//#region Comments

	interface IPopover {
		readonly node: HTMLElement;
		/** World point it hangs from. */
		readonly at: () => IPoint | undefined;
		readonly draft: boolean;
		readonly comment?: string;
		readonly cleanup: () => void;
	}
	let popover: IPopover | undefined;
	let pendingPin: { anchor: ICanvasAnchor } | undefined;
	const pinNodes = new Map<string, HTMLElement>();
	let nonceSeq = 0;

	function startComment(event: PointerEvent, v: IView): void {
		closePopover();
		const content = v.content as HTMLElement | undefined;
		const startClient = { x: event.clientX, y: event.clientY };
		beginDrag(event, (_dx, _dy, ev) => {
			if (!content) {
				return;
			}
			const r = content.getBoundingClientRect();
			const vr = viewportRect();
			const x1 = clamp(Math.min(startClient.x, ev.clientX), r.left, r.right);
			const y1 = clamp(Math.min(startClient.y, ev.clientY), r.top, r.bottom);
			const x2 = clamp(Math.max(startClient.x, ev.clientX), r.left, r.right);
			const y2 = clamp(Math.max(startClient.y, ev.clientY), r.top, r.bottom);
			regionBox.hidden = false;
			showHover(false);
			Object.assign(regionBox.style, { transform: `translate(${x1 - vr.left}px,${y1 - vr.top}px)`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
		}, (moved, ev) => {
			regionBox.hidden = true;
			if (!content) {
				return;
			}
			if (moved) {
				const r = content.getBoundingClientRect();
				const idoc = frameDoc(v);
				const sx = idoc?.defaultView?.scrollX ?? 0;
				const sy = idoc?.defaultView?.scrollY ?? 0;
				const x1 = (clamp(Math.min(startClient.x, ev.clientX), r.left, r.right) - r.left) / cam.z;
				const y1 = (clamp(Math.min(startClient.y, ev.clientY), r.top, r.bottom) - r.top) / cam.z;
				const x2 = (clamp(Math.max(startClient.x, ev.clientX), r.left, r.right) - r.left) / cam.z;
				const y2 = (clamp(Math.max(startClient.y, ev.clientY), r.top, r.bottom) - r.top) / cam.z;
				if (x2 - x1 > 6 && y2 - y1 > 6) {
					openComposer({ frame: v.frame.id, x: Math.round(x1 + sx), y: Math.round(y1 + sy), w: Math.round(x2 - x1), h: Math.round(y2 - y1) }, undefined);
					return;
				}
			}
			const picked = pick(v, startClient.x, startClient.y);
			if (picked) {
				openComposer(picked.anchor, picked.node);
			}
		});
	}

	/** Where a comment's pin sits, in world coordinates, and whether its element is gone. */
	function anchorPoint(anchor: ICanvasAnchor): { p: IPoint; outdated: boolean } | undefined {
		const v = views.get(anchor.frame);
		if (!v) {
			return undefined;
		}
		const origin = screenOrigin(v);
		const h = screenHeight(v);
		let lx: number;
		let ly: number;
		let outdated = false;
		const idoc = frameDoc(v);
		if (anchor.w && anchor.h) {
			lx = anchor.x + anchor.w - (idoc?.defaultView?.scrollX ?? 0);
			ly = anchor.y - (idoc?.defaultView?.scrollY ?? 0);
		} else if (anchor.selector && v.loaded && idoc) {
			const key = `${anchor.selector}\u0001${anchor.text ?? ''}`;
			let rect = v.rects.get(key);
			if (rect === undefined) {
				const target = findTarget(v, anchor.selector, anchor.text);
				const r = target?.getBoundingClientRect();
				rect = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
				v.rects.set(key, rect);
			}
			if (rect) {
				lx = rect.x + (anchor.fx ?? 0) * rect.w;
				ly = rect.y + (anchor.fy ?? 0) * rect.h;
			} else {
				outdated = true;
				lx = anchor.x - (idoc.defaultView?.scrollX ?? 0);
				ly = anchor.y - (idoc.defaultView?.scrollY ?? 0);
			}
		} else {
			lx = anchor.x - (idoc?.defaultView?.scrollX ?? 0);
			ly = anchor.y - (idoc?.defaultView?.scrollY ?? 0);
		}
		return { p: { x: origin.x + clamp(lx, 0, v.frame.width), y: origin.y + clamp(ly, 0, h) }, outdated };
	}

	function visibleComments(): ICanvasComment[] {
		return model.comments.filter(comment => !comment.archived && views.has(comment.anchor.frame) && (state.showResolved || comment.status !== 'resolved'));
	}
	function commentNumber(id: string): number {
		return model.comments.findIndex(comment => comment.id === id) + 1;
	}
	function pinClass(comment: ICanvasComment, outdated: boolean): string {
		return `cv-pin${comment.author === 'agent' ? ' agent' : ''}${comment.status === 'sent' ? ' sent' : ''}${comment.status === 'resolved' ? ' resolved' : ''}${outdated ? ' outdated' : ''}${popover?.comment === comment.id ? ' open' : ''}`;
	}

	/** Same spot, same pin: a draft's pin becomes the saved comment's, and the store's id swap keeps it. */
	function anchorKey(anchor: ICanvasAnchor): string {
		return [anchor.frame, anchor.selector ?? '', anchor.x, anchor.y, anchor.w ?? '', anchor.h ?? ''].join('\u0001');
	}
	function pinNode(id: string, key: string, wanted: ReadonlySet<string>): HTMLElement {
		let node = pinNodes.get(id);
		if (node) {
			return node;
		}
		for (const [other, existing] of pinNodes) {
			if (!wanted.has(other) && existing.dataset.key === key) {
				pinNodes.delete(other);
				pinNodes.set(id, existing);
				return existing;
			}
		}
		node = el('div');
		node.addEventListener('pointerdown', event => event.stopPropagation());
		node.addEventListener('click', event => {
			event.stopPropagation();
			const open = [...pinNodes].find(([, other]) => other === node)?.[0];
			if (open && open !== 'pending') {
				openThread(open);
			}
		});
		pinsLayer.append(node);
		pinNodes.set(id, node);
		return node;
	}

	function renderPins(vw: number, vh: number): void {
		const comments = visibleComments();
		const wanted = new Set(comments.map(comment => comment.id));
		if (pendingPin) {
			wanted.add('pending');
		}
		for (const comment of comments) {
			const at = anchorPoint(comment.anchor);
			if (!at) {
				wanted.delete(comment.id);
				continue;
			}
			const s = toScreen(at.p);
			const node = pinNode(comment.id, anchorKey(comment.anchor), wanted);
			node.dataset.key = anchorKey(comment.anchor);
			const className = pinClass(comment, at.outdated);
			if (node.className !== className) {
				node.className = className;
			}
			const glyph = comment.author === 'agent' ? 'sparkle' : comment.status === 'resolved' ? 'check' : String(commentNumber(comment.id));
			if (node.dataset.glyph !== glyph) {
				node.dataset.glyph = glyph;
				if (ICONS[glyph]) {
					node.innerHTML = ICONS[glyph];
				} else {
					node.textContent = glyph;
				}
			}
			node.setAttribute('aria-label', `${comment.author === 'agent' ? S.agent : S.you}: ${comment.text}`);
			// visibility, not [hidden]: display:none would replay the pop-in each time it scrolls back into view.
			node.style.visibility = s.x < -30 || s.y < -30 || s.x > vw + 30 || s.y > vh + 30 || cam.z < 0.06 ? 'hidden' : '';
			node.style.translate = `${s.x}px ${s.y - 26}px`;
		}
		if (pendingPin) {
			const at = anchorPoint(pendingPin.anchor);
			if (at) {
				const node = pinNode('pending', anchorKey(pendingPin.anchor), wanted);
				node.dataset.key = anchorKey(pendingPin.anchor);
				if (node.className !== 'cv-pin pending') {
					node.className = 'cv-pin pending';
				}
				if (node.dataset.glyph !== 'plus') {
					node.dataset.glyph = 'plus';
					node.innerHTML = ICONS.plus;
				}
				const s = toScreen(at.p);
				node.style.translate = `${s.x}px ${s.y - 26}px`;
			}
		}
		for (const [id, node] of [...pinNodes]) {
			if (!wanted.has(id)) {
				pinNodes.delete(id);
				// Kept a moment for a comment saved from this draft (or the store's copy) to take over.
				if (still || reduced) {
					node.remove();
				} else {
					node.classList.add('cv-out');
					win.setTimeout(() => {
						if (![...pinNodes.values()].includes(node)) {
							node.remove();
						}
					}, 200);
				}
			}
		}
	}

	function closePopover(): void {
		const current = popover;
		popover = undefined;
		pendingPin = undefined;
		current?.cleanup();
		current?.node.remove();
		requestRender();
	}
	function positionPopover(): void {
		if (!popover) {
			return;
		}
		const at = popover.at();
		if (!at) {
			return;
		}
		const s = toScreen(at);
		const vr = viewportRect();
		const node = popover.node;
		const w = node.offsetWidth || 316;
		const h = node.offsetHeight || 160;
		let x = s.x + 18;
		let y = s.y - 20;
		if (x + w > vr.width - 10) {
			x = s.x - w - 18;
		}
		x = clamp(x, 10, Math.max(10, vr.width - w - 10));
		y = clamp(y, 50, Math.max(50, vr.height - h - 10));
		node.style.transform = `translate(${x}px,${y}px)`;
	}

	function anchorChip(anchor: ICanvasAnchor): string {
		const v = views.get(anchor.frame);
		if (anchor.element) {
			return anchor.element;
		}
		if (anchor.w && anchor.h) {
			return fmt(S.region, `${Math.round(anchor.w)}\u00d7${Math.round(anchor.h)}`);
		}
		return v?.frame.name ?? anchor.frame;
	}
	function anchorLabel(anchor: ICanvasAnchor): string {
		const v = views.get(anchor.frame);
		return `${v?.frame.name ?? anchor.frame} \u203a ${anchorChip(anchor)}`;
	}

	function autoGrow(area: HTMLTextAreaElement): void {
		area.style.height = 'auto';
		area.style.height = `${Math.min(220, area.scrollHeight + 2)}px`;
	}

	/** A new comment on `anchor`: text, optional style tweaks on the element, Add (queue) or Send now. */
	function openComposer(initial: ICanvasAnchor, node: Element | undefined): void {
		closePopover();
		let anchor = initial;
		let target = node;
		pendingPin = { anchor };
		const box = el('div', 'cv-pop cv-glass');
		const head = el('div', 'cv-pop-head');
		const chip = el('span', 'cv-chip', anchorChip(anchor));
		chip.title = anchor.selector ?? '';
		head.append(chip);
		const parentButton = button(S.parent, 'up', () => {
			const parent = target?.parentElement;
			const v = views.get(anchor.frame);
			if (!parent || !v || parent.localName === 'body' || parent.localName === 'html') {
				return;
			}
			revertTweaks();
			target = parent;
			const r = parent.getBoundingClientRect();
			anchor = anchorFor(v, parent, r.left + r.width / 2, r.top + 4).anchor;
			pendingPin = { anchor };
			chip.textContent = anchorChip(anchor);
			chip.title = anchor.selector ?? '';
			buildTweaks();
			requestRender();
		});
		parentButton.hidden = !target;
		head.append(parentButton, button(S.close, 'close', () => {
			revertTweaks();
			closePopover();
		}));
		const area = el('textarea');
		area.placeholder = S.addComment;
		area.rows = 2;
		area.addEventListener('input', () => autoGrow(area));
		const tweaksWrap = el('div');
		const tweaks = new Map<string, ICanvasTweak>();
		const originals = new Map<string, string>();
		const revertTweaks = () => {
			const element = target as HTMLElement | undefined;
			if (element) {
				for (const [property, before] of originals) {
					if (property === 'text') {
						element.textContent = before;
					} else {
						element.style.removeProperty(property);
					}
				}
			}
			tweaks.clear();
			originals.clear();
		};
		const buildTweaks = () => {
			tweaksWrap.replaceChildren();
			const element = target as HTMLElement | undefined;
			if (!element || !element.ownerDocument.defaultView) {
				styleToggle.hidden = true;
				return;
			}
			styleToggle.hidden = false;
			if (styleToggle.getAttribute('aria-pressed') !== 'true') {
				return;
			}
			tweaksWrap.append(tweakEditor(element, tweaks, originals));
			positionPopover();
		};
		const styleToggle = button(S.style, 'style', () => {
			styleToggle.setAttribute('aria-pressed', String(styleToggle.getAttribute('aria-pressed') !== 'true'));
			buildTweaks();
		}, '', true);
		styleToggle.setAttribute('aria-pressed', 'false');
		const actions = el('div', 'cv-pop-row');
		const save = (send: boolean) => {
			const text = area.value.trim();
			if (!text && !tweaks.size) {
				area.focus();
				return;
			}
			const nonce = `n${Date.now().toString(36)}${nonceSeq++}`;
			const comment: ICanvasComment = { id: `pending-${nonce}`, anchor, text, status: 'open', author: 'user', at: Date.now(), ...(tweaks.size ? { tweaks: [...tweaks.values()] } : {}) };
			model = { ...model, comments: [...model.comments, hosted ? comment : { ...comment, id: `c${model.comments.length + 1}` }] };
			post('comment', { comment: { anchor, text, ...(tweaks.size ? { tweaks: [...tweaks.values()] } : {}) }, nonce, send });
			tweaks.clear();
			originals.clear();
			closePopover();
			syncComments();
		};
		actions.append(
			button(S.askInChat, 'chat', () => {
				post('prompt', { text: fmt(S.askPrompt, anchorLabel(anchor), model.title), anchor });
				revertTweaks();
				closePopover();
			}),
			button(S.nextScreen, 'next', () => {
				post('prompt', { text: fmt(S.nextScreenPrompt, model.title, anchorLabel(anchor)), anchor });
				revertTweaks();
				closePopover();
			}),
			styleToggle,
			el('span', 'cv-grow'),
			button(S.add, undefined, () => save(false), '', true),
			button(S.sendNow, 'send', () => save(true), 'primary', true),
		);
		area.addEventListener('keydown', event => {
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				save(true);
			} else if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				save(false);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				revertTweaks();
				closePopover();
			}
		});
		box.append(head, area, tweaksWrap, actions, el('div', 'cv-pop-hint', S.commentHint));
		box.addEventListener('pointerdown', event => event.stopPropagation());
		box.addEventListener('wheel', event => event.stopPropagation());
		stage.append(box);
		// Dismissed any way (Esc, Close, a click elsewhere): unsaved style tweaks go back.
		popover = { node: box, at: () => anchorPoint(anchor)?.p, draft: true, cleanup: revertTweaks };
		buildTweaks();
		positionPopover();
		requestRender();
		win.setTimeout(() => area.focus(), 0);
	}

	function colorHex(value: string): string | undefined {
		const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i.exec(value);
		if (!m || (m[4] !== undefined && Number(m[4]) === 0)) {
			return undefined;
		}
		return `#${[m[1], m[2], m[3]].map(n => Math.round(Number(n)).toString(16).padStart(2, '0')).join('')}`;
	}

	/** Live style edits on the picked element; each change is recorded for the agent. */
	function tweakEditor(element: HTMLElement, tweaks: Map<string, ICanvasTweak>, originals: Map<string, string>): HTMLElement {
		const grid = el('div', 'cv-tweaks');
		const computed = element.ownerDocument.defaultView!.getComputedStyle(element);
		const record = (property: string, value: string, before: string) => {
			if (!originals.has(property)) {
				originals.set(property, property === 'text' ? before : element.style.getPropertyValue(property));
			}
			if (property === 'text') {
				element.textContent = value;
			} else {
				element.style.setProperty(property, value);
			}
			tweaks.set(property, { property, value, before });
			const v = views.get(model.frames.find(frame => frameDoc(views.get(frame.id)!) === element.ownerDocument)?.id ?? '');
			v?.rects.clear();
			requestRender();
		};
		const row = (label: string, field: HTMLElement) => {
			grid.append(el('label', undefined, label), field);
		};
		if (!element.children.length && (element.textContent ?? '').trim() && (element.textContent ?? '').length < 300) {
			const input = el('input');
			input.type = 'text';
			const before = element.textContent ?? '';
			input.value = before.trim();
			input.addEventListener('input', () => record('text', input.value, before.trim()));
			const wrap = el('div', 'cv-field');
			wrap.append(input);
			row(S.text, wrap);
		}
		for (const [property, label] of [['color', S.color], ['background-color', S.background]] as const) {
			const before = computed.getPropertyValue(property);
			const wrap = el('div', 'cv-field');
			const swatch = el('input');
			swatch.type = 'color';
			swatch.value = colorHex(before) ?? '#000000';
			const textField = el('input');
			textField.type = 'text';
			textField.value = colorHex(before) ?? before;
			swatch.addEventListener('input', () => {
				textField.value = swatch.value;
				record(property, swatch.value, before);
			});
			textField.addEventListener('change', () => record(property, textField.value.trim(), before));
			wrap.append(swatch, textField);
			row(label, wrap);
		}
		for (const [property, label] of [['font-size', S.fontSize], ['border-radius', S.radius], ['padding', S.padding]] as const) {
			const before = computed.getPropertyValue(property);
			const input = el('input');
			input.type = 'text';
			input.value = before;
			input.addEventListener('change', () => record(property, input.value.trim(), before));
			const wrap = el('div', 'cv-field');
			wrap.append(input);
			row(label, wrap);
		}
		{
			const before = computed.getPropertyValue('font-weight');
			const selectNode = el('select');
			for (const weight of ['300', '400', '500', '600', '700', '800']) {
				const option = el('option', undefined, weight);
				option.value = weight;
				selectNode.append(option);
			}
			selectNode.value = String(Math.round(Number(before) / 100) * 100 || 400);
			selectNode.addEventListener('change', () => record('font-weight', selectNode.value, before));
			const wrap = el('div', 'cv-field');
			wrap.append(selectNode);
			row(S.fontWeight, wrap);
		}
		return grid;
	}

	/** Re-applies tweaks the user has not had applied yet, after a frame (re)loads. */
	function applyTweaks(v: IView): void {
		for (const comment of model.comments) {
			if (comment.anchor.frame !== v.frame.id || comment.status === 'resolved' || !comment.tweaks?.length) {
				continue;
			}
			const target = findTarget(v, comment.anchor.selector, comment.anchor.text) as HTMLElement | undefined;
			if (!target) {
				continue;
			}
			for (const tweak of comment.tweaks) {
				if (tweak.property === 'text') {
					target.textContent = tweak.value;
				} else {
					target.style.setProperty(tweak.property, tweak.value);
				}
			}
		}
	}

	/** An existing comment: its thread (the user's text, the agent's reply), resolve, delete, send. */
	function openThread(id: string): void {
		const comment = model.comments.find(other => other.id === id);
		if (!comment) {
			return;
		}
		closePopover();
		const box = el('div', 'cv-pop cv-glass');
		const head = el('div', 'cv-pop-head');
		const chip = el('span', 'cv-chip', anchorLabel(comment.anchor));
		chip.title = comment.anchor.selector ?? '';
		head.append(chip, button(S.close, 'close', () => closePopover()));
		const thread = el('div', 'cv-thread');
		const message = (who: 'user' | 'agent', text: string, status?: string) => {
			const row = el('div', 'cv-msg');
			const avatar = el('span', `cv-avatar${who === 'agent' ? ' agent' : ''}`);
			if (who === 'agent') {
				avatar.innerHTML = ICONS.sparkle;
			} else {
				avatar.textContent = String(commentNumber(comment.id));
			}
			const body = el('div', 'cv-msg-body');
			const whoRow = el('div', 'cv-msg-who', who === 'agent' ? S.agent : S.you);
			if (status) {
				whoRow.append(el('span', 'cv-badge', status));
			}
			body.append(whoRow, el('div', 'cv-msg-text', text));
			row.append(avatar, body);
			thread.append(row);
		};
		message(comment.author, comment.text || (comment.tweaks ?? []).map(t => `${t.property}: ${t.value}`).join('\n'), comment.status === 'sent' ? S.sent : comment.status === 'resolved' ? S.resolved : undefined);
		if (comment.tweaks?.length && comment.text) {
			message('user', comment.tweaks.map(t => `${t.property}: ${t.value}`).join('\n'));
		}
		if (comment.reply) {
			message('agent', comment.reply);
		}
		const actions = el('div', 'cv-pop-row');
		actions.append(
			button(S.remove, 'trash', () => {
				post('comment-delete', { comment: comment.id });
				model = { ...model, comments: model.comments.filter(other => other.id !== comment.id) };
				closePopover();
				syncComments();
			}),
			button(S.askInChat, 'chat', () => {
				post('prompt', { text: fmt(S.askPrompt, anchorLabel(comment.anchor), model.title), anchor: comment.anchor });
				closePopover();
			}),
			el('span', 'cv-grow'),
		);
		if (comment.status === 'resolved') {
			actions.append(button(S.reopen, undefined, () => setStatus(comment.id, 'open'), '', true));
		} else {
			actions.append(button(S.resolve, 'check', () => setStatus(comment.id, 'resolved'), '', true));
			if (comment.status === 'open' && comment.author === 'user') {
				actions.append(button(S.sendNow, 'send', () => {
					post('send', { comments: [comment.id] });
					closePopover();
				}, 'primary', true));
			}
		}
		box.append(head, thread, actions);
		box.addEventListener('pointerdown', event => event.stopPropagation());
		box.addEventListener('wheel', event => event.stopPropagation());
		stage.append(box);
		popover = { node: box, at: () => anchorPoint(comment.anchor)?.p, draft: false, comment: comment.id, cleanup: () => undefined };
		positionPopover();
		post('thread', { comment: comment.id });
		requestRender();
	}

	function setStatus(id: string, status: 'open' | 'resolved'): void {
		model = { ...model, comments: model.comments.map(comment => comment.id === id ? { ...comment, status } : comment) };
		post('comment', { comment: { id, status } });
		closePopover();
		syncComments();
	}

	function sendAll(note?: string): void {
		const ready = model.comments.filter(comment => comment.status === 'open' && comment.author === 'user' && !comment.id.startsWith('pending-'));
		if (!ready.length) {
			return;
		}
		post('send', { comments: ready.map(comment => comment.id), note: note ?? '' });
		model = { ...model, comments: model.comments.map(comment => ready.includes(comment) ? { ...comment, status: 'sent' as const } : comment) };
		syncComments();
	}

	function flyToComment(id: string): void {
		const comment = model.comments.find(other => other.id === id);
		const at = comment ? anchorPoint(comment.anchor) : undefined;
		if (!comment || !at) {
			return;
		}
		const r = viewportRect();
		const z = Math.max(cam.z, 0.6);
		flyTo({ x: r.width / 2 - 120 - at.p.x * z, y: r.height / 2 - at.p.y * z, z });
		win.setTimeout(() => openThread(id), still || reduced ? 0 : 470);
	}

	//#endregion

	//#region Chrome: top bar, toolbar, minimap, tray, panes

	const top = el('div', 'cv-top');
	const titleBox = el('div', 'cv-title');
	const backButton = button(S.back, 'back', () => {
		const prev = playHistory.pop();
		if (prev) {
			zoomToFrame(prev, true);
		}
		syncTop();
	});
	backButton.classList.add('cv-back');
	const titleText = el('b');
	const versionChip = el('span', 'cv-ver');
	const changeText = el('span', 'cv-change');
	titleBox.append(backButton, titleText, versionChip, changeText);
	const actions = el('div', 'cv-actions');
	const lookGroup = el('div', 'cv-group cv-glass');
	const lookButtons = (['light', 'dark'] as const).map(kind => {
		const node = button(kind === 'light' ? S.light : S.dark, kind === 'light' ? 'sun' : 'moon', () => setLook(kind));
		lookGroup.append(node);
		return { node, kind };
	});
	const viewGroup = el('div', 'cv-group cv-glass cv-viewgroup');
	const devicesButton = button(S.devices, 'device', () => {
		state.devices = !state.devices;
		devicesButton.setAttribute('aria-pressed', String(state.devices));
		ordered().forEach(view => dress(view));
	});
	const flowsButton = button(S.flows, 'flow', () => {
		state.flows = !state.flows;
		flowsButton.setAttribute('aria-pressed', String(state.flows));
		requestRender();
	});
	const minimapButton = button(S.minimap, 'map', () => {
		state.minimap = !state.minimap;
		minimapButton.setAttribute('aria-pressed', String(state.minimap));
		minimap.hidden = !state.minimap;
		requestRender();
	});
	viewGroup.append(devicesButton, flowsButton, minimapButton);
	actions.append(lookGroup, viewGroup);
	// Play: the prototype from its first screen, every hotspot live.
	const playGroup = el('div', 'cv-group cv-glass');
	const playButton = button(S.play, 'play', () => {
		if (state.tool === 'play') {
			setTool('move');
			return;
		}
		setTool('play');
		const first = startFrame();
		if (first) {
			select(first);
			zoomToFrame(first, true);
		}
	}, 'labeled', true);
	playButton.lastChild!.textContent = S.playShort;
	playButton.setAttribute('aria-pressed', 'false');
	playGroup.append(playButton);
	actions.append(playGroup);
	/** Panel: shows or hides the workbench panes beside the page (the host may ask too). */
	let setPanes: ((layers: boolean, comments: boolean) => void) | undefined;
	if (!inline) {
		// The frame list and the comments are workbench panes beside the page (canvasView.ts).
		const paneGroup = el('div', 'cv-group cv-glass');
		setPanes = (layers, comments) => {
			state.layers = layers;
			state.commentsOpen = comments;
			syncPanes();
		};
		const syncPanes = () => {
			layersButton.setAttribute('aria-pressed', String(state.layers));
			commentsButton.setAttribute('aria-pressed', String(state.commentsOpen));
			post('panes', { layers: state.layers, comments: state.commentsOpen });
			syncComments();
		};
		const layersButton = button(S.layers, 'layers', () => {
			state.layers = !state.layers;
			syncPanes();
		});
		const commentsButton = button(S.comments, 'comment', () => {
			state.commentsOpen = !state.commentsOpen;
			syncPanes();
		});
		layersButton.setAttribute('aria-pressed', String(state.layers));
		commentsButton.setAttribute('aria-pressed', String(state.commentsOpen));
		paneGroup.append(layersButton, commentsButton);
		actions.append(paneGroup);
	} else if (hosted) {
		const open = button(S.openPanel, 'panel', () => post('open', { frame: [...state.selected][0] }), 'chip', true);
		const wrap = el('div', 'cv-group cv-glass');
		wrap.append(open);
		actions.append(wrap);
	}
	top.append(titleBox, actions);
	stage.append(top);
	devicesButton.setAttribute('aria-pressed', 'true');
	flowsButton.setAttribute('aria-pressed', 'true');
	minimapButton.setAttribute('aria-pressed', String(state.minimap));

	function syncTop(): void {
		titleText.textContent = model.title;
		titleText.title = model.subtitle ?? model.title;
		versionChip.textContent = fmt(S.version, model.version);
		changeText.textContent = model.change ? `\u00b7 ${model.change}` : fmt(S.frameCount, model.frames.length);
		changeText.title = model.change ?? '';
		backButton.hidden = !(state.tool === 'play' && playHistory.length);
		for (const entry of lookButtons) {
			entry.node.setAttribute('aria-pressed', String(entry.kind === look));
		}
	}

	/** Where the prototype starts: the first frame nothing leads to, among frames that lead on. */
	function startFrame(): string | undefined {
		const list = ordered();
		const flows = linkTriggers();
		const targets = new Set(flows.map(entry => entry.t.to));
		const sources = new Set(flows.map(entry => entry.v.frame.id));
		const selected = [...state.selected][0];
		if (selected && views.has(selected)) {
			return selected;
		}
		return list.find(v => sources.has(v.frame.id) && !targets.has(v.frame.id))?.frame.id ?? list[0]?.frame.id;
	}

	function setLook(kind: CanvasTheme): void {
		if (kind === look) {
			return;
		}
		look = kind;
		for (const v of views.values()) {
			const theme = v.frame.theme ?? look;
			if (theme !== v.theme) {
				v.theme = theme;
				v.node.dataset.look = theme;
				refresh(v, false);
			}
		}
		syncTop();
	}

	const toolbar = el('div', 'cv-toolbar cv-group cv-glass');
	const toolButtons = new Map<Tool, HTMLButtonElement>();
	for (const [tool, label, iconName] of [['move', `${S.move} (V)`, 'move'], ['hand', `${S.hand} (H)`, 'hand'], ['comment', `${S.comment} (C)`, 'comment'], ['play', `${S.play} (P)`, 'play']] as const) {
		const node = button(label, iconName, () => setTool(state.tool === tool && tool !== 'move' ? 'move' : tool));
		node.setAttribute('aria-pressed', String(tool === state.tool));
		toolButtons.set(tool, node);
		toolbar.append(node);
	}
	toolbar.append(el('span', 'cv-sep'));
	const undoButton = button(`${S.undo} (\u2318Z)`, 'undo', () => undo(), 'cv-undo');
	toolbar.append(undoButton, el('span', 'cv-sep cv-undo'));
	toolbar.append(button(`${S.zoomOut} (\u2212)`, 'minus', () => zoomStep(0.8)));
	const zoomLabel = button(S.zoom100, undefined, () => zoomStep(1 / cam.z), 'cv-zoom', true);
	zoomLabel.title = `${S.zoom100} (\u21e70)`;
	toolbar.append(zoomLabel, button(`${S.zoomIn} (+)`, 'plus', () => zoomStep(1.25)), button(`${S.fit} (\u21e71)`, 'fit', () => fitAll()));
	stage.append(toolbar);

	const hint = el('div', 'cv-hint cv-glass');
	stage.append(hint);
	let hintTimer = 0;
	function showHint(text: string, ms = 1600): void {
		hint.textContent = text;
		hint.classList.add('on');
		win.clearTimeout(hintTimer);
		hintTimer = win.setTimeout(() => hint.classList.remove('on'), ms);
	}

	const toastNode = el('div', 'cv-toast cv-glass');
	toastNode.hidden = true;
	stage.append(toastNode);
	let toastTimer = 0;
	function toast(text: string, agent = true): void {
		toastNode.replaceChildren();
		if (agent) {
			toastNode.append(icon('sparkle'));
		}
		toastNode.append(doc.createTextNode(text));
		toastNode.hidden = false;
		win.clearTimeout(toastTimer);
		toastTimer = win.setTimeout(() => {
			toastNode.hidden = true;
		}, 3200);
	}

	const minimap = el('div', 'cv-minimap');
	const miniView = el('div', 'cv-mini-view');
	minimap.append(miniView);
	minimap.hidden = !state.minimap;
	stage.append(minimap);
	const miniFrames = new Map<string, HTMLElement>();
	let miniTransform = { x: 0, y: 0, s: 1 };
	function renderMinimap(): void {
		if (minimap.hidden) {
			return;
		}
		const r = viewportRect();
		const viewWorld: IRect = { x: -cam.x / cam.z, y: -cam.y / cam.z, w: r.width / cam.z, h: r.height / cam.z };
		const frames = ordered().map(v => ({ v, b: boxOf(v) }));
		const bounds = union([...frames.map(entry => entry.b), viewWorld]);
		if (!bounds) {
			return;
		}
		const mw = minimap.clientWidth;
		const mh = minimap.clientHeight;
		const pad = 8;
		const s = Math.min((mw - pad * 2) / bounds.w, (mh - pad * 2) / bounds.h);
		const ox = pad + ((mw - pad * 2) - bounds.w * s) / 2 - bounds.x * s;
		const oy = pad + ((mh - pad * 2) - bounds.h * s) / 2 - bounds.y * s;
		miniTransform = { x: ox, y: oy, s };
		const seen = new Set<string>();
		for (const { v, b } of frames) {
			let node = miniFrames.get(v.frame.id);
			if (!node) {
				node = el('div', 'cv-mini-frame');
				minimap.insertBefore(node, miniView);
				miniFrames.set(v.frame.id, node);
			}
			seen.add(v.frame.id);
			node.classList.toggle('sel', state.selected.has(v.frame.id));
			Object.assign(node.style, { transform: `translate(${ox + b.x * s}px,${oy + b.y * s}px)`, width: `${Math.max(2, b.w * s)}px`, height: `${Math.max(2, b.h * s)}px` });
		}
		for (const [id, node] of miniFrames) {
			if (!seen.has(id)) {
				node.remove();
				miniFrames.delete(id);
			}
		}
		Object.assign(miniView.style, { transform: `translate(${ox + viewWorld.x * s}px,${oy + viewWorld.y * s}px)`, width: `${viewWorld.w * s}px`, height: `${viewWorld.h * s}px` });
	}
	minimap.addEventListener('pointerdown', event => {
		event.stopPropagation();
		engage();
		const centerOn = (clientX: number, clientY: number) => {
			const mr = minimap.getBoundingClientRect();
			const wx = (clientX - mr.left - miniTransform.x) / miniTransform.s;
			const wy = (clientY - mr.top - miniTransform.y) / miniTransform.s;
			const r = viewportRect();
			stopFlight();
			setCamera(r.width / 2 - wx * cam.z, r.height / 2 - wy * cam.z, cam.z);
		};
		centerOn(event.clientX, event.clientY);
		minimap.setPointerCapture(event.pointerId);
		const onMove = (ev: PointerEvent) => centerOn(ev.clientX, ev.clientY);
		const onUp = () => {
			minimap.removeEventListener('pointermove', onMove);
			minimap.removeEventListener('pointerup', onUp);
		};
		minimap.addEventListener('pointermove', onMove);
		minimap.addEventListener('pointerup', onUp);
	});
	minimap.addEventListener('wheel', event => event.stopPropagation());

	// The comment tray: comments waiting to go to the agent.
	const tray = el('div', 'cv-tray cv-glass');
	const trayCount = el('span', 'cv-tray-count');
	tray.append(trayCount, button(S.clear, undefined, () => {
		for (const comment of model.comments.filter(c => c.status === 'open' && c.author === 'user')) {
			post('comment-delete', { comment: comment.id });
		}
		model = { ...model, comments: model.comments.filter(c => !(c.status === 'open' && c.author === 'user')) };
		syncComments();
	}, '', true), button(S.sendAll, 'send', () => sendAll(), 'primary', true));
	tray.hidden = true;
	stage.append(tray);
	const trayButton = tray.lastElementChild as HTMLButtonElement;

	// The selection bar: size presets and quick actions for one frame.
	const selbar = el('div', 'cv-selbar cv-glass');
	selbar.hidden = true;
	selbar.addEventListener('pointerdown', event => event.stopPropagation());
	stage.append(selbar);
	function syncSelectionBar(): void {
		const ids = [...state.selected];
		const v = ids.length === 1 && state.tool === 'move' ? views.get(ids[0]) : undefined;
		selbar.hidden = !v;
		selbar.replaceChildren();
		if (!v) {
			return;
		}
		const sizes = el('select', 'cv-select');
		sizes.title = S.size;
		const current = el('option', undefined, `${v.frame.width} \u00d7 ${v.frame.height || 'auto'}`);
		current.value = '';
		sizes.append(current);
		for (const preset of boot.presets) {
			const option = el('option', undefined, `${preset.label} \u00b7 ${preset.width}\u00d7${preset.height}`);
			option.value = `${preset.width}x${preset.height}`;
			sizes.append(option);
		}
		sizes.addEventListener('change', () => {
			const [w, h] = sizes.value.split('x').map(Number);
			if (w && h) {
				pushUndo(layoutOf([v.frame.id]));
				setGeometry(v.frame.id, { width: w, height: h }, true);
				sendLayout([v.frame.id]);
				syncSelectionBar();
			}
		});
		selbar.append(sizes, el('span', 'cv-sep'));
		if (hosted) {
			selbar.append(
				button(S.variations, 'variants', () => post('prompt', { text: fmt(S.variationsPrompt, `"${v.frame.name}" [${v.frame.id}]`, model.title) })),
				button(S.nextScreen, 'next', () => post('prompt', { text: fmt(S.nextScreenPrompt, model.title, `"${v.frame.name}" [${v.frame.id}]`) })),
				button(S.askInChat, 'chat', () => post('prompt', { text: fmt(S.askPrompt, `"${v.frame.name}" [${v.frame.id}]`, model.title) })),
			);
			if (v.frame.html) {
				selbar.append(button(S.copyHtml, 'copy', () => {
					post('copy', { frame: v.frame.id });
					toast(S.copied, false);
				}));
			}
		}
		positionSelectionBar();
	}
	function positionSelectionBar(): void {
		if (selbar.hidden) {
			return;
		}
		const v = views.get([...state.selected][0] ?? '');
		if (!v || state.dragging || resizing) {
			selbar.style.visibility = 'hidden';
			return;
		}
		const b = boxOf(v);
		const s = toScreen(b);
		const r = viewportRect();
		const x = clamp(s.x + b.w * cam.z / 2, selbar.offsetWidth / 2 + 8, r.width - selbar.offsetWidth / 2 - 8);
		const y = s.y - 34;
		selbar.style.visibility = y < 56 || y > r.height ? 'hidden' : 'visible';
		selbar.style.transform = `translate(${x}px,${y}px) translate(-50%,-100%)`;
	}

	function syncComments(): void {
		const ready = model.comments.filter(c => c.status === 'open' && c.author === 'user').length;
		tray.hidden = !ready || (!inline && state.commentsOpen);
		trayCount.replaceChildren(el('span', 'cv-tray-dot'), doc.createTextNode(fmt(S.ready, ready)));
		trayButton.lastChild!.textContent = fmt(S.sendAll, ready);
		for (const v of views.values()) {
			v.rects.clear();
		}
		requestRender();
	}

	//#endregion

	//#region Sync with the host

	function syncDoc(next: ICanvasDoc, origin: string, focus?: string): void {
		const previousTheme = model.theme;
		const previousVersion = model.version;
		model = next;
		if (next.theme !== previousTheme) {
			look = next.theme ?? look;
		}
		const ids = new Set(next.frames.map(frame => frame.id));
		for (const v of [...views.values()]) {
			if (!ids.has(v.frame.id)) {
				removeView(v, true);
			}
		}
		const changed: string[] = [];
		for (const frame of next.frames) {
			let v = views.get(frame.id);
			if (!v) {
				v = createView(frame);
				views.set(frame.id, v);
				if (fitted && !still) {
					v.node.classList.add('cv-appear');
				}
				changed.push(frame.name);
				continue;
			}
			const moved = v.frame.x !== frame.x || v.frame.y !== frame.y || v.frame.width !== frame.width || v.frame.height !== frame.height;
			const dragged = (state.dragging || resizing) && state.selected.has(frame.id);
			v.frame = dragged ? { ...frame, x: v.frame.x, y: v.frame.y, width: v.frame.width, height: v.frame.height } : frame;
			v.theme = frame.theme ?? look;
			const nextHash = contentHash(frame, v.theme);
			dress(v, moved && !dragged && origin === 'agent');
			if (nextHash !== v.hash) {
				refresh(v, origin === 'agent');
				changed.push(frame.name);
			}
		}
		for (const v of views.values()) {
			collectTriggers(v);
		}
		syncTop();
		syncSelectionBar();
		syncComments();
		if (origin === 'agent' && next.version !== previousVersion) {
			toast(changed.length ? fmt(S.updated, changed.slice(0, 4).join(', ')) : `${fmt(S.version, next.version)} \u00b7 ${next.change ?? ''}`);
		}
		if (focus && views.has(focus)) {
			zoomToFrame(focus);
		}
		requestRender();
	}

	win.addEventListener('message', event => {
		const data = event.data as { type?: unknown; op?: unknown; id?: unknown; doc?: ICanvasDoc; origin?: string; frame?: string; comment?: unknown; show?: unknown; layers?: unknown; comments?: ICanvasComment[] | boolean; frames?: ICanvasLayout[] } | null;
		if (!data || data.type !== 'volt-canvas' || (data.id !== undefined && data.id !== model.id)) {
			return;
		}
		switch (data.op) {
			case 'doc':
				if (data.doc && boot.pinned) {
					// History keeps its version; only the comments follow the canvas.
					model = { ...model, comments: data.doc.comments };
					syncComments();
				} else if (data.doc) {
					syncDoc(data.doc, data.origin ?? 'user', data.frame);
				}
				return;
			case 'comments':
				if (Array.isArray(data.comments)) {
					// The store's list replaces the view's, pending comments included (they are in it now).
					model = { ...model, comments: data.comments };
					syncComments();
				}
				return;
			case 'layout':
				if (Array.isArray(data.frames) && !boot.pinned) {
					for (const entry of data.frames) {
						const dragged = (state.dragging || resizing) && state.selected.has(entry.id);
						if (!dragged) {
							setGeometry(entry.id, { x: entry.x, y: entry.y, width: entry.width, height: entry.height }, true);
						}
					}
				}
				return;
			case 'focus':
				if (typeof data.frame === 'string') {
					select(data.frame);
					zoomToFrame(data.frame);
				}
				return;
			case 'hover':
				state.hoverFrame = typeof data.frame === 'string' ? data.frame : undefined;
				requestRender();
				return;
			case 'comment':
				if (typeof data.comment === 'string') {
					flyToComment(data.comment);
				}
				return;
			case 'resolved':
				state.showResolved = !!data.show;
				syncComments();
				return;
			case 'panes':
				setPanes?.(data.layers !== false, data.comments !== false);
				return;
		}
	});

	//#endregion

	//#region Start

	for (const frame of model.frames) {
		views.set(frame.id, createView(frame));
	}
	syncTop();
	syncComments();

	const fitFirst = () => {
		if (fitted) {
			return;
		}
		const r = viewportRect();
		// A host still laying out (a webview mounting) can report a sliver: fit once it has room.
		if (r.width < 120 || r.height < 120) {
			return;
		}
		fitted = true;
		if (boot.focus && views.has(boot.focus)) {
			const v = views.get(boot.focus)!;
			const b = boxOf(v);
			const target = fitCamera({ x: b.x, y: b.y - 24, w: b.w, h: b.h + 24 }, 40, 1.5);
			setCamera(target.x, target.y, target.z);
			select(boot.focus);
		} else {
			fitAll(false);
		}
	};
	let lastSize = { w: 0, h: 0 };
	let untouched = true;
	for (const type of ['pointerdown', 'wheel', 'keydown'] as const) {
		root.addEventListener(type, () => untouched = false, { capture: true, passive: true });
	}
	if (typeof win.ResizeObserver === 'function') {
		new win.ResizeObserver(() => {
			const r = viewportRect();
			if (!fitted) {
				fitFirst();
			} else if (untouched && r.width >= 120 && r.height >= 120 && (r.width !== lastSize.w || r.height !== lastSize.h)) {
				// Panes opening or closing before the user moved anything: fit again.
				fitAll(false);
			} else if (lastSize.w && (r.width !== lastSize.w || r.height !== lastSize.h)) {
				// Keep what was centered centered.
				setCamera(cam.x + (r.width - lastSize.w) / 2, cam.y + (r.height - lastSize.h) / 2, cam.z);
			}
			lastSize = { w: r.width, h: r.height };
		}).observe(viewport);
	}
	fitFirst();
	requestRender();
	post('hello', { version: model.version, ...(boot.pinned ? { pinned: true } : {}) });

	//#endregion
}

//#endregion

//#region Page

function jsonForScript(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function scriptSource(fn: (...args: never[]) => unknown): string {
	return fn.toString().replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/** The canvas page (Volt wraps it with the theme and bridge when it is shown). */
export function buildCanvasPage(data: ICanvasPageData): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${data.doc.title.replace(/[<&]/g, '')}</title><style>${CANVAS_CSS}</style></head><body><div id="volt-canvas"></div><script type="application/json" id="volt-canvas-data">${jsonForScript(data)}</script><script>(${scriptSource(designCanvasRuntime)})(window, ${scriptSource(canvasFrameDocument)});</script></body></html>`;
}

//#endregion
