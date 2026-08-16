/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme, IThemeService, IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme', /* id kept for compatibility reasons */
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export enum ThemeSettingDefaults {
	COLOR_THEME_DARK = 'Cursor Dark',
	COLOR_THEME_LIGHT = 'Cursor Light',
	COLOR_THEME_HC_DARK = 'Cursor Dark High Contrast',
	COLOR_THEME_HC_LIGHT = 'Default High Contrast Light',

	COLOR_THEME_DARK_OLD = 'Default Dark+',
	COLOR_THEME_LIGHT_OLD = 'Default Light+',

	FILE_ICON_THEME = 'vs-seti',
	PRODUCT_ICON_THEME = 'Default',
}

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#383a49',
	'activityBar.activeBorder': '#0078D4',
	'activityBar.background': '#141414',
	'activityBar.border': '#2B2B2B',
	'activityBar.foreground': '#F0F0F0BD',
	'activityBar.inactiveForeground': '#868686',
	'activityBarBadge.background': '#88C0D0',
	'activityBarBadge.foreground': '#141414',
	'badge.background': '#88C0D0',
	'badge.foreground': '#141414',
	'button.background': '#81A1C1',
	'button.border': '#FFFFFF12',
	'button.foreground': '#191c22',
	'button.hoverBackground': '#87A6C4',
	'button.secondaryBackground': '#626262',
	'button.secondaryForeground': '#F0F0F0',
	'button.secondaryHoverBackground': '#818181',
	'chat.slashCommandBackground': '#26477866',
	'chat.slashCommandForeground': '#85B6FF',
	'chat.editedFileForeground': '#E2C08D',
	'checkbox.background': '#313131',
	'checkbox.border': '#3C3C3C',
	'debugToolBar.background': '#141414',
	'descriptionForeground': '#9D9D9D',
	'dropdown.background': '#181818',
	'dropdown.border': '#F0F0F013',
	'dropdown.foreground': '#F0F0F0',
	'dropdown.listBackground': '#1F1F1F',
	'editor.background': '#181818',
	'editor.findMatchBackground': '#88C0D066',
	'editor.foreground': '#F0F0F0',
	'editor.inactiveSelectionBackground': '#40404077',
	'editor.selectionHighlightBackground': '#404040CC',
	'editorGroup.border': '#F0F0F013',
	'editorGroupHeader.tabsBackground': '#141414',
	'editorGroupHeader.tabsBorder': '#F0F0F013',
	'editorGutter.addedBackground': '#3FA266',
	'editorGutter.deletedBackground': '#E34671',
	'editorGutter.modifiedBackground': '#D2943E',
	'editorIndentGuide.activeBackground1': '#F0F0F030',
	'editorIndentGuide.background1': '#F0F0F013',
	'editorLineNumber.activeForeground': '#F0F0F0',
	'editorLineNumber.foreground': '#F0F0F05C',
	'editorOverviewRuler.border': '#00000000',
	'editorWidget.background': '#141414',
	'errorForeground': '#E34671',
	'focusBorder': '#F0F0F026',
	'foreground': '#F0F0F0',
	'icon.foreground': '#CCCCCC',
	'input.background': '#F0F0F00A',
	'input.border': '#F0F0F013',
	'input.foreground': '#F0F0F0',
	'input.placeholderForeground': '#F0F0F099',
	'inputOption.activeBackground': '#F0F0F01E',
	'inputOption.activeBorder': '#F0F0F000',
	'keybindingLabel.foreground': '#CCCCCC',
	'list.activeSelectionIconForeground': '#FFF',
	'list.dropBackground': '#F0F0F011',
	'menu.background': '#141414',
	'menu.border': '#F0F0F013',
	'menu.foreground': '#F0F0F0',
	'menu.selectionBackground': '#0078d4',
	'menu.separatorBackground': '#F0F0F013',
	'notificationCenterHeader.background': '#1F1F1F',
	'notificationCenterHeader.foreground': '#CCCCCC',
	'notifications.background': '#141414',
	'notifications.border': '#2B2B2B',
	'notifications.foreground': '#F0F0F0',
	'panel.background': '#141414',
	'panel.border': '#F0F0F013',
	'panelInput.border': '#2B2B2B',
	'panelTitle.activeBorder': '#F0F0F000',
	'panelTitle.activeForeground': '#F0F0F0',
	'panelTitle.inactiveForeground': '#F0F0F0BD',
	'peekViewEditor.background': '#141414',
	'peekViewEditor.matchHighlightBackground': '#88C0D044',
	'peekViewResult.background': '#141414',
	'peekViewResult.matchHighlightBackground': '#88C0D044',
	'pickerGroup.border': '#F0F0F01C',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#3FA266',
	'quickInput.background': '#222222',
	'quickInput.foreground': '#CCCCCC',
	'settings.dropdownBackground': '#313131',
	'settings.dropdownBorder': '#3C3C3C',
	'settings.headerForeground': '#FFFFFF',
	'settings.modifiedItemIndicator': '#BB800966',
	'sideBar.background': '#141414',
	'sideBar.border': '#F0F0F013',
	'sideBar.foreground': '#F0F0F0BD',
	'sideBarSectionHeader.background': '#141414',
	'sideBarSectionHeader.border': '#2B2B2B',
	'sideBarSectionHeader.foreground': '#F0F0F05C',
	'sideBarTitle.foreground': '#F0F0F0BD',
	'statusBar.background': '#141414',
	'statusBar.border': '#F0F0F013',
	'statusBar.debuggingBackground': '#F0F0F01C',
	'statusBar.debuggingForeground': '#F0F0F0',
	'statusBar.focusBorder': '#0078D4',
	'statusBar.foreground': '#F0F0F099',
	'statusBar.noFolderBackground': '#141414',
	'statusBarItem.focusBorder': '#0078D4',
	'statusBarItem.prominentBackground': '#F0F0F011',
	'statusBarItem.remoteBackground': '#141414',
	'statusBarItem.remoteForeground': '#F0F0F0BD',
	'tab.activeBackground': '#181818',
	'tab.activeBorder': '#181818',
	'tab.activeBorderTop': '#F0F0F000',
	'tab.activeForeground': '#F0F0F0',
	'tab.border': '#F0F0F013',
	'tab.hoverBackground': '#F0F0F000',
	'tab.inactiveBackground': '#141414',
	'tab.inactiveForeground': '#F0F0F05C',
	'tab.lastPinnedBorder': '#ccc3',
	'tab.selectedBackground': '#222222',
	'tab.selectedBorderTop': '#6caddf',
	'tab.selectedForeground': '#ffffffa0',
	'tab.unfocusedActiveBorder': '#181818',
	'tab.unfocusedActiveBorderTop': '#2B2B2B',
	'tab.unfocusedHoverBackground': '#2A2A2AB3',
	'terminal.foreground': '#F0F0F0',
	'terminal.inactiveSelectionBackground': '#3A3D41',
	'terminal.tab.activeBorder': '#0078D4',
	'textBlockQuote.background': '#2B2B2B',
	'textBlockQuote.border': '#616161',
	'textCodeBlock.background': '#2B2B2B',
	'textLink.activeForeground': '#87A6C4',
	'textLink.foreground': '#81A1C1',
	'textPreformat.background': '#3C3C3C',
	'textPreformat.foreground': '#88C0D0',
	'textSeparator.foreground': '#88C0D0',
	'titleBar.activeBackground': '#141414',
	'titleBar.activeForeground': '#F0F0F084',
	'titleBar.border': '#F0F0F013',
	'titleBar.inactiveBackground': '#141414',
	'titleBar.inactiveForeground': '#F0F0F099',
	'welcomePage.progress.foreground': '#0078D4',
	'welcomePage.tileBackground': '#2B2B2B',
	'widget.border': '#313131'
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#dddddd',
	'activityBar.activeBorder': '#005FB8',
	'activityBar.background': '#F3F3F3',
	'activityBar.border': '#E5E5E5',
	'activityBar.foreground': '#141414BD',
	'activityBar.inactiveForeground': '#616161',
	'activityBarBadge.background': '#005293',
	'activityBarBadge.foreground': '#F3F3F3',
	'badge.background': '#F3F3F3',
	'badge.foreground': '#141414A8',
	'button.background': '#2778C1',
	'button.border': '#0000001a',
	'button.foreground': '#FCFCFC',
	'button.hoverBackground': '#246AAB',
	'button.secondaryBackground': '#14141424',
	'button.secondaryForeground': '#141414',
	'button.secondaryHoverBackground': '#14141433',
	'chat.slashCommandBackground': '#ADCEFF7A',
	'chat.slashCommandForeground': '#26569E',
	'chat.editedFileForeground': '#895503',
	'checkbox.background': '#F8F8F8',
	'checkbox.border': '#CECECE',
	'descriptionForeground': '#141414BD',
	'diffEditor.unchangedRegionBackground': '#f8f8f8',
	'dropdown.background': '#FCFCFC',
	'dropdown.border': '#14141414',
	'dropdown.foreground': '#141414',
	'dropdown.listBackground': '#FFFFFF',
	'editor.background': '#FCFCFC',
	'editor.foreground': '#141414',
	'editor.inactiveSelectionBackground': '#14141414',
	'editor.selectionHighlightBackground': '#3B7E8424',
	'editorGroup.border': '#14141414',
	'editorGroupHeader.tabsBackground': '#F3F3F3',
	'editorGroupHeader.tabsBorder': '#14141414',
	'editorGutter.addedBackground': '#007041',
	'editorGutter.deletedBackground': '#BE1744',
	'editorGutter.modifiedBackground': '#A46700',
	'editorIndentGuide.activeBackground1': '#14141433',
	'editorIndentGuide.background1': '#14141414',
	'editorLineNumber.activeForeground': '#141414BD',
	'editorLineNumber.foreground': '#1414145C',
	'editorOverviewRuler.border': '#FCFCFC00',
	'editorSuggestWidget.background': '#F3F3F3',
	'editorWidget.background': '#F3F3F3',
	'errorForeground': '#BE1744',
	'focusBorder': '#14141433',
	'foreground': '#141414',
	'icon.foreground': '#14141480',
	'input.background': '#FCFCFC',
	'input.border': '#14141433',
	'input.foreground': '#141414',
	'input.placeholderForeground': '#1414145C',
	'inputOption.activeBackground': '#14141424',
	'inputOption.activeBorder': '#14141400',
	'inputOption.activeForeground': '#000000',
	'keybindingLabel.foreground': '#3B3B3B',
	'list.activeSelectionBackground': '#14141414',
	'list.activeSelectionForeground': '#141414',
	'list.activeSelectionIconForeground': '#000000',
	'list.focusAndSelectionOutline': '#005FB8',
	'list.hoverBackground': '#14141414',
	'menu.border': '#CECECE',
	'menu.selectionBackground': '#005FB8',
	'menu.selectionForeground': '#ffffff',
	'notebook.cellBorderColor': '#E5E5E5',
	'notebook.selectedCellBackground': '#C8DDF150',
	'notificationCenterHeader.background': '#FFFFFF',
	'notificationCenterHeader.foreground': '#3B3B3B',
	'notifications.background': '#F3F3F3',
	'notifications.border': '#14141414',
	'notifications.foreground': '#141414',
	'panel.background': '#F3F3F3',
	'panel.border': '#14141414',
	'panelInput.border': '#E5E5E5',
	'panelTitle.activeBorder': '#0B0B2D00',
	'panelTitle.activeForeground': '#141414',
	'panelTitle.inactiveForeground': '#141414BD',
	'peekViewEditor.matchHighlightBackground': '#3B7E8424',
	'peekViewResult.background': '#F3F3F3',
	'peekViewResult.matchHighlightBackground': '#3B7E8424',
	'pickerGroup.border': '#1414141F',
	'pickerGroup.foreground': '#141414',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#007041',
	'quickInput.background': '#F8F8F8',
	'quickInput.foreground': '#3B3B3B',
	'searchEditor.textInputBorder': '#CECECE',
	'settings.dropdownBackground': '#FFFFFF',
	'settings.dropdownBorder': '#CECECE',
	'settings.headerForeground': '#1F1F1F',
	'settings.modifiedItemIndicator': '#BB800966',
	'settings.numberInputBorder': '#CECECE',
	'settings.textInputBorder': '#CECECE',
	'sideBar.background': '#F3F3F3',
	'sideBar.border': '#14141414',
	'sideBar.foreground': '#141414BD',
	'sideBarSectionHeader.background': '#F3F3F3',
	'sideBarSectionHeader.border': '#E5E5E5',
	'sideBarSectionHeader.foreground': '#141414BD',
	'sideBarTitle.foreground': '#141414BD',
	'statusBar.background': '#F3F3F3',
	'statusBar.border': '#14141414',
	'statusBar.debuggingBackground': '#F3F3F3',
	'statusBar.debuggingForeground': '#14141499',
	'statusBar.focusBorder': '#005FB8',
	'statusBar.foreground': '#14141499',
	'statusBar.noFolderBackground': '#F3F3F3',
	'statusBarItem.compactHoverBackground': '#CCCCCC',
	'statusBarItem.errorBackground': '#C72E0F',
	'statusBarItem.focusBorder': '#005FB8',
	'statusBarItem.hoverBackground': '#14141414',
	'statusBarItem.prominentBackground': '#14141414',
	'statusBarItem.remoteBackground': '#F3F3F3',
	'statusBarItem.remoteForeground': '#141414BD',
	'tab.activeBackground': '#FCFCFC',
	'tab.activeBorder': '#FCFCFC',
	'tab.activeBorderTop': '#FCFCFC00',
	'tab.activeForeground': '#141414',
	'tab.border': '#1414141F',
	'tab.hoverBackground': '#14141414',
	'tab.inactiveBackground': '#F3F3F3',
	'tab.inactiveForeground': '#141414BD',
	'tab.lastPinnedBorder': '#D4D4D4',
	'tab.selectedBackground': '#ffffffa5',
	'tab.selectedBorderTop': '#68a3da',
	'tab.selectedForeground': '#333333b3',
	'tab.unfocusedActiveBorder': '#FCFCFC',
	'tab.unfocusedActiveBorderTop': '#E5E5E5',
	'tab.unfocusedHoverBackground': '#14141400',
	'terminal.foreground': '#141414',
	'terminal.inactiveSelectionBackground': '#E5EBF1',
	'terminal.tab.activeBorder': '#005FB8',
	'terminalCursor.foreground': '#141414',
	'textBlockQuote.background': '#F8F8F8',
	'textBlockQuote.border': '#E5E5E5',
	'textCodeBlock.background': '#F8F8F8',
	'textLink.activeForeground': '#0064B0',
	'textLink.foreground': '#0064B0',
	'textPreformat.background': '#0000001F',
	'textPreformat.foreground': '#3B7E84',
	'textSeparator.foreground': '#3B7E84',
	'titleBar.activeBackground': '#F3F3F3',
	'titleBar.activeForeground': '#141414A8',
	'titleBar.border': '#14141414',
	'titleBar.inactiveBackground': '#F3F3F3',
	'titleBar.inactiveForeground': '#14141480',
	'welcomePage.tileBackground': '#F3F3F3',
	'widget.border': '#1414141F'
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {
}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';


export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(themeId: string | undefined | IWorkbenchColorTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(iconThemeId: string | undefined | IWorkbenchFileIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(iconThemeId: string | undefined | IWorkbenchProductIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchProductIconTheme[]>;
	onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]: IThemeScopedTokenColorCustomizations | ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedSemanticTokenColorCustomizations | ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedExperimentalSemanticTokenColorCustomizations | ISemanticTokenRules | undefined;
}

export type IThemeScopedCustomizations =
	IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return d && { _extensionId: d.extensionId, _extensionIsBuiltin: d.extensionIsBuiltin, _extensionName: d.extensionName, _extensionPublisher: d.extensionPublisher };
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (o && isString(o._extensionId) && isBoolean(o._extensionIsBuiltin) && isString(o._extensionName) && isString(o._extensionPublisher)) {
			return { extensionId: o._extensionId, extensionIsBuiltin: o._extensionIsBuiltin, extensionName: o._extensionName, extensionPublisher: o._extensionPublisher };
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return { extensionPublisher: publisher, extensionId: `${publisher}.${name}`, extensionName: name, extensionIsBuiltin: isBuiltin };
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}
