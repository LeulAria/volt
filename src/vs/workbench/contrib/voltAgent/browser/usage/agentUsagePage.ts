/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentUsage.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Action } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IVoltUsageLimitGroup, IVoltUsageService, IVoltUsageSnapshot, VOLT_USAGE_PROVIDERS, VoltUsageProvider } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { createBrandIcon } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createVoltSegmented } from '../ui/segmented/voltSegmented.js';
import { usageInsights } from './agentUsageInsights.js';
import { voltCharts, voltChartStrings } from '../visuals/agentVisuals.js';
import { DotMatrixMeter } from './agentUsageDots.js';
import { showUsageModelDialog } from './agentUsageModelDialog.js';
import { renderUsageCalendar, usageCalendar } from './agentUsageCalendar.js';
import { IRunwayStyle, renderRunway, runwayHighlights } from './agentUsageRunway.js';
import { costTypeSegments, hasFasterSpeeds, renderShareBar, speedCostSegments } from './agentUsageShareBar.js';
import { formatCost, formatDay, formatDuration, formatShare, formatSlot, formatTokens } from './agentUsageFormat.js';
import { createRefreshSpinner } from './agentUsageIcons.js';
import { IUsageModelRow, IUsageSummary, metricValue, placeholderLimits, placeholderUsage, summarizeUsage, UsageMetric, UsageRange } from './agentUsageModel.js';

const STORAGE_RANGE = 'volt.usage.range';
const STORAGE_BREAKDOWN = 'volt.usage.breakdown';
/** Refresh while the page is open; the main process caches, so most polls are free. */
const POLL_MS = 60_000;
const STORAGE_PAGE_SIZE = 'volt.usage.pageSize';
/** Breakdown rows per page, the choices Cursor's tables offer. */
const PAGE_SIZES = [10, 25, 50, 100] as const;
/** The page reads in dollars; tokens sit beside every figure instead of behind a switch. */
const METRIC: UsageMetric = 'cost';

const RANGES: { id: UsageRange; label: string; phrase: string; empty: string }[] = [
	{ id: '24h', label: localize('voltUsage.24h', "Past 24h"), phrase: localize('voltUsage.phrase24h', "past 24 hours"), empty: localize('voltUsage.empty24h', "No usage in the past 24 hours") },
	{ id: '7d', label: localize('voltUsage.7d', "7 days"), phrase: localize('voltUsage.phrase7d', "last 7 days"), empty: localize('voltUsage.empty7d', "No usage in the past 7 days") },
	{ id: '30d', label: localize('voltUsage.30d', "30 days"), phrase: localize('voltUsage.phrase30d', "last 30 days"), empty: localize('voltUsage.empty30d', "No usage in the past 30 days") },
	{ id: '90d', label: localize('voltUsage.90d', "90 days"), phrase: localize('voltUsage.phrase90d', "last 90 days"), empty: localize('voltUsage.empty90d', "No usage in the past 90 days") },
];

/** Names in the usage history (the agent) and on the limits lanes (the account). */
const PROVIDER_LABELS: Record<VoltUsageProvider, { agent: string; account: string }> = {
	claude: { agent: 'Claude Code', account: 'Claude' },
	codex: { agent: 'Codex', account: 'Codex' },
	cursor: { agent: 'Cursor', account: 'Cursor' },
};

const PROVIDER_COLORS: Record<VoltUsageProvider, string> = {
	claude: 'var(--volt-usage-claude)',
	codex: 'var(--volt-usage-codex)',
	cursor: 'var(--volt-usage-cursor)',
};

const RUNWAY_STYLE: IRunwayStyle = {
	label: provider => PROVIDER_LABELS[provider].account,
	color: provider => PROVIDER_COLORS[provider],
};

/** Models listed under "Where it went"; the Breakdown table has every one. */
const TOP_MODELS = 6;

type Breakdown = 'model' | 'day';

/**
 * A small caps section label in the manner of VS Code's settings. Trailing controls (the
 * Model/Day switch) sit at the far end.
 */
function sectionHead(parent: HTMLElement, title: string): HTMLElement {
	const head = append(parent, $('.volt-usage-head'));
	append(head, $('span.title')).textContent = title;
	append(head, $('span.spacer'));
	return head;
}

