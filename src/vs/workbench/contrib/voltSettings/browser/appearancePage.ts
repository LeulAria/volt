/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/appearancePage.css';
import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { ISelectOptionItem, SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Color } from '../../../../base/common/color.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ColorScheme, isDark } from '../../../../platform/theme/common/theme.js';
import { ColorThemeData } from '../../../services/themes/common/colorThemeData.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService, ThemeSettings } from '../../../services/themes/common/workbenchThemeService.js';
import { AGENT_CODE_WRAP_SETTING, AGENT_THEMED_DIFFS_SETTING, AGENT_TOOL_DENSITIES, AGENT_TOOL_DENSITY_SETTING, AgentToolDensity, readToolDensity, VOLT_REDUCE_TRANSPARENCY_SETTING, VOLT_TINT_HUE_SETTING, VOLT_TINT_INTENSITY_SETTING, VOLT_UI_FONT_FAMILY_SETTING } from '../../voltAgent/common/agentAppearanceSettings.js';
import { mixTint, tintAmount, tintColor } from '../common/voltTint.js';

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

/** The settings editor's row helpers, lent to the sections drawn here. */
export interface ISettingsPageKit {
	sectionLabel(label: string): void;
	settingsGroup(): HTMLElement;
	settingRow(parent: HTMLElement, title: string, desc: string | undefined, renderControl?: (host: HTMLElement) => void): HTMLElement;
	stepper(parent: HTMLElement, valueText: string, unit: string, onCommit: (next: number) => number, step: number): void;
	selectBox(host: HTMLElement, options: ISelectOptionItem[], selected: number, ariaLabel: string): SelectBox;
}

/** A font choice: what the picker shows, and the font-family list it writes (empty: the default). */
interface IFontChoice {
	readonly label: string;
	readonly value: string;
}

const UI_FONTS: readonly IFontChoice[] = [
	{ label: localize('voltSettings.font.system', "System font"), value: '' },
	{ label: 'Inter', value: '"Inter"' },
	{ label: 'Geist', value: '"Geist"' },
	{ label: 'Helvetica Neue', value: '"Helvetica Neue"' },
	{ label: 'Avenir Next', value: '"Avenir Next"' },
	{ label: 'IBM Plex Sans', value: '"IBM Plex Sans"' },
	{ label: 'Segoe UI', value: '"Segoe UI"' },
	{ label: 'Roboto', value: '"Roboto"' },
];

