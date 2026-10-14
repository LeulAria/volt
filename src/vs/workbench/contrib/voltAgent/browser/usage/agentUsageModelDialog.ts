/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IVoltUsageModelPrice, IVoltUsageSnapshot, VoltUsageProvider } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { createBrandIcon } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { IUsageChartSeriesStyle, UsageChart } from './agentUsageChart.js';
import { formatCost, formatShare, formatTokens } from './agentUsageFormat.js';
import { cacheHitRate, costPerMillionTokens, IUsageModelRow, summarizeUsage, UsageMetric, UsageRange } from './agentUsageModel.js';
import { copyUsagePage } from './agentUsagePageMirror.js';
import { costTypeSegments, hasFasterSpeeds, renderShareBar, speedCostSegments, tokenTypeSegments } from './agentUsageShareBar.js';

export interface IUsageModelDialogOptions {
	readonly model: IUsageModelRow;
	readonly snapshot: IVoltUsageSnapshot;
	readonly range: UsageRange;
	readonly metric: UsageMetric;
	/** The model's share of all cost in the range, e.g. 0.824. */
	readonly costShare: number;
	readonly agentLabel: string;
	readonly style: IUsageChartSeriesStyle;
	/** The usage page under the dialog; a blurred copy of it frosts the card. */
	readonly page: HTMLElement;
	/** The price the user set for this model, if any. */
	readonly price?: IVoltUsageModelPrice;
	/** Saves (or with `undefined`, clears) the model's price; the page reloads after. */
	readonly setPrice: (price: IVoltUsageModelPrice | undefined) => Promise<void>;
}

/**
 * One model's usage in the current range, opened from the Breakdown list: its cost, tokens,
 * effective price and cache hit rate, its own trend, and how its cost and tokens split by type
 * and speed. The figures come from the same snapshot as the page, narrowed to this model.
 */
