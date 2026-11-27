/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationPropertySchema, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { foreground } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { VoltViewLocation } from '../../../services/voltPlugins/common/voltContributions.js';
import { IVoltDropdownOption } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { IVoltIconService, renderVoltLayoutGlyph } from '../../voltCustomize/browser/voltIconService.js';
import { IVoltPluginSettingsPage, IVoltPluginUiService } from '../../voltCustomize/browser/voltPluginUi.js';
import { extensionSettingKeys, voltViewLocationLabel } from '../../voltCustomize/browser/voltPluginUiService.js';
import { IVoltSlotService, VOLT_SLOTS, VoltSlotId } from '../../voltCustomize/common/voltSlots.js';

/** The settings editor's building blocks, so plugin pages look like Volt's own. */
export interface IPluginSettingsKit {
	readonly store: DisposableStore;
	pageHead(title: string, lead?: string): void;
	sectionLabel(label: string): void;
	settingsGroup(): HTMLElement;
	settingRow(parent: HTMLElement, title: string, desc: string | undefined, renderControl?: (host: HTMLElement) => void): HTMLElement;
	toggle(parent: HTMLElement, on: boolean, label: string, onClick: () => void): void;
	dropdown<T extends string>(host: HTMLElement, options: readonly IVoltDropdownOption<T>[], value: T, ariaLabel: string, onChange: (value: T) => void, width?: number): void;
	input(parent: HTMLElement, value: string, placeholder: string, label: string, onCommit: (value: string) => void): void;
	button(parent: HTMLElement, label: string, onClick: () => void, kind?: 'primary' | 'secondary'): Button;
	rerender(): void;
}

export interface IPluginSettingsServices {
	readonly pluginUi: IVoltPluginUiService;
	readonly slots: IVoltSlotService;
	readonly icons: IVoltIconService;
	readonly configuration: IConfigurationService;
	readonly extensions: IExtensionService;
	readonly quickInput: IQuickInputService;
	readonly theme: IThemeService;
}

