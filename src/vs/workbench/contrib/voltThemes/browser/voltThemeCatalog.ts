/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../../../base/common/color.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { ColorScheme, isHighContrast } from '../../../../platform/theme/common/theme.js';
import { ColorThemeData } from '../../../services/themes/common/colorThemeData.js';
import { IWorkbenchColorTheme } from '../../../services/themes/common/workbenchThemeService.js';
import { extractThemeSwatches, IVoltThemeSwatches } from '../common/voltThemeSwatches.js';

export type VoltThemeGroup = 'dark' | 'light' | 'hc';

export function themeGroup(theme: IWorkbenchColorTheme): VoltThemeGroup {
	return isHighContrast(theme.type) ? 'hc' : theme.type === ColorScheme.LIGHT ? 'light' : 'dark';
}

function isDarkType(type: ColorScheme): boolean {
	return type === ColorScheme.DARK || type === ColorScheme.HIGH_CONTRAST_DARK;
}

function swatchesOf(theme: IWorkbenchColorTheme): IVoltThemeSwatches {
	const hex = (id: string) => {
		const color = theme.getColor(id, true);
		return color ? Color.Format.CSS.formatHexA(color, true) : undefined;
	};
	return extractThemeSwatches(hex, theme.tokenColors, isDarkType(theme.type));
}

/** Swatches by theme id. Themes do not change once loaded, so a picker opened again is instant. */
const cache = new Map<string, Promise<IVoltThemeSwatches>>();

/**
 * Reads a theme's colors without applying it: a private copy of the theme is loaded from the
 * theme's file, so the registered theme (and its user customizations) is left alone. The active
 * theme is read as it is, customizations included, and never cached.
 */
export function loadThemeSwatches(theme: IWorkbenchColorTheme, active: IWorkbenchColorTheme, loader: IExtensionResourceLoaderService): Promise<IVoltThemeSwatches> {
	if (theme.id === active.id) {
		return Promise.resolve(swatchesOf(active));
	}
	const location = theme instanceof ColorThemeData ? theme.location : undefined;
	const key = `${theme.id}|${location?.toString() ?? ''}`;
	let pending = cache.get(key);
	if (!pending) {
		pending = (async () => {
			if (!location) {
				return swatchesOf(theme);
			}
			const copy = ColorThemeData.createUnloadedTheme(theme.id);
			copy.location = location;
			await copy.ensureLoaded(loader);
			return swatchesOf(copy);
		})();
		pending.catch(() => cache.delete(key));
		cache.set(key, pending);
	}
	return pending;
}
