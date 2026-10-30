/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { createBrandIcon, PROVIDER_BRANDS } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { GitCodingAgentId } from '../../common/gitAgentAttribution.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Marks Volt's provider brands don't carry (dashboard-icons github-copilot, theSVG gemini-google, via AriaIcons). */
const EXTRA_MARKS: Partial<Record<GitCodingAgentId, { readonly viewBox: string; readonly d: string; readonly color?: string }>> = {
	copilot: {
		viewBox: '0 2.5 24 19',
		d: 'M19.245 5.364c1.322 1.36 1.877 3.216 2.11 5.817.622 0 1.2.135 1.592.654l.73.964c.21.278.323.61.323.955v2.62c0 .339-.173.669-.453.868C20.239 19.602 16.157 21.5 12 21.5c-4.6 0-9.205-2.583-11.547-4.258-.28-.2-.452-.53-.453-.868v-2.62c0-.345.113-.679.321-.956l.73-.963c.392-.517.974-.654 1.593-.654l.029-.297c.25-2.446.81-4.213 2.082-5.52 2.461-2.54 5.71-2.851 7.146-2.864h.198c1.436.013 4.685.323 7.146 2.864zm-7.244 4.328c-.284 0-.613.016-.962.05-.123.447-.305.85-.57 1.108-1.05 1.023-2.316 1.18-2.994 1.18-.638 0-1.306-.13-1.851-.464-.516.165-1.012.403-1.044.996a65.882 65.882 0 00-.063 2.884l-.002.48c-.002.563-.005 1.126-.013 1.69.002.326.204.63.51.765 2.482 1.102 4.83 1.657 6.99 1.657 2.156 0 4.504-.555 6.985-1.657a.854.854 0 00.51-.766c.03-1.682.006-3.372-.076-5.053-.031-.596-.528-.83-1.046-.996-.546.333-1.212.464-1.85.464-.677 0-1.942-.157-2.993-1.18-.266-.258-.447-.661-.57-1.108-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zM7.635 5.087c-1.05.102-1.935.438-2.385.906-.975 1.037-.765 3.668-.21 4.224.405.394 1.17.657 1.995.657h.09c.649-.013 1.785-.176 2.73-1.11.435-.41.705-1.433.675-2.47-.03-.834-.27-1.52-.63-1.813-.39-.336-1.275-.482-2.265-.394zm6.465.394c-.36.292-.6.98-.63 1.813-.03 1.037.24 2.06.675 2.47.968.957 2.136 1.104 2.776 1.11h.044c.825 0 1.59-.263 1.995-.657.555-.556.765-3.187-.21-4.224-.45-.468-1.335-.804-2.385-.906-.99-.088-1.875.058-2.265.394zM12 7.615c-.24 0-.525.015-.84.044.03.16.045.336.06.526l-.001.159a2.94 2.94 0 01-.014.25c.225-.022.425-.027.612-.028h.366c.187 0 .387.006.612.028-.015-.146-.015-.277-.015-.409.015-.19.03-.365.06-.526a9.29 9.29 0 00-.84-.044z',
	},
	gemini: {
		viewBox: '0 0 24 24',
		color: '#4C8DF6',
		d: 'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z',
	},
};

/** The bolt from brand/volt-icon.svg, as the agent terminal icon draws it. */
const VOLT_BOLT = 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z';

/**
 * A coding agent's mark at `size`: the provider brand Volt already draws for Claude, Cursor, Codex,
 * Grok, OpenCode and Kimi; Copilot and Gemini from their own marks; a sparkle for the rest.
 */
export function createAgentMark(id: GitCodingAgentId, size = 14): HTMLElement {
	if (PROVIDER_BRANDS[id]) {
		return createBrandIcon(id, size);
	}
	// Jules is Google's: it wears the Gemini spark.
	const extra = EXTRA_MARKS[id === 'jules' ? 'gemini' : id];
	if (extra || id === 'volt') {
		const host = $('span.volt-brand-icon');
		host.style.width = host.style.height = `${size}px`;
		if (extra?.color) {
			host.style.color = extra.color;
		}
		const svg = host.ownerDocument.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', extra?.viewBox ?? '0 0 24 24');
		svg.setAttribute('width', String(size));
		svg.setAttribute('height', String(size));
		svg.setAttribute('aria-hidden', 'true');
		const path = host.ownerDocument.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', extra?.d ?? VOLT_BOLT);
		path.setAttribute('fill', 'currentColor');
		if (extra) {
			path.setAttribute('fill-rule', 'evenodd');
		}
		svg.appendChild(path);
		host.appendChild(svg);
		return host;
	}
	const host = $('span.volt-brand-icon');
	host.style.width = host.style.height = `${size}px`;
	const icon = renderIcon(Codicon.sparkle);
	icon.style.fontSize = `${size}px`;
	host.appendChild(icon);
	return host;
}
