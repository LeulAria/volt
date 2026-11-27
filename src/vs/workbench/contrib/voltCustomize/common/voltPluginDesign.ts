/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VoltViewLocation } from '../../../services/voltPlugins/common/voltContributions.js';

/**
 * How a plugin view fits Volt: the size each placement gives it, and the Volt kit, Volt's own look
 * (type, spacing, buttons, lists) put into every plugin webview.
 *
 * Both are soft. A view asks for another size in `voltViews[].size` and gets it inside the
 * placement's bounds; a page overrides the kit with its own CSS (the kit is a cascade layer, so any
 * rule of the page wins) or turns it off with `<meta name="volt-kit" content="off">`.
 */

export interface IVoltViewSize {
	readonly width?: number;
	readonly height?: number;
}

interface IBounds {
	readonly default: number;
	readonly min: number;
	readonly max: number;
}

/**
 * What each placement gives a view. A missing axis is not the view's to choose: the right panel,
 * a page and the files sidebar are as big as the user makes them, and a card above the composer
 * is as wide as the chat.
 */
export const VOLT_VIEW_SIZE_BOUNDS: { readonly [L in VoltViewLocation]: { readonly width?: IBounds; readonly height?: IBounds } } = {
	rightPanel: {},
	filesSidebar: {},
	page: {},
	popover: { width: { default: 360, min: 280, max: 480 }, height: { default: 420, min: 160, max: 560 } },
	aboveComposer: { height: { default: 160, min: 72, max: 320 } },
	sidebarSection: { height: { default: 200, min: 96, max: 400 } },
};

function clamp(bounds: IBounds | undefined, requested: number | undefined): number | undefined {
	if (!bounds) {
		return undefined;
	}
	if (typeof requested !== 'number' || !Number.isFinite(requested)) {
		return bounds.default;
	}
	return Math.round(Math.max(bounds.min, Math.min(bounds.max, requested)));
}

/** The size a view gets in `location`: what it asked for, inside the placement's bounds. */
export function resolveVoltViewSize(location: VoltViewLocation, requested: IVoltViewSize | undefined): IVoltViewSize {
	const bounds = VOLT_VIEW_SIZE_BOUNDS[location];
	return { width: clamp(bounds.width, requested?.width), height: clamp(bounds.height, requested?.height) };
}

/**
 * Volt's look for plugin webviews. Everything is in `@layer volt-kit`, after VS Code's
 * `vscode-default` layer, so it beats VS Code's webview defaults and loses to any rule of the page.
 * Colours are the theme's (`--vscode-*`, which every webview has), so it follows the theme.
 */
