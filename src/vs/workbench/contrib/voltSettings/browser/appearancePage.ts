/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/appearancePage.css';
import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { Color } from '../../../../base/common/color.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ColorScheme, isDark } from '../../../../platform/theme/common/theme.js';
import { ColorThemeData } from '../../../services/themes/common/colorThemeData.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService, ThemeSettings } from '../../../services/themes/common/workbenchThemeService.js';
import { AGENT_CODE_WRAP_SETTING, AGENT_THEMED_DIFFS_SETTING, AGENT_TOOL_DENSITIES, AGENT_TOOL_DENSITY_SETTING, AgentToolDensity, readToolDensity, VOLT_REDUCE_TRANSPARENCY_SETTING, VOLT_TINT_HUE_SETTING, VOLT_TINT_INTENSITY_SETTING, VOLT_UI_FONT_FAMILY_SETTING, VOLT_WINDOW_TRANSPARENCY_SETTING } from '../../voltAgent/common/agentAppearanceSettings.js';
import { mixTint, tintAmount, tintColor } from '../common/voltTint.js';
import { createVoltDropdown } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { createSettingsIcon } from './settingsIcons.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';


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

/** A small chip in a theme's colors for its menu row: sidebar, editor, and the accent in a corner. */
function themeChip(theme: IWorkbenchColorTheme): HTMLElement {
	const color = (id: string, fallback: string) => theme.getColor(id, true)?.toString() ?? fallback;
	const dark = isDark(theme.type);
	const editor = color('editor.background', dark ? '#1e1e1e' : '#ffffff');
	const sidebar = color('sideBar.background', editor);
	const accent = color('button.background', color('focusBorder', '#3b82f6'));
	const chip = $('span.volt-settings-theme-chip');
	chip.style.background = `linear-gradient(${accent}, ${accent}) right 2px bottom 2px / 6px 3px no-repeat, linear-gradient(90deg, ${sidebar} 0 38%, ${editor} 38%)`;
	return chip;
}

type AppearanceMode = 'system' | 'light' | 'dark';

/** The settings editor's row helpers, lent to the sections drawn here. */
export interface ISettingsPageKit {
	sectionLabel(label: string): void;
	settingsGroup(): HTMLElement;
	settingRow(parent: HTMLElement, title: string, desc: string | undefined, renderControl?: (host: HTMLElement) => void): HTMLElement;
	stepper(parent: HTMLElement, valueText: string, unit: string, onCommit: (next: number) => number, step: number): void;
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
 * Volt Settings > Appearance: System / Light / Dark, then a dark theme and a light theme picked from
 * dropdowns of every installed color theme. A pick for the scheme on screen applies at once; the
 * other waits for Mode or System to switch to it.
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

	/** System / Light / Dark as a dropdown, each with its glyph. */
	renderModeControl(host: HTMLElement): void {
		const option = (id: AppearanceMode, label: string, description: string) => ({ id, label, description, icon: () => createSettingsIcon(`appearance-${id}`)! });
		createVoltDropdown(host, this.contextView, {
			options: [
				option('system', localize('voltSettings.appearance.system', "System"), localize('voltSettings.appearance.systemDesc', "Follows macOS light and dark")),
				option('light', localize('voltSettings.appearance.light', "Light"), localize('voltSettings.appearance.lightDesc', "Always your light theme")),
				option('dark', localize('voltSettings.appearance.dark', "Dark"), localize('voltSettings.appearance.darkDesc', "Always your dark theme")),
			],
			value: this.mode(),
			ariaLabel: localize('voltSettings.appearanceMode', "Mode"),
			onChange: mode => void this.setMode(mode),
		}, this.store);
	}

	/**
	 * Dark theme and Light theme rows under Mode: each a dropdown of that scheme's themes with a chip
	 * in the theme's colors, then a row that opens the VS Code theme picker. The dropdowns fill in
	 * once the themes have loaded their colors; the rows are there from the start so nothing jumps.
	 */
	renderThemePickers(kit: ISettingsPageKit, group: HTMLElement): Promise<void> {
		const hosts = new Map<ColorScheme, HTMLElement>();
		kit.settingRow(
			group,
			localize('voltSettings.appearance.darkTheme', "Dark theme"),
			localize('voltSettings.appearance.darkThemeDesc', "Used in Dark mode, and by System while macOS is dark."),
			host => hosts.set(ColorScheme.DARK, host),
		);
		kit.settingRow(
			group,
			localize('voltSettings.appearance.lightTheme', "Light theme"),
			localize('voltSettings.appearance.lightThemeDesc', "Used in Light mode, and by System while macOS is light."),
			host => hosts.set(ColorScheme.LIGHT, host),
		);
		kit.settingRow(
			group,
			localize('voltSettings.appearance.moreThemes', "More themes"),
			localize('voltSettings.appearance.moreThemesDesc', "Install a VS Code theme and it joins these lists."),
			host => {
				const more = this.store.add(createVoltButton(host, 'secondary'));
				more.label = localize('voltSettings.appearance.browse', "Browse");
				// The color theme quick pick, with Browse Additional Color Themes. Quick input sits above
				// the settings overlay, so the page stays open under it.
				this.store.add(more.onDidClick(() => void this.commands.executeCommand('workbench.action.selectTheme')));
			},
		);
		return this.fillThemePickers(hosts);
	}