export function showUsageModelDialog(host: HTMLElement, options: IUsageModelDialogOptions): IDisposable {
	const store = new DisposableStore();
	const window = getWindow(host);
	const previousFocus = window.document.activeElement as HTMLElement | null;
	const { model } = options;

	// Only this model's buckets: the chart, splits and stats all derive from the same narrowing.
	const narrowed: IVoltUsageSnapshot = {
		...options.snapshot,
		buckets: options.snapshot.buckets.filter(bucket => bucket.provider === model.provider && bucket.model === model.model),
		activity: [],
	};
	const unpriced = model.cost === 0 && model.unpricedTokens > 0;
	const metric: UsageMetric = unpriced ? 'tokens' : options.metric;
	const summary = summarizeUsage(narrowed, options.range, metric);
	const totals = summary.total;

	const layer = append(host, $('.volt-usage-dialog-layer'));
	store.add(toDisposable(() => layer.remove()));
	// Softens the page behind the dialog (agentUsage.css). A plain filter on the page itself, never
	// backdrop-filter: that breaks the see-through agent window (black sidebar, scroll trails).
	host.classList.add('dialog-open');
	store.add(toDisposable(() => host.classList.remove('dialog-open')));
	const backdrop = append(layer, $('.volt-usage-dialog-backdrop'));
	const dialog = append(layer, $('.volt-usage-dialog'));
	dialog.setAttribute('role', 'dialog');
	// Frosted card without backdrop-filter (it breaks the see-through agent window): a copy of the
	// page sits behind the card's content, lined up with the real page and blurred 2px, under the
	// card's own translucent fill.
	const glass = append(dialog, $('.volt-usage-dialog-glass'));
	const mirror = append(glass, copyUsagePage(options.page));
	const placeMirror = () => {
		const pageRect = options.page.getBoundingClientRect();
		const glassRect = glass.getBoundingClientRect();
		mirror.style.width = `${pageRect.width}px`;
		mirror.style.transform = `translate(${pageRect.left - glassRect.left}px, ${pageRect.top - glassRect.top}px)`;
	};
	window.requestAnimationFrame(placeMirror);
	// The card scales in; line the copy up again once it has settled, and on every resize.
	store.add(addDisposableListener(dialog, 'animationend', placeMirror));
	const resize = new window.ResizeObserver(placeMirror);
	resize.observe(layer);
	store.add(toDisposable(() => resize.disconnect()));
	// The content scrolls inside the card, so the frost and the glass edge stay put on short windows.
	const body = append(dialog, $('.volt-usage-dialog-body'));
	dialog.setAttribute('aria-modal', 'true');
	dialog.tabIndex = -1;

	const header = append(body, $('.volt-usage-dialog-header'));
	const title = append(header, $('.title'));
	title.appendChild(createBrandIcon(model.provider, 20));
	const name = append(title, $('h2'));
	name.textContent = model.model;
	name.id = `volt-usage-dialog-${Date.now()}`;
	dialog.setAttribute('aria-labelledby', name.id);
	append(header, $('.description')).textContent = unpriced
		? options.agentLabel
		: localize('voltUsage.dialogShare', "{0} · {1} of cost", options.agentLabel, formatShare(options.costShare, 1));
	const close = append(header, $('button.close')) as HTMLButtonElement;
	close.type = 'button';
	close.setAttribute('aria-label', localize('voltUsage.close', "Close"));
	close.appendChild(renderIcon(Codicon.close));

	const stats = append(body, $('.volt-usage-dialog-stats'));
	const perMillion = costPerMillionTokens(totals);
	const hitRate = cacheHitRate(totals);
	const statRows: [string, string][] = [
		[localize('voltUsage.costColumn', "Cost"), unpriced ? localize('voltUsage.unpriced', "Unpriced") : formatCost(totals.cost)],
		[localize('voltUsage.tokensColumn', "Tokens"), formatTokens(totals.tokens)],
	];
	if (perMillion !== undefined) {
		statRows.push([localize('voltUsage.perMillion', "Per 1M tokens"), formatCost(perMillion)]);
	}
	if (hitRate !== undefined) {
		statRows.push([localize('voltUsage.cacheHit', "Cache hit"), formatShare(hitRate, 1)]);
	}
	for (const [label, value] of statRows) {
		const stat = append(stats, $('.stat'));
		append(stat, $('.label')).textContent = label;
		append(stat, $('.value')).textContent = value;
	}

	// Unpriced cost is unknown, not zero, so its trend shows tokens.
	const chartHost = append(body, $('.volt-usage-dialog-chart'));
	const chart = store.add(new UsageChart(chartHost));
	const styles = new Map<VoltUsageProvider, IUsageChartSeriesStyle>([[model.provider, options.style]]);
	window.requestAnimationFrame(() => chart.update(summary, metric, styles, true));

	const shares = append(body, $('.volt-usage-shares'));
	if (!unpriced) {
		renderShareBar(shares, localize('voltUsage.costByType', "Cost by type"), costTypeSegments(totals), formatCost);
	}
	renderShareBar(shares, localize('voltUsage.tokensByType', "Tokens by type"), tokenTypeSegments(totals), formatTokens);
	if (hasFasterSpeeds(totals)) {
		renderShareBar(shares, localize('voltUsage.costBySpeed', "Cost by speed"), speedCostSegments(totals), formatCost,
			localize('voltUsage.premium', "Premium {0}", formatCost(totals.speedPremium)));
	}
	if (totals.unpricedTokens > 0) {
		append(body, $('.volt-usage-dialog-footnote')).textContent = localize('voltUsage.unpricedTokens', "{0} tokens have no known price", formatTokens(totals.unpricedTokens));
	}
	renderPriceEditor(body, options, store, unpriced);

	const dismiss = () => store.dispose();
	store.add(addDisposableListener(close, EventType.CLICK, dismiss));
	store.add(addDisposableListener(backdrop, EventType.CLICK, dismiss));
	store.add(addDisposableListener(layer, EventType.KEY_DOWN, e => {
		if (new StandardKeyboardEvent(e).equals(KeyCode.Escape)) {
			e.preventDefault();
			e.stopPropagation();
			dismiss();
		}
	}));
	store.add(toDisposable(() => previousFocus?.focus?.()));
	window.requestAnimationFrame(() => close.focus());
	return store;
}

const PRICE_FIELDS: { key: keyof IVoltUsageModelPrice; label: string; optional: boolean }[] = [
	{ key: 'input', label: localize('voltUsage.priceInput', "Input"), optional: false },
	{ key: 'output', label: localize('voltUsage.priceOutput', "Output"), optional: false },
	{ key: 'cacheRead', label: localize('voltUsage.priceCacheRead', "Cache read"), optional: true },
	{ key: 'cacheWrite', label: localize('voltUsage.priceCacheWrite', "Cache write"), optional: true },
];