const CODE_FONTS: readonly IFontChoice[] = [
	{ label: localize('voltSettings.font.codeDefault', "Geist Mono"), value: '' },
	{ label: localize('voltSettings.font.systemMono', "System monospace"), value: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
	{ label: 'SF Mono', value: '"SF Mono", Menlo, monospace' },
	{ label: 'Menlo', value: 'Menlo, monospace' },
	{ label: 'JetBrains Mono', value: '"JetBrains Mono", monospace' },
	{ label: 'Fira Code', value: '"Fira Code", monospace' },
	{ label: 'Cascadia Code', value: '"Cascadia Code", monospace' },
	{ label: 'Source Code Pro', value: '"Source Code Pro", monospace' },
	{ label: 'IBM Plex Mono', value: '"IBM Plex Mono", monospace' },
];

/** The sample the density preview draws: two edits and two commands. */
const DENSITY_SAMPLE: readonly { readonly kind: 'edit' | 'run'; readonly title: string; readonly meta: string }[] = [
	{ kind: 'edit', title: localize('voltSettings.density.edit1', "Edited math.ts"), meta: '+4 -1' },
	{ kind: 'edit', title: localize('voltSettings.density.edit2', "Edited README.md"), meta: '+5 -1' },
	{ kind: 'run', title: localize('voltSettings.density.run1', "Ran focused tests"), meta: 'npm test' },
	{ kind: 'run', title: localize('voltSettings.density.run2', "Ran type-check"), meta: 'npm run' },
];

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
	private readonly contextView: IContextViewService;

	constructor(
		instantiationService: IInstantiationService,
		private readonly store: DisposableStore,
		private readonly isCurrent: () => boolean,
	) {
		({ themes: this.themes, configuration: this.configuration, commands: this.commands, resources: this.resources, contextView: this.contextView } = instantiationService.invokeFunction(accessor => ({
			themes: accessor.get(IWorkbenchThemeService),
			configuration: accessor.get(IConfigurationService),
			commands: accessor.get(ICommandService),
			resources: accessor.get(IExtensionResourceLoaderService),
			contextView: accessor.get(IContextViewService),
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

	//#region Agent Conversations, Colors, Typography, High Contrast, Motion

	/** Tool call density (a three-stop slider that previews itself while hovered), code wrap, diff tints. */
	renderAgentConversations(kit: ISettingsPageKit): void {
		kit.sectionLabel(localize('voltSettings.agentConversations', "Agent Conversations"));
		const group = kit.settingsGroup();
		kit.settingRow(
			group,
			localize('voltSettings.toolDensity', "Tool Call Density"),
			localize('voltSettings.toolDensityDesc', "Adjust how much detail is shown for tool calls"),
			host => this.densityControl(host),
		);
		this.toggleRow(kit, group, localize('voltSettings.codeWrap', "Code Block Word Wrap"), localize('voltSettings.codeWrapDesc', "Wrap long lines in Agent conversation code blocks"), AGENT_CODE_WRAP_SETTING, false);
		this.toggleRow(kit, group, localize('voltSettings.themedDiffs', "Themed Diff Backgrounds"), localize('voltSettings.themedDiffsDesc', "Use themed background colors for inline code diffs"), AGENT_THEMED_DIFFS_SETTING, true);
	}

	/** Hue and Intensity of the window tint, and Reduce Transparency. */
	renderColors(kit: ISettingsPageKit): void {
		kit.sectionLabel(localize('voltSettings.colors', "Colors"));
		const group = kit.settingsGroup();
		let swatch: HTMLElement | undefined;
		let hue = this.configuration.getValue<number>(VOLT_TINT_HUE_SETTING) ?? 220;
		let intensity = this.configuration.getValue<number>(VOLT_TINT_INTENSITY_SETTING) ?? 0;
		// The swatch is the window's surface under the tint, as it will look.
		const paint = () => {
			const theme = this.themes.getColorTheme();
			const base = theme.getColor('sideBar.background') ?? theme.getColor('editor.background') ?? Color.black;
			if (swatch) {
				swatch.style.background = Color.Format.CSS.formatHexA(mixTint(base, tintColor(hue, isDark(theme.type)), tintAmount(intensity)));
			}
		};
		kit.settingRow(
			group,
			localize('voltSettings.hue', "Hue"),
			localize('voltSettings.hueDesc', "Choose a tint color"),
			host => {
				host.classList.add('volt-appearance-slider-row');
				this.slider(host, { min: 0, max: 360, value: hue, label: localize('voltSettings.hue', "Hue") }, next => {
					hue = next;
					paint();
				}, next => void this.configuration.updateValue(VOLT_TINT_HUE_SETTING, next));
				swatch = append(host, $('span.volt-appearance-swatch'));
				paint();
			},
		);
		kit.settingRow(
			group,
			localize('voltSettings.intensity', "Intensity"),
			localize('voltSettings.intensityDesc', "Control how strongly the tint is applied"),
			host => {
				host.classList.add('volt-appearance-slider-row');
				const value = $('span.volt-appearance-slider-value');
				value.textContent = `${intensity}%`;
				this.slider(host, { min: 0, max: 100, value: intensity, label: localize('voltSettings.intensity', "Intensity") }, next => {
					intensity = next;
					value.textContent = `${next}%`;
					paint();
				}, next => void this.configuration.updateValue(VOLT_TINT_INTENSITY_SETTING, next));
				host.appendChild(value);
			},
		);
		this.toggleRow(kit, group, localize('voltSettings.reduceTransparency', "Reduce Transparency"), localize('voltSettings.reduceTransparencyDesc', "Replace translucent surfaces with opaque backgrounds"), VOLT_REDUCE_TRANSPARENCY_SETTING, false);
	}

	/** Sizes and families for the interface and for code, a diff drawn in the code font, and font smoothing. */
	renderTypography(kit: ISettingsPageKit): void {
		kit.sectionLabel(localize('voltSettings.typography', "Typography"));
		const group = kit.settingsGroup();
		const zoom = () => this.configuration.getValue<number>('window.zoomLevel') ?? 0;
		kit.settingRow(
			group,
			localize('voltSettings.uiFontSize', "UI Font Size"),
			localize('voltSettings.uiFontSizeDesc', "Font size for the Volt interface. It scales the whole window."),
			// 13px is the interface at 100%: each size is a window zoom of size / 13.
			host => kit.stepper(host, String(Math.round(13 * Math.pow(1.2, zoom()))), '', size => {
				const clamped = Math.max(9, Math.min(24, Math.round(size)));
				void this.configuration.updateValue('window.zoomLevel', Math.log(clamped / 13) / Math.log(1.2));
				return clamped;
			}, 1),
		);
		kit.settingRow(
			group,
			localize('voltSettings.codeFontSize', "Code Font Size"),
			localize('voltSettings.codeFontSizeDesc2', "Font size for code editors and diffs"),
			host => kit.stepper(host, String(this.configuration.getValue<number>('editor.fontSize') ?? 13), '', size => {
				const clamped = Math.max(8, Math.min(32, Math.round(size)));
				void this.configuration.updateValue('editor.fontSize', clamped);
				return clamped;
			}, 1),
		);
		kit.settingRow(
			group,
			localize('voltSettings.uiFontFamily', "UI Font Family"),
			localize('voltSettings.uiFontFamilyDesc', "Override the Volt user interface typeface"),
			host => this.fontPicker(kit, host, UI_FONTS, VOLT_UI_FONT_FAMILY_SETTING, localize('voltSettings.uiFontFamily', "UI Font Family")),
		);
		const codeRow = kit.settingRow(
			group,
			localize('voltSettings.codeFontFamily', "Code Font Family"),
			localize('voltSettings.codeFontFamilyDesc', "Override the font for code editors and diffs"),
			host => this.fontPicker(kit, host, CODE_FONTS, 'editor.fontFamily', localize('voltSettings.codeFontFamily', "Code Font Family")),
		);
		codeRow.classList.add('has-preview');
		this.codeFontPreview(group);
		if (isMacintosh) {
			kit.settingRow(
				group,
				localize('voltSettings.fontSmoothing', "Font Smoothing"),
				localize('voltSettings.fontSmoothingDesc', "Use native macOS font anti-aliasing"),
				host => {
					const value = this.configuration.getValue<string>('workbench.fontAliasing');
					this.toggle(host, value === 'antialiased' || value === 'auto', localize('voltSettings.fontSmoothing', "Font Smoothing"), on => void this.configuration.updateValue('workbench.fontAliasing', on ? 'antialiased' : 'default'));
				},
			);
		}
	}

	renderHighContrast(kit: ISettingsPageKit): void {
		kit.sectionLabel(localize('voltSettings.highContrast', "High Contrast"));
		this.toggleRow(kit, kit.settingsGroup(), localize('voltSettings.followHighContrast', "Follow System High Contrast"), localize('voltSettings.followHighContrastDesc', "Switch to a high contrast theme when your OS is in a high contrast mode"), ThemeSettings.DETECT_HC, true);
	}

	renderMotion(kit: ISettingsPageKit): void {
		kit.sectionLabel(localize('voltSettings.motion', "Motion"));
		kit.settingRow(
			kit.settingsGroup(),
			localize('voltSettings.reduceMotion', "Reduce Motion"),
			localize('voltSettings.reduceMotionDesc', "Minimize interface animations. System follows your OS preference."),
			host => {
				const options = [
					{ id: 'auto', text: localize('voltSettings.motion.system', "System") },
					{ id: 'on', text: localize('voltSettings.motion.on', "On") },
					{ id: 'off', text: localize('voltSettings.motion.off', "Off") },
				];
				const current = this.configuration.getValue<string>('workbench.reduceMotion');
				const box = kit.selectBox(append(host, $('.volt-settings-select')), options.map(option => ({ text: option.text })), Math.max(0, options.findIndex(option => option.id === current)), localize('voltSettings.reduceMotion', "Reduce Motion"));
				this.store.add(box.onDidSelect(e => void this.configuration.updateValue('workbench.reduceMotion', options[e.index].id)));
			},
		);
	}

	private toggleRow(kit: ISettingsPageKit, group: HTMLElement, title: string, desc: string, key: string, defaultValue: boolean): void {
		kit.settingRow(group, title, desc, host => this.toggle(host, this.configuration.getValue<boolean>(key) ?? defaultValue, title, on => void this.configuration.updateValue(key, on)));
	}

	/** A switch that flips itself: the page does not redraw for these settings. */
	private toggle(host: HTMLElement, initial: boolean, label: string, onChange: (on: boolean) => void): void {
		let on = initial;
		const toggle = append(host, $('button.volt-settings-toggle')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-label', label);
		const paint = () => {
			toggle.classList.toggle('on', on);
			toggle.setAttribute('aria-checked', String(on));
		};
		paint();
		this.store.add(addDisposableListener(toggle, 'click', () => {
			on = !on;
			paint();
			onChange(on);
		}));
	}

	/** A range slider: `onInput` follows the drag, `onCommit` gets the value where it was let go. */
	private slider(host: HTMLElement, range: { readonly min: number; readonly max: number; readonly value: number; readonly step?: number; readonly label: string; readonly stops?: number }, onInput: (value: number) => void, onCommit: (value: number) => void): HTMLInputElement {
		const input = append(host, $('input.volt-appearance-slider')) as HTMLInputElement;
		input.type = 'range';
		input.min = String(range.min);
		input.max = String(range.max);
		input.step = String(range.step ?? 1);
		input.value = String(range.value);
		input.setAttribute('aria-label', range.label);
		this.store.add(addDisposableListener(input, 'input', () => onInput(Number(input.value))));
		this.store.add(addDisposableListener(input, 'change', () => onCommit(Number(input.value))));
		return input;
	}

	/**
	 * Compact, standard, detailed on three stops (the middle one dotted), labeled at its ends. While
	 * hovered or focused, a card under it shows what a chat draws at the stop under the thumb.
	 */
	private densityControl(host: HTMLElement): void {
		host.classList.add('volt-appearance-density');
		let density = readToolDensity(this.configuration);
		let preview: HTMLElement | undefined;
		let hovered = false;
		let focused = false;
		const track = append(host, $('.volt-appearance-density-track'));
		const input = this.slider(track, { min: 0, max: AGENT_TOOL_DENSITIES.length - 1, value: AGENT_TOOL_DENSITIES.indexOf(density), label: localize('voltSettings.toolDensity', "Tool Call Density") }, index => {
			density = AGENT_TOOL_DENSITIES[index] ?? 'compact';
			input.setAttribute('aria-valuetext', densityLabel(density));
			if (preview) {
				renderDensityPreview(preview, density);
			}
		}, index => void this.configuration.updateValue(AGENT_TOOL_DENSITY_SETTING, AGENT_TOOL_DENSITIES[index] ?? 'compact'));
		input.classList.add('stops');
		input.setAttribute('aria-valuetext', densityLabel(density));
		const labels = append(host, $('.volt-appearance-density-labels'));
		append(labels, $('span')).textContent = densityLabel('compact');
		append(labels, $('span')).textContent = densityLabel('detailed');

		const update = () => {
			if ((hovered || focused) && !preview) {
				this.contextView.showContextView({
					getAnchor: () => host,
					anchorAlignment: AnchorAlignment.RIGHT,
					anchorPosition: AnchorPosition.BELOW,
					render: container => {
						preview = append(container, $('.volt-appearance-density-preview'));
						renderDensityPreview(preview, density);
						return toDisposable(() => preview = undefined);
					},
					onHide: () => preview = undefined,
				});
			} else if (!hovered && !focused && preview) {
				this.contextView.hideContextView();
			}
		};
		this.store.add(addDisposableListener(host, 'mouseenter', () => { hovered = true; update(); }));
		this.store.add(addDisposableListener(host, 'mouseleave', () => { hovered = false; update(); }));
		this.store.add(addDisposableListener(input, 'focus', () => { focused = true; update(); }));
		this.store.add(addDisposableListener(input, 'blur', () => { focused = false; update(); }));
		this.store.add(toDisposable(() => {
			if (preview) {
				this.contextView.hideContextView();
			}
		}));
	}

	/** A font picker; a family set elsewhere that is not in the list shows as Custom. */
	private fontPicker(kit: ISettingsPageKit, host: HTMLElement, choices: readonly IFontChoice[], key: string, label: string): void {
		const user = this.configuration.inspect<string>(key).userValue?.trim() ?? '';
		const options = [...choices];
		let selected = options.findIndex(choice => choice.value === user);
		if (selected < 0) {
			options.push({ label: localize('voltSettings.font.custom', "Custom ({0})", user.split(',')[0].replace(/["']/g, '').trim()), value: user });
			selected = options.length - 1;
		}
		const box = kit.selectBox(append(host, $('.volt-settings-select')), options.map(choice => ({ text: choice.label })), selected, label);
		this.store.add(box.onDidSelect(e => void this.configuration.updateValue(key, options[e.index].value || undefined)));
	}

	/** A two-line edit in the code font and size, tinted as chat diffs are. */
	private codeFontPreview(group: HTMLElement): void {
		const theme = this.themes.getColorTheme();
		const family = this.configuration.getValue<string>('editor.fontFamily');
		const preview = append(group, $('.volt-appearance-code-preview'));
		if (family) {
			preview.style.fontFamily = family;
		}
		preview.style.fontSize = `${this.configuration.getValue<number>('editor.fontSize') || 13}px`;
		const keyword = tokenColor(theme, ['keyword', 'storage.type', 'keyword.control', 'storage']);
		const variable = tokenColor(theme, ['variable', 'variable.other', 'variable.other.readwrite']);
		const line = (kind: 'insert' | 'delete', num: number, parts: [string, string | undefined][]) => {
			const row = append(preview, $(`.volt-appearance-code-line.${kind}`));
			append(row, $('span.num')).textContent = String(num);
			const text = append(row, $('span.text'));
			for (const [part, color] of parts) {
				const span = append(text, $('span'));
				span.textContent = part;
				if (color) {
					span.style.color = color;
				}
			}
		};
		line('delete', 1, [['return', keyword], [' ', undefined], ['a', variable], [' + ', undefined], ['b', variable], [';', undefined]]);
		line('insert', 1, [['const', keyword], [' ', undefined], ['result', variable], [' = ', undefined], ['a', variable], [' + ', undefined], ['b', variable], [';', undefined]]);
		line('insert', 2, [['return', keyword], [' ', undefined], ['result', variable], [';', undefined]]);
	}

	//#endregion
}

function densityLabel(density: AgentToolDensity): string {
	switch (density) {
		case 'compact': return localize('voltSettings.density.compact', "Compact");
		case 'standard': return localize('voltSettings.density.standard', "Standard");
		case 'detailed': return localize('voltSettings.density.detailed', "Detailed");
	}
}

/** What a chat shows at `density`, drawn with the sample work: one line, a line per call, or cards. */
function renderDensityPreview(host: HTMLElement, density: AgentToolDensity): void {
	host.replaceChildren();
	host.className = `volt-appearance-density-preview ${density}`;
	if (density === 'compact') {
		const line = append(host, $('.line'));
		append(line, $('span.title')).textContent = localize('voltSettings.density.compactVerb', "Edited");
		append(line, $('span.meta')).textContent = localize('voltSettings.density.compactDetail', "2 files, ran 2 commands");
		return;
	}
	for (const step of DENSITY_SAMPLE) {
		const parent = density === 'detailed' ? append(host, $('.card')) : host;
		const line = append(parent, $('.line'));
		append(line, $('span.title')).textContent = step.title;
		append(line, $('span.meta')).textContent = step.meta;
		if (density === 'detailed') {
			const body = append(parent, $('.body'));
			for (const bar of step.kind === 'edit' ? ['delete', 'delete short', 'insert', 'insert short'] : ['', 'short']) {
				append(body, $(`span.bar${bar ? `.${bar.replace(' ', '.')}` : ''}`));
			}
		}
	}
}
