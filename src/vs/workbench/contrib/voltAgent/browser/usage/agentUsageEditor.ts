/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentUsage.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType, getWindow, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Action } from '../../../../../base/common/actions.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IVoltUsageLimitGroup, IVoltUsageLimitWindow, IVoltUsageService, IVoltUsageSnapshot, VOLT_USAGE_PROVIDERS, VoltUsageProvider } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { getLayoutMode, onDidChangeLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { createBrandIcon } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createAgentScrollable } from '../editor/agentScrollable.js';
import { createVoltSegmented, IVoltSegmented } from '../ui/segmented/voltSegmented.js';
import { IUsageChartSeriesStyle, UsageChart } from './agentUsageChart.js';
import { usageInsightsSpec } from './agentUsageInsights.js';
import { voltCharts, voltChartStrings } from '../visuals/agentVisuals.js';
import { DotMatrixMeter } from './agentUsageDots.js';
import { showUsageModelDialog } from './agentUsageModelDialog.js';
import { copyUsagePage } from './agentUsagePageMirror.js';
import { costTypeSegments, hasFasterSpeeds, renderShareBar, speedCostSegments, tokenTypeSegments } from './agentUsageShareBar.js';
import { formatCost, formatDay, formatDuration, formatPercent, formatResetTime, formatShare, formatSlot, formatTokens } from './agentUsageFormat.js';
import { createPaceIcon, createRefreshSpinner, createResetIcon, createTicketIcon } from './agentUsageIcons.js';
import { IUsageModelRow, IUsageSummary, IUsageTotals, limitPace, metricValue, placeholderLimits, placeholderUsage, summarizeUsage, UsageMetric, UsageRange, UsageView } from './agentUsageModel.js';

export const AGENT_USAGE_EDITOR_ID = 'workbench.editor.voltUsage';
export const AGENT_USAGE_INPUT_ID = 'workbench.input.voltUsage';
export const OPEN_AGENT_USAGE_COMMAND_ID = 'workbench.action.voltAgent.usage';

const UsageTabIcon = registerIcon('volt-usage-editor-label-icon', Codicon.graph, localize('voltUsageIcon', 'Icon of the agent Usage tab.'));

export class AgentUsageEditorInput extends EditorInput {

	static readonly TypeID = AGENT_USAGE_INPUT_ID;
	static readonly EditorID = AGENT_USAGE_EDITOR_ID;

	readonly resource = URI.from({ scheme: Schemas.voltUsage, path: 'usage' });

	override get typeId(): string {
		return AgentUsageEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return AgentUsageEditorInput.EditorID;
	}

	override getName(): string {
		return localize('voltUsage.tab', "Usage");
	}

	override getIcon(): ThemeIcon {
		return UsageTabIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof AgentUsageEditorInput;
	}
}

export class AgentUsageEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(AgentUsageEditorInput);
	}
}

const STORAGE_VIEW = 'volt.usage.view';
const STORAGE_RANGE = 'volt.usage.range';
const STORAGE_BREAKDOWN = 'volt.usage.breakdown';
/** Refresh while the page is open; the main process caches, so most polls are free. */
const POLL_MS = 60_000;
const STORAGE_PAGE_SIZE = 'volt.usage.pageSize';
/** Breakdown rows per page, the choices Cursor's tables offer. */
const PAGE_SIZES = [10, 25, 50, 100] as const;

const VIEWS: { id: UsageView; label: string }[] = [
	{ id: 'limits', label: localize('voltUsage.limits', "Limits") },
	{ id: 'cost', label: localize('voltUsage.cost', "Cost") },
	{ id: 'tokens', label: localize('voltUsage.tokens', "Tokens") },
];

