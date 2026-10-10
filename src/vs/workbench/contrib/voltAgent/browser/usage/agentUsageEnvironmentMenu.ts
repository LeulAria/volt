/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';

/** Which environments the Usage header is showing. One machine today, so both flags move together. */
export interface IUsageEnvironmentSelection {
	readonly all: boolean;
	readonly local: boolean;
}

/** Horizontal sliders, the same mark Cursor uses beside Model prices. */
const SLIDER_LINES: readonly (readonly [string, string, string, string])[] = [
	['21', '14', '4', '4'],
	['10', '3', '4', '4'],
	['21', '12', '12', '12'],
	['8', '3', '12', '12'],
	['21', '16', '20', '20'],
	['12', '3', '20', '20'],
	['14', '14', '2', '6'],
	['8', '8', '10', '14'],
	['16', '16', '18', '22'],
];

/**
 * macOS sometimes stores the computer name with bidi marks, so the logical order is the reverse
 * of what the menu should show ("MacBook Pro" then "LeulAria" reads as "LeulAria MacBook Pro").
 */
export function displayComputerName(raw: string): string {
	const trimmed = raw.trim();
	if (!/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(trimmed)) {
		return trimmed;
	}
	const chunks = trimmed
		.split(/[\u202a-\u202e\u2066-\u2069]+/)
		.map(part => part.replace(/[\u200e\u200f]/g, '').trim())
		.filter(part => part.length > 0);
	if (!chunks.length) {
		return trimmed.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
	}
	const rtl = /[\u200f\u202b\u202e]/.test(trimmed);
	return (rtl ? chunks.reverse() : chunks).join(' ');
}

/** Friendly machine name from the process environment, or the caller's fallback ("This Mac"). */
export function usageMachineName(env: { readonly COMPUTERNAME?: string; readonly HOSTNAME?: string } | undefined, fallback: string): string {
	const computer = env?.COMPUTERNAME?.trim();
	if (computer) {
		return computer;
	}
	const host = env?.HOSTNAME?.trim().replace(/\.local$/i, '');
	if (!host || host.toLowerCase() === 'localhost') {
		return fallback;
	}
	return host.includes(' ') ? host : host.replace(/-/g, ' ');
}

/** Trigger text: "All environments" while every environment is on, otherwise the one that is. */
export function usageEnvironmentTriggerLabel(state: IUsageEnvironmentSelection, machine: string, allLabel: string, noneLabel: string): string {
	if (state.all && state.local) {
		return allLabel;
	}
	if (state.local) {
		return machine;
	}
	return noneLabel;
}

/** "All environments" selects every row. The local row is the only environment, so it tracks that. */
export function toggleUsageEnvironment(state: IUsageEnvironmentSelection, id: 'all' | 'local'): IUsageEnvironmentSelection {
	if (id === 'all') {
		const on = !(state.all && state.local);
		return { all: on, local: on };
	}
	const local = !state.local;
	return { all: local, local };
}

type EnvPick = 'all' | 'local' | 'prices';

function sliderIcon(doc: Document): SVGSVGElement {
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	for (const [x1, x2, y1, y2] of SLIDER_LINES) {
		const line = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
		line.setAttribute('x1', x1);
		line.setAttribute('x2', x2);
		line.setAttribute('y1', y1);
		line.setAttribute('y2', y2);
		line.setAttribute('stroke', 'currentColor');
		line.setAttribute('stroke-width', '1.75');
		line.setAttribute('stroke-linecap', 'round');
		svg.appendChild(line);
	}
	return svg;
}

export interface IUsageEnvironmentMenuOptions {
	readonly anchor: HTMLElement;
	readonly state: IUsageEnvironmentSelection;
	readonly machineLabel: string;
	readonly onToggle: (state: IUsageEnvironmentSelection) => void;
	readonly onModelPrices?: () => void;
}

/**
 * The Usage header's environment menu: checked environments, then Model prices.
 * Checking a row leaves the menu open. Model prices closes it.
 * Rows are the shared list menu, flush to the border.
 */
export function showUsageEnvironmentMenu(contextViewService: IContextViewService, options: IUsageEnvironmentMenuOptions): void {
	let state = options.state;
	const allLabel = localize('voltUsage.allEnvironments', "All environments");
	const pricesLabel = localize('voltUsage.modelPrices', "Model prices");
	const doc = options.anchor.ownerDocument;
	const row = (id: EnvPick, label: string, mark: 'check' | 'blank' | 'sliders', keepOpen: boolean): IVoltMenuItem<EnvPick> => ({
		id,
		label,
		// Checks stay in the leading slot, in line with Model prices. An empty slot holds the place when off.
		icon: mark === 'check' ? Codicon.check : mark === 'sliders' ? () => sliderIcon(doc) : () => doc.createElement('span'),
		keepOpen,
		data: id,
	});
	const width = Math.min(340, Math.max(228, Math.ceil(options.machineLabel.length * 7.6 + 64)));
	const menu = showVoltMenu(contextViewService, {
		anchor: options.anchor,
		position: 'below',
		align: 'left',
		gap: 4,
		width,
		ariaLabel: allLabel,
		sections: () => [{
			id: 'environments',
			items: [
				row('all', allLabel, (state.all && state.local) ? 'check' : 'blank', true),
				row('local', options.machineLabel, state.local ? 'check' : 'blank', true),
			],
		}, {
			id: 'prices',
			items: [row('prices', pricesLabel, 'sliders', false)],
		}],
		onPick: picked => {
			if (picked.data === 'prices') {
				options.onModelPrices?.();
				return;
			}
			state = toggleUsageEnvironment(state, picked.data);
			options.onToggle(state);
			menu.refresh();
		},
	});
}
