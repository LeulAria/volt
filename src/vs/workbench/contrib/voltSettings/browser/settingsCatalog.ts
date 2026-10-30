/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISetting, ISettingsGroup } from '../../../services/preferences/common/preferences.js';
import { getCommonlyUsedData, isHiddenCopilotSetting, ITOCEntry, tocData } from '../../preferences/browser/settingsLayout.js';
import { resolveSettingsTree } from '../../preferences/browser/settingsTree.js';
import { settingKeyToDisplayFormat } from '../../preferences/browser/settingsTreeModels.js';

export interface ISettingsCatalogSetting {
	readonly kind: 'setting';
	readonly id: string;
	readonly setting: ISetting;
	readonly category: string;
	readonly label: string;
	readonly extension?: string;
}

/** A subsection of a category (Text Editor > Cursor), holding its settings and its own subsections. */
export interface ISettingsCatalogGroup {
	readonly kind: 'group';
	readonly id: string;
	readonly label: string;
	readonly children: readonly SettingsCatalogNode[];
}

/** A row of a category's tree: a subsection, or a setting. */
export type SettingsCatalogNode = ISettingsCatalogSetting | ISettingsCatalogGroup;

/** Every extension's settings, one subsection per extension. */
export const EXTENSIONS_CATEGORY = 'cat:extensions';

/** The Extensions subsection holding one extension's settings. */
export function extensionGroupId(extensionId: string): string {
	return `g:ext:${extensionId}`;
}

export interface ISettingsCatalogCategory {
	/** Nav id, `cat:<toc id>`, or `cat:extensions` for every extension's settings. */
	readonly id: string;
	readonly label: string;
	readonly group: 'settings' | 'extensions';
	/** Subsections first, then the settings that belong to the category itself. */
	readonly nodes: readonly SettingsCatalogNode[];
	/** Every setting in the category, subsections included. */
	readonly settings: readonly ISettingsCatalogSetting[];
	readonly count: number;
}

/**
 * Every registered setting (VS Code's, Volt's and each extension's), sorted into the categories the
 * VS Code settings editor uses: Commonly Used and its table of contents, a Volt category for the
 * `volt.*` keys it has no place for, and one category per extension.
 */
