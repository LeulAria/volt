/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color, RGBA } from '../../../../base/common/color.js';

export const VOLT_THEME_CONTRAST_SETTING = 'volt.theme.contrast';
export const VOLT_THEME_CONTRAST_MIN = -100;
export const VOLT_THEME_CONTRAST_MAX = 100;
/** One press of the picker's minus / plus buttons. */
export const VOLT_THEME_CONTRAST_STEP = 10;

/**
 * How a theme color takes part in contrast: text and icons, edges between areas, or one of the
 * big surfaces the text sits on. Everything else (highlights, diff fills, terminal palettes,
 * chart colors) keeps the theme's value.
 */
export type ContrastRole = 'text' | 'border' | 'surface';

/** Palettes and decorations whose colors carry meaning rather than "text on a surface". */
const UNTOUCHED = /^(terminal\.ansi|terminalCommandGuide|editorBracketHighlight|editorBracketPairGuide|debugTokenExpression|debugConsole|symbolIcon|charts\.|minimap|editorOverviewRuler|editorGutter|scmGraph|editorInlayHint|editorGhostText|editorUnnecessaryCode|editorLightBulb|editorCodeLens|testing\.|ports\.)/;

/** The surfaces whole areas paint. Their tints and selections stay as the theme drew them. */
const SURFACES = new Set([
	'editor.background',
	'editorPane.background',
	'editorGroupHeader.tabsBackground',
	'editorGroupHeader.noTabsBackground',
	'editorWidget.background',
	'editorHoverWidget.background',
	'editorSuggestWidget.background',
	'sideBar.background',
	'sideBarSectionHeader.background',
	'sideBarStickyScroll.background',
	'activityBar.background',
	'panel.background',
	'panelStickyScroll.background',
	'titleBar.activeBackground',
	'titleBar.inactiveBackground',
	'statusBar.background',
	'statusBar.noFolderBackground',
	'tab.activeBackground',
	'tab.inactiveBackground',
	'tab.unfocusedActiveBackground',
	'tab.unfocusedInactiveBackground',
	'terminal.background',
	'menu.background',
	'quickInput.background',
	'notifications.background',
	'notificationCenterHeader.background',
	'input.background',
	'dropdown.background',
	'peekViewEditor.background',
	'peekViewResult.background',
	'breadcrumb.background',
	'welcomePage.background',
]);

export function contrastRole(id: string): ContrastRole | undefined {
	if (UNTOUCHED.test(id)) {
		return undefined;
	}
	if (SURFACES.has(id)) {
		return 'surface';
	}
	const last = id.slice(id.lastIndexOf('.') + 1);
	if (last === 'foreground' || last.endsWith('Foreground')) {
		return 'text';
	}
	if (last === 'border' || last.endsWith('Border') || last === 'separatorBackground' || id === 'tree.indentGuidesStroke') {
		return 'border';
	}
	return undefined;
}

/** A setting value as a whole step inside the range; anything else is 0 (the theme as made). */
export function clampContrast(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return 0;
	}
	return Math.max(VOLT_THEME_CONTRAST_MIN, Math.min(VOLT_THEME_CONTRAST_MAX, Math.round(value)));
}

/** Grays, near-blacks and near-whites move toward the extreme; colored text keeps most of its hue. */
function isNeutral(color: Color): boolean {
	const { s, l } = color.hsla;
	return s < 0.25 || l < 0.12 || l > 0.9;
}

function withAlpha(color: Color, alpha: number): Color {
	const { r, g, b } = color.rgba;
	return new Color(new RGBA(r, g, b, Math.max(0, Math.min(1, Math.round(alpha * 1000) / 1000))));
}

function mixRgb(color: Color, target: Color, factor: number): Color {
	const mixed = color.mix(new Color(new RGBA(target.rgba.r, target.rgba.g, target.rgba.b, color.rgba.a)), factor);
	return mixed;
}

/**
 * The theme color moved for a contrast step. `amount` runs from -1 (softest) to 1 (strongest);
 * 0 returns the color untouched. `dark` says which way "more contrast" goes: text toward white
 * and surfaces toward black on a dark theme, the other way round on a light one. Fully
 * transparent colors (things a theme turned off) stay off.
 */
export function adjustColorForContrast(color: Color, role: ContrastRole, amount: number, dark: boolean): Color {
	const t = Math.max(-1, Math.min(1, amount));
	if (t === 0 || color.rgba.a === 0) {
		return color;
	}
	const ink = dark ? Color.white : Color.black;
	const paper = dark ? Color.black : Color.white;
	const a = color.rgba.a;
	switch (role) {
		case 'text': {
			if (t > 0) {
				const firmer = withAlpha(color, a + (1 - a) * t * 0.85);
				return mixRgb(firmer, ink, t * (isNeutral(color) ? 0.6 : 0.25));
			}
			return withAlpha(color, a * (1 + t * 0.45));
		}
		case 'border': {
			if (t > 0) {
				const firmer = withAlpha(color, a + (1 - a) * t * 0.6);
				return isNeutral(color) ? mixRgb(firmer, ink, t * 0.4) : firmer;
			}
			return withAlpha(color, a * (1 + t * 0.7));
		}
		case 'surface': {
			return t > 0 ? mixRgb(color, paper, t * 0.35) : mixRgb(color, ink, -t * 0.08);
		}
	}
}

/**
 * CSS variable overrides for a contrast step: `[cssVariable, value]` for every color that moved.
 * `colors` is every registered color id with the theme's resolved value.
 */
export function contrastOverrides(colors: Iterable<readonly [id: string, color: Color | undefined]>, amount: number, dark: boolean, cssVariable: (id: string) => string): [string, string][] {
	const result: [string, string][] = [];
	if (amount === 0) {
		return result;
	}
	for (const [id, color] of colors) {
		const role = color && contrastRole(id);
		if (!color || !role) {
			continue;
		}
		const adjusted = adjustColorForContrast(color, role, amount, dark);
		if (!adjusted.equals(color)) {
			result.push([cssVariable(id), adjusted.toString()]);
		}
	}
	return result;
}
