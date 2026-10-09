/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The colors a theme picker row paints so a theme can be told apart before it is applied. */
export interface IVoltThemeSwatches {
	/** Editor background: the tile's fill. */
	readonly background: string;
	/** The side bar's fill, drawn as the tile's left strip. */
	readonly surface: string;
	readonly foreground: string;
	/** Buttons and focus rings. */
	readonly accent: string;
	readonly keyword: string;
	readonly string: string;
	readonly func: string;
	readonly comment: string;
}

/** A TextMate rule as theme files write it: `scope` is one selector, a comma list, or an array. */
export interface IVoltThemeTokenRule {
	readonly scope?: string | readonly string[];
	readonly settings?: { readonly foreground?: string };
}

/** The workbench color, or the next one down the list when the theme leaves it out. */
function firstColor(getColor: (id: string) => string | undefined, ids: readonly string[]): string | undefined {
	for (const id of ids) {
		const value = getColor(id);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function selectorsOf(scope: IVoltThemeTokenRule['scope']): string[] {
	if (!scope) {
		return [];
	}
	const list = typeof scope === 'string' ? scope.split(',') : scope.flatMap(s => s.split(','));
	return list.map(s => s.trim()).filter(Boolean);
}

/**
 * The foreground a theme gives a token scope: the rule whose selector matches the most dots of
 * it wins, a later rule winning a tie (as TextMate themes cascade). Descendant selectors
 * (`source.js keyword`) only count by their last part, enough for a preview.
 */
export function tokenForeground(rules: readonly IVoltThemeTokenRule[], scope: string): string | undefined {
	let best: { depth: number; color: string } | undefined;
	for (const rule of rules) {
		const color = rule.settings?.foreground;
		if (!color) {
			continue;
		}
		for (const selector of selectorsOf(rule.scope)) {
			const last = selector.slice(selector.lastIndexOf(' ') + 1);
			if (last === scope || scope.startsWith(`${last}.`)) {
				const depth = last.split('.').length;
				if (!best || depth >= best.depth) {
					best = { depth, color };
				}
			}
		}
	}
	return best?.color;
}

function tokenColor(rules: readonly IVoltThemeTokenRule[], scopes: readonly string[]): string | undefined {
	for (const scope of scopes) {
		const color = tokenForeground(rules, scope);
		if (color) {
			return color;
		}
	}
	return undefined;
}

/**
 * Swatches for a loaded theme. `getColor` returns the theme's resolved workbench color (with
 * registry defaults); `rules` are its token colors. Missing token colors fall back to the
 * foreground so a sparse theme still draws a sensible tile.
 */
export function extractThemeSwatches(getColor: (id: string) => string | undefined, rules: readonly IVoltThemeTokenRule[], dark: boolean): IVoltThemeSwatches {
	const background = firstColor(getColor, ['editor.background']) ?? (dark ? '#1e1e1e' : '#ffffff');
	const foreground = firstColor(getColor, ['editor.foreground', 'foreground']) ?? (dark ? '#cccccc' : '#333333');
	return {
		background,
		surface: firstColor(getColor, ['sideBar.background', 'activityBar.background', 'editorGroupHeader.tabsBackground']) ?? background,
		foreground,
		accent: firstColor(getColor, ['button.background', 'focusBorder', 'textLink.foreground']) ?? foreground,
		keyword: tokenColor(rules, ['keyword.control', 'keyword', 'storage.type']) ?? foreground,
		string: tokenColor(rules, ['string.quoted', 'string']) ?? foreground,
		func: tokenColor(rules, ['entity.name.function', 'support.function', 'entity.name.type']) ?? foreground,
		comment: tokenColor(rules, ['comment.line', 'comment']) ?? foreground,
	};
}
