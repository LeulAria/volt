/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, isHTMLElement } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IVoltUsageLimitGroup, IVoltUsageLimitWindow, VoltUsageProvider } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { createBrandIcon } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { DotMatrixMeter } from './agentUsageDots.js';
import { formatAxis, formatCost, formatDuration, formatPercent, formatSlot, formatTime, formatTokens, formatWeekday } from './agentUsageFormat.js';
import { IUsageSummary, limitPace } from './agentUsageModel.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** How far right of "now" the timeline reaches. Resets further out get an arrow at the edge. */
const HORIZON_MS = 7 * DAY_MS;

export interface IRunwayStyle {
	label(provider: VoltUsageProvider): string;
	color(provider: VoltUsageProvider): string;
}

interface IRunwayLane {
	readonly group: IVoltUsageLimitGroup;
	readonly window?: IVoltUsageLimitWindow;
}

/** What the stats row calls out: the soonest reset and the limit closest to running dry. */
export interface IRunwayHighlights {
	readonly nextReset?: { readonly provider: VoltUsageProvider; readonly label: string; readonly inMs: number };
	readonly risk?: { readonly provider: VoltUsageProvider; readonly label: string; readonly full: boolean; readonly inMs?: number };
}

export function runwayHighlights(groups: readonly IVoltUsageLimitGroup[], now: number): IRunwayHighlights {
	let nextReset: IRunwayHighlights['nextReset'];
	let risk: IRunwayHighlights['risk'];
	for (const group of groups) {
		for (const window of group.windows) {
			if (window.usedPercent > 0 && window.resetsAt && window.resetsAt > now) {
				const inMs = window.resetsAt - now;
				if (!nextReset || inMs < nextReset.inMs) {
					nextReset = { provider: group.provider, label: window.label, inMs };
				}
			}
			if (window.usedPercent >= 100) {
				// A limit already hit outranks one that is only on its way.
				if (!risk?.full) {
					risk = { provider: group.provider, label: window.label, full: true };
				}
				continue;
			}
			const runsOutInMs = limitPace(window, now)?.runsOutInMs;
			if (runsOutInMs !== undefined && !risk?.full && (risk?.inMs === undefined || runsOutInMs < risk.inMs)) {
				risk = { provider: group.provider, label: window.label, full: false, inMs: runsOutInMs };
			}
		}
	}
	return { nextReset, risk };
}

/** `5:09 PM` today, `Wed 4:59 PM` later in the week. */
function shortReset(ms: number, now: number): string {
	return ms - now < DAY_MS && new Date(ms).getDate() === new Date(now).getDate()
		? formatTime(ms)
		: `${formatWeekday(ms)} ${formatTime(ms)}`;
}

/** Places an element at a point of the future half: `fraction` 0 is now, 1 is the horizon. */
function atFuture(element: HTMLElement, fraction: number): void {
	element.style.setProperty('--volt-usage-f', String(Math.max(0, Math.min(1, fraction))));
}

/**
 * One time axis for spend and limits. Left of the NOW line, what each day (or hour) cost,
 * stacked by agent. Right of it, one lane per limit window: its dot meter sits at now, a dashed
 * line burns it forward at the current pace, a red block marks where it would run dry, and a
 * ring marks the reset.
 */