export function buildSettingsCatalog(groups: readonly ISettingsGroup[], logService: ILogService): ISettingsCatalogCategory[] {
	// The first group is VS Code's own Commonly Used list; the layout below rebuilds it.
	const all = groups.slice(1);
	const core = all.filter(group => !group.extensionInfo);
	const categories: ISettingsCatalogCategory[] = [];

	const commonly = resolveSettingsTree(getCommonlyUsedData(undefined), core, logService).tree;
	categories.push(category(`cat:${commonly.id}`, commonly.label, 'settings', tocNodes(commonly, [])));

	const { tree, leftoverSettings } = resolveSettingsTree(tocData, core, logService);
	// Volt lists only its own pages; the `volt.*` keys those pages set are not listed again.
	const other = [...leftoverSettings].filter(setting => !setting.key.startsWith('volt.'));
	categories.push(category('cat:volt', localize('voltSettings.catalog.volt', "Volt"), 'settings', []));
	for (const child of tree.children ?? []) {
		categories.push(category(`cat:${child.id}`, child.label, 'settings', tocNodes(child, [child.id])));
	}
	if (other.length) {
		categories.push(category('cat:other', localize('voltSettings.catalog.other', "Other"), 'settings', byKeySegment(other, '')));
	}

	// One category per extension; an extension can contribute several groups.
	const extensions = new Map<string, { label: string; groups: SettingsCatalogNode[]; own: SettingsCatalogNode[] }>();
	for (const group of all) {
		const info = group.extensionInfo;
		if (!info || isHiddenCopilotSetting('', info.id)) {
			continue;
		}
		let ext = extensions.get(info.id);
		if (!ext) {
			ext = { label: info.displayName || group.title || info.id, groups: [], own: [] };
			extensions.set(info.id, ext);
		}
		const settings = group.sections.flatMap(section => section.settings).filter(setting => !setting.overrides?.length && !isHiddenCopilotSetting(setting.key, info.id));
		if (!settings.length) {
			continue;
		}
		const rows = sortByOrder(settings).map(setting => settingEntry(setting, '', ext.label));
		if (group.title && group.title !== ext.label) {
			ext.groups.push({ kind: 'group', id: `g:${info.id}:${group.id}:${group.title}`, label: group.title, children: rows });
		} else {
			ext.own.push(...rows);
		}
	}
	// Extensions is one category; each extension is one of its subsections (`g:ext:<id>`).
	const sorted = [...extensions.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
	const extensionGroups: SettingsCatalogNode[] = [];
	for (const [id, ext] of sorted) {
		const children = [...ext.own, ...ext.groups];
		if (children.length) {
			extensionGroups.push({ kind: 'group', id: extensionGroupId(id), label: ext.label, children });
		}
	}
	if (extensionGroups.length) {
		categories.push(category(EXTENSIONS_CATEGORY, localize('voltSettings.catalog.extensions', "Extensions"), 'extensions', extensionGroups));
	}
	return categories;
}

function category(id: string, label: string, group: ISettingsCatalogCategory['group'], nodes: SettingsCatalogNode[]): ISettingsCatalogCategory {
	const settings = catalogSettings(nodes);
	return { id, label, group, nodes, settings, count: settings.length };
}

/** Every setting under `nodes`, in the order the tree shows them. */
export function catalogSettings(nodes: readonly SettingsCatalogNode[]): ISettingsCatalogSetting[] {
	return nodes.flatMap(node => node.kind === 'setting' ? [node] : catalogSettings(node.children));
}

/** A table-of-contents node as tree rows: each child as a subsection, then the node's own settings. */
function tocNodes(node: ITOCEntry<ISetting>, path: readonly string[]): SettingsCatalogNode[] {
	const nodes: SettingsCatalogNode[] = [];
	for (const child of node.children ?? []) {
		// Some layout nodes have no id (Features > Other), so the path names the group.
		const childPath = [...path, child.id ?? child.label];
		const children = tocNodes(child, childPath);
		if (children.length) {
			nodes.push({ kind: 'group', id: `g:${childPath.join('/')}`, label: child.label, children });
		}
	}
	for (const setting of node.settings ?? []) {
		nodes.push(settingEntry(setting, node.id ?? ''));
	}
	return nodes;
}

/** Settings the layout has no place for, grouped by the key segment after `prefix`. */
function byKeySegment(settings: readonly ISetting[], prefix: string): SettingsCatalogNode[] {
	const sections = new Map<string, ISetting[]>();
	for (const setting of settings) {
		const rest = prefix ? setting.key.slice(prefix.length + 1) : setting.key;
		const segment = rest.includes('.') ? rest.slice(0, rest.indexOf('.')) : '';
		const list = sections.get(segment) ?? [];
		list.push(setting);
		sections.set(segment, list);
	}
	const groups: SettingsCatalogNode[] = [];
	const own: SettingsCatalogNode[] = [];
	for (const segment of [...sections.keys()].sort((a, b) => a.localeCompare(b))) {
		const groupId = segment ? (prefix ? `${prefix}/${segment}` : segment) : prefix;
		const rows = sortByOrder(sections.get(segment)!).map(setting => settingEntry(setting, groupId));
		if (segment) {
			groups.push({ kind: 'group', id: `g:${prefix}:${segment}`, label: settingKeyToDisplayFormat(`${segment}.x`).category, children: rows });
		} else {
			own.push(...rows);
		}
	}
	return [...groups, ...own];
}

function sortByOrder(settings: readonly ISetting[]): ISetting[] {
	return [...settings].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key));
}

function settingEntry(setting: ISetting, groupId: string, extension?: string): ISettingsCatalogSetting {
	const { category, label } = settingKeyToDisplayFormat(setting.key, groupId, setting.isLanguageTagSetting);
	return { kind: 'setting', id: setting.key, setting, category: setting.title ? '' : category, label: setting.title ?? label, extension };
}

/** Whether a setting matches every word of a search, by key, title or description. */
export function settingMatches(entry: ISettingsCatalogSetting, words: readonly string[]): boolean {
	if (!words.length) {
		return true;
	}
	const text = `${entry.setting.key} ${entry.category} ${entry.label} ${entry.setting.description.join(' ')}`.toLowerCase();
	return words.every(word => text.includes(word));
}

export function searchWords(search: string): string[] {
	return search.trim().toLowerCase().split(/\s+/).filter(Boolean);
}
