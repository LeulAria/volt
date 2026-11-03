/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentUsage.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVoltAccountsService, IVoltClaudeAccount, IVoltClaudeAccountsState } from '../../../../../platform/voltAccounts/common/voltAccounts.js';
import {
	IVoltUsageLimitGroup, IVoltUsageMachineStatus, IVoltUsageModelPrice, IVoltUsageService, IVoltUsageSnapshot, VOLT_USAGE_PROVIDERS, VOLT_USAGE_SHARE_MACHINE_COMMAND_ID,
	VoltResetCreditOutcome, VoltUsageProvider
} from '../../../../../platform/voltUsage/common/voltUsage.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { createBrandIcon } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { IVoltQueryCache, IVoltQueryHandle, IVoltQueryState } from '../../../../services/voltRuntime/browser/queryCache.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { showVoltMenu } from '../ui/menu/voltMenu.js';
import { createVoltSegmented } from '../ui/segmented/voltSegmented.js';
import { usageInsights } from './agentUsageInsights.js';
import { voltCharts, voltChartStrings } from '../visuals/agentVisuals.js';
import { DotMatrixMeter } from './agentUsageDots.js';
import { showUsageModelDialog } from './agentUsageModelDialog.js';
import { renderUsageCalendar, usageCalendar } from './agentUsageCalendar.js';
import { IRunwayStyle, renderRunway, runwayHighlights } from './agentUsageRunway.js';
import { costTypeSegments, hasFasterSpeeds, renderShareBar, speedCostSegments } from './agentUsageShareBar.js';
import { formatCost, formatDay, formatDuration, formatResetTime, formatShare, formatSlot, formatTokens } from './agentUsageFormat.js';
import { createRefreshSpinner, createTicketIcon, setRefreshSpinnerRunning } from './agentUsageIcons.js';
import { IUsageModelRow, IUsageSummary, IUsageTotals, limitsQuery, metricValue, placeholderLimits, placeholderUsage, summarizeUsage, usageQuery, UsageMetric, UsageRange } from './agentUsageModel.js';

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
	opencode: { agent: 'OpenCode', account: 'OpenCode Go' },
	grok: { agent: 'Grok', account: 'Grok' },
};

