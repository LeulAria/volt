/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../base/browser/dom.js';
import { renderAntigravityBrand } from './antigravityIcon.js';
import { providerFamily } from './providerFamily.js';
import { IProviderBrandData, PROVIDER_BRAND_DATA } from './providerBrandData.js';

export { providerFamily };

export type { IProviderBrandPath } from './providerBrandData.js';

export interface IProviderBrand extends IProviderBrandData {
	/** Rich marks (filters, masks, mixed fills) that cannot be expressed as paths. */
	readonly render?: (svg: SVGSVGElement) => void;
}

const RICH_RENDERERS: Record<string, (svg: SVGSVGElement) => void> = {
	antigravity: renderAntigravityBrand,
};

export const PROVIDER_BRANDS: Record<string, IProviderBrand> = Object.fromEntries(Object.entries(PROVIDER_BRAND_DATA)
	.map(([id, brand]) => [id, RICH_RENDERERS[id] ? { ...brand, render: RICH_RENDERERS[id] } : brand]));

const FAMILY_LABELS: Record<string, string> = {
	codex: 'Codex',
	claude: 'Claude',
	cursor: 'Cursor',
	grok: 'Grok',
	opencode: 'OpenCode',
	antigravity: 'Antigravity',
	kimi: 'Kimi Code',
	muse: 'Muse Code',
	local: 'Local',
	openrouter: 'OpenRouter',
};


export function providerFamilyLabel(providerId: string): string {
	const family = providerFamily(providerId);
	return FAMILY_LABELS[family] ?? PROVIDER_BRANDS[family]?.label ?? family;
}

export function brandForProvider(providerId: string): IProviderBrand {
	return PROVIDER_BRANDS[providerFamily(providerId)] ?? PROVIDER_BRANDS.generic;
}

export function createBrandIcon(providerId: string, size = 16): HTMLElement {
	const brand = brandForProvider(providerId);
	const host = $('span.volt-brand-icon');
	host.style.width = `${size}px`;
	host.style.height = `${size}px`;
	if (brand.color) {
		host.style.color = brand.color;
	}
	const svg = host.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', brand.viewBox);
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	if (brand.render) {
		brand.render(svg);
	} else {
		for (const path of brand.paths ?? []) {
			const node = host.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
			node.setAttribute('d', path.d);
			node.setAttribute('fill', path.fill ?? 'currentColor');
			if (path.evenOdd) {
				node.setAttribute('fill-rule', 'evenodd');
				node.setAttribute('clip-rule', 'evenodd');
			}
			svg.appendChild(node);
		}
	}
	host.appendChild(svg);
	return host;
}
