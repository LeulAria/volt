/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ColorScheme, isDark } from '../../../../platform/theme/common/theme.js';
import { ColorThemeData } from '../../../services/themes/common/colorThemeData.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService, ThemeSettings } from '../../../services/themes/common/workbenchThemeService.js';

/** What a theme card paints: a sidebar, an editor with a few lines of code, and an accent. */
interface IThemeSwatch {
	readonly sidebar: string;
	readonly editor: string;
	readonly foreground: string;
	readonly muted: string;
	readonly accent: string;
	readonly keyword: string;
	readonly string: string;
	readonly func: string;
}

/** Volt's own themes lead each list; the rest follow by name. */
function themeOrder(a: IWorkbenchColorTheme, b: IWorkbenchColorTheme): number {
	const volt = (theme: IWorkbenchColorTheme) => theme.settingsId.startsWith('Volt ') ? 0 : 1;
	return volt(a) - volt(b) || a.label.localeCompare(b.label);
}

function tokenColor(theme: IWorkbenchColorTheme, scopes: readonly string[]): string | undefined {
	for (const rule of theme.tokenColors) {
		const ruleScopes = Array.isArray(rule.scope) ? rule.scope : typeof rule.scope === 'string' ? rule.scope.split(',').map(scope => scope.trim()) : [];
		if (rule.settings?.foreground && ruleScopes.some(scope => scopes.includes(scope))) {
			return rule.settings.foreground;
		}
	}
	return undefined;
}

function swatch(theme: IWorkbenchColorTheme): IThemeSwatch {
	const color = (id: string, fallback: string) => theme.getColor(id, true)?.toString() ?? fallback;
	const dark = isDark(theme.type);
	const foreground = color('editor.foreground', dark ? '#d4d4d4' : '#1f1f1f');
	return {
		sidebar: color('sideBar.background', color('editor.background', dark ? '#181818' : '#f3f3f3')),
		editor: color('editor.background', dark ? '#1e1e1e' : '#ffffff'),
		foreground,
		muted: color('editorLineNumber.foreground', dark ? '#6e7681' : '#9a9a9a'),
		accent: color('button.background', color('focusBorder', '#3b82f6')),
		keyword: tokenColor(theme, ['keyword', 'storage.type', 'keyword.control', 'storage']) ?? foreground,
		string: tokenColor(theme, ['string', 'string.quoted']) ?? foreground,
		func: tokenColor(theme, ['entity.name.function', 'support.function']) ?? foreground,
	};
}

type AppearanceMode = 'system' | 'light' | 'dark';

/**
 * Volt Settings > Appearance: System / Light / Dark, and every installed color theme as a card
 * drawn in its own colors. Picking a card applies it at once; under System it becomes the theme
 * for that scheme.
 */
export class AppearancePage {

	private readonly themes: IWorkbenchThemeService;
	private readonly configuration: IConfigurationService;
	private readonly commands: ICommandService;
	private readonly resources: IExtensionResourceLoaderService;

	constructor(
		instantiationService: IInstantiationService,
		private readonly store: DisposableStore,
		private readonly isCurrent: () => boolean,
	) {
		({ themes: this.themes, configuration: this.configuration, commands: this.commands, resources: this.resources } = instantiationService.invokeFunction(accessor => ({
			themes: accessor.get(IWorkbenchThemeService),
			configuration: accessor.get(IConfigurationService),
			commands: accessor.get(ICommandService),
			resources: accessor.get(IExtensionResourceLoaderService),
		})));
	}

	mode(): AppearanceMode {
		if (this.configuration.getValue<boolean>(ThemeSettings.DETECT_COLOR_SCHEME)) {
			return 'system';
		}
		return isDark(this.themes.getColorTheme().type) ? 'dark' : 'light';
	}

	/** System follows the OS; Light and Dark switch to that scheme's preferred theme. */
	async setMode(mode: AppearanceMode): Promise<void> {
		if (mode === 'system') {
			await this.configuration.updateValue(ThemeSettings.DETECT_COLOR_SCHEME, true);
			return;
		}
		await this.configuration.updateValue(ThemeSettings.DETECT_COLOR_SCHEME, false);
		const current = this.themes.getColorTheme();
		if (isDark(current.type) === (mode === 'dark')) {
			return;
		}
		// setColorTheme takes a theme's internal id; settings hold its settings id.
		const preferred = this.preferredTheme(mode === 'dark' ? ColorScheme.DARK : ColorScheme.LIGHT);
		const themes = await this.themes.getColorThemes();
		const theme = themes.find(candidate => candidate.settingsId === preferred)
			?? themes.find(candidate => isDark(candidate.type) === (mode === 'dark') && candidate.settingsId.startsWith('Volt '));
		if (theme) {
			await this.themes.setColorTheme(theme, 'auto');
		}
	}

	private preferredTheme(scheme: ColorScheme): string {
		const id = this.configuration.getValue<string>(scheme === ColorScheme.DARK ? ThemeSettings.PREFERRED_DARK_THEME : ThemeSettings.PREFERRED_LIGHT_THEME) ?? '';
		return id.startsWith('Cursor ') ? `Volt ${id.slice('Cursor '.length)}` : id;
	}