export const VOLT_WEBVIEW_KIT_CSS = `
@layer volt-kit {
	:root {
		--volt-font-size: 13px;
		--volt-font-size-small: 12px;
		--volt-font-size-caption: 11px;
		--volt-line-height: 1.45;
		--volt-space-1: 4px;
		--volt-space-2: 8px;
		--volt-space-3: 12px;
		--volt-space-4: 16px;
		--volt-gutter: 12px;
		--volt-row-height: 26px;
		--volt-section-header-height: 30px;
		--volt-button-height: 28px;
		--volt-button-height-small: 24px;
		--volt-icon-button-size: 24px;
		/* Icon sizes are Volt's own: 16px in list rows, 15px in toolbars, 14px in buttons. */
		--volt-icon-size: 16px;
		--volt-toolbar-icon-size: 15px;
		--volt-button-icon-size: 14px;
		--volt-radius: 6px;
		--volt-radius-large: 10px;
		--volt-content-max-width: 728px;
		--volt-border: var(--vscode-widget-border, color-mix(in srgb, var(--vscode-foreground) 12%, transparent));
		--volt-muted: var(--vscode-descriptionForeground);
		--volt-hover: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 7%, transparent));
		--volt-tone-error: var(--vscode-errorForeground, #f85149);
		--volt-tone-warning: var(--vscode-editorWarning-foreground, #d29922);
		--volt-tone-success: var(--vscode-testing-iconPassed, #3fb950);
		--volt-tone-info: var(--vscode-charts-blue, #4f8cff);
		color-scheme: light dark;
	}
	:root[data-volt-placement="rightPanel"], :root[data-volt-placement="page"] { --volt-gutter: 16px; }
	:root[data-volt-placement="aboveComposer"] { --volt-row-height: 24px; }

	html, body { height: 100%; }
	body {
		margin: 0;
		padding: 0;
		box-sizing: border-box;
		color: var(--vscode-foreground);
		background: transparent;
		font-family: var(--vscode-font-family);
		font-size: var(--volt-font-size);
		line-height: var(--volt-line-height);
		-webkit-font-smoothing: antialiased;
	}
	*, *::before, *::after { box-sizing: inherit; }
	h1, h2, h3, h4, p { margin: 0; }
	h1 { font-size: 16px; font-weight: 600; }
	h2 { font-size: 14px; font-weight: 600; }
	h3, h4 { font-size: var(--volt-font-size); font-weight: 600; }
	code, kbd, .volt-mono { font-family: var(--vscode-editor-font-family); font-size: var(--volt-font-size-small); }
	a { color: var(--vscode-textLink-foreground); text-decoration: none; }
	a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
	:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	::-webkit-scrollbar { width: 10px; height: 10px; }
	::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); }
	::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
	::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }
	svg { flex: none; }

	/* The page: a scrolling column with the placement's gutter; a page view keeps the chat's width. */
	.volt-view { display: flex; flex-direction: column; min-height: 100%; }
	.volt-view.fill { height: 100%; min-height: 0; }
	.volt-content { padding: var(--volt-gutter); display: flex; flex-direction: column; gap: var(--volt-space-3); }
	:root[data-volt-placement="page"] .volt-content { width: 100%; max-width: var(--volt-content-max-width); margin: 0 auto; padding-top: 24px; }

	/* Sections: a header line, then rows edge to edge. No boxes around them. */
	.volt-section { display: flex; flex-direction: column; min-height: 0; }
	.volt-section + .volt-section { border-top: 1px solid var(--volt-border); }
	.volt-section-header {
		display: flex; align-items: center; gap: var(--volt-space-2);
		height: var(--volt-section-header-height); padding: 0 var(--volt-space-1) 0 var(--volt-gutter);
		font-size: var(--volt-font-size-small); font-weight: 600; color: var(--volt-muted);
	}
	.volt-section-header > .volt-title { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
	.volt-section-body { padding: 0 var(--volt-gutter) var(--volt-space-3); display: flex; flex-direction: column; gap: var(--volt-space-2); }
	.volt-section > :is(.volt-list, .volt-row, .volt-empty) + .volt-section-body { padding-top: var(--volt-space-2); }
	.volt-section > :is(.volt-list, .volt-row):last-child { padding-bottom: var(--volt-space-2); }

	/* Lists: VS Code's list rows. Edge to edge, square, no gaps between rows. */
	.volt-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
	.volt-row {
		display: flex; align-items: center; gap: var(--volt-space-2);
		min-height: var(--volt-row-height); padding: 0 var(--volt-gutter);
		color: var(--vscode-foreground); cursor: default;
	}
	.volt-row.two-line { min-height: 40px; }
	.volt-row:is(button, a, [role="button"], .clickable) { cursor: pointer; border: 0; background: none; font: inherit; text-align: left; width: 100%; text-decoration: none; }
	.volt-row:is(button, a, [role="button"], .clickable):hover { background: var(--volt-hover); }
	.volt-row.selected { background: var(--vscode-list-inactiveSelectionBackground); }
	.volt-row:focus-visible { outline: 1px solid var(--vscode-list-focusOutline, var(--vscode-focusBorder)); outline-offset: -1px; }
	.volt-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
	.volt-row-label { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
	.volt-row-description { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--volt-font-size-small); color: var(--volt-muted); }
	.volt-row-meta { flex: none; font-size: var(--volt-font-size-small); color: var(--volt-muted); }
	.volt-row-actions { flex: none; display: none; align-items: center; gap: 2px; }
	.volt-row:hover .volt-row-actions, .volt-row:focus-within .volt-row-actions { display: inline-flex; }

	/* Buttons: Volt's (createVoltButton). One primary per view at most. */
	.volt-button {
		display: inline-flex; align-items: center; justify-content: center; gap: 6px;
		height: var(--volt-button-height); padding: 0 12px; margin: 0;
		border: 1px solid var(--vscode-button-border, transparent); border-radius: var(--volt-radius);
		font: inherit; font-size: var(--volt-font-size); white-space: nowrap; cursor: pointer;
		color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
	}
	.volt-button:hover { background: var(--vscode-button-secondaryHoverBackground); }
	.volt-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
	.volt-button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
	.volt-button.primary:hover { background: var(--vscode-button-hoverBackground); }
	.volt-button.ghost { border-color: transparent; background: transparent; color: var(--volt-muted); }
	.volt-button.ghost:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
	.volt-button.danger { color: var(--volt-tone-error); border-color: color-mix(in srgb, var(--volt-tone-error) 30%, transparent); background: color-mix(in srgb, var(--volt-tone-error) 10%, transparent); }
	.volt-button.small { height: var(--volt-button-height-small); padding: 0 10px; font-size: var(--volt-font-size-small); }
	.volt-button:disabled { opacity: 0.45; cursor: default; pointer-events: none; }
	.volt-button svg { width: var(--volt-button-icon-size); height: var(--volt-button-icon-size); }
	.volt-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--volt-space-2); }

	/* Icon buttons: a 16px icon in a square that shows on hover (the window's toolbars). */
	.volt-icon-button {
		display: inline-flex; align-items: center; justify-content: center; flex: none;
		width: var(--volt-icon-button-size); height: var(--volt-icon-button-size); padding: 0;
		border: 0; border-radius: 5px; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground));
		cursor: pointer;
	}
	.volt-icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
	.volt-icon-button:disabled { opacity: 0.45; cursor: default; }
	.volt-icon, .volt-icon > svg, .volt-row > svg { width: var(--volt-icon-size); height: var(--volt-icon-size); flex: none; }
	:is(.volt-icon-button, .volt-toolbar) :is(.volt-icon, svg) { width: var(--volt-toolbar-icon-size); height: var(--volt-toolbar-icon-size); }
	.volt-button :is(.volt-icon, svg) { width: var(--volt-button-icon-size); height: var(--volt-button-icon-size); }
	/* Volt's icon line: 0.9px on screen (about 1px), whatever the SVG or its size says. */
	:is(.volt-icon, .volt-icon-button, .volt-row, .volt-button, .volt-section-header) svg :is(path, line, polyline, polygon, rect, circle, ellipse) { stroke-width: 0.9px; vector-effect: non-scaling-stroke; }
	.volt-toolbar { display: inline-flex; align-items: center; gap: 2px; }

	/* Fields. No native <select>: offer a choice with buttons, or Volt's pickers (chats.pickModel). */
	.volt-input, .volt-textarea {
		width: 100%; margin: 0; padding: 4px 8px;
		border: 1px solid var(--vscode-input-border, var(--volt-border)); border-radius: var(--volt-radius);
		color: var(--vscode-input-foreground); background: var(--vscode-input-background);
		font: inherit;
	}
	.volt-input { height: var(--volt-button-height); }
	.volt-textarea { min-height: 72px; resize: none; line-height: var(--volt-line-height); }
	.volt-input::placeholder, .volt-textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
	.volt-input:focus, .volt-textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; border-color: transparent; }

	/* Small things: text tones, badges, status dots, key/value lines, dividers, empty states. */
	.volt-muted { color: var(--volt-muted); }
	.volt-small { font-size: var(--volt-font-size-small); }
	.volt-caption { font-size: var(--volt-font-size-caption); color: var(--volt-muted); }
	.volt-strong { font-weight: 600; }
	.volt-ellipsis { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; }
	.volt-tone-error { color: var(--volt-tone-error); }
	.volt-tone-warning { color: var(--volt-tone-warning); }
	.volt-tone-success { color: var(--volt-tone-success); }
	.volt-badge {
		display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 9px;
		font-size: var(--volt-font-size-caption); font-weight: 500; white-space: nowrap;
		color: var(--vscode-badge-foreground); background: var(--vscode-badge-background);
	}
	.volt-badge:is(.error, .warning, .success, .info) { background: color-mix(in srgb, var(--volt-badge-tone) 16%, transparent); color: var(--volt-badge-tone); }
	.volt-badge.error { --volt-badge-tone: var(--volt-tone-error); }
	.volt-badge.warning { --volt-badge-tone: var(--volt-tone-warning); }
	.volt-badge.success { --volt-badge-tone: var(--volt-tone-success); }
	.volt-badge.info { --volt-badge-tone: var(--volt-tone-info); }
	.volt-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--volt-muted); }
	.volt-dot.error { background: var(--volt-tone-error); }
	.volt-dot.warning { background: var(--volt-tone-warning); }
	.volt-dot.success { background: var(--volt-tone-success); }
	.volt-divider { height: 1px; border: 0; margin: 0; background: var(--volt-border); }
	.volt-kv { display: grid; grid-template-columns: max-content 1fr; column-gap: var(--volt-space-3); row-gap: var(--volt-space-1); font-size: var(--volt-font-size-small); }
	.volt-kv > :nth-child(odd) { color: var(--volt-muted); }
	.volt-empty {
		display: flex; flex-direction: column; align-items: flex-start; gap: var(--volt-space-2);
		padding: var(--volt-space-3) var(--volt-gutter); color: var(--volt-muted); font-size: var(--volt-font-size-small);
	}
	.volt-empty.center { align-items: center; justify-content: center; text-align: center; flex: 1 1 auto; }
	/* Under a section's header line the header is the space above. */
	.volt-section-header + :is(.volt-empty, .volt-section-body) { padding-top: 0; }
}
`;

