/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';
import { localize } from '../../../../../nls.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { formatShare } from './agentUsageFormat.js';
import { IUsageTotals } from './agentUsageModel.js';

export interface IShareSegment {
	readonly label: string;
	readonly value: number;
	/** CSS color. */
	readonly color: string;
}

/**
 * Token types and speeds take hues the page does not already use for an agent (Claude is orange,
 * Cursor blue), so a segment is never read as a provider. Validated as a set for both themes with
 * the dataviz palette checks; the values live in agentUsage.css (`--volt-usage-type-*`).
 */
const TYPE_COLORS = {
	input: 'var(--volt-usage-type-input)',
	cacheRead: 'var(--volt-usage-type-cache-read)',
	cacheWrite: 'var(--volt-usage-type-cache-write)',
	output: 'var(--volt-usage-type-output)',
	other: 'var(--volt-usage-type-other)',
};

export function costTypeSegments(totals: IUsageTotals): IShareSegment[] {
	const split = totals.inputCost + totals.cacheReadCost + totals.cacheWriteCost + totals.outputCost;
	// Reported cost with no rates to split it (Cursor's own models). Under a cent it is rounding.
	const other = totals.cost - split;
	return [
		{ label: localize('voltUsage.typeInput', "Input"), value: totals.inputCost, color: TYPE_COLORS.input },
		{ label: localize('voltUsage.typeCacheRead', "Cache read"), value: totals.cacheReadCost, color: TYPE_COLORS.cacheRead },
		{ label: localize('voltUsage.typeCacheWrite', "Cache write"), value: totals.cacheWriteCost, color: TYPE_COLORS.cacheWrite },
		{ label: localize('voltUsage.typeOutput', "Output"), value: totals.outputCost, color: TYPE_COLORS.output },
		{ label: localize('voltUsage.typeOther', "Other"), value: other >= 0.005 ? other : 0, color: TYPE_COLORS.other },
	];
}

export function tokenTypeSegments(totals: IUsageTotals): IShareSegment[] {
	return [
		{ label: localize('voltUsage.typeInput', "Input"), value: totals.uncached, color: TYPE_COLORS.input },
		{ label: localize('voltUsage.typeCacheRead', "Cache read"), value: totals.cached, color: TYPE_COLORS.cacheRead },
		{ label: localize('voltUsage.typeCacheWrite', "Cache write"), value: totals.cacheWrite, color: TYPE_COLORS.cacheWrite },
		{ label: localize('voltUsage.typeOutput', "Output"), value: totals.output, color: TYPE_COLORS.output },
	];
}

/** Speeds are ordered by price: calm for standard, warmer as they cost more. */
export function speedCostSegments(totals: IUsageTotals): IShareSegment[] {
	return [
		{ label: localize('voltUsage.speedStandard', "Standard"), value: Math.max(0, totals.cost - totals.fastCost - totals.ultrafastCost), color: 'var(--volt-usage-speed-standard)' },
		{ label: localize('voltUsage.speedFast', "Fast"), value: totals.fastCost, color: 'var(--volt-usage-speed-fast)' },
		{ label: localize('voltUsage.speedUltrafast', "Ultrafast"), value: totals.ultrafastCost, color: 'var(--volt-usage-speed-ultrafast)' },
	];
}

export function hasFasterSpeeds(totals: IUsageTotals): boolean {
	return totals.fastCost + totals.ultrafastCost > 0;
}

/**
 * One part-to-whole bar with its legend, for cost or tokens split by type or speed. Empty
 * segments are left out; nothing renders without a total. Returns the block, or undefined.
 */
export function renderShareBar(parent: HTMLElement, label: string, segments: readonly IShareSegment[], format: (value: number) => string, aside?: string): HTMLElement | undefined {
	const visible = segments.filter(segment => segment.value > 0);
	const total = visible.reduce((sum, segment) => sum + segment.value, 0);
	if (total <= 0) {
		return undefined;
	}
	const block = append(parent, $('.volt-usage-share'));
	const head = append(block, $('.volt-usage-share-head'));
	append(head, $('span.title')).textContent = label;
	if (aside) {
		append(head, $('span.aside')).textContent = aside;
	}
	const bar = append(block, $('.volt-usage-share-bar'));
	bar.setAttribute('role', 'img');
	bar.setAttribute('aria-label', `${label}: ${visible.map(segment => `${segment.label} ${format(segment.value)}`).join(', ')}`);
	for (const segment of visible) {
		const part = append(bar, $('span.segment'));
		part.style.flex = `${segment.value} 1 0`;
		part.style.background = segment.color;
		setAgentTooltip(part, `${segment.label} · ${format(segment.value)} · ${formatShare(segment.value, total)}`);
	}
	const legend = append(block, $('.volt-usage-share-legend'));
	for (const segment of visible) {
		const item = append(legend, $('span.item'));
		append(item, $('span.swatch')).style.background = segment.color;
		append(item, $('span.label')).textContent = segment.label;
		append(item, $('span.value')).textContent = format(segment.value);
	}
	return block;
}