const PROVIDER_COLORS: Record<VoltUsageProvider, string> = {
	claude: 'var(--volt-usage-claude)',
	codex: 'var(--volt-usage-codex)',
	cursor: 'var(--volt-usage-cursor)',
	opencode: 'var(--volt-usage-opencode)',
	grok: 'var(--volt-usage-grok)',
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
	/** Other computers whose usage counts here, and the prices the user set. */
	private machines: readonly IVoltUsageMachineStatus[] = [];
	private prices: Record<string, IVoltUsageModelPrice> = {};
	/** The saved Claude accounts (absent where the service isn't, e.g. another machine's browser). */
	private readonly accounts: IVoltAccountsService | undefined;
	private accountsState: IVoltClaudeAccountsState | undefined;
	private accountsLoading = false;
	/** The account being switched to. */
	private switchingAccount: string | undefined;
	/** Accounts with a reset being redeemed, by `provider|account`. */
	private readonly redeeming = new Set<string>();
	private usageError = false;
	private limitsError = false;
	private loadingUsage = false;
	private loadingLimits = false;
	private refreshing = false;
	/** The cache watches while the page shows. */
	private handles: { readonly usage: IVoltQueryHandle<IVoltUsageSnapshot>; readonly limits: IVoltQueryHandle<readonly IVoltUsageLimitGroup[]> } | undefined;
	/** Headline value last shown, so the next one counts from it. */
	private shownHeadline: { metric: UsageMetric; value: number } | undefined;
	/** Set when what the page shows changed, so bars and meters animate in once. */
	private animateNext = true;
	/** The next render builds the sections under the runway over a few frames (the page just opened). */
	private stagger = true;

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
		@IVoltQueryCache private readonly cache: IVoltQueryCache,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.accounts = instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(IVoltAccountsService);
			} catch {
				return undefined;
			}
		});
		this.range = this.readStored(STORAGE_RANGE, RANGES.map(range => range.id), '30d');
		this.breakdown = this.readStored(STORAGE_BREAKDOWN, ['model', 'day'], 'model');
		const pageSize = Number(this.storage.get(STORAGE_PAGE_SIZE, StorageScope.PROFILE));
		this.pageSize = (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : 10;
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
		this.stagger = true;
		const usage = this.visibleStore.add(this.cache.watch(usageQuery(this.usageService)));
		const limits = this.visibleStore.add(this.cache.watch(limitsQuery(this.usageService)));
		this.handles = { usage, limits };
		const sync = () => {
			const before = { snapshot: this.snapshot, limits: this.limits, usageError: this.usageError, limitsError: this.limitsError };
			this.apply(usage.state, limits.state);
			this.refreshing = usage.state.fetching || limits.state.fetching;
			this.syncRefresh();
			// A fetch starting or ending with nothing new only turns the spinner; data redraws the page.
			if (before.snapshot !== this.snapshot || before.limits !== this.limits || before.usageError !== this.usageError || before.limitsError !== this.limitsError) {
				this.render();
			}
		};
		this.visibleStore.add(usage.onDidChange(sync));
		this.visibleStore.add(limits.onDidChange(sync));
		const poll = window.setInterval(() => void this.load(false), POLL_MS);
		const tick = window.setInterval(() => this.render(), 60_000);
		this.visibleStore.add(toDisposable(() => {
			window.clearInterval(poll);
			window.clearInterval(tick);
			this.handles = undefined;
		}));
		sync();
		void this.loadExtras();
		if (this.accounts) {
			this.visibleStore.add(this.accounts.onDidChangeClaudeAccounts(() => void this.loadAccounts(false)));
			void this.loadAccounts(true);
		}
	}

	/** Reads the saved Claude accounts; `refreshLimits` also reads limits gone stale. Redraws when they changed. */
	private async loadAccounts(refreshLimits: boolean): Promise<void> {
		if (!this.accounts || this.accountsLoading) {
			return;
		}
		this.accountsLoading = true;
		try {
			const state = await this.accounts.getClaudeAccounts(refreshLimits);
			if (JSON.stringify(state) !== JSON.stringify(this.accountsState)) {
				this.accountsState = state;
				if (this.visible) {
					this.render();
				}
			}
		} catch {
			// A locked keychain: the section stays as it was.
		} finally {
			this.accountsLoading = false;
		}
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
		showVoltMenu(this.contextViewService, {
			anchor,
			position: 'below',
			align: 'left',
			gap: 4,
			width: 160,
			ariaLabel: localize('voltUsage.rangeMenu', "Range"),
			sections: [{ id: 'ranges', items: RANGES.map(range => ({ id: range.id, label: range.label, checked: range.id === this.range, data: range.id })) }],
			onPick: picked => this.setRange(picked.data),
		});
	}

	/** Takes what the cache holds; `loading*` is true until the source answered once (or failed). */
	private apply(usage: IVoltQueryState<IVoltUsageSnapshot>, limits: IVoltQueryState<readonly IVoltUsageLimitGroup[]>): void {
		if (usage.data && usage.data !== this.snapshot) {
			this.animateNext ||= !this.snapshot;
			this.snapshot = usage.data;
		}
		if (limits.data && limits.data !== this.limits) {
			this.animateNext ||= !this.limits;
			this.limits = limits.data;
		}
		this.usageError = !!usage.error && !usage.fetching;
		this.limitsError = !!limits.error && !limits.fetching;
		this.loadingUsage = !usage.data && (!usage.loaded || usage.fetching);
		this.loadingLimits = !limits.data && (!limits.loaded || limits.fetching);
	}

	/** Refetches both; `force` (the refresh button) also skips the main process's own caches. */
	private async load(force: boolean): Promise<void> {
		if (!this.handles) {
			return;
		}
		await Promise.all([this.handles.usage.refetch(force), this.handles.limits.refetch(force), this.loadExtras(), this.loadAccounts(force)]);
	}

	/** The machines list and the user's prices; redraws when either changed. */
	private async loadExtras(): Promise<void> {
		try {
			const [machines, prices] = await Promise.all([this.usageService.getMachines(), this.usageService.getModelPrices()]);
			if (JSON.stringify(machines) !== JSON.stringify(this.machines) || JSON.stringify(prices) !== JSON.stringify(this.prices)) {
				this.machines = machines;
				this.prices = prices;
				if (this.visible) {
					this.render();
				}
			}
		} catch {
			// An older service (another machine's browser workbench) without machines or prices.
		}
	}

	private syncRefresh(): void {
		const button = this.content?.querySelector<HTMLElement>('.volt-usage-refresh');
		button?.classList.toggle('spinning', this.refreshing);
		const spinner = button?.querySelector('svg:last-child');
		if (spinner) {
			setRefreshSpinnerRunning(spinner, this.refreshing);
		}
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
				: localize('voltUsage.noLimits2', "Sign in to Claude Code, Codex, Cursor, OpenCode Go or Grok to see your limits here.");
		}
		if (usagePending || limitsPending) {
			this.fadePlaceholder(runway);
		} else {
			this.renderResets(groups);
			this.renderMachines();
		}

		// Below the runway, in steps: on opening, the top shows at once and the rest follows over the
		// next frames instead of holding the first paint until every section is built.
		const fade = (section: HTMLElement) => {
			if (usagePending) {
				this.fadePlaceholder(section);
			}
		};
		const steps = [
			() => {
				const split = append(this.content, $('.volt-usage-split'));
				this.renderTopModels(split, summary, animate);
				this.renderShares(split, summary);
				fade(split);
				const activity = append(this.content, $('.volt-usage-section'));
				sectionHead(activity, localize('voltUsage.activity', "Activity"));
				renderUsageCalendar(activity, usageCalendar(snapshot, now), animate);
				fade(activity);
			},
			() => {
				const before = new Set(this.content.children);
				this.renderTotals(summary);
				this.renderBreakdown(summary, METRIC);
				if (!usagePending) {
					this.renderInsights(snapshot, summary, METRIC, animate);
				}
				if (!limitsPending) {
					this.renderAccounts(groups, now);
				}
				this.renderFootnote();
				for (const section of this.content.querySelectorAll<HTMLElement>(':scope > .volt-usage-section')) {
					if (!before.has(section)) {
						fade(section);
					}
				}
			},
		];
		if (!this.stagger) {
			steps.forEach(step => step());
			return;
		}
		this.stagger = false;
		const window = getWindow(this.element);
		let frame = 0;
		const next = (index: number) => {
			frame = window.requestAnimationFrame(() => {
				steps[index]();
				if (index + 1 < steps.length) {
					next(index + 1);
				}
			});
		};
		next(0);
		this.renderStore.add(toDisposable(() => window.cancelAnimationFrame(frame)));
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
		setRefreshSpinnerRunning(button.appendChild(createRefreshSpinner()), this.refreshing);
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
			price: this.customPrice(model.model),
			setPrice: async price => {
				await this.usageService.setModelPrice(model.model, price);
				this.dialog.clear();
				await this.loadExtras();
				await this.load(true);
			},
		});
	}

	/** The price the user set for a model, matched the way the service matches it. */
	private customPrice(model: string): IVoltUsageModelPrice | undefined {
		const key = (id: string) => id.trim().toLowerCase().replace(/\[.*$/, '');
		const bare = (id: string) => key(id).slice(key(id).lastIndexOf('/') + 1);
		const entries = Object.entries(this.prices);
		return entries.find(([id]) => key(id) === key(model))?.[1] ?? entries.find(([id]) => key(id) === bare(model))?.[1];
	}

	//#region Resets and machines

	/** Banked limit resets (Claude, Codex), each with the button that spends one. */
	private renderResets(groups: readonly IVoltUsageLimitGroup[]): void {
		const withCredits = groups.filter(group => group.resetCredits && group.account);
		if (!withCredits.length) {
			return;
		}
		const section = append(this.content, $('.volt-usage-section.volt-usage-resets'));
		sectionHead(section, localize('voltUsage.resetsTitle', "Limit Resets"));
		const list = append(section, $('.volt-usage-card.volt-usage-list'));
		for (const group of withCredits) {
			const row = append(list, $('.volt-usage-list-row'));
			row.appendChild(createTicketIcon());
			const who = append(row, $('.who'));
			append(who, $('span.label')).textContent = PROVIDER_LABELS[group.provider].account;
			const count = group.resetCredits ?? 0;
			const detail = [
				group.account?.label,
				count === 1 ? localize('voltUsage.oneReset', "1 reset available") : localize('voltUsage.resets', "{0} resets available", count),
				group.resetCreditsExpireAt ? localize('voltUsage.resetExpires', "next expires {0}", formatResetTime(group.resetCreditsExpireAt)) : undefined,
				group.machines?.join(', '),
			].filter(Boolean).join(' \u00b7 ');
			append(who, $('span.detail')).textContent = detail;
			const key = `${group.provider}|${group.account!.id}`;
			const button = this.renderStore.add(createVoltButton(row, 'secondary'));
			button.label = this.redeeming.has(key) ? localize('voltUsage.redeeming', "Using Reset") : localize('voltUsage.useReset', "Use Reset");
			button.enabled = !this.redeeming.has(key);
			this.renderStore.add(button.onDidClick(() => void this.redeem(group)));
		}
	}

	private async redeem(group: IVoltUsageLimitGroup): Promise<void> {
		const account = group.account;
		if (!account) {
			return;
		}
		const name = PROVIDER_LABELS[group.provider].account;
		const { confirmed } = await this.dialogService.confirm({
			message: localize('voltUsage.redeemConfirm', "Use a {0} limit reset now?", name),
			detail: group.machines?.length
				? localize('voltUsage.redeemDetailEverywhere', "This spends one of {0}'s banked resets and clears its current limits on every machine. It can't be undone.", account.label ?? name)
				: localize('voltUsage.redeemDetail', "This spends one of {0}'s banked resets and clears its current limits. It can't be undone.", account.label ?? name),
			primaryButton: localize({ key: 'voltUsage.redeemButton', comment: ['&& denotes a mnemonic'] }, "&&Use Reset"),
		});
		if (!confirmed) {
			return;
		}
		const key = `${group.provider}|${account.id}`;
		this.redeeming.add(key);
		this.render();
		try {
			const outcome = await this.usageService.redeemResetCredit(group.provider, account.id);
			const messages: Record<VoltResetCreditOutcome, string> = {
				reset: localize('voltUsage.redeemDone', "{0} limits were reset.", name),
				nothingToReset: localize('voltUsage.redeemNothing', "{0} has nothing to reset right now, so no reset was used.", name),
				noCredit: localize('voltUsage.redeemNoCredit', "{0} has no resets left to use.", name),
				alreadyRedeemed: localize('voltUsage.redeemAlready', "That reset was already used; your limits are reset."),
			};
			this.notificationService.notify({ severity: outcome === 'noCredit' ? Severity.Warning : Severity.Info, message: messages[outcome] });
		} catch (error) {
			this.notificationService.notify({ severity: Severity.Error, message: error instanceof Error ? error.message : String(error) });
		} finally {
			this.redeeming.delete(key);
			this.render();
			await this.load(true);
		}
	}

	/** Other computers whose usage and limits count here, and the way to add one. */
	private renderMachines(): void {
		const section = append(this.content, $('.volt-usage-section.volt-usage-machines'));
		sectionHead(section, localize('voltUsage.machines', "Machines"));
		const list = append(section, $('.volt-usage-card.volt-usage-list'));
		if (!this.machines.length) {
			append(list, $('.volt-usage-list-empty')).textContent = localize('voltUsage.machinesEmpty', "Add your other computers to count their usage and limits here. On the other computer, choose Share This Machine and copy the pairing link it makes, then add it here.");
		}
		const states: Record<IVoltUsageMachineStatus['state'], string> = {
			ok: localize('voltUsage.machineOk', "Connected"),
			offline: localize('voltUsage.machineOffline', "Can't be reached"),
			unauthorized: localize('voltUsage.machineUnauthorized', "Key removed there; add it again"),
			error: localize('voltUsage.machineError', "Didn't answer with usage; update Volt there"),
		};
		for (const machine of this.machines) {
			const row = append(list, $('.volt-usage-list-row'));
			row.dataset.state = machine.state;
			append(row, $('span.status'));
			const who = append(row, $('.who'));
			append(who, $('span.label')).textContent = machine.name;
			append(who, $('span.detail')).textContent = `${machine.url} \u00b7 ${states[machine.state]}`;
			const remove = this.renderStore.add(createVoltButton(row, 'ghost', { ariaLabel: localize('voltUsage.removeMachine', "Remove {0}", machine.name) }));
			remove.label = localize('voltUsage.remove', "Remove");
			this.renderStore.add(remove.onDidClick(async () => {
				await this.usageService.removeMachine(machine.id);
				await this.loadExtras();
				await this.load(false);
			}));
		}
		const actions = append(section, $('.volt-usage-list-actions'));
		const add = this.renderStore.add(createVoltButton(actions, 'secondary'));
		add.label = localize('voltUsage.addMachine', "Add Machine");
		this.renderStore.add(add.onDidClick(() => void this.addMachine()));
		// Sharing runs this machine's agent server on the network: the desktop app only.
		if (CommandsRegistry.getCommand(VOLT_USAGE_SHARE_MACHINE_COMMAND_ID)) {
			const share = this.renderStore.add(createVoltButton(actions, 'ghost'));
			share.label = localize('voltUsage.shareMachine', "Share This Machine");
			this.renderStore.add(share.onDidClick(() => void this.commandService.executeCommand(VOLT_USAGE_SHARE_MACHINE_COMMAND_ID)));
		}
	}

	/**
	 * Every saved Claude account, then each other account a limit was read for (Codex, Cursor...),
	 * with every limit window, how much of it is used and when it resets.
	 */
	private renderAccounts(groups: readonly IVoltUsageLimitGroup[], now: number): void {
		const claude = this.accountsState?.accounts.filter(account => !account.needsSignIn || account.limits) ?? [];
		const expired = this.accountsState?.accounts.filter(account => account.needsSignIn && !account.limits) ?? [];
		const others = groups.filter(group => !(group.provider === 'claude' && claude.length));
		if (!claude.length && !expired.length && !others.length) {
			return;
		}
		const section = append(this.content, $('.volt-usage-section.volt-usage-accounts'));
		const head = sectionHead(section, localize('voltUsage.accounts', "Accounts"));
		if (this.accountsState && this.accountsState.accounts.length > 1) {
			append(head, $('span.volt-usage-accounts-mode')).textContent = this.accountsState.switching === 'auto'
				? localize('voltUsage.accountsAuto', "Switches automatically at {0}%", this.accountsState.threshold)
				: localize('voltUsage.accountsManual', "Switched by hand");
		}
		const list = append(section, $('.volt-usage-card.volt-usage-list'));
		const sorted = [...claude, ...expired].sort((a, b) => Number(b.active) - Number(a.active));
		for (const account of sorted) {
			// The account in use reads its limits from the same source as the lanes above.
			const live = account.active ? groups.find(group => group.provider === 'claude' && (group.account?.id === account.id || group.account?.label === account.email)) : undefined;
			this.renderAccountRow(list, {
				provider: 'claude',
				name: account.email,
				detail: [account.plan ? `Claude ${account.plan}` : PROVIDER_LABELS.claude.account, account.organizationName].filter(Boolean).join(' \u00b7 '),
				active: account.active,
				limits: live ?? account.limits,
				warning: account.needsSignIn ? localize('voltUsage.accountExpired', "The saved sign-in expired. Sign in again in Settings > Providers & Models.") : undefined,
			}, now, account);
		}
		for (const group of others) {
			this.renderAccountRow(list, {
				provider: group.provider,
				name: group.account?.label ?? PROVIDER_LABELS[group.provider].account,
				detail: [PROVIDER_LABELS[group.provider].account, group.plan, group.machines?.join(', ')].filter(Boolean).join(' \u00b7 '),
				active: false,
				limits: group,
			}, now);
		}
	}

	private renderAccountRow(list: HTMLElement, row: { provider: VoltUsageProvider; name: string; detail: string; active: boolean; limits?: IVoltUsageLimitGroup; warning?: string }, now: number, claude?: IVoltClaudeAccount): void {
		const item = append(list, $('.volt-usage-list-row.volt-usage-account'));
		item.classList.toggle('active', row.active);
		const top = append(item, $('.volt-usage-account-top'));
		top.appendChild(createBrandIcon(row.provider, 16));
		const who = append(top, $('.who'));
		const name = append(who, $('span.label'));
		append(name, $('span')).textContent = row.name;
		if (row.active) {
			append(name, $('span.volt-usage-account-badge')).textContent = localize('voltUsage.accountInUse', "In use");
		}
		const detail = append(who, $('span.detail'));
		detail.textContent = row.warning ?? row.detail;
		detail.classList.toggle('warn', !!row.warning);
		const credits = row.limits?.resetCredits;
		if (credits) {
			append(top, $('span.volt-usage-account-credits')).textContent = credits === 1 ? localize('voltUsage.oneReset', "1 reset available") : localize('voltUsage.resets', "{0} resets available", credits);
		}
		if (claude && !claude.active && !claude.needsSignIn) {
			if (this.switchingAccount === claude.id) {
				append(top, $('span.volt-usage-account-busy')).appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
			} else {
				const button = this.renderStore.add(createVoltButton(top, 'ghost', { ariaLabel: localize('voltUsage.switchAccount', "Make {0} Claude Code's account", claude.email) }));
				button.label = localize('voltUsage.switch', "Switch");
				this.renderStore.add(button.onDidClick(() => void this.switchAccount(claude)));
			}
		}

		const limits = row.limits;
		if (!limits || !limits.windows.length) {
			if (!row.warning) {
				append(item, $('.volt-usage-account-empty')).textContent = limits?.error ?? localize('voltUsage.accountLimitsUnknown', "Limits not read yet");
			}
			return;
		}
		const grid = append(item, $('.volt-usage-account-windows'));
		for (const window of limits.windows) {
			const passed = window.resetsAt !== undefined && window.resetsAt <= now;
			const used = passed ? 0 : Math.round(window.usedPercent);
			const meter = append(grid, $('.volt-usage-account-window'));
			meter.classList.toggle('high', used >= 80);
			meter.classList.toggle('full', used >= 100);
			const line = append(meter, $('.line'));
			append(line, $('span.name')).textContent = window.scope && window.scope !== window.label ? `${window.label} \u00b7 ${window.scope}` : window.label;
			append(line, $('span.value')).textContent = `${used}%`;
			const bar = append(meter, $('span.bar'));
			append(bar, $('span.fill')).style.width = `${Math.min(100, used)}%`;
			append(meter, $('span.reset')).textContent = window.resetsAt && !passed
				? localize('voltUsage.accountResets', "Resets {0} \u00b7 {1}", fromNow(window.resetsAt, true, true), formatResetTime(window.resetsAt))
				: passed ? localize('voltUsage.accountReset', "Reset") : localize('voltUsage.accountNotStarted', "Starts with your next message");
			if (window.note) {
				setAgentTooltip(meter, window.note);
			}
		}
		append(item, $('.volt-usage-account-checked')).textContent = localize('voltUsage.accountChecked', "Checked {0}", now - limits.checkedAt < 60_000 ? localize('voltUsage.justNow', "just now") : fromNow(limits.checkedAt, true));
	}

	private async switchAccount(account: IVoltClaudeAccount): Promise<void> {
		if (!this.accounts) {
			return;
		}
		this.switchingAccount = account.id;
		this.render();
		try {
			this.accountsState = await this.accounts.switchClaudeAccount(account.id);
			this.notificationService.info(localize('voltUsage.switched', "Claude Code now uses {0}. Running chats pick it up within about 30 seconds.", account.email));
		} catch (error) {
			this.notificationService.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.switchingAccount = undefined;
			this.render();
			await this.load(true);
		}
	}

	private async addMachine(): Promise<void> {
		const address = await this.quickInputService.input({
			title: localize('voltUsage.addMachineTitle', "Add Machine"),
			prompt: localize('voltUsage.addMachinePrompt', "Paste the pairing link the other computer made under Share This Machine."),
			placeHolder: 'http://192.168.1.20:7791/pair#code=ABCD-EFGH',
			ignoreFocusLost: true,
			validateInput: async value => value.trim() && !/[#?&](code|token)=/.test(value) ? localize('voltUsage.addMachineNoCode', "The link needs its #code= part.") : undefined,
		});
		if (!address?.trim()) {
			return;
		}
		try {
			const machine = await this.usageService.addMachine(address.trim());
			this.notificationService.info(localize('voltUsage.machineAdded', "{0} was added. Its usage and limits now count here.", machine.name));
		} catch (error) {
			this.notificationService.error(error instanceof Error ? error.message : String(error));
		}
		await this.loadExtras();
		await this.load(true);
	}

	//#endregion

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
			if ('model' in item && this.customPrice(item.model)) {
				cost.classList.add('custom-price');
				setAgentTooltip(cost, localize('voltUsage.customPriceTip', "Priced at the rates you set"));
			}
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
			showVoltMenu(this.contextViewService, {
				anchor: size,
				position: 'below',
				align: 'left',
				gap: 4,
				width: 120,
				ariaLabel: localize('voltUsage.rowsMenu', "Rows per page"),
				sections: [{ id: 'rows', items: PAGE_SIZES.map(option => ({ id: String(option), label: String(option), checked: option === this.pageSize, data: option })) }],
				onPick: picked => {
					this.pageSize = picked.data;
					this.page = 0;
					this.store(STORAGE_PAGE_SIZE, String(picked.data));
					this.render();
				},
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
		const machines = (this.snapshot.machines ?? []).filter(machine => machine.state === 'ok').map(machine => machine.name);
		const source = machines.length
			? localize('voltUsage.footnoteSourceMachines', "From Claude Code and Codex transcripts on this computer and on {0}, and your Cursor account.", machines.join(', '))
			: localize('voltUsage.footnoteSource', "From Claude Code and Codex transcripts on this computer and your Cursor account.");
		const custom = Object.keys(this.prices).length;
		const prices = custom
			? localize('voltUsage.footnotePricesCustom', "Prices: {0}, and {1} you set.", this.snapshot.pricingSource, custom === 1 ? localize('voltUsage.oneModel', "1 model") : localize('voltUsage.models', "{0} models", custom))
			: localize('voltUsage.footnotePrices', "Prices: {0}.", this.snapshot.pricingSource);
		note.textContent = localize('voltUsage.footnote2', "{0} Each model response is counted once, as it is billed; Claude Code's /stats adds every transcript line, and a response spans several, so its token totals read about twice as high. {1} Updated {2}.", source, prices, updated);
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