const OFF = /<meta\s+name=["']volt-kit["']\s+content=["']off["']/i;

/**
 * Volt's icon line: 0.9px on screen whatever the icon's grid or drawn size (agentHomePane.css,
 * "Chrome icons"). `non-scaling-stroke` measures the stroke on screen, not in the viewBox.
 */
export const VOLT_ICON_STROKE = '0.9px';

/**
 * An outline icon drawn with Volt's own line (`VOLT_ICON_STROKE`), at any size: the set's 2px
 * (lucide) becomes Volt's 0.9px. Filled icons (brand logos) have no stroke and come back as they are.
 */
export function voltIconStrokeSvg(svg: string): string {
	if (!/\sstroke(-width)?\s*=/i.test(svg) || /<style\b/i.test(svg)) {
		return svg;
	}
	const style = `<style>:is(path,line,polyline,polygon,rect,circle,ellipse){stroke-width:${VOLT_ICON_STROKE};vector-effect:non-scaling-stroke}</style>`;
	return svg.replace(/<svg\b[^>]*>/i, root => root + style);
}

/**
 * The page with the Volt kit in front of everything in its `<head>`, and the placement on `<html>`
 * (`data-volt-placement`, for the kit's per-placement gutters and for the page's own CSS). The kit
 * goes before the page's Content-Security-Policy, which governs only what follows it, so a strict
 * policy doesn't block it. `<meta name="volt-kit" content="off">` keeps the page as it is, but for
 * the placement.
 */
export function injectVoltWebviewKit(html: string, placement: VoltViewLocation | undefined): string {
	let out = html;
	if (placement) {
		const attr = ` data-volt-placement="${placement}"`;
		// The first of a repeated attribute wins, so Volt's goes first.
		out = /<html\b/i.test(out) ? out.replace(/<html\b/i, `<html${attr}`) : `<html${attr}>${out}`;
	}
	if (OFF.test(html)) {
		return out;
	}
	const style = `<style id="_voltKit">${VOLT_WEBVIEW_KIT_CSS}</style>`;
	if (/<head\b[^>]*>/i.test(out)) {
		return out.replace(/<head\b[^>]*>/i, head => head + style);
	}
	// No <head>: the parser opens one for a leading <style>.
	return /<html\b[^>]*>/i.test(out) ? out.replace(/<html\b[^>]*>/i, tag => `${tag}<head>${style}</head>`) : style + out;
}
