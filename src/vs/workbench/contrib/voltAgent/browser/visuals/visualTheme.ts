/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color, RGBA } from '../../../../../base/common/color.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { IColorTheme, registerThemingParticipant } from '../../../../../platform/theme/common/themeService.js';

// The theme side of visuals and the canvas: the chart palette, the page's CSS and light or dark. A module of its own so the
// canvas can use it without importing the visuals, which import the canvas.

/** Whether a page drawn for `theme` is light or dark. */
export function themeKind(theme: IColorTheme): 'light' | 'dark' {
	return theme.type === ColorScheme.LIGHT || theme.type === ColorScheme.HIGH_CONTRAST_LIGHT ? 'light' : 'dark';
}

/** Where each chart hue comes from, best first: the theme's chart color, then its terminal palette. */
const PALETTE_SOURCES: readonly (readonly [slot: string, ids: readonly string[]])[] = [
	['blue', ['charts.blue', 'terminal.ansiBrightBlue', 'terminal.ansiBlue']],
	['green', ['charts.green', 'terminal.ansiGreen', 'terminal.ansiBrightGreen']],
	['purple', ['charts.purple', 'terminal.ansiMagenta', 'terminal.ansiBrightMagenta']],
	['yellow', ['charts.yellow', 'terminal.ansiYellow', 'terminal.ansiBrightYellow']],
	['red', ['charts.red', 'terminal.ansiRed', 'terminal.ansiBrightRed']],
	['teal', ['terminal.ansiCyan', 'terminal.ansiBrightCyan']],
	['pink', ['terminal.ansiBrightMagenta', 'terminal.ansiMagenta']],
	['orange', ['charts.orange']],
];

function mix(a: Color, b: Color, weight = 0.5): Color {
	return new Color(new RGBA(
		Math.round(a.rgba.r * weight + b.rgba.r * (1 - weight)),
		Math.round(a.rgba.g * weight + b.rgba.g * (1 - weight)),
		Math.round(a.rgba.b * weight + b.rgba.b * (1 - weight)),
	));
}

/**
 * The chart palette for a theme, as CSS custom properties. A hue the theme sets itself (its chart
 * or terminal colors) beats VS Code's defaults, so Nord, Dracula or Solarized charts look like
 * Nord, Dracula or Solarized. Orange, which terminals lack, is the theme's red and yellow mixed.
 */
export function chartPaletteVariables(theme: IColorTheme): Record<string, string> {
	const background = theme.getColor('sideBar.background') ?? theme.getColor('editor.background') ?? Color.black;
	const opaque = (color: Color) => color.isOpaque() ? color : color.makeOpaque(background);
	const colors = new Map<string, Color>();
	const declared = new Set<string>();
	for (const [slot, ids] of PALETTE_SOURCES) {
		const id = ids.find(candidate => theme.defines(candidate));
		const color = theme.getColor(id ?? ids[0]);
		if (id) {
			declared.add(slot);
		}
		if (color) {
			colors.set(slot, opaque(color));
		}
	}
	const red = colors.get('red');
	const yellow = colors.get('yellow');
	if (!declared.has('orange') && red && yellow) {
		colors.set('orange', mix(red, yellow));
	}
	const purple = colors.get('purple');
	const pink = colors.get('pink');
	if (red && purple && (!pink || pink.equals(purple))) {
		colors.set('pink', mix(red, purple));
	}
	const accent = theme.getColor('textLink.foreground') ?? colors.get('blue');
	const variables: Record<string, string> = {};
	if (accent) {
		variables['--volt-chart-accent'] = opaque(accent).toString();
	}
	for (const [slot, color] of colors) {
		variables[`--volt-chart-${slot}`] = color.toString();
	}
	return variables;
}

function cssBlock(selector: string, variables: Record<string, string>): string {
	return `${selector}{${Object.entries(variables).map(([name, value]) => `${name}:${value};`).join('')}}`;
}

registerThemingParticipant((theme, collector) => {
	collector.addRule(cssBlock('.monaco-workbench', chartPaletteVariables(theme)));
});

/** What a page needs on top of the webview's own `--vscode-*` colors: the chart palette and the chat's surface. */
export function visualThemeCss(theme: IColorTheme, extra: Record<string, string> = {}): string {
	const surface = theme.getColor('sideBar.background') ?? theme.getColor('editor.background');
	return cssBlock(':root', { ...extra, ...chartPaletteVariables(theme), ...(surface ? { '--volt-surface': surface.toString() } : {}) });
}