export function renderRunway(parent: HTMLElement, summary: IUsageSummary, groups: readonly IVoltUsageLimitGroup[], style: IRunwayStyle, now: number, animate: boolean, store: DisposableStore): HTMLElement {
	const runway = append(parent, $('.volt-usage-runway'));

	// Header row: the legend on the left, the spend bars and both axes on the right.
	const head = append(runway, $('.volt-usage-runway-row.head'));
	const legend = append(head, $('.volt-usage-runway-legend'));
	const title = append(legend, $('.title'));
	append(title, $('span')).textContent = localize('voltUsage.past', "Past");
	append(title, $('span.arrow')).textContent = '←';
	append(title, $('span.now')).textContent = localize('voltUsage.nowWord', "now");
	append(title, $('span.arrow')).textContent = '→';
	append(title, $('span')).textContent = localize('voltUsage.future', "future");
	append(legend, $('.hint')).textContent = localize('voltUsage.runwayHint', "Bars are what you spent. Each lane is a limit, burned forward at your pace until it resets.");
	const agents = append(legend, $('.agents'));
	for (const provider of summary.providers) {
		const item = append(agents, $('span.agent'));
		append(item, $('span.swatch')).style.background = style.color(provider.provider);
		append(item, $('span')).textContent = style.label(provider.provider);
	}

	const plot = append(head, $('.volt-usage-runway-plot'));
	const past = append(plot, $('.volt-usage-runway-past'));
	const peak = Math.max(0, ...summary.slots.map(slot => {
		let sum = 0;
		for (const totals of slot.byProvider.values()) {
			sum += totals.cost;
		}
		return sum;
	}));
	const order = summary.providers.map(row => row.provider).reverse();
	summary.slots.forEach((slot, index) => {
		const column = append(past, $('.col'));
		column.style.setProperty('--volt-usage-i', String(index));
		let cost = 0;
		let tokens = 0;
		for (const provider of order) {
			const totals = slot.byProvider.get(provider);
			if (!totals || totals.cost <= 0) {
				continue;
			}
			cost += totals.cost;
			tokens += totals.tokens;
			const part = append(column, $('span.part'));
			part.style.height = `${peak > 0 ? (totals.cost / peak) * 100 : 0}%`;
			part.style.background = style.color(provider);
		}
		for (const totals of slot.byProvider.values()) {
			if (totals.cost <= 0) {
				tokens += totals.tokens;
			}
		}
		column.classList.toggle('empty', cost <= 0);
		column.classList.toggle('animate', animate);
		setAgentTooltip(column, `${formatSlot(slot.start, summary.hourly)} · ${formatCost(cost)} · ${formatTokens(tokens)}`);
	});

	const future = append(plot, $('.volt-usage-runway-future'));
	for (let day = 1; day < HORIZON_MS / DAY_MS; day++) {
		const tick = append(future, $('span.tick'));
		atFuture(tick, day * DAY_MS / HORIZON_MS);
	}

	// Axis: a few dates under the bars, day offsets under the future.
	const axis = append(plot, $('.volt-usage-runway-axis'));
	const count = summary.slots.length;
	const labels = Math.min(5, count);
	for (let i = 0; i < labels; i++) {
		const index = Math.round((i / Math.max(1, labels - 1)) * (count - 1) * 0.86);
		const label = append(axis, $('span.past'));
		label.style.left = `calc(var(--volt-usage-now) * ${(index + 0.5) / count})`;
		label.textContent = formatAxis(summary.slots[index].start, summary.hourly);
	}
	for (let day = 1; day < HORIZON_MS / DAY_MS; day++) {
		const label = append(axis, $('span.future'));
		atFuture(label, day * DAY_MS / HORIZON_MS);
		label.textContent = `+${day}d`;
	}
	// The hovered day (or hour) also shows on the axis, in a chip under its bar that covers the
	// regular labels, the way the chart engine marks its crosshair.
	const chip = append(axis, $('span.cursor'));
	chip.setAttribute('aria-hidden', 'true');
	store.add(addDisposableListener(past, 'mouseover', e => {
		const column = isHTMLElement(e.target) ? e.target.closest<HTMLElement>('.col') : null;
		const index = column ? Number(column.style.getPropertyValue('--volt-usage-i')) : NaN;
		if (!column || !summary.slots[index]) {
			return;
		}
		chip.textContent = formatAxis(summary.slots[index].start, summary.hourly);
		chip.style.left = `${column.offsetLeft + column.offsetWidth / 2}px`;
		axis.classList.add('hovering');
	}));
	store.add(addDisposableListener(past, 'mouseleave', () => axis.classList.remove('hovering')));
	const marker = append(plot, $('.volt-usage-runway-now'));
	append(marker, $('span')).textContent = localize('voltUsage.nowAt', "NOW · {0}", `${formatWeekday(now)} ${formatTime(now)}`);

	const lanes: IRunwayLane[] = [];
	for (const group of groups) {
		if (group.error || !group.windows.length) {
			lanes.push({ group });
			continue;
		}
		for (const window of group.windows) {
			lanes.push({ group, window });
		}
	}
	for (const lane of lanes) {
		renderLane(runway, lane, style, now, animate, store);
	}
	return runway;
}