function formatRate(value: number): string {
	return `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

/**
 * The model's price in USD per million tokens: the one the user set, or a button to set one.
 * It replaces automatic pricing for every row of the model, here and from other machines.
 */
function renderPriceEditor(body: HTMLElement, options: IUsageModelDialogOptions, store: DisposableStore, unpriced: boolean): void {
	const section = append(body, $('.volt-usage-price'));
	const showSummary = () => {
		section.replaceChildren();
		const line = append(section, $('.summary'));
		const price = options.price;
		append(line, $('span.text')).textContent = price
			? localize('voltUsage.priceSet', "Your price per 1M tokens: {0} input, {1} output, {2} cache read, {3} cache write",
				formatRate(price.input), formatRate(price.output), formatRate(price.cacheRead ?? price.input), formatRate(price.cacheWrite ?? price.input))
			: unpriced
				? localize('voltUsage.priceMissing', "No public price is known for this model.")
				: localize('voltUsage.priceAuto', "Priced automatically from public API prices.");
		const edit = append(line, $('button.volt-usage-more')) as HTMLButtonElement;
		edit.type = 'button';
		edit.textContent = price ? localize('voltUsage.editPrice', "Edit Price") : localize('voltUsage.setPrice', "Set Price");
		store.add(addDisposableListener(edit, EventType.CLICK, showForm));
		if (price) {
			const reset = append(line, $('button.volt-usage-more')) as HTMLButtonElement;
			reset.type = 'button';
			reset.textContent = localize('voltUsage.resetPrice', "Reset to Automatic");
			store.add(addDisposableListener(reset, EventType.CLICK, () => void save(undefined, reset)));
		}
	};
	const save = async (price: IVoltUsageModelPrice | undefined, button: HTMLButtonElement, error?: HTMLElement) => {
		button.disabled = true;
		try {
			await options.setPrice(price);
		} catch (e) {
			button.disabled = false;
			if (error) {
				error.textContent = e instanceof Error ? e.message : String(e);
			}
		}
	};
	const showForm = () => {
		section.replaceChildren();
		append(section, $('.caption')).textContent = localize('voltUsage.priceCaption', "USD per 1M tokens. Blank cache rates use the input rate; enter 0 for free tokens.");
		const grid = append(section, $('.fields'));
		const inputs = new Map<keyof IVoltUsageModelPrice, HTMLInputElement>();
		for (const field of PRICE_FIELDS) {
			const label = append(grid, $('label.field'));
			append(label, $('span')).textContent = field.label;
			const input = append(label, $('input')) as HTMLInputElement;
			input.type = 'number';
			input.min = '0';
			input.step = 'any';
			input.placeholder = field.optional ? localize('voltUsage.priceSameAsInput', "Input rate") : '0.00';
			const current = options.price?.[field.key];
			if (current !== undefined) {
				input.value = String(current);
			}
			inputs.set(field.key, input);
		}
		const error = append(section, $('.error'));
		const actions = append(section, $('.actions'));
		const cancel = append(actions, $('button.volt-usage-more')) as HTMLButtonElement;
		cancel.type = 'button';
		cancel.textContent = localize('voltUsage.cancel', "Cancel");
		store.add(addDisposableListener(cancel, EventType.CLICK, showSummary));
		const submit = append(actions, $('button.volt-usage-more.primary')) as HTMLButtonElement;
		submit.type = 'button';
		submit.textContent = localize('voltUsage.savePrice', "Save Price");
		store.add(addDisposableListener(submit, EventType.CLICK, () => {
			const price: Record<string, number> = {};
			for (const field of PRICE_FIELDS) {
				const text = inputs.get(field.key)!.value.trim();
				if (!text) {
					if (!field.optional) {
						error.textContent = localize('voltUsage.priceRequired', "Enter the {0} rate.", field.label.toLowerCase());
						return;
					}
					continue;
				}
				const value = Number(text);
				if (!Number.isFinite(value) || value < 0) {
					error.textContent = localize('voltUsage.priceInvalid', "{0} must be a number of 0 or more.", field.label);
					return;
				}
				price[field.key] = value;
			}
			void save(price as unknown as IVoltUsageModelPrice, submit, error);
		}));
		inputs.get('input')!.focus();
	};
	showSummary();
}
