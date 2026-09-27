/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh } from '../../../../../base/common/platform.js';
import type { IModelOptionDescriptor } from '../../../../services/voltRuntime/common/models/modelOptions.js';

export const PICKER_FAVORITES_TAB = 'favorites';
export const PICKER_SHORTCUT_COUNT = 6;
export const MODEL_FAVORITES_STORAGE_KEY = 'volt.agent.modelFavorites';

export interface IModelOption {
	ref: string;
	name: string;
	qualifier?: string;
	providerId: string;
	family: string;
	optionDescriptors: IModelOptionDescriptor[];
	detail?: string;
	description?: string;
	contextLabel?: string;
	contextWindow: number;
}

export interface IProviderGroup {
	family: string;
	label: string;
	models: IModelOption[];
}

/** Provider tabs lead with these families, in this order; the rest follow as they arrive. */
export const PROVIDER_FAMILY_ORDER: readonly string[] = ['claude', 'codex', 'cursor', 'antigravity'];

export function sortProviderGroups<T extends { family: string }>(groups: readonly T[]): T[] {
	const rank = (family: string) => {
		const index = PROVIDER_FAMILY_ORDER.indexOf(family);
		return index === -1 ? PROVIDER_FAMILY_ORDER.length : index;
	};
	// Array.prototype.sort is stable, so unranked families keep their arrival order.
	return [...groups].sort((a, b) => rank(a.family) - rank(b.family));
}

export function parseFavoriteRefs(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];
	} catch {
		return [];
	}
}

export function modelSearchText(model: IModelOption): string {
	return [model.name, model.description, model.detail, model.qualifier, model.family].filter(Boolean).join(' ').toLowerCase();
}

export function filterPickerModels(
	groups: readonly IProviderGroup[],
	tab: string | undefined,
	query: string,
	favoriteRefs: ReadonlySet<string>,
): IModelOption[] {
	const needle = query.trim().toLowerCase();
	const models = groups.flatMap(group => {
		if (!needle && tab !== PICKER_FAVORITES_TAB && group.family !== tab) {
			return [];
		}
		return group.models.filter(model => !needle || modelSearchText(model).includes(needle));
	});
	if (!needle && tab === PICKER_FAVORITES_TAB) {
		return models.filter(model => favoriteRefs.has(model.ref));
	}
	const starred = models.filter(model => favoriteRefs.has(model.ref));
	const rest = models.filter(model => !favoriteRefs.has(model.ref));
	return needle ? models : [...starred, ...rest];
}

export function pickerShortcutLabel(index: number, macintosh = isMacintosh): string | undefined {
	if (index < 0 || index >= PICKER_SHORTCUT_COUNT) {
		return undefined;
	}
	return macintosh ? `\u2318${index + 1}` : `Ctrl+${index + 1}`;
}

export function toggleFavoriteRefs(refs: readonly string[], ref: string): string[] {
	return refs.includes(ref) ? refs.filter(item => item !== ref) : [...refs, ref];
}