function renderLane(parent: HTMLElement, lane: IRunwayLane, style: IRunwayStyle, now: number, animate: boolean, store: DisposableStore): void {
	const { group, window } = lane;
	const color = style.color(group.provider);
	const row = append(parent, $('.volt-usage-runway-row.lane'));
	row.style.setProperty('--volt-usage-tint', color);

	const name = append(row, $('.volt-usage-runway-name'));
	name.appendChild(createBrandIcon(group.provider, 16));
	const text = append(name, $('.text'));
	// The icon names the provider, so the lane leads with the window; the plan or scope goes under it.
	append(text, $('.label')).textContent = window?.label ?? style.label(group.provider);
	const sub = append(text, $('.sub'));
	sub.textContent = window?.scope ?? (group.plan ? `${style.label(group.provider)} ${group.plan}` : style.label(group.provider));
	setAgentTooltip(name, window ? `${style.label(group.provider)} \u00b7 ${window.label}` : style.label(group.provider));
	if (window?.note) {
		setAgentTooltip(row, window.note);
	}

	const track = append(row, $('.volt-usage-runway-track'));
	append(track, $('span.now-rule'));
	if (!window) {
		const message = append(track, $('.volt-usage-runway-message'));
		message.appendChild(renderIcon(Codicon.info));
		append(message, $('span')).textContent = group.error ?? localize('voltUsage.noWindows', "No limits reported for this account.");
		return;
	}

	const used = Math.min(100, Math.max(0, window.usedPercent));
	const full = used >= 100;
	row.classList.toggle('full', full);

	// The meter ends at now: how much of the window is gone, with a tick where even use would be.
	const gauge = append(track, $('.volt-usage-runway-gauge'));
	store.add(new DotMatrixMeter(gauge, used / 100, `${group.provider}:${window.id}`, animate));
	if (window.resetsAt && window.windowMs && used > 0 && !full) {
		const elapsed = 1 - (window.resetsAt - now) / window.windowMs;
		if (elapsed > 0 && elapsed < 1) {
			const tick = append(gauge, $('span.pace'));
			tick.style.left = `${elapsed * 100}%`;
			setAgentTooltip(tick, localize('voltUsage.evenPace', "Where usage would be if it were spread evenly over the window"));
		}
	}
	const pace = used > 0 && !full ? limitPace(window, now) : undefined;
	const usedLabel = append(gauge, $('span.used'));
	usedLabel.textContent = localize('voltUsage.usedShort', "{0} used", formatPercent(used));
	usedLabel.classList.toggle('warn', pace?.runsOutInMs !== undefined);
	usedLabel.classList.toggle('full', full);

	if (!window.resetsAt || window.resetsAt <= now) {
		append(track, $('.volt-usage-runway-message.quiet')).textContent = used === 0
			? localize('voltUsage.notStarted', "Starts with your next message")
			: localize('voltUsage.noReset', "No reset time reported");
		return;
	}

	const resetIn = window.resetsAt - now;
	const resetAt = Math.min(1, resetIn / HORIZON_MS);
	const emptyIn = pace?.runsOutInMs;
	// An unused window has nothing to burn; it only shows when it resets.
	if (used > 0) {
		const burn = append(track, $('span.burn'));
		burn.classList.toggle('full', full);
		atFuture(burn, emptyIn !== undefined ? emptyIn / HORIZON_MS : resetAt);
	}
	if (full) {
		const blocked = append(track, $('span.blocked'));
		blocked.textContent = localize('voltUsage.limitReached', "Limit reached");
	} else if (emptyIn !== undefined) {
		const dry = append(track, $('span.dry'));
		atFuture(dry, emptyIn / HORIZON_MS);
		const dryLabel = append(track, $('span.dry-label'));
		atFuture(dryLabel, emptyIn / HORIZON_MS);
		dryLabel.textContent = localize('voltUsage.emptyIn', "empty in {0}", formatDuration(emptyIn));
		const starved = append(track, $('span.starved'));
		starved.style.setProperty('--volt-usage-from', String(emptyIn / HORIZON_MS));
		atFuture(starved, resetAt);
	}

	if (resetIn <= HORIZON_MS) {
		const ring = append(track, $('span.reset'));
		atFuture(ring, resetAt);
		const label = append(track, $('span.reset-label'));
		atFuture(label, resetAt);
		label.classList.toggle('before', resetAt > 0.8);
		label.appendChild(renderIcon(Codicon.refresh));
		append(label, $('span')).textContent = shortReset(window.resetsAt, now);
	} else {
		const label = append(track, $('span.reset-label.edge'));
		label.appendChild(renderIcon(Codicon.refresh));
		append(label, $('span')).textContent = localize('voltUsage.resetsLater', "in {0}", formatDuration(resetIn));
		label.appendChild(renderIcon(Codicon.arrowRight));
	}
}