/**
 * Usage for every agent Volt runs, on one page with no tabs: what was spent and how many tokens,
 * then one time axis where the spend sits left of now and each subscription limit runs right of
 * it until it resets. Reads real records: Claude Code and Codex transcripts, Cursor's account
 * usage, and each provider's limits API.
 *
 * Lives in Volt Settings (Usage) and in the old Usage tab. The host owns scrolling; the page grows
 * to its content and keeps its height through re-renders so the host's scroll position holds.
 */
export class AgentUsagePage extends Disposable {

	/** The page; the host appends it wherever it scrolls. */
	readonly element: HTMLElement;
	private readonly content: HTMLElement;

	private range: UsageRange;
	private breakdown: Breakdown;
	private page = 0;
	private pageSize: number;
	private visible = false;

	private snapshot: IVoltUsageSnapshot | undefined;
	private limits: readonly IVoltUsageLimitGroup[] | undefined;
	private usageError = false;
	private limitsError = false;
	private loadingUsage = false;
	private loadingLimits = false;
	private refreshing = false;
	private loadVersion = 0;
	/** Headline value last shown, so the next one counts from it. */
	private shownHeadline: { metric: UsageMetric; value: number } | undefined;
	/** Set when what the page shows changed, so bars and meters animate in once. */
	private animateNext = true;

	private readonly renderStore = this._register(new DisposableStore());
	/** The open model dialog, if any. */
	private readonly dialog = this._register(new MutableDisposable());
	private readonly visibleStore = this._register(new DisposableStore());

	/**
	 * @param dialogHost A positioned element covering the visible area (the Settings overlay, the
	 * editor); the model dialog centers in it.
	 */
	constructor(
		private readonly dialogHost: () => HTMLElement,
		@IStorageService private readonly storage: IStorageService,
		@IVoltUsageService private readonly usageService: IVoltUsageService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super();
		this.range = this.readStored(STORAGE_RANGE, RANGES.map(range => range.id), '30d');
		this.breakdown = this.readStored(STORAGE_BREAKDOWN, ['model', 'day'], 'model');
		const pageSize = Number(this.storage.get(STORAGE_PAGE_SIZE, StorageScope.PROFILE));
		this.pageSize = (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : 25;
		this.element = $('.volt-usage');
		this.content = append(this.element, $('.volt-usage-content'));
		this.render();
	}

	private readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
		const value = this.storage.get(key, StorageScope.PROFILE);
		return allowed.includes(value as T) ? value as T : fallback;
	}

	private store(key: string, value: string): void {
		this.storage.store(key, value, StorageScope.PROFILE, StorageTarget.USER);
	}

	/** Loads on show and polls while shown; reset countdowns and the NOW line move every minute. */
	setVisible(visible: boolean): void {
		if (visible === this.visible) {
			return;
		}
		this.visible = visible;
		this.visibleStore.clear();
		if (!visible) {
			this.dialog.clear();
			return;
		}
		const window = getWindow(this.element);
		const poll = window.setInterval(() => void this.load(false, true), POLL_MS);
		const tick = window.setInterval(() => this.render(), 60_000);
		this.visibleStore.add(toDisposable(() => {
			window.clearInterval(poll);
			window.clearInterval(tick);
		}));
		void this.load(false, !!this.snapshot);
	}

	focus(): void {
		this.content.querySelector<HTMLElement>('.volt-usage-range')?.focus();
	}

	private setRange(range: UsageRange): void {
		if (range === this.range) {
			return;
		}
		this.range = range;
		this.page = 0;
		this.store(STORAGE_RANGE, range);
		this.animateNext = true;
		this.render(true);
	}

