/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { asCssVariableName, getColorRegistry } from '../../../../platform/theme/common/colorRegistry.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { clampContrast, contrastOverrides, VOLT_THEME_CONTRAST_SETTING } from '../common/voltThemeContrast.js';

export const IVoltThemeContrastService = createDecorator<IVoltThemeContrastService>('voltThemeContrastService');

export interface IVoltThemeContrastService {
	readonly _serviceBrand: undefined;
	/** The contrast on screen: the picker's preview while one is open, else the setting. */
	readonly value: number;
	/** The contrast in the user's settings. */
	readonly saved: number;
	readonly onDidChange: Event<number>;
	/** Shows a contrast without saving it; `undefined` goes back to the setting. */
	preview(value: number | undefined): void;
	/** Saves a contrast to the user's settings (0 removes the setting). */
	set(value: number): Promise<void>;
}

/**
 * Applies `volt.theme.contrast` on top of whatever theme is active. The theme service writes
 * every color as a `--vscode-*` variable on `.monaco-workbench`; this writes a second rule with
 * the text, border and surface colors moved, one selector stronger, so clearing it gives the
 * theme back exactly. Colors only: no CSS filter over the window (it is see-through).
 */
class VoltThemeContrastService extends Disposable implements IVoltThemeContrastService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<number>());
	readonly onDidChange = this._onDidChange.event;

	private readonly style: HTMLStyleElement;
	private previewValue: number | undefined;
	private applied = 0;
	private appliedThemeId: string | undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
	) {
		super();
		this.style = createStyleSheet(undefined, undefined, this._store);
		this.style.className = 'volt-theme-contrast';
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VOLT_THEME_CONTRAST_SETTING)) {
				this.apply(false);
			}
		}));
		this._register(this.themeService.onDidColorThemeChange(() => this.apply(true)));
		this.apply(true);
	}

	get value(): number {
		return this.previewValue ?? this.saved;
	}

	get saved(): number {
		return clampContrast(this.configurationService.getValue(VOLT_THEME_CONTRAST_SETTING));
	}

	preview(value: number | undefined): void {
		this.previewValue = value === undefined ? undefined : clampContrast(value);
		this.apply(false);
	}

	async set(value: number): Promise<void> {
		const next = clampContrast(value);
		this.previewValue = undefined;
		await this.configurationService.updateValue(VOLT_THEME_CONTRAST_SETTING, next === 0 ? undefined : next);
		this.apply(false);
	}

	private apply(themeChanged: boolean): void {
		const value = this.value;
		const theme = this.themeService.getColorTheme();
		if (!themeChanged && value === this.applied && theme.id === this.appliedThemeId) {
			return;
		}
		const changed = value !== this.applied;
		this.applied = value;
		this.appliedThemeId = theme.id;
		const dark = theme.type === ColorScheme.DARK || theme.type === ColorScheme.HIGH_CONTRAST_DARK;
		const colors = getColorRegistry().getColors().map(c => [c.id, theme.getColor(c.id, true)] as const);
		const overrides = contrastOverrides(colors, value / 100, dark, asCssVariableName);
		// `:root` makes this outrank the theme's own `.monaco-workbench` rule wherever it lands.
		this.style.textContent = overrides.length
			? `:root .monaco-workbench { ${overrides.map(([name, color]) => `${name}: ${color};`).join(' ')} }`
			: '';
		if (changed) {
			this._onDidChange.fire(value);
		}
	}
}

registerSingleton(IVoltThemeContrastService, VoltThemeContrastService, InstantiationType.Delayed);
