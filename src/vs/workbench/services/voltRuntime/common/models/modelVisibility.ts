/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which catalog rows the chat model picker may show.
 *
 * `whitelist` is the older "only these" list. Empty means every model is on.
 * `hidden` is the models the user turned off. An empty whitelist must not mean
 * "show everything" once a model has been hidden, or the next catalog refresh
 * puts it back.
 */

export interface IModelVisibility {
	readonly hidden: readonly string[];
	readonly whitelist: readonly string[];
}

export function isCatalogModelEnabled(ref: string, hidden: ReadonlySet<string>, whitelist: ReadonlySet<string>): boolean {
	if (hidden.has(ref)) {
		return false;
	}
	return whitelist.size === 0 || whitelist.has(ref);
}

export function setCatalogModelEnabled(ref: string, enabled: boolean, hidden: ReadonlySet<string>, whitelist: ReadonlySet<string>): IModelVisibility {
	const nextHidden = new Set(hidden);
	const nextWhitelist = new Set(whitelist);
	if (enabled) {
		nextHidden.delete(ref);
		if (nextWhitelist.size) {
			nextWhitelist.add(ref);
		}
	} else {
		nextHidden.add(ref);
		nextWhitelist.delete(ref);
	}
	return { hidden: [...nextHidden], whitelist: [...nextWhitelist] };
}

export function enabledProfileIds(profiles: readonly { id: string; enabled: boolean }[]): Set<string> {
	return new Set(profiles.filter(profile => profile.enabled).map(profile => profile.id));
}

/** A model stays out of the picker when its own switch is off or its provider is off. */
export function isPickerModelVisible(item: { enabled: boolean; profileId: string }, profiles: ReadonlySet<string>): boolean {
	return item.enabled && profiles.has(item.profileId);
}