const RANGES: { id: UsageRange; label: string; empty: string }[] = [
	{ id: '24h', label: localize('voltUsage.24h', "Past 24h"), empty: localize('voltUsage.empty24h', "No usage in the past 24 hours") },
	{ id: '7d', label: localize('voltUsage.7d', "7 days"), empty: localize('voltUsage.empty7d', "No usage in the past 7 days") },
	{ id: '30d', label: localize('voltUsage.30d', "30 days"), empty: localize('voltUsage.empty30d', "No usage in the past 30 days") },
	{ id: '90d', label: localize('voltUsage.90d', "90 days"), empty: localize('voltUsage.empty90d', "No usage in the past 90 days") },
];

/** Names in the usage history (the agent) and on the limits page (the account). */
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
 * Usage for every agent Volt runs: what the tokens would cost at API prices, how many were
 * processed, and how much of each subscription's rate limits is left. Reads real records:
 * Claude Code and Codex transcripts, Cursor's account usage, and each provider's limits API.
 */
export class AgentUsageEditor extends EditorPane {

	static readonly ID = AGENT_USAGE_EDITOR_ID;

	private container!: HTMLElement;
	private content!: HTMLElement;
	private scroll!: DomScrollableElement;
	private controls!: HTMLElement;
	/** Limits / Cost / Tokens. In the agent layout it sits at the titlebar's right end, before the ranges. */
	private viewBar!: HTMLElement;
	/** The ranges and refresh. In the agent layout they take the titlebar's right corner. */
	private rangeBar!: HTMLElement;
	private viewSegment!: IVoltSegmented<UsageView>;
	private rangeSegment!: IVoltSegmented<UsageRange>;
	private refreshButton!: HTMLButtonElement;
	private headerBackdrop!: HTMLElement;
	/** A copy of the page for the header's blurred backdrop; dropped whenever the page changes. */
	private headerMirror: HTMLElement | undefined;
	private readonly pendingBackdrop = this._register(new MutableDisposable());
	private chart: UsageChart | undefined;

	private view: UsageView;
	private range: UsageRange;
	private breakdown: Breakdown;
	private page = 0;
	private pageSize: number;

	private snapshot: IVoltUsageSnapshot | undefined;
	private limits: readonly IVoltUsageLimitGroup[] | undefined;
	private usageError = false;
	private limitsError = false;
	private loadingUsage = false;
	private loadingLimits = false;
	private loadVersion = 0;
	/** Headline value last shown, so the next one counts from it. */
	private shownHeadline: { metric: UsageMetric; value: number } | undefined;
	/** Set when what the page shows changed, so bars and curves animate in once. */
	private animateNext = true;

