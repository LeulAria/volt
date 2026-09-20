/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../base/browser/dom.js';
import { renderAntigravityBrand } from './antigravityIcon.js';

export interface IProviderBrandPath {
	readonly d: string;
	readonly evenOdd?: boolean;
	/** Explicit fill. Omit to inherit `currentColor`. */
	readonly fill?: string;
}

export interface IProviderBrand {
	readonly id: string;
	readonly label: string;
	readonly viewBox: string;
	readonly paths?: readonly IProviderBrandPath[];
	/** Brand colour. Omit to inherit `currentColor` so the glyph follows the theme. */
	readonly color?: string;
	/** Rich marks (filters, masks, mixed fills) that cannot be expressed as paths. */
	readonly render?: (svg: SVGSVGElement) => void;
}

const SPARK: IProviderBrandPath = {
	d: 'M12 1.5 14.6 9.4 22.5 12 14.6 14.6 12 22.5 9.4 14.6 1.5 12 9.4 9.4Z',
};

export const PROVIDER_BRANDS: Record<string, IProviderBrand> = {
	codex: {
		id: 'codex',
		label: 'Codex',
		viewBox: '0 0 24 24',
		paths: [{
			evenOdd: true,
			d: 'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z',
		}],
	},
	claude: {
		id: 'claude',
		label: 'Claude',
		viewBox: '0 0 24 24',
		color: '#D97757',
		paths: [{
			d: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
		}],
	},
	cursor: {
		id: 'cursor',
		label: 'Cursor',
		viewBox: '0 0 466.73 532.09',
		paths: [{
			d: 'M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z',
		}],
	},
	grok: {
		id: 'grok',
		label: 'Grok',
		viewBox: '0 0 1024 1024',
		paths: [
			{ d: 'M395.479 633.828L735.91 381.105C752.599 368.715 776.454 373.548 784.406 392.792C826.26 494.285 807.561 616.253 724.288 699.996C641.016 783.739 525.151 802.104 419.247 760.277L303.556 814.143C469.49 928.202 670.987 899.995 796.901 773.282C896.776 672.843 927.708 535.937 898.785 412.476L899.047 412.739C857.105 231.37 909.358 158.874 1016.4 10.6326C1018.93 7.11771 1021.47 3.60279 1024 0L883.144 141.651V141.212L395.392 633.916' },
			{ d: 'M325.226 695.251C206.128 580.84 226.662 403.776 328.285 301.668C403.431 226.097 526.549 195.254 634.026 240.596L749.454 186.994C728.657 171.88 702.007 155.623 671.424 144.2C533.19 86.9942 367.693 115.465 255.323 228.382C147.234 337.081 113.244 504.215 171.613 646.833C215.216 753.423 143.739 828.818 71.7385 904.916C46.2237 931.893 20.6216 958.87 0 987.429L325.139 695.339' },
		],
	},
	opencode: {
		id: 'opencode',
		label: 'OpenCode',
		viewBox: '0 0 24 24',
		paths: [{ d: 'M22 24H2V0h20zM17 4.8H7v14.4h10z' }],
	},
	antigravity: {
		id: 'antigravity',
		label: 'Antigravity',
		viewBox: '0 0 16 15',
		render: renderAntigravityBrand,
	},
	kimi: {
		id: 'kimi',
		label: 'Kimi Code',
		viewBox: '0 0 512 512',
		paths: [
			{ d: 'M503 114.333v280c0 60.711-49.29 110-110 110H113c-60.711 0-110-49.289-110-110v-280c0-60.71 49.289-110 110-110h280c60.71 0 110 49.29 110 110z', fill: '#111' },
			{ d: 'M342.065 189.759c1.886-2.42 3.541-4.63 5.289-6.77.81-1.007.74-1.771-.046-2.824-7.58-9.965-8.298-21.028-3.935-32.254 3.275-8.448 10.52-12.406 19.373-13.25 5.52-.521 10.936.046 15.959 2.73 6.596 3.53 10.438 8.912 11.688 16.341.995 5.926.81 11.712-.868 17.452-2.974 10.161-10.277 15.427-20.287 16.758-8.31 1.11-16.734 1.25-25.113 1.817-.648.046-1.308 0-2.06 0z', fill: '#027aff' },
			{ d: 'M321.512 144.254h-50.064l-39.637 90.384h-56.036v-89.99H131v232.868h44.787v-98.103h78.973c13.598 0 26.015-7.927 31.744-20.252v118.355h44.787v-98.103c0-23.342-18.239-42.97-41.523-44.671v-.116h-24.593a45.577 45.577 0 0026.884-24.534l29.453-65.838z', fill: '#fff', evenOdd: true },
		],
	},
	muse: {
		id: 'muse',
		label: 'Muse Code',
		viewBox: '0 0 24 24',
		paths: [{
			d: 'M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z',
		}],
	},
	local: {
		id: 'local',
		label: 'Local',
		viewBox: '0 0 16 16',
		paths: [{
			d: 'M8 1a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1zm1 13.5a.5.5 0 1 0 1 0a.5.5 0 0 0-1 0m2 0a.5.5 0 1 0 1 0a.5.5 0 0 0-1 0M9.5 1a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1zM9 3.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 0-1h-5a.5.5 0 0 0-.5.5M1.5 2A1.5 1.5 0 0 0 0 3.5v7A1.5 1.5 0 0 0 1.5 12H6v2h-.5a.5.5 0 0 0 0 1H7v-4H1.5a.5.5 0 0 1-.5-.5v-7a.5.5 0 0 1 .5-.5H7V2z',
		}],
	},
	openrouter: {
		id: 'openrouter',
		label: 'OpenRouter',
		viewBox: '0 0 24 24',
		paths: [SPARK],
	},
	generic: {
		id: 'generic',
		label: 'Provider',
		viewBox: '0 0 24 24',
		paths: [SPARK],
	},
};

/**
 * Providers that share a rail entry in the picker. Codex is OpenAI's CLI, so an API key
 * connection to OpenAI belongs on the same tab rather than beside a duplicate icon, and every
 * on-device runtime collapses into one "Local" tab.
 */
const PROVIDER_FAMILIES: Record<string, string> = {
	codex: 'codex',
	openai: 'codex',
	claude: 'claude',
	'claude-code': 'claude',
	anthropic: 'claude',
	cursor: 'cursor',
	'cursor-acp': 'cursor',
	grok: 'grok',
	xai: 'grok',
	opencode: 'opencode',
	antigravity: 'antigravity',
	agy: 'antigravity',
	gemini: 'antigravity',
	'gemini-cli': 'antigravity',
	'gemini-acp': 'antigravity',
	kimi: 'kimi',
	muse: 'muse',
	ollama: 'local',
	lmstudio: 'local',
	'openai-compat': 'local',
	openrouter: 'openrouter',
};

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

/** Rail identity for a provider: several provider ids can collapse onto one family. */
export function providerFamily(providerId: string): string {
	return PROVIDER_FAMILIES[providerId] ?? providerId;
}

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