	private pickRange(anchor: HTMLElement): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => RANGES.map(range => {
				const action = new Action(`volt.usage.range.${range.id}`, range.label, undefined, true, () => this.setRange(range.id));
				action.checked = range.id === this.range;
				return action;
			}),
		});
	}

	private async load(force: boolean, quiet = false): Promise<void> {
		const version = ++this.loadVersion;
		this.loadingUsage = true;
		this.loadingLimits = true;
		if (!quiet) {
			this.refreshing = true;
			this.syncRefresh();
		}
		if (!this.snapshot || !this.limits) {
			this.render();
		}
		const usage = this.usageService.getUsage(force).then(snapshot => {
			if (version === this.loadVersion) {
				this.animateNext ||= !this.snapshot;
				this.snapshot = snapshot;
				this.usageError = false;
			}
		}, () => {
			if (version === this.loadVersion) {
				this.usageError = true;
			}
		}).finally(() => {
			if (version === this.loadVersion) {
				this.loadingUsage = false;
				this.render();
			}
		});
		const limits = this.usageService.getLimits(force).then(groups => {
			if (version === this.loadVersion) {
				this.animateNext ||= !this.limits;
				this.limits = groups;
				this.limitsError = false;
			}
		}, () => {
			if (version === this.loadVersion) {
				this.limitsError = true;
			}
		}).finally(() => {
			if (version === this.loadVersion) {
				this.loadingLimits = false;
				this.render();
			}
		});
		await Promise.allSettled([usage, limits]);
		if (version === this.loadVersion) {
			this.refreshing = false;
			this.syncRefresh();
		}
	}

	private syncRefresh(): void {
		const button = this.content?.querySelector<HTMLElement>('.volt-usage-refresh');
		button?.classList.toggle('spinning', this.refreshing);
		if (this.refreshing) {
			button?.setAttribute('aria-busy', 'true');
		} else {
			button?.removeAttribute('aria-busy');
		}
	}

	//#region Rendering

	private render(transition = false): void {
		if (!this.content) {
			return;
		}
		// The page keeps its height through every re-render (paging, Model/Day, ranges, refreshes) so
		// the host's scroll position holds; emptying it would collapse it and snap the scroll to the top.
		const height = this.content.offsetHeight;
		this.content.style.minHeight = height ? `${height}px` : '';
		this.renderStore.clear();
		clearNode(this.content);
		this.content.classList.toggle('transition', transition);
		this.content.classList.remove('placeholder');
		this.content.removeAttribute('aria-busy');

		if (!this.snapshot && this.usageError && !this.loadingUsage) {
			this.renderMessage(localize('voltUsage.loadFailed', "Usage could not be read."), true);
		} else {
			this.renderPage();
		}
		this.animateNext = false;
		// Release the held height once the async parts (insights charts) have drawn.
		this.renderStore.add(toDisposable((() => {
			const frame = getWindow(this.element).requestAnimationFrame(() => this.content.style.minHeight = '');
			return () => getWindow(this.element).cancelAnimationFrame(frame);
		})()));
	}

	private renderPage(): void {
		// Until a source arrives its part of the page renders sample data as a still skeleton, so
		// everything loads in place.
		const usagePending = !this.snapshot;
		const limitsPending = !this.limits && !(this.limitsError && !this.loadingLimits);
		const snapshot = this.snapshot ?? placeholderUsage();
		const groups = [...this.limits ?? (limitsPending ? placeholderLimits() : [])]
			.sort((a, b) => VOLT_USAGE_PROVIDERS.indexOf(a.provider) - VOLT_USAGE_PROVIDERS.indexOf(b.provider));
		const summary = summarizeUsage(snapshot, this.range, METRIC);
		const animate = this.animateNext && !usagePending;
		const now = Date.now();

		const hero = this.renderHero(snapshot, summary, groups, now, usagePending);
		if (usagePending) {
			this.fadePlaceholder(hero.spent);
		}
		if (limitsPending) {
			this.fadePlaceholder(hero.limits);
		}
		for (const note of snapshot.notes) {
			const item = append(this.content, $('.volt-usage-note'));
			item.appendChild(renderIcon(Codicon.warning));
			append(item, $('span')).textContent = note.message;
		}

		const runway = renderRunway(this.content, summary, groups, RUNWAY_STYLE, now, this.animateNext && !limitsPending, this.renderStore);
		runway.querySelector('.volt-usage-runway-legend')?.appendChild(hero.refresh);
		if (!groups.length) {
			const empty = append(runway, $('.volt-usage-runway-row.lane.empty'));
			append(empty, $('span'));
			append(empty, $('.volt-usage-runway-message.quiet')).textContent = this.limitsError
				? localize('voltUsage.limitsFailed', "Limits could not be read.")
				: localize('voltUsage.noLimits', "Sign in to Claude Code, Codex or Cursor to see your limits here.");
		}
		if (usagePending || limitsPending) {
			this.fadePlaceholder(runway);
		}

		const split = append(this.content, $('.volt-usage-split'));
		this.renderTopModels(split, summary, animate);
		this.renderShares(split, summary);
		const activity = append(this.content, $('.volt-usage-section'));
		sectionHead(activity, localize('voltUsage.activity', "Activity"));
		renderUsageCalendar(activity, usageCalendar(snapshot, now), animate);
		this.renderTotals(summary);
		this.renderBreakdown(summary, METRIC);
		if (!usagePending) {
			this.renderInsights(snapshot, summary, METRIC, animate);
		}
		this.renderFootnote();
		if (usagePending) {
			for (const section of this.content.querySelectorAll<HTMLElement>(':scope > .volt-usage-split, :scope > .volt-usage-section')) {
				this.fadePlaceholder(section);
			}
		}
	}

	/**
	 * The stats row: what the range cost (the range itself is the phrase under the number, a menu),
	 * the soonest reset and the limit closest to running dry, then refresh.
	 */
	private renderHero(snapshot: IVoltUsageSnapshot, summary: IUsageSummary, groups: readonly IVoltUsageLimitGroup[], now: number, placeholder: boolean): { spent: HTMLElement; limits: HTMLElement; refresh: HTMLElement } {
		const hero = append(this.content, $('.volt-usage-stats'));
		const spent = append(hero, $('.volt-usage-stat.spent'));
		const label = append(spent, $('.label'));
		append(label, $('span')).textContent = localize('voltUsage.spentIn', "Spent in the");
		const range = RANGES.find(item => item.id === this.range)!;
		const picker = append(label, $('button.volt-usage-range')) as HTMLButtonElement;
		picker.type = 'button';
		append(picker, $('span')).textContent = range.phrase;
		picker.appendChild(renderIcon(Codicon.chevronDown));
		picker.setAttribute('aria-haspopup', 'menu');
		picker.setAttribute('aria-label', localize('voltUsage.rangeLabel', "Range: {0}", range.label));
		this.renderStore.add(addDisposableListener(picker, EventType.CLICK, () => this.pickRange(picker)));

		const headline = append(spent, $('.volt-usage-headline'));
		const sub = append(spent, $('.volt-usage-subline'));
		if (placeholder) {
			headline.textContent = formatCost(summary.total.cost);
			// Sample text for the skeleton to cover; it never shows.
			append(sub, $('span')).textContent = '00.0B tokens · 000 sessions';
		} else {
			this.countUp(headline, METRIC, summary.total.cost);
			append(sub, $('span')).textContent = summary.sessions === 1
				? localize('voltUsage.tokensOneSession', "{0} tokens · 1 session", formatTokens(summary.total.tokens))
				: localize('voltUsage.tokensSessions', "{0} tokens · {1} sessions", formatTokens(summary.total.tokens), summary.sessions.toLocaleString());
			append(sub, $('span.dot')).textContent = '·';
			const estimate = append(sub, $('span.estimate'));
			append(estimate, $('span')).textContent = localize('voltUsage.apiEstimate', "API estimate");
			estimate.appendChild(renderIcon(Codicon.info));
			setAgentTooltip(estimate, localize('voltUsage.apiEstimateTip', "What these tokens would cost at public API prices ({0}). Cursor rows use what Cursor charged. Subscriptions bill differently.", snapshot.pricingSource));
		}

		const limits = append(hero, $('.volt-usage-stat-group'));
		const { nextReset, risk } = runwayHighlights(groups, now);
		const resetStat = append(limits, $('.volt-usage-stat'));
		append(resetStat, $('.label')).textContent = localize('voltUsage.nextReset', "Next reset");
		const resetValue = append(resetStat, $('.value'));
		if (nextReset) {
			resetValue.appendChild(createBrandIcon(nextReset.provider, 16));
			append(resetValue, $('span')).textContent = `${PROVIDER_LABELS[nextReset.provider].account} ${nextReset.label.toLowerCase()}`;
			append(resetValue, $('span.muted')).textContent = localize('voltUsage.inDuration', "in {0}", formatDuration(nextReset.inMs));
		} else {
			append(resetValue, $('span.muted')).textContent = localize('voltUsage.nothingToReset', "Nothing used yet");
		}

		const riskStat = append(limits, $('.volt-usage-stat'));
		append(riskStat, $('.label')).textContent = risk?.full
			? localize('voltUsage.atLimit', "At its limit")
			: localize('voltUsage.firstDry', "First to run dry");
		const riskValue = append(riskStat, $('.value'));
		if (risk) {
			riskValue.classList.add(risk.full ? 'full' : 'warn');
			riskValue.appendChild(createBrandIcon(risk.provider, 16));
			append(riskValue, $('span')).textContent = `${PROVIDER_LABELS[risk.provider].account} ${risk.label.toLowerCase()}`;
			append(riskValue, $('span.muted')).textContent = risk.full
				? localize('voltUsage.reached', "reached")
				: localize('voltUsage.inDuration', "in {0}", formatDuration(risk.inMs ?? 0));
		} else {
			riskValue.classList.add('ok');
			append(riskValue, $('span')).textContent = localize('voltUsage.allOnPace', "Every limit is on pace");
		}

		// Refresh sits under the runway's legend, where the live part of the page is.
		const refresh = $('.volt-usage-updated');
		if (this.snapshot) {
			append(refresh, $('span')).textContent = Date.now() - this.snapshot.generatedAt < 60_000
				? localize('voltUsage.updatedJustNow', "Updated just now")
				: localize('voltUsage.updatedAgo', "Updated {0}", fromNow(this.snapshot.generatedAt, true));
		}
		const button = append(refresh, $('button.volt-usage-refresh')) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(renderIcon(Codicon.refresh));
		button.appendChild(createRefreshSpinner());
		button.classList.toggle('spinning', this.refreshing);
		const refreshLabel = localize('voltUsage.refresh', "Refresh");
		button.setAttribute('aria-label', refreshLabel);
		setAgentTooltip(button, refreshLabel);
		this.renderStore.add(addDisposableListener(button, EventType.CLICK, () => void this.load(true)));
		return { spent, limits, refresh };
	}

	/** "Where it went": the costliest models, each with a dot meter against the top one. Click for detail. */
	private renderTopModels(parent: HTMLElement, summary: IUsageSummary, animate: boolean): void {
		const card = append(parent, $('.volt-usage-card'));
		const head = append(card, $('.volt-usage-card-head'));
		append(head, $('span.title')).textContent = localize('voltUsage.whereItWent', "Where it went");
		const models = summary.models.slice(0, TOP_MODELS);
		if (!models.length) {
			append(card, $('.volt-usage-table-empty')).textContent = RANGES.find(range => range.id === this.range)!.empty;
			return;
		}
		const peak = Math.max(0, ...models.map(model => model.cost));
		for (const model of models) {
			const row = append(card, $('.volt-usage-top-model'));
			row.style.color = PROVIDER_COLORS[model.provider];
			row.appendChild(createBrandIcon(model.provider, 14));
			append(row, $('span.name')).textContent = model.model;
			const meter = append(row, $('.meter'));
			this.renderStore.add(new DotMatrixMeter(meter, peak > 0 ? model.cost / peak : 0, `model:${model.model}`, animate));
			append(row, $('span.tokens')).textContent = formatTokens(model.tokens);
			const cost = append(row, $('span.cost'));
			cost.textContent = model.unpriced && model.cost === 0 ? localize('voltUsage.unpriced', "Unpriced") : formatCost(model.cost);
			row.tabIndex = 0;
			row.setAttribute('role', 'button');
			row.setAttribute('aria-label', localize('voltUsage.openModel', "Show usage for {0}", model.model));
			const open = () => this.openModel(model, summary, METRIC);
			this.renderStore.add(addDisposableListener(row, EventType.CLICK, open));
			this.renderStore.add(addDisposableListener(row, EventType.KEY_DOWN, e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					open();
				}
			}));
		}
	}

	/** What the range says, each chart titled with its finding: token mix, cache hits, models over time, when you work. */
	private renderInsights(snapshot: IVoltUsageSnapshot, summary: IUsageSummary, metric: UsageMetric, animate: boolean): void {
		const insights = usageInsights(snapshot, summary, metric);
		if (!insights.length) {
			return;
		}
		const section = append(this.content, $('.volt-usage-section.volt-usage-insights'));
		sectionHead(section, localize('voltUsage.insights', "Insights"));
		const grid = append(section, $('.volt-usage-insights-grid'));
		const charts = voltCharts(getWindow(grid));
		for (const insight of insights) {
			const card = append(grid, $('.volt-usage-insight'));
			card.classList.toggle('wide', insight.wide);
			const handle = charts.render(card, insight.spec, { strings: voltChartStrings(), animate });
			this.renderStore.add(toDisposable(() => handle.dispose()));
		}
	}

	private renderTotals(summary: IUsageSummary): void {
		const section = append(this.content, $('.volt-usage-section'));
		sectionHead(section, localize('voltUsage.totals', "Totals"));
		const grid = append(section, $('.volt-usage-totals'));
		const total = summary.total;
		const cells: [string, string, string | undefined][] = [
			[localize('voltUsage.processed', "Processed tokens"), formatTokens(total.tokens), localize('voltUsage.processedTip', "Every token sent to or produced by a model, cached input included.")],
			[localize('voltUsage.cachedInput', "Cached input"), formatTokens(total.cached), localize('voltUsage.cachedTip', "Input read back from the prompt cache, billed at a fraction of the input rate.")],
			[localize('voltUsage.uncachedInput', "Uncached input"), formatTokens(total.uncached + total.cacheWrite), localize('voltUsage.uncachedTip', "Fresh input: {0} at the full rate and {1} written to the prompt cache.", formatTokens(total.uncached), formatTokens(total.cacheWrite))],
			[localize('voltUsage.output', "Output"), formatTokens(total.output), localize('voltUsage.outputTip', "Generated tokens, reasoning included.")],
			[localize('voltUsage.cacheSavings', "Cache savings"), formatCost(total.savings), localize('voltUsage.savingsTip', "What cached input would have cost at the full input rate, minus what it cost.")],
		];
		for (const [label, value, tip] of cells) {
			const cell = append(grid, $('.volt-usage-total'));
			const labelEl = append(cell, $('.label'));
			labelEl.textContent = label;
			append(cell, $('.value')).textContent = value;
			if (tip) {
				setAgentTooltip(cell, tip);
			}
		}
	}

	/** "What it was": cost by token type (and by speed when anything ran fast), and what the cache saved. */
	private renderShares(parent: HTMLElement, summary: IUsageSummary): void {
		const card = append(parent, $('.volt-usage-card.volt-usage-shares'));
		const head = append(card, $('.volt-usage-card-head'));
		append(head, $('span.title')).textContent = localize('voltUsage.whatItWas', "What it was");
		if (summary.total.tokens <= 0) {
			append(card, $('.volt-usage-table-empty')).textContent = RANGES.find(range => range.id === this.range)!.empty;
			return;
		}
		renderShareBar(card, localize('voltUsage.costByType', "Cost by type"), costTypeSegments(summary.total), formatCost);
		if (hasFasterSpeeds(summary.total)) {
			renderShareBar(card, localize('voltUsage.costBySpeed', "Cost by speed"), speedCostSegments(summary.total), formatCost,
				localize('voltUsage.premium', "Premium {0}", formatCost(summary.total.speedPremium)));
		}
		if (summary.total.savings > 0) {
			const saved = append(card, $('.volt-usage-saved'));
			append(saved, $('span')).textContent = localize('voltUsage.cacheSaved', "Cache saved");
			append(saved, $('b')).textContent = formatCost(summary.total.savings);
			const input = summary.total.cached + summary.total.uncached + summary.total.cacheWrite;
			if (input > 0) {
				append(saved, $('span')).textContent = localize('voltUsage.cacheShare', "\u2014 {0} of input came from the cache.", formatShare(summary.total.cached, input));
			}
		}
	}

	private openModel(model: IUsageModelRow, summary: IUsageSummary, metric: UsageMetric): void {
		if (!this.snapshot) {
			return;
		}
		this.dialog.value = showUsageModelDialog(this.dialogHost(), {
			model,
			snapshot: this.snapshot,
			range: this.range,
			metric,
			costShare: summary.total.cost > 0 ? model.cost / summary.total.cost : 0,
			agentLabel: PROVIDER_LABELS[model.provider].agent,
			style: { label: PROVIDER_LABELS[model.provider].agent, color: PROVIDER_COLORS[model.provider] },
			page: this.content,
		});
	}

	private renderBreakdown(summary: IUsageSummary, metric: UsageMetric): void {
		const section = append(this.content, $('.volt-usage-section'));
		const head = sectionHead(section, localize('voltUsage.breakdown', "Breakdown"));
		const toggle = createVoltSegmented<Breakdown>(head, [
			{ id: 'model', label: localize('voltUsage.byModel', "Model") },
			{ id: 'day', label: summary.hourly ? localize('voltUsage.byHour', "Hour") : localize('voltUsage.byDay', "Day") },
		], this.breakdown, value => {
			this.breakdown = value;
			this.page = 0;
			this.store(STORAGE_BREAKDOWN, value);
			this.render();
		}, this.renderStore, 'small');
		getWindow(this.element).requestAnimationFrame(() => toggle.sync());

		// Laid out like Cursor's usage events table: a filled panel, plain column titles, hairline rows.
		const byModel = this.breakdown === 'model';
		const table = append(section, $('.volt-usage-table'));
		table.classList.toggle('by-model', byModel);
		const header = append(table, $('.volt-usage-row.header'));
		if (byModel) {
			append(header, $('span.rank')).textContent = '#';
		}
		append(header, $('span.name')).textContent = byModel
			? localize('voltUsage.model', "Model")
			: summary.hourly ? localize('voltUsage.hour', "Hour") : localize('voltUsage.date', "Date");
		append(header, $('span.agent')).textContent = byModel ? localize('voltUsage.agent', "Agent") : localize('voltUsage.agents', "Agents");
		append(header, $('span.num')).textContent = localize('voltUsage.share', "Share");
		append(header, $('span.num')).textContent = localize('voltUsage.tokensColumn', "Tokens");
		append(header, $('span.num')).textContent = localize('voltUsage.costColumn', "Cost");

		const whole = metricValue(summary.total, metric);
		const rows = byModel ? summary.models : summary.days;
		if (!rows.length) {
			append(table, $('.volt-usage-table-empty')).textContent = RANGES.find(range => range.id === this.range)!.empty;
			return;
		}
		const pages = Math.max(1, Math.ceil(rows.length / this.pageSize));
		this.page = Math.min(this.page, pages - 1);
		const first = this.page * this.pageSize;
		const visible = rows.slice(first, first + this.pageSize);
		const slots = new Map(summary.slots.map(slot => [slot.start, slot]));
		// Share bars under model names are relative to the busiest model, like T3's breakdown.
		const peak = Math.max(0, ...rows.map(row => metricValue(row, metric)));
		visible.forEach((item, index) => {
			const row = append(table, $('.volt-usage-row'));
			if ('model' in item) {
				append(row, $('span.rank')).textContent = String(first + index + 1);
			}
			const name = append(row, $('span.name'));
			const agent = append(row, $('span.agent'));
			if ('model' in item) {
				const line = append(name, $('span.line'));
				line.appendChild(createBrandIcon(item.provider, 14));
				append(line, $('span.text')).textContent = item.model;
				const value = metricValue(item, metric);
				const track = append(name, $('span.volt-usage-model-bar'));
				const bar = append(track, $('span'));
				bar.style.width = value > 0 && peak > 0 ? `max(8px, ${(value / peak) * 100}%)` : '0';
				bar.style.background = PROVIDER_COLORS[item.provider];
				agent.appendChild(createBrandIcon(item.provider, 14));
				append(agent, $('span.text')).textContent = PROVIDER_LABELS[item.provider].agent;
				row.classList.add('clickable');
				row.tabIndex = 0;
				row.setAttribute('role', 'button');
				row.setAttribute('aria-label', localize('voltUsage.openModel', "Show usage for {0}", item.model));
				const open = () => this.openModel(item, summary, metric);
				this.renderStore.add(addDisposableListener(row, EventType.CLICK, open));
				this.renderStore.add(addDisposableListener(row, EventType.KEY_DOWN, e => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						open();
					}
				}));
			} else {
				append(name, $('span.text')).textContent = summary.hourly ? formatSlot(item.start, true) : formatDay(item.start);
				// Every agent used that day, busiest first, as a row of icons.
				const active = [...(slots.get(item.start)?.byProvider ?? new Map<VoltUsageProvider, IUsageTotals>())]
					.filter(([, totals]) => totals.tokens > 0)
					.sort((a, b) => metricValue(b[1], metric) - metricValue(a[1], metric));
				for (const [provider] of active) {
					const icon = agent.appendChild(createBrandIcon(provider, 14));
					setAgentTooltip(icon, PROVIDER_LABELS[provider].agent);
				}
			}
			const unpriced = 'unpriced' in item && item.unpriced && item.cost === 0;
			const share = append(row, $('span.num.muted'));
			share.textContent = unpriced && metric === 'cost' ? '\u2014' : formatShare(metricValue(item, metric), whole);
			append(row, $('span.num')).textContent = formatTokens(item.tokens);
			const cost = append(row, $('span.num'));
			cost.textContent = unpriced ? localize('voltUsage.unpriced', "Unpriced") : formatCost(item.cost);
			cost.classList.toggle('muted', unpriced);
		});
		this.renderPager(section, rows.length, pages);
	}

	/** Rows per page on the left with the range shown; Prev, page of pages, Next on the right. */
	private renderPager(parent: HTMLElement, total: number, pages: number): void {
		const pager = append(parent, $('.volt-usage-pager'));
		const size = append(pager, $('button.volt-usage-pager-button.size')) as HTMLButtonElement;
		size.type = 'button';
		append(size, $('span')).textContent = localize('voltUsage.rows', "Rows: {0}", this.pageSize);
		size.appendChild(renderIcon(Codicon.chevronDown));
		this.renderStore.add(addDisposableListener(size, EventType.CLICK, () => {
			this.contextMenuService.showContextMenu({
				getAnchor: () => size,
				getActions: () => PAGE_SIZES.map(option => {
					const action = new Action(`volt.usage.rows.${option}`, String(option), undefined, true, () => {
						this.pageSize = option;
						this.page = 0;
						this.store(STORAGE_PAGE_SIZE, String(option));
						this.render();
					});
					action.checked = option === this.pageSize;
					return action;
				}),
			});
		}));
		const first = this.page * this.pageSize + 1;
		const last = Math.min(total, first + this.pageSize - 1);
		append(pager, $('span.range')).textContent = localize('voltUsage.showing', "Showing {0}\u2013{1} of {2}", first, last, total);
		append(pager, $('span.spacer'));

		const prev = append(pager, $('button.volt-usage-pager-button')) as HTMLButtonElement;
		prev.type = 'button';
		prev.textContent = localize('voltUsage.prev', "Prev");
		prev.disabled = this.page === 0;
		append(pager, $('span.page')).textContent = localize('voltUsage.pageOf', "{0} / {1}", this.page + 1, pages);
		const next = append(pager, $('button.volt-usage-pager-button')) as HTMLButtonElement;
		next.type = 'button';
		next.textContent = localize('voltUsage.next', "Next");
		next.disabled = this.page >= pages - 1;
		const go = (delta: number) => {
			this.page = Math.max(0, Math.min(pages - 1, this.page + delta));
			this.render();
		};
		this.renderStore.add(addDisposableListener(prev, EventType.CLICK, () => go(-1)));
		this.renderStore.add(addDisposableListener(next, EventType.CLICK, () => go(1)));
	}

	private renderFootnote(): void {
		if (!this.snapshot) {
			return;
		}
		const note = append(this.content, $('.volt-usage-footnote'));
		const updated = Date.now() - this.snapshot.generatedAt < 60_000
			? localize('voltUsage.justNow', "just now")
			: fromNow(this.snapshot.generatedAt, true);
		note.textContent = localize('voltUsage.footnote', "From Claude Code and Codex transcripts on this computer and your Cursor account. Each model response is counted once, as it is billed; Claude Code's /stats adds every transcript line, and a response spans several, so its token totals read about twice as high. Prices: {0}. Updated {1}.", this.snapshot.pricingSource, updated);
	}

	/** Eases the headline from the last value shown to the new one. */
	private countUp(element: HTMLElement, metric: UsageMetric, value: number): void {
		const format = (n: number) => metric === 'cost' ? formatCost(n) : formatTokens(n);
		const from = this.shownHeadline?.metric === metric ? this.shownHeadline.value : 0;
		this.shownHeadline = { metric, value };
		const window = getWindow(this.element);
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (reduced || from === value) {
			element.textContent = format(value);
			return;
		}
		const started = window.performance.now();
		const duration = 650;
		let frame = 0;
		const step = (now: number) => {
			const t = Math.min(1, (now - started) / duration);
			const eased = 1 - Math.pow(1 - t, 4);
			element.textContent = format(from + (value - from) * eased);
			if (t < 1) {
				frame = window.requestAnimationFrame(step);
			}
		};
		frame = window.requestAnimationFrame(step);
		this.renderStore.add(toDisposable(() => window.cancelAnimationFrame(frame)));
	}

	/**
	 * Turns the page rendered from sample data into a still skeleton: every run of text becomes a
	 * flat bone the size of the text, so the layout matches the loaded page but no number shows.
	 */
	private fadePlaceholder(root: HTMLElement): void {
		root.classList.add('volt-usage-placeholder');
		root.setAttribute('aria-busy', 'true');
		root.inert = true;
		const doc = root.ownerDocument;
		const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const texts: Text[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node.textContent?.trim()) {
				texts.push(node as Text);
			}
		}
		for (const text of texts) {
			const bone = doc.createElement('span');
			bone.className = 'volt-usage-bone';
			text.replaceWith(bone);
			bone.appendChild(text);
		}
	}

	private renderMessage(text: string, retry: boolean): void {
		const box = append(this.content, $('.volt-usage-message'));
		append(box, $('span')).textContent = text;
		if (retry) {
			const button = append(box, $('button.volt-usage-more')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = localize('voltUsage.tryAgain', "Try Again");
			this.renderStore.add(addDisposableListener(button, EventType.CLICK, () => void this.load(true)));
		}
	}


	//#endregion
}