	private readonly renderStore = this._register(new DisposableStore());
	/** The open model dialog, if any. */
	private readonly dialog = this._register(new MutableDisposable());
	private readonly visibleStore = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storage: IStorageService,
		@IVoltUsageService private readonly usageService: IVoltUsageService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService private readonly workbenchLayoutService: IWorkbenchLayoutService,
	) {
		super(AgentUsageEditor.ID, group, telemetryService, themeService, storage);
		this._register(onDidChangeLayoutMode(() => this.syncWindowClass()));
		this.view = this.readStored(STORAGE_VIEW, VIEWS.map(view => view.id), 'limits');
		this.range = this.readStored(STORAGE_RANGE, RANGES.map(range => range.id), '30d');
		this.breakdown = this.readStored(STORAGE_BREAKDOWN, ['model', 'day'], 'model');
		const pageSize = Number(this.storage.get(STORAGE_PAGE_SIZE, StorageScope.PROFILE));
		this.pageSize = (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : 25;
	}

	private readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
		const value = this.storage.get(key, StorageScope.PROFILE);
		return allowed.includes(value as T) ? value as T : fallback;
	}

	private store(key: string, value: string): void {
		this.storage.store(key, value, StorageScope.PROFILE, StorageTarget.USER);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.volt-usage'));

		// The tab row and titlebar already name the page, so the header is only its controls. In the
		// agent layout those move up into the titlebar (placeControls) and this header stays empty.
		const header = append(this.container, $('.volt-usage-header'));
		this.headerBackdrop = append(header, $('.volt-usage-header-backdrop'));
		this.headerBackdrop.setAttribute('aria-hidden', 'true');
		this.controls = append(header, $('.volt-usage-controls'));
		const headerStore = this._register(new DisposableStore());
		this.viewBar = append(this.controls, $('.volt-usage-bar.views'));
		this.viewSegment = createVoltSegmented(this.viewBar, VIEWS, this.view, view => this.setView(view), headerStore);
		append(this.controls, $('span.volt-usage-spacer'));
		this.rangeBar = append(this.controls, $('.volt-usage-bar.ranges'));
		this.rangeSegment = createVoltSegmented(this.rangeBar, RANGES, this.range, range => this.setRange(range), headerStore, 'range');
		this.refreshButton = append(this.rangeBar, $('button.volt-usage-refresh')) as HTMLButtonElement;
		this.refreshButton.type = 'button';
		this.refreshButton.appendChild(renderIcon(Codicon.refresh));
		this.refreshButton.appendChild(createRefreshSpinner());
		const refreshLabel = localize('voltUsage.refresh', "Refresh");
		this.refreshButton.setAttribute('aria-label', refreshLabel);
		setAgentTooltip(this.refreshButton, refreshLabel);
		headerStore.add(addDisposableListener(this.refreshButton, EventType.CLICK, () => void this.load(true)));

		const body = $('.volt-usage-body');
		this.content = append(body, $('.volt-usage-content'));
		this.scroll = this._register(createAgentScrollable(body));
		this.container.insertBefore(this.scroll.getDomNode(), header).classList.add('volt-usage-scroll');
		this._register(this.scroll.onScroll(() => this.syncHeaderBackdrop()));
		const observer = new MutationObserver(() => {
			this.headerMirror = undefined;
			this.pendingBackdrop.value = scheduleAtNextAnimationFrame(getWindow(this.container), () => this.syncHeaderBackdrop());
		});
		observer.observe(this.content, { childList: true, subtree: true, characterData: true });
		this._register(toDisposable(() => observer.disconnect()));
		this.syncHeader();
		this.render();
	}

	override async setInput(input: AgentUsageEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.syncWindowClass();
		if (!token.isCancellationRequested) {
			void this.load(false);
		}
	}

	/**
	 * While Usage is showing, the right side of the agent window (title bar and page) lets more of
	 * the desktop through: see `volt-usage-open` in agentUsage.css. Re-derived on every visibility,
	 * layout and input change, because a restored window rewrites the workbench's classes after the
	 * page turns visible, and closing a tab can lay the pane out once more on its way out.
	 */
	private syncWindowClass(): void {
		const workbench = this.container ? getWindow(this.container).document.querySelector('.monaco-workbench') : undefined;
		workbench?.classList.toggle('volt-usage-open', this.isVisible() && !!this.input);
		this.placeControls();
	}

	/**
	 * In the agent layout the controls live at the titlebar's right end, where the IDE and panel
	 * buttons sit (hidden while Usage shows, see agentUsage.css). Anywhere else, or while the page
	 * is hidden, they go back to the page header.
	 */
	private placeControls(): void {
		if (!this.container) {
			return;
		}
		// Only the main panel's page; one opened among the tools beside a chat keeps its own header.
		const mainPanel = !this.container.closest('.volt-agent-tools-part, .volt-agent-side-host');
		const titlebar = this.isVisible() && this.input && mainPanel && getLayoutMode(this.workbenchLayoutService) === 'agent'
			? getWindow(this.container).document.querySelector('.part.titlebar > .titlebar-container')
			: null;
		const right = titlebar?.querySelector(':scope > .titlebar-right');
		const inTitlebar = isHTMLElement(right);
		this.container.classList.toggle('controls-in-titlebar', inTitlebar);
		if (!inTitlebar) {
			if (this.viewBar.parentElement !== this.controls) {
				this.controls.prepend(this.viewBar);
			}
			if (this.rangeBar.parentElement !== this.controls) {
				this.controls.append(this.rangeBar);
			}
			return;
		}
		// Both at the right end, view switch first; the title's drag space fills the bar before them.
		if (this.rangeBar.parentElement !== right) {
			right.prepend(this.rangeBar);
		}
		if (this.viewBar.nextElementSibling !== this.rangeBar) {
			this.rangeBar.before(this.viewBar);
		}
		this.viewSegment.sync();
		this.rangeSegment.sync();
	}

	override clearInput(): void {
		super.clearInput();
		this.syncWindowClass();
	}

	override dispose(): void {
		if (this.container) {
			getWindow(this.container).document.querySelector('.monaco-workbench')?.classList.remove('volt-usage-open');
			this.viewBar.remove();
			this.rangeBar.remove();
		}
		super.dispose();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.syncWindowClass();
		this.visibleStore.clear();
		if (!visible) {
			return;
		}
		const window = getWindow(this.container);
		const poll = window.setInterval(() => void this.load(false, true), POLL_MS);
		// Reset countdowns move every minute even when the numbers do not.
		const tick = window.setInterval(() => {
			if (this.view === 'limits') {
				this.render();
			}
		}, 30_000);
		this.visibleStore.add(toDisposable(() => {
			window.clearInterval(poll);
			window.clearInterval(tick);
		}));
		window.requestAnimationFrame(() => {
			this.viewSegment.sync();
			this.rangeSegment.sync();
		});
		if (this.input) {
			void this.load(false, true);
		}
	}

	override layout(dimension: Dimension): void {
		this.syncWindowClass();
		this.container.style.height = `${dimension.height}px`;
		this.container.style.width = `${dimension.width}px`;
		this.viewSegment.sync();
		this.rangeSegment.sync();
		this.chart?.layout();
		this.scroll.scanDomNode();
		this.headerMirror = undefined;
		this.syncHeaderBackdrop();
	}

	override focus(): void {
		super.focus();
		this.viewSegment.element.querySelector<HTMLElement>('.volt-segment.active')?.focus();
	}

	private setView(view: UsageView): void {
		this.view = view;
		this.page = 0;
		this.store(STORAGE_VIEW, view);
		this.animateNext = true;
		this.syncHeader();
		this.render(true);
	}

	private setRange(range: UsageRange): void {
		this.range = range;
		this.page = 0;
		this.store(STORAGE_RANGE, range);
		this.animateNext = true;
		this.render();
	}

	/**
	 * The controls sit over a blurred copy of the page, like the settings titles.
	 * No backdrop-filter: in the see-through agent window it leaves scroll trails and turns the
	 * sidebar black (volt-transparent-window skill), so the copy is blurred with a plain filter.
	 */
	private syncHeaderBackdrop(): void {
		this.pendingBackdrop.clear();
		if (this.container.classList.contains('controls-in-titlebar')) {
			this.headerMirror = undefined;
			this.headerBackdrop.replaceChildren();
			return;
		}
		const mirror = this.headerMirror ??= copyUsagePage(this.content);
		if (mirror.parentElement !== this.headerBackdrop) {
			this.headerBackdrop.replaceChildren(mirror);
		}
		const page = this.content.getBoundingClientRect();
		const backdrop = this.headerBackdrop.getBoundingClientRect();
		mirror.style.width = `${page.width}px`;
		mirror.style.transform = `translate(${page.left - backdrop.left}px, ${page.top - backdrop.top}px)`;
	}

	private syncHeader(): void {
		this.rangeSegment.element.classList.toggle('hidden', this.view === 'limits');
		this.rangeSegment.element.setAttribute('aria-hidden', String(this.view === 'limits'));
		// In the titlebar a hidden switch takes no room, so its thumb is measured again on return.
		this.rangeSegment.sync();
	}

	private async load(force: boolean, quiet = false): Promise<void> {
		const version = ++this.loadVersion;
		this.loadingUsage = true;
		this.loadingLimits = true;
		if (!quiet) {
			this.refreshButton.classList.add('spinning');
			this.refreshButton.setAttribute('aria-busy', 'true');
		}
		if (!this.snapshot || !this.limits) {
			this.render();
		}
		const usage = this.usageService.getUsage(force).then(snapshot => {
			if (version === this.loadVersion) {
				const first = !this.snapshot;
				this.snapshot = snapshot;
				this.usageError = false;
				this.animateNext ||= first;
			}
		}, () => {
			if (version === this.loadVersion) {
				this.usageError = true;
			}
		}).finally(() => {
			if (version === this.loadVersion) {
				this.loadingUsage = false;
				if (this.view !== 'limits') {
					this.render();
				}
			}
		});
		const limits = this.usageService.getLimits(force).then(groups => {
			if (version === this.loadVersion) {
				const first = !this.limits;
				this.limits = groups;
				this.limitsError = false;
				this.animateNext ||= first;
			}
		}, () => {
			if (version === this.loadVersion) {
				this.limitsError = true;
			}
		}).finally(() => {
			if (version === this.loadVersion) {
				this.loadingLimits = false;
				if (this.view === 'limits') {
					this.render();
				}
			}
		});
		await Promise.allSettled([usage, limits]);
		if (version === this.loadVersion) {
			this.refreshButton.classList.remove('spinning');
			this.refreshButton.removeAttribute('aria-busy');
		}
	}

	//#region Rendering

	private render(transition = false): void {
		if (!this.content) {
			return;
		}
		// The page keeps its place through every re-render: paging, Model/Day, ranges, refreshes and
		// view switches. Clearing the page would otherwise collapse it and snap the scroll to the top.
		const scrollTop = this.scroll.getScrollPosition().scrollTop;
		this.renderStore.clear();
		this.chart = undefined;
		clearNode(this.content);
		this.content.classList.toggle('transition', transition);
		this.content.classList.remove('placeholder');
		this.content.removeAttribute('aria-busy');
		this.content.dataset.view = this.view;
		if (this.view === 'limits') {
			this.renderLimits();
		} else {
			this.renderHistory(this.view);
		}
		this.animateNext = false;
		this.scroll.scanDomNode();
		this.scroll.setScrollPosition({ scrollTop });
	}

	private seriesStyles(): Map<VoltUsageProvider, IUsageChartSeriesStyle> {
		return new Map(VOLT_USAGE_PROVIDERS.map(provider => [provider, { label: PROVIDER_LABELS[provider].agent, color: PROVIDER_COLORS[provider] }]));
	}

	private renderHistory(metric: UsageMetric): void {
		if (!this.snapshot && this.usageError && !this.loadingUsage) {
			this.renderMessage(localize('voltUsage.loadFailed', "Usage could not be read."), true);
			return;
		}
		// Until the snapshot arrives the page renders sample data, faded, so it loads in place.
		const placeholder = !this.snapshot;
		const snapshot = this.snapshot ?? placeholderUsage();
		const summary = summarizeUsage(snapshot, this.range, metric);
		const animate = this.animateNext && !placeholder;

		const hero = append(this.content, $('.volt-usage-hero'));
		const headline = append(hero, $('.volt-usage-headline'));
		const sub = append(hero, $('.volt-usage-subline'));
		if (placeholder) {
			headline.textContent = metric === 'cost' ? formatCost(summary.total.cost) : formatTokens(summary.total.tokens);
			// Sample text for the skeleton to cover; it never shows.
			append(sub, $('span')).textContent = '000 sessions \u00b7 Last 30 days';
		} else {
			this.countUp(headline, metric, metricValue(summary.total, metric));
			const rangeLabel = RANGES.find(range => range.id === this.range)!.label;
			append(sub, $('span')).textContent = summary.sessions === 1
				? localize('voltUsage.oneSessionIn', "1 session \u00b7 {0}", rangeLabel)
				: localize('voltUsage.sessionsIn', "{0} sessions \u00b7 {1}", summary.sessions.toLocaleString(), rangeLabel);
			if (metric === 'cost') {
				append(sub, $('span.dot')).textContent = '\u00b7';
				const estimate = append(sub, $('span.estimate'));
				append(estimate, $('span')).textContent = localize('voltUsage.apiEstimate', "API estimate");
				estimate.appendChild(renderIcon(Codicon.info));
				setAgentTooltip(estimate, localize('voltUsage.apiEstimateTip', "What these tokens would cost at public API prices ({0}). Cursor rows use what Cursor charged. Subscriptions bill differently.", snapshot.pricingSource));
			}
		}

		// The three agent cards stacked in a narrow column, the chart beside them taking the rest.
		const overview = append(this.content, $('.volt-usage-overview'));
		const providers = append(overview, $('.volt-usage-providers'));
		if (!summary.providers.length) {
			append(providers, $('.volt-usage-providers-empty')).textContent = RANGES.find(range => range.id === this.range)!.empty;
		}
		summary.providers.forEach((row, order) => this.renderProviderCard(providers, row.provider, row, row.sessions, summary, metric, order, animate));
		for (const note of snapshot.notes) {
			const item = append(this.content, $('.volt-usage-note'));
			item.appendChild(renderIcon(Codicon.warning));
			append(item, $('span')).textContent = note.message;
		}

		const chartSection = append(overview, $('.volt-usage-chart-column.engine'));
		chartSection.setAttribute('aria-label', summary.hourly
			? metric === 'cost' ? localize('voltUsage.hourlyCost', "Cost per hour") : localize('voltUsage.hourlyTokens', "Tokens per hour")
			: metric === 'cost' ? localize('voltUsage.dailyCost', "Cost per day") : localize('voltUsage.dailyTokens', "Tokens per day"));
		const chart = new UsageChart(chartSection);
		this.renderStore.add(chart);
		this.chart = chart;
		getWindow(this.container).requestAnimationFrame(() => {
			if (this.chart === chart) {
				chart.update(summary, metric, this.seriesStyles(), animate);
				this.scroll.scanDomNode();
			}
		});

		this.renderShares(summary, metric);
		this.renderTotals(summary);
		this.renderBreakdown(summary, metric);
		if (!placeholder) {
			this.renderInsights(snapshot, summary, metric, animate);
		}
		this.renderFootnote();
		if (placeholder) {
			this.fadePlaceholder();
		}
	}

	private renderProviderCard(parent: HTMLElement, provider: VoltUsageProvider, totals: IUsageTotals, sessions: number, summary: IUsageSummary, metric: UsageMetric, order: number, animate: boolean): void {
		const card = append(parent, $('.volt-usage-provider'));
		card.style.setProperty('--volt-usage-tint', PROVIDER_COLORS[provider]);
		card.style.setProperty('--volt-usage-order', String(order));
		card.classList.toggle('animate', animate);
		const top = append(card, $('.volt-usage-provider-top'));
		top.appendChild(createBrandIcon(provider, 16));
		append(top, $('span.name')).textContent = PROVIDER_LABELS[provider].agent;
		const whole = metricValue(summary.total, metric);
		append(top, $('span.share')).textContent = formatShare(metricValue(totals, metric), whole);
		append(card, $('.volt-usage-provider-value')).textContent = metric === 'cost' ? formatCost(totals.cost) : formatTokens(totals.tokens);
		const meter = append(card, $('.volt-usage-provider-meter'));
		const fill = append(meter, $('span'));
		fill.style.width = `${whole > 0 ? Math.max(1.5, (metricValue(totals, metric) / whole) * 100) : 0}%`;
		const detail = append(card, $('.volt-usage-provider-detail'));
		const sessionsText = sessions === 1
			? localize('voltUsage.oneSessionShort', "1 session")
			: localize('voltUsage.sessionsShort', "{0} sessions", sessions.toLocaleString());
		detail.textContent = `${sessionsText} \u00b7 ${metric === 'cost'
			? localize('voltUsage.tokensSuffix', "{0} tokens", formatTokens(totals.tokens))
			: formatCost(totals.cost)}`;
	}

	/** What the range says, each chart titled with its finding: token mix, cache hits, models over time, when you work. */
	private renderInsights(snapshot: IVoltUsageSnapshot, summary: IUsageSummary, metric: UsageMetric, animate: boolean): void {
		const spec = usageInsightsSpec(snapshot, summary, metric);
		if (!spec) {
			return;
		}
		const section = append(this.content, $('.volt-usage-section.volt-usage-insights'));
		sectionHead(section, localize('voltUsage.insights', "Insights"));
		const host = append(section, $('.volt-usage-insights-body'));
		const handle = voltCharts(getWindow(host)).render(host, spec, { strings: voltChartStrings(), animate });
		this.renderStore.add(toDisposable(() => handle.dispose()));
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

	/**
	 * Under the chart, above the totals: cost by type and by speed (or tokens by type on the Tokens page). Speed only
	 * shows when something ran fast; then type takes the whole row.
	 */
	private renderShares(summary: IUsageSummary, metric: UsageMetric): void {
		if (summary.total.tokens <= 0) {
			return;
		}
		const section = append(this.content, $('.volt-usage-section.volt-usage-shares'));
		if (metric === 'tokens') {
			renderShareBar(section, localize('voltUsage.tokensByType', "Tokens by type"), tokenTypeSegments(summary.total), formatTokens);
		} else {
			renderShareBar(section, localize('voltUsage.costByType', "Cost by type"), costTypeSegments(summary.total), formatCost);
			if (hasFasterSpeeds(summary.total)) {
				renderShareBar(section, localize('voltUsage.costBySpeed', "Cost by speed"), speedCostSegments(summary.total), formatCost,
					localize('voltUsage.premium', "Premium {0}", formatCost(summary.total.speedPremium)));
			}
		}
		if (!section.childElementCount) {
			section.remove();
		}
	}

	private openModel(model: IUsageModelRow, summary: IUsageSummary, metric: UsageMetric): void {
		if (!this.snapshot) {
			return;
		}
		this.dialog.value = showUsageModelDialog(this.container, {
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
		getWindow(this.container).requestAnimationFrame(() => toggle.sync());

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
		const window = getWindow(this.container);
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
	private fadePlaceholder(): void {
		this.content.classList.add('placeholder');
		this.content.setAttribute('aria-busy', 'true');
		const doc = this.content.ownerDocument;
		const walker = doc.createTreeWalker(this.content, NodeFilter.SHOW_TEXT);
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
		for (const child of this.content.children) {
			(child as HTMLElement).inert = true;
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

	//#region Limits

	private renderLimits(): void {
		if (!this.limits && this.limitsError && !this.loadingLimits) {
			this.renderMessage(localize('voltUsage.limitsFailed', "Limits could not be read."), true);
			return;
		}
		const placeholder = !this.limits;
		const groups = [...this.limits ?? placeholderLimits()].sort((a, b) => VOLT_USAGE_PROVIDERS.indexOf(a.provider) - VOLT_USAGE_PROVIDERS.indexOf(b.provider));
		if (!groups.length) {
			this.renderMessage(localize('voltUsage.noLimits', "Sign in to Claude Code, Codex or Cursor to see your limits here."), false);
			return;
		}
		const root = append(this.content, $('.volt-usage-limits'));
		const now = Date.now();
		for (const group of groups) {
			const section = append(root, $('.volt-usage-limit-group'));
			section.dataset.provider = group.provider;
			const title = append(section, $('.volt-usage-limit-title'));
			title.appendChild(createBrandIcon(group.provider, 16));
			append(title, $('span.name')).textContent = PROVIDER_LABELS[group.provider].account;
			if (group.plan) {
				append(title, $('span.plan')).textContent = group.plan;
			}
			// A sample from a transcript is as old as the last Codex turn; say so.
			if (now - group.checkedAt > 5 * 60_000) {
				append(title, $('span.stale')).textContent = localize('voltUsage.asOf', "as of {0}", fromNow(group.checkedAt, true));
			}
			const panel = append(section, $('.volt-usage-limit-panel'));
			if (group.error || !group.windows.length) {
				const row = append(panel, $('.volt-usage-limit.error'));
				row.appendChild(renderIcon(Codicon.info));
				append(row, $('span')).textContent = group.error ?? localize('voltUsage.noWindows', "No limits reported for this account.");
				continue;
			}
			for (const window of group.windows) {
				this.renderLimitWindow(panel, group, window, now);
			}
			if (group.resetCredits) {
				const credit = append(panel, $('.volt-usage-limit-credit'));
				credit.appendChild(createTicketIcon());
				append(credit, $('span')).textContent = group.resetCredits === 1
					? localize('voltUsage.oneCredit', "1 free limit reset available in Codex")
					: localize('voltUsage.credits', "{0} free limit resets available in Codex", group.resetCredits);
			}
		}
		if (placeholder) {
			this.fadePlaceholder();
		}
	}

	/** One window, laid out like Cursor's usage page: title and share used, the meter, then when it resets. */
	private renderLimitWindow(parent: HTMLElement, group: IVoltUsageLimitGroup, window: IVoltUsageLimitWindow, now: number): void {
		const used = Math.min(100, Math.max(0, window.usedPercent));
		const row = append(parent, $('.volt-usage-limit'));
		row.classList.toggle('high', used >= 80);
		row.classList.toggle('full', used >= 100);

		const top = append(row, $('.volt-usage-limit-top'));
		const name = append(top, $('span.name'));
		append(name, $('span.label')).textContent = window.label;
		if (window.scope) {
			append(name, $('span.scope')).textContent = ` \u00b7 ${window.scope}`;
		}
		append(top, $('span.used')).textContent = localize('voltUsage.usedShort', "{0} used", formatPercent(used));

		const dots = new DotMatrixMeter(row, used / 100, `${group.provider}:${window.id}`, this.animateNext);
		this.renderStore.add(dots);

		const meta = append(row, $('.volt-usage-limit-meta'));
		if (window.resetsAt && window.resetsAt > now) {
			const reset = append(meta, $('span.part'));
			reset.appendChild(createResetIcon());
			append(reset, $('span')).textContent = localize('voltUsage.resetsInAt', "Resets in {0} \u00b7 {1}", formatDuration(window.resetsAt - now), formatResetTime(window.resetsAt));
		} else if (used === 0) {
			append(meta, $('span.part')).textContent = localize('voltUsage.notStarted', "Starts with your next message");
		}
		const pace = used > 0 && used < 100 ? limitPace(window, now) : undefined;
		if (used >= 100) {
			append(meta, $('span.part.pace.full')).textContent = localize('voltUsage.limitReached', "Limit reached");
		} else if (pace) {
			const mark = append(meta, $('span.part.pace'));
			mark.classList.toggle('warn', pace.runsOutInMs !== undefined);
			mark.appendChild(createPaceIcon(pace.ahead));
			append(mark, $('span')).textContent = pace.runsOutInMs !== undefined
				? localize('voltUsage.paceOutShort', "At this pace, runs out in {0}", formatDuration(pace.runsOutInMs))
				: pace.ahead
					? localize('voltUsage.paceAheadShort', "A little ahead of pace")
					: localize('voltUsage.paceOkShort', "On pace");
		}
		if (window.note) {
			append(row, $('.volt-usage-limit-note')).textContent = window.note;
		}
	}

	//#endregion
}