	private async fillThemePickers(hosts: ReadonlyMap<ColorScheme, HTMLElement>): Promise<void> {
		const all = await this.themes.getColorThemes();
		await Promise.all(all.map(theme => theme instanceof ColorThemeData ? theme.ensureLoaded(this.resources).catch(() => undefined) : undefined));
		if (!this.isCurrent()) {
			return;
		}
		const active = this.themes.getColorTheme();
		for (const [scheme, host] of hosts) {
			const dark = scheme === ColorScheme.DARK;
			const themes = all.filter(theme => isDark(theme.type) === dark).sort(themeOrder);
			if (!themes.length) {
				continue;
			}
			// The scheme on screen shows the theme in use; the other shows the one it will switch to.
			const current = isDark(active.type) === dark ? active.settingsId : this.preferredTheme(scheme);
			createVoltDropdown(host, this.contextView, {
				options: themes.map(theme => ({ id: theme.settingsId, label: theme.label, icon: () => themeChip(theme) })),
				value: themes.find(theme => theme.settingsId === current)?.settingsId ?? themes[0].settingsId,
				ariaLabel: dark ? localize('voltSettings.appearance.darkTheme', "Dark theme") : localize('voltSettings.appearance.lightTheme', "Light theme"),
				align: 'right',
				width: 280,
				onChange: id => {
					const theme = themes.find(candidate => candidate.settingsId === id);
					if (theme) {
						void this.pick(scheme, theme);
					}
				},
			}, this.store);
		}
	}

	/**
	 * Saves the theme as that scheme's theme (what Mode and System switch to) and applies it when the
	 * window is on that scheme now.
	 */
	private async pick(scheme: ColorScheme, theme: IWorkbenchColorTheme): Promise<void> {
		await this.configuration.updateValue(scheme === ColorScheme.DARK ? ThemeSettings.PREFERRED_DARK_THEME : ThemeSettings.PREFERRED_LIGHT_THEME, theme.settingsId);
		if (isDark(theme.type) === isDark(this.themes.getColorTheme().type)) {
			await this.themes.setColorTheme(theme, 'auto');
		}
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
		this.syncedToggleRow(kit, group, localize('voltSettings.windowTransparency', "Window Transparency"), localize('voltSettings.windowTransparencyDesc', "Show the desktop through the agent window's sidebar (macOS vibrancy, Windows acrylic). Uses more GPU memory."), VOLT_WINDOW_TRANSPARENCY_SETTING, false);
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
			host => this.fontPicker(host, UI_FONTS, VOLT_UI_FONT_FAMILY_SETTING, localize('voltSettings.uiFontFamily', "UI Font Family")),
		);
		const codeRow = kit.settingRow(
			group,
			localize('voltSettings.codeFontFamily', "Code Font Family"),
			localize('voltSettings.codeFontFamilyDesc', "Override the font for code editors and diffs"),
			host => this.fontPicker(host, CODE_FONTS, 'editor.fontFamily', localize('voltSettings.codeFontFamily', "Code Font Family")),
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
					{ id: 'auto', label: localize('voltSettings.motion.system', "System") },
					{ id: 'on', label: localize('voltSettings.motion.on', "On") },
					{ id: 'off', label: localize('voltSettings.motion.off', "Off") },
				];
				const current = this.configuration.getValue<string>('workbench.reduceMotion');
				createVoltDropdown(host, this.contextView, {
					options,
					value: options.find(option => option.id === current)?.id ?? options[0].id,
					ariaLabel: localize('voltSettings.reduceMotion', "Reduce Motion"),
					onChange: id => void this.configuration.updateValue('workbench.reduceMotion', id),
				}, this.store);
			},
		);
	}

	private toggleRow(kit: ISettingsPageKit, group: HTMLElement, title: string, desc: string, key: string, defaultValue: boolean): void {
		kit.settingRow(group, title, desc, host => this.toggle(host, this.configuration.getValue<boolean>(key) ?? defaultValue, title, on => void this.configuration.updateValue(key, on)));
	}

	/** A switch that follows its setting when it changes elsewhere (settings.json, another window), without redrawing the page. */
	private syncedToggleRow(kit: ISettingsPageKit, group: HTMLElement, title: string, desc: string, key: string, defaultValue: boolean): void {
		const read = () => this.configuration.getValue<boolean>(key) ?? defaultValue;
		kit.settingRow(group, title, desc, host => {
			const set = this.toggle(host, read(), title, on => void this.configuration.updateValue(key, on, ConfigurationTarget.USER));
			this.store.add(this.configuration.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(key)) {
					set(read());
				}
			}));
		});
	}

	/** A switch that flips itself: the page does not redraw for these settings. Returns a setter for outside changes. */
	private toggle(host: HTMLElement, initial: boolean, label: string, onChange: (on: boolean) => void): (on: boolean) => void {
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
		return next => {
			on = next;
			paint();
		};
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
	private fontPicker(host: HTMLElement, choices: readonly IFontChoice[], key: string, label: string): void {
		const user = this.configuration.inspect<string>(key).userValue?.trim() ?? '';
		const options = [...choices];
		let selected = options.findIndex(choice => choice.value === user);
		if (selected < 0) {
			options.push({ label: localize('voltSettings.font.custom', "Custom ({0})", user.split(',')[0].replace(/["']/g, '').trim()), value: user });
			selected = options.length - 1;
		}
		createVoltDropdown(host, this.contextView, {
			options: options.map((choice, index) => ({ id: String(index), label: choice.label })),
			value: String(selected),
			ariaLabel: label,
			onChange: id => void this.configuration.updateValue(key, options[Number(id)].value || undefined),
		}, this.store);
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
