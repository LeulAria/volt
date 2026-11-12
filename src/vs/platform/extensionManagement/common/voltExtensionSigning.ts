/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The part of product.json the check reads (`IProductConfiguration['extensionsGallery']`). */
interface IVoltSigningProduct {
	readonly extensionsGallery?: { readonly voltRegistryPublicKeys?: readonly string[] };
}

/**
 * INV-29: an extension from the gallery installs only with a valid registry signature, or as an
 * explicitly unsigned third-party extension the user consented to. Enforced only when product.json
 * pins the registry's keys (`extensionsGallery.voltRegistryPublicKeys`); otherwise installs work as before.
 */
export function voltRegistryPublicKeys(product: IVoltSigningProduct): readonly string[] {
	const keys = product.extensionsGallery?.voltRegistryPublicKeys;
	return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string' && !!key.trim()) : [];
}

export function hasVoltRegistryPublicKeys(product: IVoltSigningProduct): boolean {
	return voltRegistryPublicKeys(product).length > 0;
}
