/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { DisposableStore, IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVoltFeatureModuleService, VoltFeatureHoverPlacement } from '../../../voltCustomize/browser/voltFeatureModules.js';
import { IVoltFeatureService } from '../../../voltCustomize/common/voltFeatures.js';
import { setAgentTooltip } from './agentTooltip.js';

/**
 * Hovering `anchor` shows the card the feature module that owns slot item `itemId` draws (Usage:
 * every account's limits), in place of the plain `tooltip`. The module loads on the first hover,
 * not before; while its feature is off, or where there are no modules, the tooltip shows.
 */
export function attachFeatureItemHover(instantiationService: IInstantiationService, anchor: HTMLElement, itemId: string, placement: VoltFeatureHoverPlacement, tooltip?: string): IDisposable {
	const store = new DisposableStore();
	const [modules, features] = instantiationService.invokeFunction(accessor => [accessor.getIfExists(IVoltFeatureModuleService), accessor.getIfExists(IVoltFeatureService)] as const);
	if (!modules) {
		if (tooltip !== undefined) {
			setAgentTooltip(anchor, tooltip);
		}
		return store;
	}
	const card = store.add(new MutableDisposable());
	let loading = false;
	const sync = () => {
		const owner = modules.partOwner('itemHover', itemId);
		if (!owner) {
			card.clear();
		}
		if (tooltip !== undefined) {
			setAgentTooltip(anchor, owner ? undefined : tooltip);
		}
	};
	let cardFeature: string | undefined;
	store.add(addDisposableListener(anchor, 'mouseenter', () => {
		const owner = modules.partOwner('itemHover', itemId);
		if (card.value || loading || !owner) {
			return;
		}
		loading = true;
		void modules.part('itemHover', itemId).then(part => {
			if (!part || store.isDisposed || card.value) {
				return;
			}
			cardFeature = owner;
			card.value = part.attach(instantiationService, anchor, placement);
			// The pointer that asked for it is still there: the card shows for this hover too.
			if (anchor.matches(':hover')) {
				anchor.dispatchEvent(new MouseEvent('mouseenter'));
			}
		}).finally(() => loading = false);
	}));
	// Unloaded (its extension disabled): the card goes with the module; the next hover loads it again.
	store.add(modules.onDidChange(feature => {
		if (feature === cardFeature && !modules.isActive(feature)) {
			card.clear();
		}
		sync();
	}));
	if (features) {
		store.add(features.onDidChange(sync));
	}
	sync();
	return store;
}