/** `prPilot.pollSeconds` → "Poll Seconds". */
function titleOf(key: string, schema: IConfigurationPropertySchema | undefined): string {
	if (typeof schema?.title === 'string' && schema.title) {
		return schema.title;
	}
	const last = key.split('.').pop() ?? key;
	return last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

function matchesKey(key: string, patterns: readonly string[]): boolean {
	return !patterns.length || patterns.some(pattern => pattern.endsWith('.') ? key.startsWith(pattern) : key === pattern);
}

/**
 * A plugin's page in Volt Settings: its own settings drawn as Volt's rows (written to the user's
 * settings.json, so `vscode.workspace.getConfiguration` and `vscode.volt.settings` read them), then
 * where its buttons and views sit, then its own settings view if it has one.
 */
export function renderPluginSettingsPage(kit: IPluginSettingsKit, services: IPluginSettingsServices, page: IVoltPluginSettingsPage): void {
	const { pluginUi, configuration } = services;
	kit.pageHead(page.label, page.description ?? localize('pluginSettings.lead', "{0}: its settings, and where its buttons and views sit in the window.", page.extensionLabel));

	const description = services.extensions.extensions.find(extension => ExtensionIdentifier.equals(extension.identifier, page.extensionId));
	const properties = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties();
	const keys = extensionSettingKeys(description).filter(key => matchesKey(key, page.settings));
	if (keys.length) {
		kit.sectionLabel(localize('pluginSettings.settings', "Settings"));
		const group = kit.settingsGroup();
		for (const key of keys) {
			const schema = properties[key];
			const value = configuration.getValue<unknown>(key);
			const desc = typeof schema?.markdownDescription === 'string' ? schema.markdownDescription : typeof schema?.description === 'string' ? schema.description : undefined;
			const title = titleOf(key, schema);
			const write = (next: unknown) => void configuration.updateValue(key, next, ConfigurationTarget.USER).then(() => kit.rerender());
			const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
			kit.settingRow(group, title, desc, host => {
				if (type === 'boolean') {
					kit.toggle(host, value === true, title, () => write(value !== true));
				} else if (Array.isArray(schema?.enum)) {
					const labels = schema.enumItemLabels ?? [];
					const options = schema.enum.map((entry, index) => ({ id: String(entry), label: labels[index] ?? String(entry) }));
					kit.dropdown(host, options, String(value ?? schema.default ?? ''), title, id => write(type === 'number' || type === 'integer' ? Number(id) : id));
				} else if (type === 'number' || type === 'integer') {
					kit.input(host, String(value ?? ''), String(schema?.default ?? ''), title, text => {
						const next = Number(text);
						if (text.trim() && !Number.isNaN(next)) {
							write(next);
						}
					});
				} else if (type === 'string' || type === undefined) {
					kit.input(host, typeof value === 'string' ? value : '', typeof schema?.default === 'string' ? schema.default : '', title, text => write(text));
				} else {
					kit.button(host, localize('pluginSettings.editJson', "Edit in settings.json"), () => void services.configuration.updateValue(key, value, ConfigurationTarget.USER));
				}
			});
		}
	}

	renderPlacementRows(kit, services, item => item.extensionId !== undefined && ExtensionIdentifier.equals(item.extensionId, page.extensionId), view => ExtensionIdentifier.equals(view.extensionId, page.extensionId));

	if (page.view && pluginUi.view(page.view)) {
		kit.sectionLabel(pluginUi.view(page.view)!.title);
		const host = append(kit.settingsGroup(), $('.volt-settings-plugin-view'));
		kit.store.add(pluginUi.mountView(page.view, host, 'rightPanel'));
	}
}

/** Where buttons and views sit: a slot per button, a location per view, and an icon for each. */
function renderPlacementRows(kit: IPluginSettingsKit, services: IPluginSettingsServices, itemFilter: (item: { id: string; extensionId?: string }) => boolean, viewFilter: (view: { extensionId: string }) => boolean): void {
	const { pluginUi, slots } = services;
	const items = slots.items.filter(itemFilter);
	const slotOptions: IVoltDropdownOption<VoltSlotId>[] = VOLT_SLOTS.map(slot => ({ id: slot.id, label: slot.label, description: slot.description, icon: () => renderVoltLayoutGlyph(slot.id) }));
	const slotOf = (id: string): VoltSlotId => VOLT_SLOTS.find(slot => slots.placement[slot.id]?.includes(id))?.id ?? 'hidden';
	if (items.length) {
		kit.sectionLabel(localize('pluginSettings.buttons', "Buttons, chips and menus"));
		const group = kit.settingsGroup();
		for (const item of items) {
			const plugin = pluginUi.item(item.id);
			const row = kit.settingRow(group, item.label, item.description, host => {
				if (plugin) {
					iconButton(kit, services, host, item.id, plugin.extensionLocation);
				}
				kit.dropdown(host, slotOptions, slotOf(item.id), localize('pluginSettings.slot', "Where {0} sits", item.label), slot => void pluginUi.moveItem(item.id, slot).then(() => kit.rerender()), 220);
			});
			row.classList.add('volt-settings-plugin-row');
		}
	}
	const views = pluginUi.views().filter(viewFilter);
	if (views.length) {
		kit.sectionLabel(localize('pluginSettings.views', "Views"));
		const group = kit.settingsGroup();
		for (const view of views) {
			kit.settingRow(group, view.title, view.description ?? localize('pluginSettings.viewDesc', "Where it opens when you click its button."), host => {
				iconButton(kit, services, host, view.id, view.extensionLocation);
				const options: IVoltDropdownOption<VoltViewLocation>[] = view.locations.map(location => ({ id: location, label: voltViewLocationLabel(location), icon: () => renderVoltLayoutGlyph(location) }));
				kit.dropdown(host, options, pluginUi.viewLocation(view.id), localize('pluginSettings.viewLocation', "Where {0} opens", view.title), location => void pluginUi.setViewLocation(view.id, location).then(() => kit.rerender()), 200);
				kit.button(host, localize('pluginSettings.open', "Open"), () => void pluginUi.showView(view.id));
			});
		}
	}
}

/** The current icon as a button: a click opens the Aria Icons picker. */
function iconButton(kit: IPluginSettingsKit, services: IPluginSettingsServices, host: HTMLElement, id: string, extensionLocation: URI | undefined): void {
	const button = append(host, $('button.volt-settings-plugin-icon')) as HTMLButtonElement;
	button.type = 'button';
	button.setAttribute('aria-label', localize('pluginSettings.pickIcon', "Pick an icon"));
	button.title = localize('pluginSettings.pickIconTitle', "Pick an icon from Aria Icons");
	button.appendChild(services.icons.render(services.pluginUi.iconFor(id), extensionLocation));
	button.addEventListener('click', () => void pickAriaIcon(services).then(icon => {
		if (icon !== undefined) {
			void services.pluginUi.setIcon(id, icon || undefined).then(() => kit.rerender());
		}
	}));
}

/**
 * Aria Icons (icons.leularia.com, 1.4M icons): type to search, pick one. Undefined: closed;
 * empty: back to the plugin's own icon.
 */
export async function pickAriaIcon(services: Pick<IPluginSettingsServices, 'icons' | 'quickInput' | 'theme'>): Promise<string | undefined> {
	type IconItem = IQuickPickItem & { readonly icon: string };
	const color = services.theme.getColorTheme().getColor(foreground)?.toString() ?? '#cccccc';
	const pick = services.quickInput.createQuickPick<IconItem>();
	pick.title = localize('pluginSettings.ariaTitle', "Aria Icons");
	pick.placeholder = localize('pluginSettings.ariaPlaceholder', "Search 1.4M icons (lucide, tabler, heroicons, brand logos, ...)");
	pick.matchOnDescription = true;
	const reset: IconItem = { label: localize('pluginSettings.ariaReset', "Use the plugin's own icon"), icon: '' };
	pick.items = [reset];
	let generation = 0;
	const search = async (query: string) => {
		const mine = ++generation;
		if (!query.trim()) {
			pick.items = [reset];
			return;
		}
		pick.busy = true;
		try {
			const hits = await services.icons.search(query, { limit: 60 });
			const items = await Promise.all(hits.map(async (hit): Promise<IconItem> => {
				const svg = await services.icons.svg(`aria:${hit.id}`);
				const tinted = svg?.replace(/currentColor/g, color);
				const iconPath = tinted ? URI.parse(`data:image/svg+xml;utf8,${encodeURIComponent(tinted)}`) : undefined;
				return { label: hit.name, description: hit.id, icon: `aria:${hit.id}`, ...(iconPath ? { iconPath: { dark: iconPath, light: iconPath } } : {}) };
			}));
			if (mine === generation) {
				pick.items = [reset, ...items];
			}
		} catch {
			if (mine === generation) {
				pick.items = [reset, { label: localize('pluginSettings.ariaOffline', "Aria Icons can't be reached"), icon: '', alwaysShow: true }];
			}
		} finally {
			if (mine === generation) {
				pick.busy = false;
			}
		}
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	pick.onDidChangeValue(value => {
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => void search(value), 250);
	});
	return new Promise<string | undefined>(resolve => {
		let picked: string | undefined;
		pick.onDidAccept(() => {
			picked = pick.selectedItems[0]?.icon;
			pick.hide();
		});
		pick.onDidHide(() => {
			pick.dispose();
			resolve(picked);
		});
		pick.show();
	});
}

/**
 * Settings > Plugin Layout: every button (Volt's and plugins') with the slot it sits in, every
 * plugin view with where it opens, and Reset. Dragging buttons in the window does the same.
 */
export function renderPluginLayoutPage(kit: IPluginSettingsKit, services: IPluginSettingsServices): void {
	kit.pageHead(
		localize('pluginLayout.title', "Plugin Layout"),
		localize('pluginLayout.lead', "Choose where each button, chip and view sits. In the window you can also drag a button to another place, or right-click it to move it, open its view somewhere else or hide it."),
	);
	renderPlacementRows(kit, services, () => true, () => true);
	kit.sectionLabel(localize('pluginLayout.resetSection', "Reset"));
	kit.settingRow(kit.settingsGroup(), localize('pluginLayout.reset', "Reset Layout"), localize('pluginLayout.resetDesc', "Puts every button and view back where Volt and its plugins put them."), host => {
		kit.button(host, localize('pluginLayout.resetButton', "Reset"), () => void services.pluginUi.resetLayout().then(() => kit.rerender()));
	});
}
