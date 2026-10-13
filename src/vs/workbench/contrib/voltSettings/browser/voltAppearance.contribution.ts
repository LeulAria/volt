/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltAppearance.css';
import { createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { Color } from '../../../../base/common/color.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { asCssVariableName } from '../../../../platform/theme/common/colorUtils.js';
import { isDark } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { mixTint, tintAmount, tintColor } from '../common/voltTint.js';
import { AGENT_CODE_WRAP_SETTING, AGENT_THEMED_DIFFS_SETTING, VOLT_REDUCE_TRANSPARENCY_SETTING, VOLT_TINT_HUE_SETTING, VOLT_TINT_INTENSITY_SETTING, VOLT_UI_FONT_FAMILY_SETTING } from '../../voltAgent/common/agentAppearanceSettings.js';

/** The surfaces a tint washes over: the theme's backgrounds, not its text, borders or accents. */
const TINTED_BACKGROUNDS = [
	'editor.background', 'editorGutter.background', 'editorGroupHeader.tabsBackground', 'editorStickyScroll.background', 'breadcrumb.background',
	'tab.activeBackground', 'tab.inactiveBackground', 'tab.unfocusedActiveBackground', 'tab.unfocusedInactiveBackground',
	'sideBar.background', 'sideBarSectionHeader.background', 'sideBarStickyScroll.background', 'activityBar.background',
	'titleBar.activeBackground', 'titleBar.inactiveBackground', 'statusBar.background', 'statusBar.noFolderBackground',
	'panel.background', 'panelStickyScroll.background', 'terminal.background', 'minimap.background',
	'input.background', 'dropdown.background', 'menu.background', 'editorWidget.background', 'quickInput.background', 'notifications.background',
];

const WATCHED = [AGENT_CODE_WRAP_SETTING, AGENT_THEMED_DIFFS_SETTING, VOLT_REDUCE_TRANSPARENCY_SETTING, VOLT_TINT_HUE_SETTING, VOLT_TINT_INTENSITY_SETTING, VOLT_UI_FONT_FAMILY_SETTING];

/**
 * Applies Settings > Appearance to every window: classes for code wrap, diff tints and reduced
 * transparency (voltAppearance.css, agentMarkdown.css), the interface font, and the tint (theme
 * background variables mixed toward the chosen hue, redone whenever the theme changes).
 */
class VoltAppearanceContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAppearance';

	private readonly tintSheet = createStyleSheet(undefined, undefined, this._store);

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IThemeService private readonly themeService: IThemeService,
	) {
		super();
		this.applyAll();
		this._register(this.layoutService.onDidAddContainer(({ container }) => this.applyTo(container)));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (WATCHED.some(key => e.affectsConfiguration(key))) {
				this.applyAll();
			}
		}));
		this._register(this.themeService.onDidColorThemeChange(() => this.updateTint()));
	}

	private applyAll(): void {
		for (const container of this.layoutService.containers) {
			this.applyTo(container);
		}
		this.updateTint();
	}

	private applyTo(container: HTMLElement): void {
		const get = <T>(key: string) => this.configurationService.getValue<T>(key);
		container.classList.toggle('volt-code-wrap', get<boolean>(AGENT_CODE_WRAP_SETTING) === true);
		const themed = get<boolean>(AGENT_THEMED_DIFFS_SETTING) !== false;
		container.classList.toggle('volt-themed-diffs', themed);
		container.classList.toggle('volt-plain-diffs', !themed);
		container.classList.toggle('volt-reduce-transparency', get<boolean>(VOLT_REDUCE_TRANSPARENCY_SETTING) === true);
		const family = (get<string>(VOLT_UI_FONT_FAMILY_SETTING) ?? '').trim();
		container.classList.toggle('volt-ui-font', !!family);
		if (family) {
			container.style.setProperty('--volt-ui-font-family', `${family}, -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", sans-serif`);
		} else {
			container.style.removeProperty('--volt-ui-font-family');
		}
		container.classList.toggle('volt-tinted', this.intensity() > 0);
	}

	private intensity(): number {
		return Number(this.configurationService.getValue<number>(VOLT_TINT_INTENSITY_SETTING)) || 0;
	}

	/** One global sheet (cloned into every window) overrides the background variables under `.volt-tinted`. */
	private updateTint(): void {
		const intensity = this.intensity();
		if (intensity <= 0) {
			this.tintSheet.textContent = '';
			return;
		}
		const theme = this.themeService.getColorTheme();
		const tint = tintColor(Number(this.configurationService.getValue<number>(VOLT_TINT_HUE_SETTING)) || 0, isDark(theme.type));
		const amount = tintAmount(intensity);
		const rules: string[] = [];
		for (const id of TINTED_BACKGROUNDS) {
			const color = theme.getColor(id);
			if (color) {
				rules.push(`${asCssVariableName(id)}: ${Color.Format.CSS.formatHexA(mixTint(color, tint, amount))};`);
			}
		}
		this.tintSheet.textContent = `.monaco-workbench.volt-tinted { ${rules.join(' ')} }`;
	}
}

registerWorkbenchContribution2(VoltAppearanceContribution.ID, VoltAppearanceContribution, WorkbenchPhase.BlockRestore);