	/** Picks a theme. Under System it is saved as that scheme's theme too, so the OS switch keeps it. */
	private async pick(theme: IWorkbenchColorTheme): Promise<void> {
		if (this.configuration.getValue<boolean>(ThemeSettings.DETECT_COLOR_SCHEME)) {
			const key = isDark(theme.type) ? ThemeSettings.PREFERRED_DARK_THEME : ThemeSettings.PREFERRED_LIGHT_THEME;
			await this.configuration.updateValue(key, theme.settingsId);
			if (isDark(theme.type) !== isDark(this.themes.getColorTheme().type)) {
				// The OS is on the other scheme: the pick waits for it, so say nothing changed on screen.
				return;
			}
		}
		await this.themes.setColorTheme(theme, 'auto');
	}

	renderModeControl(host: HTMLElement): void {
		host.classList.add('wide');
		const control = append(host, $('.volt-settings-segmented'));
		control.setAttribute('role', 'radiogroup');
		const current = this.mode();
		const options: { id: AppearanceMode; label: string }[] = [
			{ id: 'system', label: localize('voltSettings.appearance.system', "System") },
			{ id: 'light', label: localize('voltSettings.appearance.light', "Light") },
			{ id: 'dark', label: localize('voltSettings.appearance.dark', "Dark") },
		];
		for (const option of options) {
			const button = append(control, $('button.volt-settings-segment')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'radio');
			button.setAttribute('aria-checked', String(option.id === current));
			button.classList.toggle('active', option.id === current);
			append(button, $('span')).textContent = option.label;
			this.store.add(addDisposableListener(button, 'click', () => void this.setMode(option.id)));
		}
	}

	/** Theme cards, dark ones then light ones. Themes load their colors first so the cards show them. */
	async renderGallery(host: HTMLElement, needle: string): Promise<void> {
		const all = (await this.themes.getColorThemes()).filter(theme => !needle || theme.label.toLowerCase().includes(needle));
		await Promise.all(all.map(theme => theme instanceof ColorThemeData ? theme.ensureLoaded(this.resources).catch(() => undefined) : undefined));
		if (!this.isCurrent()) {
			return;
		}
		const active = this.themes.getColorTheme().settingsId;
		const system = this.configuration.getValue<boolean>(ThemeSettings.DETECT_COLOR_SCHEME);
		const preferred = new Set([this.preferredTheme(ColorScheme.DARK), this.preferredTheme(ColorScheme.LIGHT)]);
		const groups: { title: string; themes: IWorkbenchColorTheme[] }[] = [
			{ title: localize('voltSettings.appearance.darkThemes', "Dark"), themes: all.filter(theme => isDark(theme.type)).sort(themeOrder) },
			{ title: localize('voltSettings.appearance.lightThemes', "Light"), themes: all.filter(theme => !isDark(theme.type)).sort(themeOrder) },
		];
		for (const group of groups) {
			if (!group.themes.length) {
				continue;
			}
			append(host, $('.volt-settings-theme-group-title')).textContent = group.title;
			const grid = append(host, $('.volt-settings-theme-grid'));
			for (const theme of group.themes) {
				this.themeCard(grid, theme, theme.settingsId === active, system && preferred.has(theme.settingsId) && theme.settingsId !== active);
			}
		}
		const more = append(host, $('button.volt-settings-link')) as HTMLButtonElement;
		more.type = 'button';
		more.appendChild(renderIcon(Codicon.extensions));
		append(more, $('span')).textContent = localize('voltSettings.appearance.more', "Browse more themes");
		// The color theme quick pick: every installed theme by scheme, plus Browse Additional Color
		// Themes. Quick input sits above the settings overlay, so the page stays open under it.
		this.store.add(addDisposableListener(more, 'click', () => void this.commands.executeCommand('workbench.action.selectTheme')));
	}

	private themeCard(grid: HTMLElement, theme: IWorkbenchColorTheme, active: boolean, standby: boolean): void {
		const colors = swatch(theme);
		const card = append(grid, $('button.volt-settings-theme')) as HTMLButtonElement;
		card.type = 'button';
		card.classList.toggle('active', active);
		card.setAttribute('aria-pressed', String(active));
		card.title = theme.label;

		const preview = append(card, $('.volt-settings-theme-preview'));
		preview.style.background = colors.editor;
		const side = append(preview, $('.side'));
		side.style.background = colors.sidebar;
		for (let i = 0; i < 3; i++) {
			const item = append(side, $('span'));
			item.style.background = colors.muted;
		}
		const code = append(preview, $('.code'));
		const line = (parts: [string, number][]) => {
			const row = append(code, $('.line'));
			for (const [color, width] of parts) {
				const token = append(row, $('span'));
				token.style.background = color;
				token.style.width = `${width}%`;
			}
		};
		line([[colors.keyword, 22], [colors.func, 34]]);
		line([[colors.foreground, 16], [colors.string, 44]]);
		line([[colors.keyword, 14], [colors.foreground, 26], [colors.func, 20]]);
		line([[colors.muted, 38]]);
		const accent = append(preview, $('.accent'));
		accent.style.background = colors.accent;

		const label = append(card, $('.volt-settings-theme-label'));
		append(label, $('span.name')).textContent = theme.label;
		if (active) {
			append(label, $('span.check')).appendChild(renderIcon(Codicon.check));
		} else if (standby) {
			const tag = append(label, $('span.tag'));
			tag.textContent = isDark(theme.type) ? localize('voltSettings.appearance.whenDark', "When dark") : localize('voltSettings.appearance.whenLight', "When light");
		}
		this.store.add(addDisposableListener(card, 'click', () => void this.pick(theme)));
	}
}
