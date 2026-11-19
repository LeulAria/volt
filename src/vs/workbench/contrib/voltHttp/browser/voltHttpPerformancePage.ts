/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltHttpPerformance.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer } from '../../../../base/browser/ui/list/list.js';
import { Action, Separator } from '../../../../base/common/actions.js';
import { raceCancellation, RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, joinPath, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IVoltLoadThreshold, VOLT_LOAD_MAX_USERS, VOLT_LOAD_METRICS, VOLT_LOAD_OPERATORS, VoltLoadErrorKind, VoltLoadHistogram, VoltLoadMetric, VoltLoadMode, VoltLoadOperator, voltLoadPercentiles, voltLoadProfileDefaults, voltLoadProfilePoints, VoltLoadProfileKind } from '../../../../platform/voltHttp/common/voltHttpLoad.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { findHttpItemByPath, httpItemPath, httpRequestLabel, httpRequestsOf, IHttpRequest } from '../common/httpCollection.js';
import { compareHttpPerfRuns, httpPerfLiveNumbers, formatHttpPerfBytes, formatHttpPerfMetric, formatHttpPerfMs, formatHttpPerfNumber, formatHttpPerfPercent, formatHttpPerfSeconds, HTTP_PERF_AGENT_MAX_SECONDS, HTTP_PERF_AGENT_MAX_USERS, HTTP_PERF_PHASES, HTTP_PERF_PROFILES, HttpPerfCompareKey, httpPerfAnalysisPrompt, httpPerfErrorKindLabel, httpPerfHistogramBins, httpPerfHtmlReport, httpPerfJsonReport, httpPerfLatencyLabel, httpPerfMarkdownReport, httpPerfMetricLabel, httpPerfRunText, httpPerfStatusClasses, httpPerfThresholdText, httpPerfUnit, IHttpPerfDelta, IHttpPerfFile, IHttpPerfInline, IHttpPerfLoad, IHttpPerfRun, IHttpPerfTarget, isHttpPerfLocalHost } from '../common/httpPerformance.js';
import { httpRequestBadge, httpRequestBadgeKey } from '../common/httpProtocols.js';
import { HttpHistogramChart, HttpLineChart, renderHttpStackedBar } from './voltHttpCharts.js';
import { IVoltHttpCollections } from './voltHttpCollections.js';
import { IHttpPerfPrepared, IHttpPerfRunState, IVoltHttpPerformance } from './voltHttpPerformance.js';
import { IHttpToolPage, IHttpToolPageHost, IHttpToolTabState } from './voltHttpToolPages.js';
import { createHttpAiModelButton, httpAiModelRef } from './voltHttpAiModel.js';
import { createHttpAgentIcon } from './voltHttpIcons.js';
import { createHttpCheck, createHttpDropdown, createHttpIconButton, createHttpVariableField, decorateHttpHeadButton, renderHttpAiAnswer, renderHttpTabs, showHttpActionMenu } from './voltHttpWidgets.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';

type PerfTab = 'setup' | 'results' | 'history';
type ReportFormat = 'html' | 'markdown' | 'json';

const NARROW = 720;
const TINY = 480;
const TARGET_ROW = 40;
const RUN_ROW = 44;
const MAX_TARGET_ROWS = 8;
const AI_TIMEOUT_MS = 120_000;
/** Live parts redraw at most this often (ms). */
const LIVE_REDRAW_MS = 250;
// allow-any-unicode-next-line
const DOT = ' · ';

/** Who the model is when it reads a run. */
export const HTTP_PERF_ANALYSIS_SYSTEM_PROMPT = 'You are a performance engineer reading the results of a load test for the developer who owns the system under test. Answer in plain text, short, no tables, no tool use and no questions.';

const COLORS = {
	throughput: 'var(--vscode-charts-blue)',
	errors: 'var(--vscode-charts-red)',
	users: 'var(--vscode-descriptionForeground)',
	sent: 'var(--vscode-charts-purple)',
	mean: 'var(--vscode-descriptionForeground)',
	// Percentiles are ordered: one hue, lighter to darker.
	p50: 'color-mix(in srgb, var(--vscode-charts-blue) 40%, var(--vscode-editor-background))',
	p95: 'color-mix(in srgb, var(--vscode-charts-blue) 70%, var(--vscode-editor-background))',
	p99: 'var(--vscode-charts-blue)',
	histogram: 'var(--vscode-charts-blue)',
	'2xx': 'var(--vscode-charts-green)',
	'3xx': 'var(--vscode-charts-blue)',
	'4xx': 'var(--vscode-charts-yellow)',
	'5xx': 'var(--vscode-charts-red)',
	other: 'var(--vscode-descriptionForeground)',
} as const;

const MODE_LABELS: Readonly<Record<VoltLoadMode, string>> = {
	http: localize('voltHttp.perfModeHttp', "HTTP"),
	ws: localize('voltHttp.perfModeWs', "WebSocket"),
	sse: localize('voltHttp.perfModeSse', "SSE"),
};

const PROFILE_LABELS: Readonly<Record<VoltLoadProfileKind, string>> = {
	fixed: localize('voltHttp.perfProfileFixed', "Fixed"),
	rampUp: localize('voltHttp.perfProfileRamp', "Ramp up"),
	spike: localize('voltHttp.perfProfileSpike', "Spike"),
	peak: localize('voltHttp.perfProfilePeak', "Peak"),
};

const PROFILE_DESCRIPTIONS: Readonly<Record<VoltLoadProfileKind, string>> = {
	fixed: localize('voltHttp.perfProfileFixedDesc', "The same number of users from start to end."),
	rampUp: localize('voltHttp.perfProfileRampDesc', "Starts low and climbs to the full number, then holds."),
	spike: localize('voltHttp.perfProfileSpikeDesc', "A base load with one sudden burst to the full number."),
	peak: localize('voltHttp.perfProfilePeakDesc', "A base load that climbs, holds at the full number, and comes down."),
};

const OPERATOR_LABELS: Readonly<Record<VoltLoadOperator, string>> = {
	lt: localize('voltHttp.perfOpLt', "less than"),
	lte: localize('voltHttp.perfOpLte', "at most"),
	gt: localize('voltHttp.perfOpGt', "more than"),
	gte: localize('voltHttp.perfOpGte', "at least"),
};

interface ITargetTemplate {
	readonly method: HTMLElement;
	readonly name: HTMLElement;
	readonly detail: HTMLElement;
	readonly weight: HTMLInputElement;
	readonly weightWrap: HTMLElement;
	readonly store: DisposableStore;
}

interface IRunTemplate {
	readonly verdict: HTMLElement;
	readonly date: HTMLElement;
	readonly by: HTMLElement;
	readonly facts: HTMLElement;
}

/**
 * A performance test's tab: Setup (targets, load, options, thresholds), Results (live while it
 * runs, then the final numbers, charts and tables) and History (the last runs, two compared).
 * The run itself lives in `IVoltHttpPerformance`: this page only shows it, so it can come and go.
 */
export class HttpPerformancePage extends Disposable implements IHttpToolPage {

	private readonly uri: URI;
	private readonly root: URI | undefined;
	private readonly element: HTMLElement;
	private readonly nameInput: HTMLInputElement;
	private readonly modeHost: HTMLElement;
	private readonly runButton: ReturnType<typeof createVoltButton>;
	private readonly statusEl: HTMLElement;
	private readonly tabsEl: HTMLElement;
	private readonly body: HTMLElement;
	private readonly view = this._register(new DisposableStore());
	private readonly headStore = this._register(new DisposableStore());
	private readonly sectionStore = this._register(new DisposableStore());
	private readonly aiStore = this._register(new DisposableStore());
	private readonly aiRun = this._register(new MutableDisposable());
	private readonly liveScheduler: RunOnceScheduler;
	private readonly ticker = this._register(new MutableDisposable());
	private wasRunning = false;
	/** The next file change is this page's own write: the parts already show it. */
	private echo = 0;

	// Setup
	private targetList: WorkbenchList<IHttpPerfTarget> | undefined;
	private targetHost: HTMLElement | undefined;
	private targetEditor: HTMLElement | undefined;
	private readonly targetEditorStore = this._register(new DisposableStore());
	private loadEl: HTMLElement | undefined;
	private readonly loadStore = this._register(new DisposableStore());
	private profileChart: HttpLineChart | undefined;
	private hostsEl: HTMLElement | undefined;
	private thresholdsEl: HTMLElement | undefined;
	private readonly thresholdStore = this._register(new DisposableStore());
	private prepareToken = 0;
	/** Collections this page asked to read for its rows. */
	private readonly collectionsAsked = new Set<string>();

	// Results
	private cardsEl: HTMLElement | undefined;
	private verdictEl: HTMLElement | undefined;
	private throughputChart: HttpLineChart | undefined;
	private usersChart: HttpLineChart | undefined;
	private latencyChart: HttpLineChart | undefined;
	private aiEl: HTMLElement | undefined;

	// History
	private runList: WorkbenchList<IHttpPerfRun> | undefined;
	private runHost: HTMLElement | undefined;
	private compareEl: HTMLElement | undefined;
	private readonly compareStore = this._register(new DisposableStore());

	constructor(
		parent: HTMLElement,
		private readonly state: IHttpToolTabState,
		private readonly host: IHttpToolPageHost,
		@IVoltHttpPerformance private readonly performance: IVoltHttpPerformance,
		@IVoltHttpCollections private readonly collections: IVoltHttpCollections,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
	) {
		super();
		this.uri = state.uri;
		this.root = performance.rootOf(this.uri, host.root);
		this.element = append(parent, $('.volt-http-page.volt-http-perf'));

		const head = append(this.element, $('.volt-http-head.volt-http-perf-head'));
		append(head, $('span.volt-http-page-icon')).appendChild(renderIcon(Codicon.dashboard));
		this.nameInput = append(head, $('input.volt-http-name')) as HTMLInputElement;
		this.nameInput.type = 'text';
		this.nameInput.spellcheck = false;
		this.nameInput.setAttribute('aria-label', localize('voltHttp.perfName', "Test name"));
		this._register(addDisposableListener(this.nameInput, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				this.nameInput.blur();
			} else if (event.key === 'Escape') {
				this.nameInput.value = this.file?.name ?? '';
				this.nameInput.blur();
			}
		}));
		this._register(addDisposableListener(this.nameInput, EventType.BLUR, () => {
			const name = this.nameInput.value.trim();
			if (name && name !== this.file?.name) {
				void this.performance.rename(this.uri, name).then(() => this.host.tabChanged());
			} else {
				this.nameInput.value = this.file?.name ?? '';
			}
		}));
		this.modeHost = append(head, $('.volt-http-perf-mode'));
		const actions = append(head, $('.volt-http-head-actions'));
		const analyze = this._register(createVoltButton(actions, 'ghost'));
		analyze.element.classList.add('volt-http-perf-analyze');
		decorateHttpHeadButton(analyze, createHttpAgentIcon(), localize('voltHttp.perfAnalyze', "Analyze with AI"));
		this._register(analyze.onDidClick(() => this.startAnalysis()));
		createHttpIconButton(actions, Codicon.ellipsis, localize('voltHttp.perfMore', "More Actions"), button => this.showMore(button));
		this.runButton = this._register(createVoltButton(actions, 'primary'));
		this.runButton.element.classList.add('volt-http-perf-run');
		this._register(this.runButton.onDidClick(() => void this.toggleRun()));

		this.statusEl = append(this.element, $('.volt-http-perf-status'));
		this.statusEl.setAttribute('role', 'status');
		this.tabsEl = append(this.element, $('.volt-http-tabs.volt-http-perf-tabs'));
		this.body = append(this.element, $('.volt-http-perf-body'));

		this.liveScheduler = this._register(new RunOnceScheduler(() => this.onRunProgress(), LIVE_REDRAW_MS));
		this._register(performance.onDidChangeRun(uri => {
			if (uri.toString() !== this.uri.toString()) {
				return;
			}
			// The start and the end show at once; the seconds between, a few times a second at most.
			if (!!this.live?.running !== this.wasRunning) {
				this.liveScheduler.cancel();
				this.onRunProgress();
			} else if (!this.liveScheduler.isScheduled()) {
				this.liveScheduler.schedule();
			}
		}));
		this._register(performance.onDidChangeFile(uri => {
			if (uri.toString() === this.uri.toString()) {
				this.onFileChanged();
			}
		}));
		this.wasRunning = !!this.live?.running;
		this.syncTicker();
		this.renderHead();
		void performance.load(this.uri).then(() => {
			if (!this._store.isDisposed) {
				this.renderHead();
				this.renderTab();
			}
		});
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}

	// --- State -----------------------------------------------------------------------------------

	private get file(): IHttpPerfFile | undefined {
		return this.performance.get(this.uri)?.file;
	}

	private get live(): IHttpPerfRunState | undefined {
		return this.performance.runOf(this.uri);
	}

	private get mode(): VoltLoadMode {
		return this.file?.mode ?? 'http';
	}

	private get tab(): PerfTab {
		const tab = this.state.memory.tab;
		if (tab === 'setup' || tab === 'results' || tab === 'history') {
			return tab;
		}
		return this.live || this.file?.runs.length ? 'results' : 'setup';
	}

	private setTab(tab: PerfTab): void {
		if (this.state.memory.tab !== tab || !this.body.childElementCount) {
			this.state.memory.tab = tab;
			this.renderTab();
		}
	}

	/** Changes the file; the parts that show the change are brought up to date by the caller. */
	private change(mutate: (file: IHttpPerfFile) => void): Promise<void> {
		return this.performance.update(this.uri, file => {
			this.echo++;
			mutate(file);
		}).catch(err => this.notificationService.error(localize('voltHttp.perfSaveFailed', "The test could not be saved: {0}", err instanceof Error ? err.message : String(err))));
	}

	private setLoad(change: Partial<IHttpPerfLoad>, remove: readonly (keyof IHttpPerfLoad)[] = []): Promise<void> {
		return this.change(file => {
			const next: Record<string, unknown> = { ...file.load, ...change };
			for (const key of remove) {
				delete next[key];
			}
			file.load = next as unknown as IHttpPerfLoad;
		});
	}

	/** The finished run the Results tab shows: the one picked in History, else the newest. */
	private shownRun(): IHttpPerfRun | undefined {
		const runs = this.file?.runs ?? [];
		const picked = typeof this.state.memory.runId === 'string' ? this.state.memory.runId : undefined;
		const live = this.live?.result;
		if (picked) {
			const found = runs.find(run => run.id === picked) ?? (live?.id === picked ? live : undefined);
			if (found) {
				return found;
			}
		}
		if (live && !runs.some(run => run.id === live.id) && (!runs[0] || live.startedAt >= runs[0].startedAt)) {
			return live;
		}
		return runs[0];
	}

	/** The run before `run` in the file (to compare with). */
	private previousOf(run: IHttpPerfRun | undefined): IHttpPerfRun | undefined {
		const runs = this.file?.runs ?? [];
		if (!run) {
			return runs[0];
		}
		const index = runs.findIndex(item => item.id === run.id);
		return index >= 0 ? runs[index + 1] : runs.find(item => item.startedAt < run.startedAt);
	}

	private filePath(): string {
		return (this.root && relativePath(this.root, this.uri)) || this.uri.fsPath;
	}

	private onFileChanged(): void {
		if (this.echo > 0) {
			this.echo--;
			this.renderHead();
			return;
		}
		this.renderHead();
		this.renderTab();
	}

	private onRunProgress(): void {
		if (this._store.isDisposed) {
			return;
		}
		const running = !!this.live?.running;
		const changed = this.wasRunning !== running;
		this.wasRunning = running;
		this.syncTicker();
		if (this.tab === 'results') {
			// A run that starts or ends redraws the tab; the seconds between update it in place.
			if (changed || !this.cardsEl) {
				this.renderTab();
			} else {
				this.renderHead();
				this.updateLive();
			}
		} else if (changed && this.tab === 'history') {
			this.renderTab();
		} else {
			this.renderHead();
		}
	}

	/** While a run goes, the status line counts the seconds even between samples. */
	private syncTicker(): void {
		if (this.live?.running && !this.ticker.value) {
			const targetWindow = getWindow(this.element);
			const timer = targetWindow.setInterval(() => this.renderStatus(), 1000);
			this.ticker.value = toDisposable(() => targetWindow.clearInterval(timer));
		} else if (!this.live?.running) {
			this.ticker.clear();
		}
	}

	// --- Head ------------------------------------------------------------------------------------

	private renderHead(): void {
		const file = this.file;
		const entry = this.performance.get(this.uri);
		if (this.element.ownerDocument.activeElement !== this.nameInput) {
			this.nameInput.value = file?.name ?? basename(this.uri);
		}
		const live = this.live;
		const running = !!live?.running;
		this.runButton.label = running ? (live?.stopping ? localize('voltHttp.perfStopping', "Stopping") : localize('voltHttp.perfStop', "Stop")) : localize('voltHttp.perfRun', "Run");
		this.runButton.enabled = !!entry && !entry.error && !live?.stopping;
		// The mode's dropdown is drawn again only when what it shows changes (an open menu stays open).
		const modeKey = file ? `${file.mode}|${running}` : '';
		if (this.modeHost.dataset.key !== modeKey) {
			this.modeHost.dataset.key = modeKey;
			this.headStore.clear();
			clearNode(this.modeHost);
		}
		if (file && !this.modeHost.childElementCount) {
			const dropdown = createHttpDropdown<VoltLoadMode>(this.modeHost, this.contextViewService, {
				options: [
					{ id: 'http', label: MODE_LABELS.http, description: localize('voltHttp.perfModeHttpDesc', "Virtual users send requests in a loop."), icon: Codicon.globe },
					{ id: 'ws', label: MODE_LABELS.ws, description: localize('voltHttp.perfModeWsDesc', "Connections held open; messages and round trips."), icon: Codicon.plug },
					{ id: 'sse', label: MODE_LABELS.sse, description: localize('voltHttp.perfModeSseDesc', "Event streams held open; events and time to the first."), icon: Codicon.radioTower },
				],
				value: file.mode,
				ariaLabel: localize('voltHttp.perfModeAria', "What gets the load"),
				onChange: mode => {
					if (running) {
						return;
					}
					void this.change(item => item.mode = mode).then(() => {
						this.renderHead();
						if (this.tab === 'setup') {
							this.renderTab();
						}
					});
				},
			}, this.headStore);
			// The mode of a run in progress cannot change under it.
			dropdown.element.disabled = running;
			setAgentTooltip(dropdown.element, running ? localize('voltHttp.perfModeLocked', "Stop the run to change what gets the load") : '');
		}
		this.renderStatus();
		const runs = file?.runs.length ?? 0;
		renderHttpTabs(this.tabsEl, [
			{ id: 'setup', label: localize('voltHttp.perfTabSetup', "Setup") },
			{ id: 'results', label: localize('voltHttp.perfTabResults', "Results") },
			{ id: 'history', label: localize('voltHttp.perfTabHistory', "History"), ...(runs ? { count: runs } : {}) },
		], this.tab, id => this.setTab(id));
	}

	/** The line under the head: a run's progress, or when the last one ran. */
	private renderStatus(): void {
		const parent = this.statusEl;
		clearNode(parent);
		const live = this.live;
		const entry = this.performance.get(this.uri);
		parent.classList.toggle('running', !!live?.running);
		if (live?.running) {
			const elapsed = Math.max(0, (Date.now() - live.startedAt) / 1000);
			const warm = elapsed < live.warmupSec;
			const line = append(parent, $('.volt-http-perf-status-line'));
			append(line, $('span.volt-http-spinner')).appendChild(renderIcon(Codicon.loading));
			const numbers = httpPerfLiveNumbers(live.samples);
			const last = live.samples[live.samples.length - 1];
			const unit = httpPerfUnit(live.mode);
			const parts = [
				live.stopping ? localize('voltHttp.perfStatusStopping', "Stopping") : warm ? localize('voltHttp.perfStatusWarm', "Warming up") : localize('voltHttp.perfStatusRunning', "Running"),
				localize('voltHttp.perfStatusUsers', "{0} {1}", last?.users ?? 0, live.mode === 'http' ? localize('voltHttp.perfUsersWord', "users") : localize('voltHttp.perfConnectionsWord', "connections")),
				`${formatHttpPerfNumber(numbers.count)} ${unit.many}`,
				...(live.samples.length ? [`${formatHttpPerfNumber(last?.count ?? 0)} ${unit.rate}`] : []),
			];
			append(line, $('span.volt-http-perf-status-text')).textContent = parts.join(DOT);
			const remaining = live.requests ? undefined : Math.max(0, live.plannedSec - elapsed);
			append(line, $('span.volt-http-perf-status-time')).textContent = remaining !== undefined
				? localize('voltHttp.perfStatusTime', "{0} of {1}, {2} left", formatHttpPerfSeconds(elapsed), formatHttpPerfSeconds(live.plannedSec), formatHttpPerfSeconds(remaining))
				: localize('voltHttp.perfStatusCount', "{0} of {1} requests", formatHttpPerfNumber(numbers.count), formatHttpPerfNumber(live.requests ?? 0));
			const track = append(parent, $('.volt-http-perf-progress'));
			const fraction = live.requests ? numbers.count / live.requests : live.plannedSec ? elapsed / live.plannedSec : 0;
			append(track, $('span')).style.width = `${Math.min(100, Math.max(0, fraction * 100)).toFixed(1)}%`;
			track.setAttribute('aria-hidden', 'true');
			return;
		}
		if (entry?.error) {
			append(parent, $('.volt-http-perf-status-line.error')).textContent = localize('voltHttp.perfUnreadable', "This file cannot be read: {0}", entry.error);
			return;
		}
		if (live?.error) {
			const line = append(parent, $('.volt-http-perf-status-line.error'));
			append(line, $('span.volt-http-ico')).appendChild(renderIcon(Codicon.error));
			append(line, $('span.volt-http-perf-status-text')).textContent = localize('voltHttp.perfRunFailed', "The run failed: {0}", live.error);
			return;
		}
		const last = this.file?.runs[0];
		if (last) {
			const line = append(parent, $('.volt-http-perf-status-line.muted'));
			append(line, $('span.volt-http-perf-status-text')).textContent = localize('voltHttp.perfLastRun', "Last run {0}{1}", fromNow(last.startedAt, true), `${DOT}${last.verdict.passed ? localize('voltHttp.perfPassedLower', "passed") : localize('voltHttp.perfFailedLower', "failed")}`);
			setAgentTooltip(line, new Date(last.startedAt).toLocaleString());
		}
	}

	private async toggleRun(): Promise<void> {
		const live = this.live;
		if (live?.running) {
			this.performance.stop(this.uri);
			this.renderHead();
			return;
		}
		const file = this.file;
		if (!file) {
			return;
		}
		let prepared: IHttpPerfPrepared;
		try {
			prepared = await this.performance.prepare(this.uri, this.host.root);
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
			return;
		}
		if (prepared.problems.length) {
			this.setTab('setup');
			this.notificationService.warn(localize('voltHttp.perfCannotRun', "The test cannot run yet: {0}", prepared.problems.slice(0, 3).join(' ')));
			return;
		}
		if (prepared.toConfirm.length) {
			const { confirmed } = await this.dialogService.confirm({
				type: 'warning',
				message: localize('voltHttp.perfConfirmMessage', "You are about to send load to {0}.", prepared.toConfirm.join(', ')),
				detail: localize('voltHttp.perfConfirmDetail', "Only test systems you own or have permission to test. A load test can slow down or take down the service for everyone using it. Volt remembers your answer for this test."),
				primaryButton: localize('voltHttp.perfConfirmButton', "Send Load"),
			});
			if (!confirmed || this._store.isDisposed) {
				return;
			}
			await this.performance.confirmHosts(this.uri, prepared.toConfirm);
		}
		this.state.memory.tab = 'results';
		this.state.memory.runId = undefined;
		this.state.memory.aiOpen = false;
		this.aiRun.clear();
		const run = this.performance.run(this.uri, { ...(this.host.root ? { root: this.host.root } : {}), by: 'user' });
		this.renderTab();
		try {
			const state = await run;
			if (state.error && !this._store.isDisposed) {
				this.renderHead();
			}
		} catch (err) {
			this.notificationService.error(localize('voltHttp.perfStartFailed', "The test did not start: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	private showMore(anchor: HTMLElement): void {
		const action = (id: string, label: string, run: () => void, enabled = true) => new Action(id, label, undefined, enabled, async () => run());
		const run = this.shownRun();
		const menu = showHttpActionMenu(this.contextViewService, anchor, this.element, [
			action('perf.exportHtml', localize('voltHttp.perfExportHtml', "Export Report as HTML"), () => void this.export('html'), !!run),
			action('perf.exportMarkdown', localize('voltHttp.perfExportMarkdown', "Export Report as Markdown"), () => void this.export('markdown'), !!run),
			action('perf.exportJson', localize('voltHttp.perfExportJson', "Export Report as JSON"), () => void this.export('json'), !!run),
			new Separator(),
			action('perf.analyze', localize('voltHttp.perfAnalyzeMenu', "Analyze with AI"), () => this.startAnalysis(), !!run),
			action('perf.chat', localize('voltHttp.perfAddToChat', "Add to Chat"), () => this.addToChat()),
			new Separator(),
			action('perf.reveal', localize('voltHttp.perfReveal', "Reveal File"), () => this.host.revealFile(this.uri)),
		], localize('voltHttp.perfMoreAria', "Performance test actions"));
		this.view.add(menu);
	}

	private async export(format: ReportFormat): Promise<void> {
		const file = this.file;
		const run = this.shownRun();
		if (!file || !run) {
			return;
		}
		const previous = this.previousOf(run);
		const extension = format === 'markdown' ? 'md' : format;
		const text = format === 'html' ? httpPerfHtmlReport(file, run, previous) : format === 'markdown' ? httpPerfMarkdownReport(file, run, previous) : httpPerfJsonReport(file, run, previous);
		const stem = basename(this.uri).replace(/\.volt-perf\.json$/, '') || 'performance-test';
		const target = await this.fileDialogService.showSaveDialog({
			title: localize('voltHttp.perfExportTitle', "Export Performance Report"),
			defaultUri: joinPath(dirname(this.uri), `${stem}-report.${extension}`),
			filters: [{ name: format.toUpperCase(), extensions: [extension] }],
		});
		if (!target) {
			return;
		}
		try {
			await this.fileService.writeFile(target, VSBuffer.fromString(text));
			this.notificationService.info(localize('voltHttp.perfExported', "Report saved to {0}.", basename(target)));
		} catch (err) {
			this.notificationService.error(localize('voltHttp.perfExportFailed', "The report could not be saved: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	private addToChat(): void {
		const file = this.file;
		if (!file) {
			return;
		}
		const run = this.shownRun();
		const text = [
			`Performance test "${file.name}" (${this.filePath()}): ${MODE_LABELS[file.mode]}, ${file.targets.length} target${file.targets.length === 1 ? '' : 's'}, ${file.load.users} ${file.mode === 'http' ? 'users' : 'connections'}.`,
			'',
			run ? httpPerfRunText(file, run) : 'It has not run yet.',
			'',
			`You can read and change this test and run it with the \`ide http\` ops perf_get, perf_save, perf_run (at most ${HTTP_PERF_AGENT_MAX_SECONDS} s and ${HTTP_PERF_AGENT_MAX_USERS} users, only against hosts the user confirmed or local ones) and perf_report (path: ${this.filePath()}).`,
		].join('\n');
		this.host.addToChat(localize('voltHttp.perfChatLabel', "Performance test: {0}", file.name), text);
	}

	// --- Tabs ------------------------------------------------------------------------------------

	private resetParts(): void {
		this.view.clear();
		this.sectionStore.clear();
		this.targetEditorStore.clear();
		this.loadStore.clear();
		this.thresholdStore.clear();
		this.aiStore.clear();
		this.compareStore.clear();
		this.targetList = this.runList = undefined;
		this.profileChart = this.throughputChart = this.usersChart = this.latencyChart = undefined;
		this.targetHost = this.targetEditor = this.loadEl = this.hostsEl = this.thresholdsEl = undefined;
		this.cardsEl = this.verdictEl = this.aiEl = this.runHost = this.compareEl = undefined;
	}

	private renderTab(): void {
		const scroll = this.body.scrollTop;
		this.resetParts();
		clearNode(this.body);
		this.renderHead();
		const entry = this.performance.get(this.uri);
		if (!entry) {
			// allow-any-unicode-next-line
			append(this.body, $('.volt-http-empty.center')).textContent = localize('voltHttp.perfLoading', "Loading…");
			return;
		}
		if (entry.error) {
			append(this.body, $('.volt-http-empty.center')).textContent = localize('voltHttp.perfBroken', "{0} is not a performance test Volt can read: {1}", basename(this.uri), entry.error);
			return;
		}
		switch (this.tab) {
			case 'setup': this.renderSetup(); break;
			case 'results': this.renderResults(); break;
			case 'history': this.renderHistory(); break;
		}
		this.layoutLists();
		this.body.scrollTop = scroll;
	}

	layout(width: number, _height: number): void {
		this.element.classList.toggle('narrow', width < NARROW);
		this.element.classList.toggle('tiny', width < TINY);
		this.layoutLists();
	}

	private layoutLists(): void {
		if (this.targetList && this.targetHost) {
			const rows = this.targetList.length;
			const height = Math.min(rows, MAX_TARGET_ROWS) * TARGET_ROW;
			this.targetHost.style.height = `${height}px`;
			this.targetList.layout(height);
		}
		if (this.runList && this.runHost) {
			const height = this.runList.length * RUN_ROW;
			this.runHost.style.height = `${height}px`;
			this.runList.layout(height);
		}
	}

	private section(parent: HTMLElement, title: string, hint?: string): { readonly section: HTMLElement; readonly head: HTMLElement } {
		const section = append(parent, $('.volt-http-perf-section'));
		const head = append(section, $('.volt-http-perf-section-head'));
		append(head, $('.volt-http-perf-section-title')).textContent = title;
		if (hint) {
			append(section, $('.volt-http-note.volt-http-perf-section-hint')).textContent = hint;
		}
		return { section, head };
	}

	// --- Setup -----------------------------------------------------------------------------------

	private renderSetup(): void {
		const file = this.file!;
		const page = append(this.body, $('.volt-http-perf-setup'));

		const about = this.section(page, localize('voltHttp.perfDescription', "Description")).section;
		const description = append(about, $('input.volt-http-input.volt-http-perf-description')) as HTMLInputElement;
		description.value = file.description;
		description.placeholder = localize('voltHttp.perfDescriptionPlaceholder', "What this test checks, for whoever runs it next");
		description.setAttribute('aria-label', localize('voltHttp.perfDescriptionAria', "Description"));
		this.view.add(addDisposableListener(description, EventType.CHANGE, () => void this.change(item => item.description = description.value)));

		this.renderTargets(page);
		this.loadEl = append(page, $('.volt-http-perf-section-wrap'));
		this.renderLoad();
		if (file.mode !== 'http') {
			this.renderConnectionOptions(page);
		}
		this.thresholdsEl = append(page, $('.volt-http-perf-section-wrap'));
		this.renderThresholds();
		this.hostsEl = append(page, $('.volt-http-perf-hosts'));
		this.refreshHosts();
	}

	private renderTargets(page: HTMLElement): void {
		const file = this.file!;
		const unitText = file.mode === 'ws' ? localize('voltHttp.perfTargetsHintWs', "The WebSocket each connection opens. With several, connections are shared out by weight.")
			: file.mode === 'sse' ? localize('voltHttp.perfTargetsHintSse', "The event stream each connection opens. With several, connections are shared out by weight.")
				: localize('voltHttp.perfTargetsHint', "The requests each virtual user sends: picked by weight on every send, or in order.");
		const { section, head } = this.section(page, localize('voltHttp.perfTargets', "Targets"), unitText);
		append(head, $('.volt-http-spacer'));
		if (file.mode === 'http' && file.targets.length > 1) {
			createHttpDropdown<'weighted' | 'sequence'>(head, this.contextViewService, {
				options: [
					{ id: 'weighted', label: localize('voltHttp.perfOrderWeighted', "By weight"), description: localize('voltHttp.perfOrderWeightedDesc', "Each send picks a target, more often the heavier ones.") },
					{ id: 'sequence', label: localize('voltHttp.perfOrderSequence', "In order"), description: localize('voltHttp.perfOrderSequenceDesc', "Each user walks the targets top to bottom, again and again.") },
				],
				value: file.load.order,
				ariaLabel: localize('voltHttp.perfOrderAria', "How targets are picked"),
				onChange: order => void this.setLoad({ order }).then(() => this.targetList?.rerender()),
			}, this.sectionStore);
		}
		const add = this.sectionStore.add(createVoltButton(head, 'secondary'));
		add.label = localize('voltHttp.perfAddRequest', "Add Request");
		this.sectionStore.add(add.onDidClick(() => void this.pickRequests()));
		const addUrl = this.sectionStore.add(createVoltButton(head, 'ghost'));
		addUrl.label = localize('voltHttp.perfAddUrl', "Add URL");
		this.sectionStore.add(addUrl.onDidClick(() => this.addInline()));

		if (!file.targets.length) {
			append(section, $('.volt-http-perf-empty-list')).textContent = file.mode === 'http'
				? localize('voltHttp.perfNoTargets', "No targets yet. Add requests from the project's collections, or type a URL.")
				: localize('voltHttp.perfNoTargetsStream', "No target yet. Add a request of this kind from the project's collections, or type its URL.");
		}
		this.targetHost = append(section, $('.volt-http-perf-list.volt-http-perf-target-list'));
		const renderer: IListRenderer<IHttpPerfTarget, ITargetTemplate> = {
			templateId: 'target',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-perf-target-row'));
				const method = append(row, $('span.volt-http-row-method'));
				const main = append(row, $('.volt-http-perf-target-main'));
				const name = append(main, $('.volt-http-perf-target-name'));
				const detail = append(main, $('.volt-http-perf-target-detail'));
				const weightWrap = append(row, $('label.volt-http-perf-weight'));
				append(weightWrap, $('span')).textContent = localize('voltHttp.perfWeight', "Weight");
				const weight = append(weightWrap, $('input.volt-http-perf-weight-input')) as HTMLInputElement;
				weight.type = 'text';
				weight.inputMode = 'numeric';
				weight.setAttribute('aria-label', localize('voltHttp.perfWeightAria', "Weight"));
				const store = new DisposableStore();
				const actions = append(row, $('.volt-http-perf-row-actions'));
				createHttpIconButton(actions, Codicon.close, localize('voltHttp.perfRemoveTarget', "Remove Target"), () => {
					const id = row.dataset.id;
					if (id) {
						void this.removeTarget(id);
					}
				});
				// Typing in the field is not the list's keyboard navigation.
				store.add(addDisposableListener(weight, EventType.KEY_DOWN, (event: KeyboardEvent) => {
					event.stopPropagation();
					if (event.key === 'Enter') {
						weight.blur();
					}
				}));
				store.add(addDisposableListener(weight, EventType.CHANGE, () => {
					const id = row.dataset.id;
					const value = Number(weight.value);
					if (id && Number.isFinite(value)) {
						const next = Math.min(1000, Math.max(0, Math.round(value)));
						void this.change(item => item.targets = item.targets.map(target => target.id === id ? { ...target, weight: next } : target));
						weight.value = String(next);
					}
				}));
				return { method, name, detail, weight, weightWrap, store };
			},
			renderElement: (target, _index, template) => {
				const row = template.method.parentElement!;
				row.dataset.id = target.id;
				const info = this.targetInfo(target);
				template.method.textContent = info.badge;
				template.method.dataset.method = info.badgeKey;
				template.name.textContent = info.name;
				// A URL target is named by its URL: say it once.
				template.detail.textContent = info.detail === info.name ? '' : info.detail;
				template.detail.classList.toggle('missing', !!info.missing);
				setAgentTooltip(row, `${info.name}\n${info.detail}`);
				const weighted = this.mode === 'http' && this.file?.load.order === 'weighted' || this.mode !== 'http' && (this.file?.targets.length ?? 0) > 1;
				template.weightWrap.style.display = weighted ? '' : 'none';
				if (this.element.ownerDocument.activeElement !== template.weight) {
					template.weight.value = String(target.weight);
				}
			},
			disposeTemplate: template => template.store.dispose(),
		};
		const list = this.targetList = this.view.add(this.instantiationService.createInstance(WorkbenchList<IHttpPerfTarget>, 'VoltHttpPerfTargets', this.targetHost, { getHeight: () => TARGET_ROW, getTemplateId: () => 'target' }, [renderer], {
			accessibilityProvider: {
				getAriaLabel: target => {
					const info = this.targetInfo(target);
					return `${info.badge} ${info.name}, ${info.detail}, weight ${target.weight}`;
				},
				getWidgetAriaLabel: () => localize('voltHttp.perfTargetsAria', "Targets"),
			},
			multipleSelectionSupport: false,
			// A click selects (and shows a typed URL's editor); a double click opens the request.
			openOnSingleClick: false,
			identityProvider: { getId: target => target.id },
			alwaysConsumeMouseWheel: false,
		}));
		this.view.add(list.onDidChangeSelection(event => {
			const [target] = event.elements;
			// A list being replaced (each redraw) clears its selection on the way out: that is not the user's pick.
			if (!target && !event.browserEvent) {
				return;
			}
			this.state.memory.target = target?.id;
			this.renderTargetEditor();
		}));
		this.view.add(list.onDidOpen(event => {
			const target = event.element;
			if (target?.ref) {
				void this.openRef(target);
			}
		}));
		list.splice(0, 0, file.targets);
		const selected = file.targets.findIndex(target => target.id === this.state.memory.target);
		if (selected >= 0) {
			list.setSelection([selected]);
			list.setFocus([selected]);
		}
		this.targetEditor = append(section, $('.volt-http-perf-target-editor'));
		this.renderTargetEditor();
	}

	/** What a target row shows. */
	private targetInfo(target: IHttpPerfTarget): { readonly badge: string; readonly badgeKey: string; readonly name: string; readonly detail: string; readonly missing?: boolean } {
		if (target.inline) {
			const method = this.mode === 'http' ? target.inline.method : this.mode === 'ws' ? 'WS' : 'SSE';
			return { badge: method, badgeKey: this.mode === 'http' ? method : this.mode, name: target.name || target.inline.url || localize('voltHttp.perfNewUrl', "New URL"), detail: target.inline.url || localize('voltHttp.perfNoUrl', "Type the URL below") };
		}
		const ref = target.ref!;
		const collection = this.performance.collectionUri(this.root, ref.collection);
		const loaded = collection ? this.collections.get(collection) : undefined;
		const item = loaded && !loaded.error ? findHttpItemByPath(loaded.collection, ref.path) : undefined;
		const where = [loaded && !loaded.error ? loaded.collection.name : basename(URI.file(ref.collection)), ...ref.path.slice(0, -1)].join(' / ');
		if (item?.kind === 'request') {
			return { badge: httpRequestBadge(item), badgeKey: httpRequestBadgeKey(item), name: target.name || httpRequestLabel(item), detail: `${where}${DOT}${item.url}` };
		}
		if (collection && !loaded && !this.collectionsAsked.has(collection.toString())) {
			// Not read yet: read it (once) and draw again.
			this.collectionsAsked.add(collection.toString());
			void this.collections.load(collection).then(() => this.targetList?.rerender());
		}
		return { badge: '', badgeKey: '', name: target.name || ref.path[ref.path.length - 1] || ref.collection, detail: loaded ? localize('voltHttp.perfRefGone', "Not in {0} any more", where) : where, missing: !!loaded };
	}

	private async openRef(target: IHttpPerfTarget): Promise<void> {
		const ref = target.ref;
		const collection = ref && this.performance.collectionUri(this.root, ref.collection);
		const loaded = collection ? await this.collections.load(collection) : undefined;
		const item = loaded && !loaded.error && ref ? findHttpItemByPath(loaded.collection, ref.path) : undefined;
		if (collection && item) {
			this.host.openRequest(collection, item.id);
		}
	}

	private async pickRequests(): Promise<void> {
		const mode = this.mode;
		const fits = (request: IHttpRequest) => {
			const protocol = request.protocol ?? 'http';
			return mode === 'ws' ? protocol === 'ws' : mode === 'sse' ? protocol === 'sse' || protocol === 'http' && request.method === 'GET' : ['http', 'graphql', 'soap', 'ai', 'mcp'].includes(protocol);
		};
		interface IPick extends IQuickPickItem { readonly collection: URI; readonly path: readonly string[] }
		const items: IPick[] = [];
		for (const entry of await this.collections.collections(this.root)) {
			if (entry.error) {
				continue;
			}
			for (const { request } of httpRequestsOf(entry.collection.items)) {
				if (!fits(request)) {
					continue;
				}
				const path = httpItemPath(entry.collection, request.id) ?? [request.name];
				items.push({
					label: `${httpRequestBadge(request)}  ${httpRequestLabel(request)}`,
					description: [entry.collection.name, ...path.slice(0, -1)].join(' / '),
					detail: request.url,
					collection: entry.uri,
					path,
				});
			}
		}
		if (!items.length) {
			this.notificationService.info(mode === 'http'
				? localize('voltHttp.perfNoRequests', "The project's collections have no HTTP requests. Add one, or use Add URL.")
				: localize('voltHttp.perfNoStreamRequests', "The project's collections have no {0} requests. Use Add URL.", MODE_LABELS[mode]));
			return;
		}
		const picked = await this.quickInputService.pick(items, {
			canPickMany: true,
			placeHolder: localize('voltHttp.perfPickPlaceholder', "Requests to put load on"),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!picked?.length || this._store.isDisposed) {
			return;
		}
		const added = picked.map((pick): IHttpPerfTarget => ({ id: generateUuid(), ref: { collection: this.performance.collectionRef(this.root, pick.collection), path: [...pick.path] }, weight: 1 }));
		await this.change(file => file.targets = [...file.targets, ...added].slice(0, 50));
		this.renderTab();
	}

	private addInline(): void {
		const id = generateUuid();
		const url = this.mode === 'ws' ? 'ws://localhost:3000/' : 'http://localhost:3000/';
		this.state.memory.target = id;
		void this.change(file => file.targets = [...file.targets, { id, inline: { method: 'GET', url, headers: [] }, weight: 1 }].slice(0, 50)).then(() => {
			this.renderTab();
			const input = this.targetEditor?.querySelector<HTMLInputElement>('.volt-http-field-input');
			input?.focus();
			input?.select();
		});
	}

	private async removeTarget(id: string): Promise<void> {
		if (this.state.memory.target === id) {
			this.state.memory.target = undefined;
		}
		await this.change(file => file.targets = file.targets.filter(target => target.id !== id));
		this.renderTab();
	}

	/** Under the list: the selected typed URL's request, to edit. */
	private renderTargetEditor(): void {
		const parent = this.targetEditor;
		if (!parent) {
			return;
		}
		this.targetEditorStore.clear();
		clearNode(parent);
		const target = this.file?.targets.find(item => item.id === this.state.memory.target);
		parent.classList.toggle('hidden', !target?.inline);
		if (!target?.inline) {
			return;
		}
		const store = this.targetEditorStore;
		const inline = target.inline;
		const set = (change: Partial<IHttpPerfInline>) => void this.change(file => file.targets = file.targets.map(item => item.id === target.id && item.inline ? { ...item, inline: { ...item.inline, ...change } } : item)).then(() => {
			this.targetList?.rerender();
			this.refreshHosts();
		});
		const urlRow = append(parent, $('.volt-http-perf-url-row'));
		if (this.mode === 'http') {
			createHttpDropdown<string>(urlRow, this.contextViewService, {
				options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(method => ({ id: method, label: method })),
				value: inline.method,
				ariaLabel: localize('voltHttp.perfMethod', "Method"),
				onChange: method => set({ method }),
			}, store);
		}
		const url = createHttpVariableField(urlRow, {
			value: inline.url,
			placeholder: this.mode === 'ws' ? 'wss://example.com/socket' : 'https://example.com/api',
			ariaLabel: localize('voltHttp.perfUrl', "URL"),
			variables: this.host.variables,
			onChange: () => { },
		}, store);
		url.element.classList.add('boxed');
		store.add(addDisposableListener(url.input, EventType.CHANGE, () => set({ url: url.value.trim() })));
		store.add(addDisposableListener(url.input, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				url.input.blur();
			}
		}));

		const headersField = append(parent, $('.volt-http-perf-field.wide'));
		append(headersField, $('label')).textContent = localize('voltHttp.perfHeaders', "Headers");
		const headers = append(headersField, $('textarea.volt-http-input.volt-http-perf-code')) as HTMLTextAreaElement;
		headers.rows = Math.min(6, Math.max(2, inline.headers.length + 1));
		headers.spellcheck = false;
		headers.placeholder = 'Authorization: Bearer {{token}}';
		headers.value = inline.headers.map(([key, value]) => `${key}: ${value}`).join('\n');
		headers.setAttribute('aria-label', localize('voltHttp.perfHeadersAria', "Headers, one per line"));
		store.add(addDisposableListener(headers, EventType.CHANGE, () => set({
			headers: headers.value.split(/\r?\n/).map(line => /^\s*([^:\s][^:]*):\s?(.*)$/.exec(line)).filter((match): match is RegExpExecArray => !!match).map(match => [match[1].trim(), match[2]] as const),
		})));
		if (this.mode === 'http') {
			const bodyField = append(parent, $('.volt-http-perf-field.wide'));
			append(bodyField, $('label')).textContent = localize('voltHttp.perfBody', "Body");
			const body = append(bodyField, $('textarea.volt-http-input.volt-http-perf-code')) as HTMLTextAreaElement;
			body.rows = 4;
			body.spellcheck = false;
			body.placeholder = '{ "id": "{{$guid}}", "user": {{$vu}} }';
			body.value = inline.body ?? '';
			body.setAttribute('aria-label', localize('voltHttp.perfBodyAria', "Body"));
			store.add(addDisposableListener(body, EventType.CHANGE, () => set({ body: body.value })));
		}
		append(parent, $('.volt-http-note')).textContent = localize('voltHttp.perfTokensNote', "{{variables}} come from the selected environment. These change on every send: {{$guid}}, {{$timestamp}}, {{$isoTimestamp}}, {{$randomInt}}, {{$vu}} (the user's number), {{$iteration}}.");
	}

	/** A labelled number field: empty means "the default" when `optional`. */
	private numberField(parent: HTMLElement, label: string, value: number | undefined, options: { readonly min: number; readonly max: number; readonly unit?: string; readonly placeholder?: string; readonly optional?: boolean; readonly hint?: string }, store: DisposableStore, onChange: (value: number | undefined) => void): HTMLInputElement {
		const field = append(parent, $('.volt-http-perf-field'));
		const labelEl = append(field, $('label')) as HTMLLabelElement;
		labelEl.textContent = label;
		const wrap = append(field, $('.volt-http-perf-number'));
		const input = append(wrap, $('input.volt-http-input')) as HTMLInputElement;
		input.type = 'text';
		input.inputMode = 'numeric';
		input.spellcheck = false;
		input.value = value === undefined ? '' : String(value);
		input.placeholder = options.placeholder ?? '';
		input.setAttribute('aria-label', label);
		if (options.hint) {
			setAgentTooltip(field, options.hint);
		}
		if (options.unit) {
			append(wrap, $('span.volt-http-perf-unit')).textContent = options.unit;
		}
		store.add(addDisposableListener(input, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				input.blur();
			}
		}));
		store.add(addDisposableListener(input, EventType.CHANGE, () => {
			const raw = input.value.trim();
			if (!raw && options.optional) {
				onChange(undefined);
				return;
			}
			const parsed = Number(raw.replace(/[,_\s]/g, ''));
			if (!Number.isFinite(parsed)) {
				input.value = value === undefined ? '' : String(value);
				return;
			}
			const next = Math.min(options.max, Math.max(options.min, Math.round(parsed)));
			input.value = String(next);
			onChange(next);
		}));
		return input;
	}

	private renderLoad(): void {
		const parent = this.loadEl;
		const file = this.file;
		if (!parent || !file) {
			return;
		}
		this.loadStore.clear();
		clearNode(parent);
		this.profileChart = undefined;
		const store = this.loadStore;
		const load = file.load;
		const http = file.mode === 'http';
		const byCount = http && !load.durationSec && !!load.requests;
		const { section } = this.section(parent, localize('voltHttp.perfLoad', "Load"));
		const grid = append(section, $('.volt-http-perf-grid'));
		this.numberField(grid, http ? localize('voltHttp.perfUsers', "Virtual users") : localize('voltHttp.perfConnections', "Connections"), load.users, { min: 1, max: VOLT_LOAD_MAX_USERS, hint: localize('voltHttp.perfUsersHint', "At most {0}.", VOLT_LOAD_MAX_USERS) }, store, value => void this.setLoad({ users: value ?? 1 }).then(() => this.refreshProfile()));

		const lengthField = append(grid, $('.volt-http-perf-field'));
		append(lengthField, $('label')).textContent = localize('voltHttp.perfRunFor', "Run for");
		const lengthRow = append(lengthField, $('.volt-http-perf-number'));
		if (http) {
			createHttpDropdown<'duration' | 'requests'>(lengthRow, this.contextViewService, {
				options: [
					{ id: 'duration', label: localize('voltHttp.perfByTime', "Seconds") },
					{ id: 'requests', label: localize('voltHttp.perfByCount', "Requests") },
				],
				value: byCount ? 'requests' : 'duration',
				ariaLabel: localize('voltHttp.perfRunForAria', "End the run after a time or a number of requests"),
				onChange: kind => void (kind === 'requests'
					? this.setLoad({ requests: load.requests ?? 1000 }, ['durationSec'])
					: this.setLoad({ durationSec: load.durationSec ?? 30 }, ['requests'])).then(() => this.renderLoad()),
			}, store);
		}
		const lengthInput = append(lengthRow, $('input.volt-http-input')) as HTMLInputElement;
		lengthInput.type = 'text';
		lengthInput.inputMode = 'numeric';
		lengthInput.value = String(byCount ? load.requests : load.durationSec ?? 30);
		lengthInput.setAttribute('aria-label', byCount ? localize('voltHttp.perfRequestsAria', "Requests") : localize('voltHttp.perfSecondsAria', "Seconds"));
		if (!http) {
			append(lengthRow, $('span.volt-http-perf-unit')).textContent = localize('voltHttp.perfSecondsUnit', "s");
		}
		store.add(addDisposableListener(lengthInput, EventType.KEY_DOWN, (event: KeyboardEvent) => event.key === 'Enter' && lengthInput.blur()));
		store.add(addDisposableListener(lengthInput, EventType.CHANGE, () => {
			const parsed = Math.round(Number(lengthInput.value.replace(/[,_\s]/g, '')));
			if (!Number.isFinite(parsed) || parsed < 1) {
				lengthInput.value = String(byCount ? load.requests : load.durationSec ?? 30);
				return;
			}
			const next = byCount ? Math.min(100_000_000, parsed) : Math.min(30 * 60, parsed);
			lengthInput.value = String(next);
			void (byCount ? this.setLoad({ requests: next }) : this.setLoad({ durationSec: next })).then(() => this.refreshProfile());
		}));

		if (!byCount) {
			const profileField = append(grid, $('.volt-http-perf-field'));
			append(profileField, $('label')).textContent = localize('voltHttp.perfProfile', "Load profile");
			createHttpDropdown<VoltLoadProfileKind>(profileField, this.contextViewService, {
				options: HTTP_PERF_PROFILES.map(kind => ({ id: kind, label: PROFILE_LABELS[kind], description: PROFILE_DESCRIPTIONS[kind] })),
				value: load.profile,
				ariaLabel: localize('voltHttp.perfProfileAria', "Load profile"),
				onChange: profile => void this.setLoad({ profile }, ['baseUsers', 'startSec', 'rampUpSec', 'holdSec', 'rampDownSec']).then(() => this.renderLoad()),
			}, store);
			if (load.profile !== 'fixed') {
				const shape = voltLoadProfileDefaults({ kind: load.profile, ...load }, load.users, load.durationSec ?? 30);
				const param = (key: 'baseUsers' | 'startSec' | 'rampUpSec' | 'holdSec' | 'rampDownSec', label: string, defaultValue: number, max: number, unit?: string) =>
					this.numberField(grid, label, load[key], { min: 0, max, optional: true, placeholder: String(Math.round(defaultValue)), ...(unit ? { unit } : {}) }, store, value => void (value === undefined ? this.setLoad({}, [key]) : this.setLoad({ [key]: value })).then(() => this.refreshProfile()));
				param('baseUsers', http ? localize('voltHttp.perfBaseUsers', "Starting users") : localize('voltHttp.perfBaseConnections', "Starting connections"), shape.baseUsers, load.users);
				if (load.profile !== 'rampUp') {
					param('startSec', localize('voltHttp.perfStartAt', "Climb starts at"), shape.startSec, 30 * 60, 's');
				}
				param('rampUpSec', localize('voltHttp.perfRampUp', "Ramp up"), shape.rampUpSec, 30 * 60, 's');
				if (load.profile === 'peak') {
					param('holdSec', localize('voltHttp.perfHold', "Hold"), shape.holdSec, 30 * 60, 's');
				}
				if (load.profile !== 'rampUp') {
					param('rampDownSec', localize('voltHttp.perfRampDown', "Ramp down"), shape.rampDownSec, 30 * 60, 's');
				}
			}
		}
		if (http) {
			this.numberField(grid, localize('voltHttp.perfRps', "Requests/s cap"), load.rps, { min: 1, max: 1_000_000, optional: true, placeholder: localize('voltHttp.perfNoCap', "No cap"), hint: localize('voltHttp.perfRpsHint', "The most requests per second over all users together.") }, store, value => void (value === undefined ? this.setLoad({}, ['rps']) : this.setLoad({ rps: value })));
		}
		this.numberField(grid, localize('voltHttp.perfWarmup', "Warm-up"), load.warmupSec || undefined, { min: 0, max: 300, optional: true, placeholder: '0', unit: 's', hint: localize('voltHttp.perfWarmupHint', "Load before measuring starts: shown in the charts, left out of the numbers.") }, store, value => void this.setLoad({ warmupSec: value ?? 0 }).then(() => this.refreshProfile()));
		if (http) {
			this.numberField(grid, localize('voltHttp.perfThink', "Think time"), load.thinkMs || undefined, { min: 0, max: 600_000, optional: true, placeholder: '0', unit: 'ms', hint: localize('voltHttp.perfThinkHint', "A pause after each response before the user's next request.") }, store, value => void this.setLoad({ thinkMs: value ?? 0 }));
		}
		this.numberField(grid, http ? localize('voltHttp.perfTimeout', "Request timeout") : localize('voltHttp.perfConnectTimeout', "Connect timeout"), load.timeoutMs, { min: 50, max: 600_000, unit: 'ms' }, store, value => void this.setLoad({ timeoutMs: value ?? 10_000 }));

		const tls = append(section, $('.volt-http-perf-check-row'));
		const check = createHttpCheck(tls, !load.insecure, localize('voltHttp.perfVerifyTls', "Verify TLS certificates"), checked => void (checked ? this.setLoad({}, ['insecure']) : this.setLoad({ insecure: true })));
		const tlsLabel = append(tls, $('span'));
		tlsLabel.textContent = localize('voltHttp.perfVerifyTlsLabel', "Verify TLS certificates");
		store.add(addDisposableListener(tlsLabel, EventType.CLICK, () => check.element.click()));

		const preview = append(section, $('.volt-http-perf-preview'));
		append(preview, $('.volt-http-perf-preview-title')).textContent = byCount
			? localize('voltHttp.perfPreviewCount', "{0} users until {1} requests are answered", load.users, formatHttpPerfNumber(load.requests ?? 0))
			: localize('voltHttp.perfPreviewTitle', "{0} over time", http ? localize('voltHttp.perfUsersTitle', "Virtual users") : localize('voltHttp.perfConnectionsTitle', "Connections"));
		if (!byCount) {
			this.profileChart = store.add(new HttpLineChart(preview, {
				ariaLabel: localize('voltHttp.perfPreviewAria', "Load profile preview"),
				series: [{ id: 'users', label: http ? localize('voltHttp.perfUsersSeries', "Users") : localize('voltHttp.perfConnectionsSeries', "Connections"), color: COLORS.throughput, area: true }],
				formatY: value => formatHttpPerfNumber(value),
				formatX: value => formatHttpPerfSeconds(value),
				stepX: 1,
				height: 84,
				legend: false,
				compact: true,
			}));
			this.refreshProfile();
		}
	}

	private refreshProfile(): void {
		const load = this.file?.load;
		if (!this.profileChart || !load) {
			return;
		}
		const duration = load.durationSec ?? 30;
		const warmup = load.warmupSec;
		const points = voltLoadProfilePoints({ kind: load.profile, ...load }, load.users, duration, 160);
		const xs = [...(warmup ? [0] : []), ...points.map(([t]) => t + warmup)];
		const users = [...(warmup ? [points[0][1]] : []), ...points.map(([, value]) => value)];
		this.profileChart.setData(xs, { users }, warmup ? { to: warmup, label: localize('voltHttp.perfWarmupShade', "Warm-up") } : undefined);
	}

	private renderConnectionOptions(page: HTMLElement): void {
		const file = this.file!;
		if (file.mode === 'sse') {
			const { section } = this.section(page, localize('voltHttp.perfSse', "Event stream"));
			append(section, $('.volt-http-note')).textContent = localize('voltHttp.perfSseNote', "Each connection opens the stream and counts the events and bytes it gets. Latency is the time to the first event; a stream the server ends is opened again.");
			return;
		}
		const { section } = this.section(page, localize('voltHttp.perfWs', "Messages"), localize('voltHttp.perfWsHint', "Without a message, connections are only opened and held: the test measures connects."));
		const store = this.sectionStore;
		const messageField = append(section, $('.volt-http-perf-field.wide'));
		append(messageField, $('label')).textContent = localize('voltHttp.perfMessage', "Message");
		const message = append(messageField, $('textarea.volt-http-input.volt-http-perf-code')) as HTMLTextAreaElement;
		message.rows = 3;
		message.spellcheck = false;
		message.placeholder = '{ "type": "ping", "id": "{{$guid}}" }';
		message.value = file.ws.message;
		message.setAttribute('aria-label', localize('voltHttp.perfMessageAria', "Message sent on every connection"));
		store.add(addDisposableListener(message, EventType.CHANGE, () => void this.change(item => item.ws = { ...item.ws, message: message.value })));
		const grid = append(section, $('.volt-http-perf-grid'));
		this.numberField(grid, localize('voltHttp.perfInterval', "Send every"), file.ws.intervalMs, { min: 10, max: 600_000, unit: 'ms' }, store, value => void this.change(item => item.ws = { ...item.ws, intervalMs: value ?? 1000 }));
		const row = append(section, $('.volt-http-perf-check-row'));
		const check = createHttpCheck(row, file.ws.expectReply, localize('voltHttp.perfExpectReply', "Expect a reply"), checked => void this.change(item => item.ws = { ...item.ws, expectReply: checked }));
		const label = append(row, $('span'));
		label.textContent = localize('voltHttp.perfExpectReplyLabel', "Expect a reply: time each message to the next one that comes back (the round trip)");
		store.add(addDisposableListener(label, EventType.CLICK, () => check.element.click()));
	}

	private renderThresholds(): void {
		const parent = this.thresholdsEl;
		const file = this.file;
		if (!parent || !file) {
			return;
		}
		this.thresholdStore.clear();
		clearNode(parent);
		const store = this.thresholdStore;
		const { section, head } = this.section(parent, localize('voltHttp.perfThresholds', "Thresholds"), localize('voltHttp.perfThresholdsHint', "The run passes when every threshold holds. Latencies are in ms, the error rate in percent."));
		append(head, $('.volt-http-spacer'));
		const add = append(head, $('button.volt-http-link')) as HTMLButtonElement;
		add.type = 'button';
		add.textContent = localize('voltHttp.perfAddThreshold', "Add Threshold");
		store.add(addDisposableListener(add, EventType.CLICK, () => {
			const used = new Set(file.thresholds.map(item => item.metric));
			const metric = VOLT_LOAD_METRICS.find(item => !used.has(item)) ?? 'p99';
			const fresh: IVoltLoadThreshold = { metric, op: metric === 'rps' ? 'gte' : 'lt', value: metric === 'errorRate' ? 1 : metric === 'rps' ? 100 : 500 };
			void this.change(item => item.thresholds = [...item.thresholds, fresh]).then(() => this.renderThresholds());
		}));
		if (!file.thresholds.length) {
			append(section, $('.volt-http-perf-empty-list')).textContent = localize('voltHttp.perfNoThresholds', "No thresholds: every run passes.");
			return;
		}
		const rows = append(section, $('.volt-http-perf-thresholds'));
		file.thresholds.forEach((threshold, index) => {
			const row = append(rows, $('.volt-http-perf-threshold'));
			const replace = (next: IVoltLoadThreshold) => void this.change(item => item.thresholds = item.thresholds.map((old, at) => at === index ? next : old)).then(() => this.renderThresholds());
			createHttpDropdown<VoltLoadMetric>(row, this.contextViewService, {
				options: VOLT_LOAD_METRICS.map(metric => ({ id: metric, label: httpPerfMetricLabel(metric, file.mode) })),
				value: threshold.metric,
				ariaLabel: localize('voltHttp.perfMetricAria', "Metric"),
				onChange: metric => replace({ ...threshold, metric }),
			}, store);
			createHttpDropdown<VoltLoadOperator>(row, this.contextViewService, {
				options: VOLT_LOAD_OPERATORS.map(op => ({ id: op, label: OPERATOR_LABELS[op] })),
				value: threshold.op,
				ariaLabel: localize('voltHttp.perfOperatorAria', "Comparison"),
				onChange: op => replace({ ...threshold, op }),
			}, store);
			const wrap = append(row, $('.volt-http-perf-number'));
			const input = append(wrap, $('input.volt-http-input')) as HTMLInputElement;
			input.type = 'text';
			input.inputMode = 'decimal';
			input.value = String(threshold.value);
			input.setAttribute('aria-label', localize('voltHttp.perfThresholdValue', "Value"));
			append(wrap, $('span.volt-http-perf-unit')).textContent = threshold.metric === 'errorRate' ? '%' : threshold.metric === 'rps' ? '/s' : 'ms';
			store.add(addDisposableListener(input, EventType.KEY_DOWN, (event: KeyboardEvent) => event.key === 'Enter' && input.blur()));
			store.add(addDisposableListener(input, EventType.CHANGE, () => {
				const value = Number(input.value.replace(/[,_\s]/g, ''));
				if (Number.isFinite(value) && value >= 0) {
					replace({ ...threshold, value });
				} else {
					input.value = String(threshold.value);
				}
			}));
			createHttpIconButton(row, Codicon.close, localize('voltHttp.perfRemoveThreshold', "Remove Threshold"), () => void this.change(item => item.thresholds = item.thresholds.filter((_old, at) => at !== index)).then(() => this.renderThresholds()));
		});
	}

	/** The note on where the load goes, and what stands in the way of a run. */
	private refreshHosts(): void {
		const parent = this.hostsEl;
		if (!parent) {
			return;
		}
		const token = ++this.prepareToken;
		void this.performance.prepare(this.uri, this.host.root).then(prepared => {
			if (token !== this.prepareToken || this._store.isDisposed || !this.hostsEl) {
				return;
			}
			clearNode(parent);
			if (prepared.hosts.length) {
				const line = append(parent, $('.volt-http-perf-host-line'));
				append(line, $('span.volt-http-perf-host-icon')).appendChild(renderIcon(Codicon.radioTower));
				const text = append(line, $('span'));
				text.textContent = localize('voltHttp.perfSendsTo', "Sends load to ");
				prepared.hosts.forEach((host, index) => {
					if (index) {
						text.appendChild(text.ownerDocument.createTextNode(', '));
					}
					append(text, $('b')).textContent = host;
					const local = isHttpPerfLocalHost(host);
					const confirm = prepared.toConfirm.includes(host);
					text.appendChild(text.ownerDocument.createTextNode(` (${local ? localize('voltHttp.perfHostLocal', "this machine or a private network") : confirm ? localize('voltHttp.perfHostConfirm', "you will be asked to confirm") : localize('voltHttp.perfHostConfirmed', "confirmed")})`));
				});
			}
			for (const problem of prepared.problems) {
				const line = append(parent, $('.volt-http-perf-host-line.warn'));
				append(line, $('span.volt-http-perf-host-icon')).appendChild(renderIcon(Codicon.warning));
				append(line, $('span')).textContent = problem;
			}
		}, () => undefined);
	}

	// --- Results ---------------------------------------------------------------------------------

	private renderResults(): void {
		const file = this.file!;
		const page = append(this.body, $('.volt-http-perf-results'));
		const live = this.live;
		const running = !!live?.running;
		const run = running ? undefined : this.shownRun();
		if (!running && !run) {
			const empty = append(page, $('.volt-http-perf-empty-state'));
			append(empty, $('span.volt-http-perf-empty-icon')).appendChild(renderIcon(Codicon.dashboard));
			append(empty, $('.volt-http-perf-empty-title')).textContent = localize('voltHttp.perfNoRuns', "No runs yet");
			append(empty, $('.volt-http-note')).textContent = live?.error
				? localize('voltHttp.perfLastFailed', "The last run failed: {0}", live.error)
				: localize('voltHttp.perfNoRunsHint', "Set targets and load under Setup, then press Run. Results show live while it runs.");
			if (file.targets.length) {
				const button = this.sectionStore.add(createVoltButton(empty, 'primary'));
				button.label = localize('voltHttp.perfRunNow', "Run Test");
				this.sectionStore.add(button.onDidClick(() => void this.toggleRun()));
			}
			return;
		}
		const mode = run?.mode ?? live?.mode ?? file.mode;
		const unit = httpPerfUnit(mode);
		this.verdictEl = append(page, $('.volt-http-perf-verdict'));
		this.cardsEl = append(page, $('.volt-http-perf-cards'));
		this.aiEl = append(page, $('.volt-http-perf-ai'));
		const charts = append(page, $('.volt-http-perf-charts'));

		const throughputCard = this.chartCard(charts, mode === 'http' ? localize('voltHttp.perfChartThroughput', "Throughput and virtual users") : localize('voltHttp.perfChartThroughputStream', "{0} and connections", mode === 'ws' ? localize('voltHttp.perfMessagesTitle', "Messages") : localize('voltHttp.perfEventsTitle', "Events")));
		this.throughputChart = this.sectionStore.add(new HttpLineChart(throughputCard, {
			ariaLabel: localize('voltHttp.perfThroughputAria', "{0} and errors per second over time", unit.rate),
			series: [
				{ id: 'count', label: mode === 'ws' ? localize('voltHttp.perfReceivedSeries', "received/s") : unit.rate, color: COLORS.throughput },
				...(mode === 'ws' ? [{ id: 'sent', label: localize('voltHttp.perfSentSeries', "sent/s"), color: COLORS.sent }] : []),
				{ id: 'errors', label: localize('voltHttp.perfErrorsSeries', "errors/s"), color: COLORS.errors },
			],
			formatY: value => formatHttpPerfNumber(value),
			formatX: value => formatHttpPerfSeconds(value),
			stepX: 1,
			height: 170,
		}));
		append(throughputCard, $('.volt-http-perf-subchart-title')).textContent = mode === 'http' ? localize('voltHttp.perfActiveUsers', "Active users") : localize('voltHttp.perfOpenConnections', "Open connections");
		this.usersChart = this.sectionStore.add(new HttpLineChart(throughputCard, {
			ariaLabel: localize('voltHttp.perfUsersAria', "Active users over time"),
			series: [{ id: 'users', label: localize('voltHttp.perfUsersLabel', "users"), color: COLORS.users, area: true }],
			formatY: value => formatHttpPerfNumber(value),
			formatX: value => formatHttpPerfSeconds(value),
			stepX: 1,
			height: 70,
			legend: false,
			step: true,
			compact: true,
			minMax: 1,
		}));
		const latencyCard = this.chartCard(charts, localize('voltHttp.perfChartLatency', "{0} over time", httpPerfLatencyLabel(mode)));
		this.latencyChart = this.sectionStore.add(new HttpLineChart(latencyCard, {
			ariaLabel: localize('voltHttp.perfLatencyAria', "Latency percentiles per second over time"),
			series: [
				{ id: 'mean', label: localize('voltHttp.perfMean', "mean"), color: COLORS.mean, dashed: true },
				{ id: 'p50', label: 'p50', color: COLORS.p50 },
				{ id: 'p95', label: 'p95', color: COLORS.p95 },
				{ id: 'p99', label: 'p99', color: COLORS.p99 },
			],
			formatY: value => formatHttpPerfMs(value),
			formatX: value => formatHttpPerfSeconds(value),
			stepX: 1,
			height: 252,
		}));
		if (run) {
			this.renderDistribution(charts, run);
		}

		this.updateLive();
		if (run) {
			this.renderTables(page, run);
		} else {
			append(page, $('.volt-http-note.volt-http-perf-live-note')).textContent = localize('voltHttp.perfLiveNote', "While the test runs, the numbers are per second and the percentiles approximate. The distribution, status codes and tables come when it ends.");
		}
		this.renderAi();
	}

	private chartCard(parent: HTMLElement, title: string): HTMLElement {
		const card = append(parent, $('.volt-http-perf-chart-card'));
		append(card, $('.volt-http-perf-chart-title')).textContent = title;
		return card;
	}

	/** The parts of Results that follow a run as it goes (and draw a finished one). */
	private updateLive(): void {
		const live = this.live;
		const running = !!live?.running;
		const run = running ? undefined : this.shownRun();
		const file = this.file;
		if (!file || !this.cardsEl || !this.verdictEl) {
			return;
		}
		const mode = run?.mode ?? live?.mode ?? file.mode;
		const unit = httpPerfUnit(mode);
		const previous = running ? file.runs[0] : this.previousOf(run);
		const series = run ? run.series : live?.samples ?? [];
		const warmup = run ? run.config.warmupSec : live?.warmupSec ?? 0;

		// Verdict
		const verdict = this.verdictEl;
		clearNode(verdict);
		const pill = append(verdict, $('span.volt-http-pill'));
		if (running) {
			pill.classList.add('info');
			pill.textContent = live?.stopping ? localize('voltHttp.perfPillStopping', "Stopping") : localize('voltHttp.perfPillRunning', "Running");
		} else if (run) {
			pill.classList.add(run.verdict.passed ? 'ok' : 'error');
			pill.textContent = run.verdict.passed ? localize('voltHttp.perfPassed', "Passed") : localize('voltHttp.perfFailed', "Failed");
		}
		const meta = append(verdict, $('span.volt-http-perf-verdict-meta'));
		if (run) {
			meta.textContent = [
				new Date(run.startedAt).toLocaleString(),
				`${run.config.users} ${mode === 'http' ? localize('voltHttp.perfUsersWord2', "users") : localize('voltHttp.perfConnectionsWord2', "connections")}`,
				PROFILE_LABELS[run.config.profile],
				localize('voltHttp.perfMeasured', "{0} measured", formatHttpPerfSeconds(run.measuredSec)),
				...(run.ended === 'stopped' ? [localize('voltHttp.perfStoppedEarly', "stopped early")] : []),
				...(run.config.by === 'agent' ? [localize('voltHttp.perfByAgent', "run by an agent")] : []),
			].join(DOT);
		} else if (live) {
			meta.textContent = [`${live.config.users} ${mode === 'http' ? localize('voltHttp.perfUsersWord3', "users") : localize('voltHttp.perfConnectionsWord3', "connections")}`, PROFILE_LABELS[live.config.profile]].join(DOT);
		}
		if (run && (this.file?.runs.length ?? 0) > 1) {
			append(verdict, $('.volt-http-spacer'));
			const runs = this.file!.runs;
			createHttpDropdown<string>(verdict, this.contextViewService, {
				options: runs.map((item, index) => ({ id: item.id, label: index === 0 ? localize('voltHttp.perfLatestRun', "Latest run") : fromNow(item.startedAt, true), description: `${new Date(item.startedAt).toLocaleString()}${DOT}${item.verdict.passed ? localize('voltHttp.perfPassed2', "Passed") : localize('voltHttp.perfFailed2', "Failed")}` })),
				value: run.id,
				ariaLabel: localize('voltHttp.perfPickRun', "Run shown"),
				align: 'right',
				onChange: id => {
					this.state.memory.runId = id;
					this.renderTab();
				},
			}, this.sectionStore);
		}
		if (run?.verdict.results.length) {
			const checks = append(verdict, $('.volt-http-perf-checks'));
			for (const result of run.verdict.results) {
				const chip = append(checks, $('span.volt-http-perf-check'));
				chip.classList.add(result.passed ? 'pass' : 'fail');
				append(chip, $('span.volt-http-ico')).appendChild(renderIcon(result.passed ? Codicon.check : Codicon.close));
				append(chip, $('span')).textContent = `${httpPerfThresholdText(result.threshold, mode)}${DOT}${formatHttpPerfMetric(result.threshold.metric, result.actual)}`;
				setAgentTooltip(chip, result.passed ? localize('voltHttp.perfThresholdHeld', "Held") : localize('voltHttp.perfThresholdMissed', "Missed"));
			}
		}

		// Cards
		const cards = this.cardsEl;
		clearNode(cards);
		const deltas = run && previous ? compareHttpPerfRuns(previous, run) : [];
		const numbers = run ? undefined : httpPerfLiveNumbers(live?.samples ?? []);
		const card = (label: string, value: string, key?: HttpPerfCompareKey, title?: string) => {
			const element = append(cards, $('.volt-http-perf-card'));
			append(element, $('.volt-http-perf-card-label')).textContent = label;
			append(element, $('.volt-http-perf-card-value')).textContent = value;
			const delta = key ? deltas.find(item => item.key === key) : undefined;
			const deltaEl = append(element, $('.volt-http-perf-card-delta'));
			this.renderDelta(deltaEl, delta);
			if (title) {
				setAgentTooltip(element, title);
			}
		};
		// WebSocket and SSE times are not request latency: name them after what they measure.
		const what = mode === 'ws' ? localize('voltHttp.perfRoundTrip', "Round trip") : mode === 'sse' ? localize('voltHttp.perfFirstEvent', "First event") : undefined;
		const meanLabel = what ? localize('voltHttp.perfCardWhatMean', "{0}, mean", what) : localize('voltHttp.perfCardMean', "Mean");
		const pLabel = (p: string) => what ? `${what} ${p}` : p;
		const latencyTitle = httpPerfLatencyLabel(mode);
		if (run) {
			const p = voltLoadPercentiles(run.latency);
			card(`${unit.many[0].toUpperCase()}${unit.many.slice(1)}/s`, formatHttpPerfNumber(run.rate), 'rps');
			card(meanLabel, formatHttpPerfMs(p.mean), 'mean', latencyTitle);
			card(pLabel('p95'), formatHttpPerfMs(p.p95), 'p95', latencyTitle);
			card(pLabel('p99'), formatHttpPerfMs(p.p99), 'p99', latencyTitle);
			card(localize('voltHttp.perfCardErrors', "Error rate"), formatHttpPerfPercent(run.metrics.errorRate), 'errorRate', mode === 'http' ? localize('voltHttp.perfErrorsTitle', "{0} network errors, {1} 4xx/5xx responses", run.errors, run.httpErrors) : localize('voltHttp.perfConnectErrorsTitle', "{0} of {1} connects failed", run.connectFailures, run.connects + run.connectFailures));
			card(localize('voltHttp.perfCardTotal', "Total {0}", unit.many), formatHttpPerfNumber(run.count), 'count');
			card(localize('voltHttp.perfCardReceived', "Data received"), formatHttpPerfBytes(run.bytesIn), 'bytesIn');
			card(mode === 'http' ? localize('voltHttp.perfCardPeak', "Peak users") : localize('voltHttp.perfCardPeakConn', "Peak connections"), String(run.peakUsers), 'peakUsers');
		} else if (numbers) {
			card(`${unit.many[0].toUpperCase()}${unit.many.slice(1)}/s`, formatHttpPerfNumber(numbers.rate));
			card(meanLabel, formatHttpPerfMs(numbers.mean), undefined, latencyTitle);
			card(pLabel('p95'), formatHttpPerfMs(numbers.p95), undefined, localize('voltHttp.perfApprox', "Approximate until the run ends"));
			card(pLabel('p99'), formatHttpPerfMs(numbers.p99), undefined, localize('voltHttp.perfApprox2', "Approximate until the run ends"));
			card(localize('voltHttp.perfCardErrors2', "Error rate"), formatHttpPerfPercent(numbers.errorRate));
			card(localize('voltHttp.perfCardTotal2', "Total {0}", unit.many), formatHttpPerfNumber(numbers.count));
			card(localize('voltHttp.perfCardReceived2', "Data received"), formatHttpPerfBytes(numbers.bytesIn));
			card(mode === 'http' ? localize('voltHttp.perfCardPeak2', "Peak users") : localize('voltHttp.perfCardPeakConn2', "Peak connections"), String(numbers.peakUsers));
		}

		// Charts
		const xs = series.map(sample => sample.t);
		const shade = warmup ? { to: warmup, label: localize('voltHttp.perfWarmupShade2', "Warm-up") } : undefined;
		this.throughputChart?.setData(xs, {
			count: series.map(sample => sample.count),
			sent: series.map(sample => sample.sent ?? 0),
			errors: series.map(sample => sample.errors),
		}, shade);
		this.usersChart?.setData(xs, { users: series.map(sample => sample.users) }, shade);
		this.latencyChart?.setData(xs, {
			mean: series.map(sample => sample.mean),
			p50: series.map(sample => sample.p50),
			p95: series.map(sample => sample.p95),
			p99: series.map(sample => sample.p99),
		}, shade);
	}

	private renderDelta(parent: HTMLElement, delta: IHttpPerfDelta | undefined): void {
		if (!delta || delta.percent === undefined) {
			// Nothing to compare with: an empty cell, and a card without the line (its :empty rule).
			parent.textContent = '';
			return;
		}
		if (delta.better === undefined) {
			parent.textContent = localize('voltHttp.perfDeltaSame', "{0}{1}% vs previous", delta.percent >= 0 ? '+' : '', delta.percent.toFixed(1));
			parent.classList.add('same');
			return;
		}
		parent.classList.add(delta.better ? 'better' : 'worse');
		append(parent, $('span.volt-http-ico')).appendChild(renderIcon(delta.delta >= 0 ? Codicon.arrowUp : Codicon.arrowDown));
		append(parent, $('span')).textContent = `${Math.abs(delta.percent).toFixed(1)}%`;
		setAgentTooltip(parent, delta.better ? localize('voltHttp.perfDeltaBetter', "Better than the run before ({0})", formatHttpPerfNumber(delta.before)) : localize('voltHttp.perfDeltaWorse', "Worse than the run before ({0})", formatHttpPerfNumber(delta.before)));
	}

	private renderDistribution(charts: HTMLElement, run: IHttpPerfRun): void {
		const histogram = VoltLoadHistogram.from(run.latency);
		const bins = httpPerfHistogramBins(histogram, 36);
		const distribution = this.chartCard(charts, localize('voltHttp.perfChartDistribution', "{0} distribution", httpPerfLatencyLabel(run.mode)));
		if (bins.length) {
			const p = voltLoadPercentiles(histogram);
			const chart = this.sectionStore.add(new HttpHistogramChart(distribution, {
				ariaLabel: localize('voltHttp.perfDistributionAria', "How many answers took how long, on a log scale; p50 {0}, p95 {1}, p99 {2}", formatHttpPerfMs(p.p50), formatHttpPerfMs(p.p95), formatHttpPerfMs(p.p99)),
				formatX: value => formatHttpPerfMs(value),
				color: COLORS.histogram,
				height: 190,
			}));
			chart.setData(bins, [{ label: 'p50', value: p.p50 }, { label: 'p95', value: p.p95 }, { label: 'p99', value: p.p99 }]);
		} else {
			append(distribution, $('.volt-http-perf-empty-list')).textContent = localize('voltHttp.perfNoLatency', "Nothing was measured.");
		}

		const parts = this.chartCard(charts, run.mode === 'http' ? localize('voltHttp.perfChartStatus', "Status codes") : localize('voltHttp.perfChartConnections', "Connections"));
		if (run.mode === 'http') {
			const classes = httpPerfStatusClasses(run.statusCodes);
			const errors = Object.values(run.errorKinds).reduce((sum, count) => sum + (count ?? 0), 0);
			renderHttpStackedBar(parts, [
				{ label: '2xx', count: classes['2xx'], color: COLORS['2xx'] },
				{ label: '3xx', count: classes['3xx'], color: COLORS['3xx'] },
				{ label: '4xx', count: classes['4xx'], color: COLORS['4xx'] },
				{ label: '5xx', count: classes['5xx'], color: COLORS['5xx'] },
				{ label: localize('voltHttp.perfOtherStatus', "Other"), count: classes.other, color: COLORS.other },
				{ label: localize('voltHttp.perfNoResponse', "No response"), count: errors, color: COLORS.other },
			], localize('voltHttp.perfStatusAria', "Status codes"));
			const codes = Object.entries(run.statusCodes).sort((a, b) => b[1] - a[1]);
			if (codes.length) {
				append(parts, $('.volt-http-note.volt-http-perf-codes')).textContent = codes.slice(0, 8).map(([code, count]) => `${code} x${formatHttpPerfNumber(count)}`).join(DOT);
			}
		} else {
			renderHttpStackedBar(parts, [
				{ label: localize('voltHttp.perfOpened', "Opened"), count: Math.max(0, run.connects - run.closes), color: COLORS['2xx'] },
				{ label: localize('voltHttp.perfClosedByServer', "Closed by server"), count: run.closes, color: COLORS['4xx'] },
				{ label: localize('voltHttp.perfFailedConnects', "Failed"), count: run.connectFailures, color: COLORS['5xx'] },
			], localize('voltHttp.perfConnectionsAria', "Connections"));
			append(parts, $('.volt-http-note.volt-http-perf-codes')).textContent = [
				localize('voltHttp.perfConnectsText', "{0} connects", run.connects),
				localize('voltHttp.perfReconnectsText', "{0} reconnects", run.reconnects),
				...(run.mode === 'ws' ? [localize('voltHttp.perfSentText', "{0} messages sent", formatHttpPerfNumber(run.sent))] : []),
			].join(DOT);
		}
	}

	private table(parent: HTMLElement, title: string, head: readonly string[], rows: readonly (readonly string[])[], numericFrom = 1): void {
		const section = append(parent, $('.volt-http-perf-table-section'));
		append(section, $('.volt-http-perf-section-title')).textContent = title;
		const scroll = append(section, $('.volt-http-perf-table-scroll'));
		const table = append(scroll, $('table.volt-http-perf-table'));
		const headRow = append(append(table, $('thead')), $('tr'));
		head.forEach((cell, index) => {
			const th = append(headRow, $('th'));
			th.textContent = cell;
			th.classList.toggle('num', index >= numericFrom);
		});
		const body = append(table, $('tbody'));
		for (const row of rows) {
			const tr = append(body, $('tr'));
			row.forEach((cell, index) => {
				const td = append(tr, $('td'));
				td.textContent = cell;
				td.classList.toggle('num', index >= numericFrom);
				if (index < numericFrom) {
					setAgentTooltip(td, cell);
				}
			});
		}
	}

	private renderTables(page: HTMLElement, run: IHttpPerfRun): void {
		const unit = httpPerfUnit(run.mode);
		const tables = append(page, $('.volt-http-perf-tables'));
		const p = voltLoadPercentiles(run.latency);
		const grid = append(tables, $('.volt-http-perf-table-section'));
		append(grid, $('.volt-http-perf-section-title')).textContent = localize('voltHttp.perfPercentiles', "{0} percentiles", httpPerfLatencyLabel(run.mode));
		const stats = append(grid, $('.volt-http-perf-stats'));
		for (const [label, value] of [['min', p.min], ['p50', p.p50], ['p75', p.p75], ['p90', p.p90], ['p95', p.p95], ['p97.5', p.p975], ['p99', p.p99], ['p99.9', p.p999], ['max', p.max], ['mean', p.mean], ['stddev', p.stddev]] as const) {
			const cell = append(stats, $('.volt-http-perf-stat'));
			append(cell, $('span.volt-http-perf-stat-label')).textContent = label;
			append(cell, $('span.volt-http-perf-stat-value')).textContent = formatHttpPerfMs(value);
		}
		if (run.targets.length) {
			this.table(tables, localize('voltHttp.perfPerTarget', "Per target"), [localize('voltHttp.perfColTarget', "Target"), unit.many, localize('voltHttp.perfColErrors', "Errors"), 'p50', 'p95', 'p99', localize('voltHttp.perfColReceived', "Received")], run.targets.map(target => {
				const tp = voltLoadPercentiles(target.latency);
				return [`${run.mode === 'http' ? `${target.method} ` : ''}${target.name}`, formatHttpPerfNumber(target.count), formatHttpPerfNumber(target.errors), formatHttpPerfMs(tp.p50), formatHttpPerfMs(tp.p95), formatHttpPerfMs(tp.p99), formatHttpPerfBytes(target.bytesIn)];
			}));
		}
		const kinds = Object.entries(run.errorKinds).filter(([, count]) => count);
		if (kinds.length || run.httpErrors) {
			const total = run.mode === 'http' ? run.count : run.connects + run.connectFailures;
			const rows = kinds.map(([kind, count]) => [httpPerfErrorKindLabel(kind as VoltLoadErrorKind), formatHttpPerfNumber(count ?? 0), total ? formatHttpPerfPercent((count ?? 0) / total * 100) : '-']);
			if (run.httpErrors) {
				rows.push([localize('voltHttp.perfHttpErrors', "4xx and 5xx responses"), formatHttpPerfNumber(run.httpErrors), total ? formatHttpPerfPercent(run.httpErrors / total * 100) : '-']);
			}
			this.table(tables, localize('voltHttp.perfErrorsByKind', "Errors by kind"), [localize('voltHttp.perfColKind', "Kind"), localize('voltHttp.perfColCount', "Count"), localize('voltHttp.perfColShare', "Share")], rows);
		}
		const phases = HTTP_PERF_PHASES.filter(phase => run[phase.key]?.n);
		if (phases.length) {
			this.table(tables, localize('voltHttp.perfPhases', "Timing phases"), [localize('voltHttp.perfColPhase', "Phase"), localize('voltHttp.perfColSamples', "Samples"), 'p50', 'p95', 'p99', 'max'], phases.map(phase => {
				const pp = voltLoadPercentiles(run[phase.key]);
				return [phase.label, formatHttpPerfNumber(pp.count), formatHttpPerfMs(pp.p50), formatHttpPerfMs(pp.p95), formatHttpPerfMs(pp.p99), formatHttpPerfMs(pp.max)];
			}));
			append(tables, $('.volt-http-note')).textContent = localize('voltHttp.perfPhasesNote', "DNS, TCP and TLS are measured on new connections only: kept-alive connections skip them.");
		}
		append(tables, $('.volt-http-note.volt-http-perf-sent')).textContent = localize('voltHttp.perfDataLine', "{0} received, {1} sent", formatHttpPerfBytes(run.bytesIn), formatHttpPerfBytes(run.bytesOut));
	}

	// --- Analysis --------------------------------------------------------------------------------

	private startAnalysis(): void {
		this.state.memory.aiOpen = true;
		if (this.tab !== 'results') {
			this.setTab('results');
		}
		if (!this.aiRun.value) {
			void this.runAnalysis();
		} else {
			this.renderAi();
		}
	}

	private renderAi(): void {
		const parent = this.aiEl;
		if (!parent) {
			return;
		}
		const run = this.live?.running ? undefined : this.shownRun();
		const saved = run?.analysis;
		const open = this.state.memory.aiOpen === true;
		if (!open && !saved) {
			this.aiStore.clear();
			clearNode(parent);
			parent.classList.add('hidden');
			return;
		}
		parent.classList.remove('hidden');
		const store = this.aiStore;
		store.clear();
		clearNode(parent);
		const running = !!this.aiRun.value;
		const head = append(parent, $('.volt-http-perf-ai-head'));
		append(head, $('span.volt-http-perf-ai-icon')).appendChild(renderIcon(Codicon.lightbulb));
		append(head, $('span.volt-http-perf-ai-title')).textContent = localize('voltHttp.perfAiTitle', "Assessment");
		const elapsed = append(head, $('span.volt-http-note.volt-http-perf-ai-elapsed'));
		append(head, $('.volt-http-spacer'));
		this.modelButton(head, store);
		const button = store.add(createVoltButton(head, running ? 'secondary' : 'ghost'));
		button.label = running ? localize('voltHttp.perfAiCancel', "Cancel") : (saved || this.state.memory.aiAnswer ? localize('voltHttp.perfAiAgain', "Analyze Again") : localize('voltHttp.perfAiRun', "Analyze"));
		store.add(button.onDidClick(() => running ? this.aiRun.clear() : void this.runAnalysis()));
		createHttpIconButton(head, Codicon.close, localize('voltHttp.perfAiClose', "Close"), () => {
			this.aiRun.clear();
			this.state.memory.aiOpen = false;
			this.state.memory.aiAnswer = undefined;
			this.state.memory.aiError = undefined;
			parent.classList.add('hidden');
			clearNode(parent);
		});
		if (running) {
			const started = typeof this.state.memory.aiStarted === 'number' ? this.state.memory.aiStarted : Date.now();
			const tick = () => elapsed.textContent = formatHttpPerfSeconds((Date.now() - started) / 1000);
			tick();
			const targetWindow = getWindow(parent);
			const timer = targetWindow.setInterval(tick, 1000);
			store.add(toDisposable(() => targetWindow.clearInterval(timer)));
		} else if (saved && !this.state.memory.aiAnswer) {
			elapsed.textContent = `${saved.model}${DOT}${fromNow(saved.at, true)}`;
		}
		const error = this.state.memory.aiError;
		if (typeof error === 'string' && error) {
			append(parent, $('.volt-http-perf-ai-error')).textContent = error;
		}
		const answer = typeof this.state.memory.aiAnswer === 'string' && this.state.memory.aiAnswer ? this.state.memory.aiAnswer : saved?.text ?? '';
		const text = append(parent, $('.volt-http-perf-ai-text'));
		// allow-any-unicode-next-line
		renderHttpAiAnswer(text, answer, running ? localize('voltHttp.perfAiWorking', "Reading the numbers…") : '');
		if (answer && !running) {
			createHttpIconButton(head, Codicon.copy, localize('voltHttp.perfAiCopy', "Copy Assessment"), () => void this.clipboardService.writeText(answer));
		}
	}

	private modelRef(): string | undefined {
		return httpAiModelRef(this.instantiationService);
	}

	/** The button that shows and picks the model. */
	private modelButton(parent: HTMLElement, store: DisposableStore): void {
		createHttpAiModelButton(parent, this.instantiationService, store, localize('voltHttp.perfAiModel', "The model that reads the results"), AnchorAlignment.RIGHT);
	}

	private async runAnalysis(): Promise<void> {
		const file = this.file;
		const run = this.live?.running ? undefined : this.shownRun();
		this.state.memory.aiAnswer = '';
		this.state.memory.aiError = undefined;
		if (!file || !run) {
			this.state.memory.aiError = localize('voltHttp.perfAiNothing', "There is no finished run to analyze. Run the test first.");
			this.renderAi();
			return;
		}
		const ref = this.modelRef();
		if (!ref) {
			this.state.memory.aiError = localize('voltHttp.perfAiNoModel', "No model is set up. Add one in Settings, Providers & Models.");
			this.renderAi();
			return;
		}
		const cancel = new CancellationTokenSource();
		const timer = setTimeout(() => cancel.cancel(), AI_TIMEOUT_MS);
		this.aiRun.value = toDisposable(() => {
			clearTimeout(timer);
			cancel.dispose(true);
		});
		this.state.memory.aiStarted = Date.now();
		this.renderAi();
		const prompt = httpPerfAnalysisPrompt(file, run, this.previousOf(run));
		let answer = '';
		let failure: string | undefined;
		const show = () => {
			this.state.memory.aiAnswer = answer;
			const text = this.aiEl?.querySelector<HTMLElement>('.volt-http-perf-ai-text');
			if (text) {
				renderHttpAiAnswer(text, answer);
			}
		};
		const label = this.runtime.resolveCatalogItem(ref)?.label ?? ref;
		try {
			if (this.runtime.resolveCatalogItem(ref)?.kind === 'agent') {
				const text = await raceCancellation(this.runtime.generateText(prompt, { ref, systemPrompt: HTTP_PERF_ANALYSIS_SYSTEM_PROMPT, timeoutMs: AI_TIMEOUT_MS - 5000 }), cancel.token);
				if (text === undefined && !cancel.token.isCancellationRequested) {
					failure = localize('voltHttp.perfAiAgentFailed', "{0} did not answer. Check that it is signed in, or pick another model.", label);
				}
				answer = text ?? '';
				show();
			} else {
				for await (const event of this.runtime.streamModel(ref, [{ role: 'system', content: HTTP_PERF_ANALYSIS_SYSTEM_PROMPT }, { role: 'user', content: prompt }], this.runtime.getModelOptions(ref), cancel.token, 'code')) {
					if (cancel.token.isCancellationRequested) {
						break;
					}
					if (event.type === 'text.delta' && event.delta) {
						answer += event.delta;
						show();
					} else if (event.type === 'error') {
						failure = event.message;
						break;
					}
				}
			}
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err);
		}
		const cancelled = cancel.token.isCancellationRequested;
		this.aiRun.clear();
		if (this._store.isDisposed) {
			return;
		}
		if (failure) {
			this.state.memory.aiError = failure;
		} else if (cancelled && !answer) {
			this.state.memory.aiError = localize('voltHttp.perfAiCancelled', "Cancelled.");
		} else if (answer.trim() && !cancelled) {
			await this.performance.setAnalysis(this.uri, run.id, { text: answer.trim(), model: label }).catch(() => undefined);
		}
		this.renderAi();
	}

	// --- History ---------------------------------------------------------------------------------

	private renderHistory(): void {
		const file = this.file!;
		const page = append(this.body, $('.volt-http-perf-history'));
		if (!file.runs.length) {
			const empty = append(page, $('.volt-http-perf-empty-state'));
			append(empty, $('span.volt-http-perf-empty-icon')).appendChild(renderIcon(Codicon.history));
			append(empty, $('.volt-http-perf-empty-title')).textContent = localize('voltHttp.perfNoHistory', "No runs yet");
			append(empty, $('.volt-http-note')).textContent = localize('voltHttp.perfNoHistoryHint', "The last ten runs are kept in the test's file. Select two to compare them.");
			return;
		}
		append(page, $('.volt-http-note.volt-http-perf-history-hint')).textContent = localize('voltHttp.perfHistoryHint', "Select a run to see it, or two (Cmd or Ctrl click) to compare them.");
		this.runHost = append(page, $('.volt-http-perf-list.volt-http-perf-run-list'));
		const renderer: IListRenderer<IHttpPerfRun, IRunTemplate> = {
			templateId: 'run',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-perf-run-row'));
				const top = append(row, $('.volt-http-perf-run-top'));
				const verdict = append(top, $('span.volt-http-perf-run-verdict'));
				const date = append(top, $('span.volt-http-perf-run-date'));
				const by = append(top, $('span.volt-http-perf-run-by'));
				const facts = append(row, $('.volt-http-perf-run-facts'));
				return { verdict, date, by, facts };
			},
			renderElement: (run, _index, template) => {
				template.verdict.className = `volt-http-perf-run-verdict ${run.verdict.passed ? 'pass' : 'fail'}`;
				clearNode(template.verdict);
				template.verdict.appendChild(renderIcon(run.verdict.passed ? Codicon.passFilled : Codicon.error));
				append(template.verdict, $('span')).textContent = run.verdict.passed ? localize('voltHttp.perfPassed3', "Passed") : localize('voltHttp.perfFailed3', "Failed");
				template.date.textContent = `${new Date(run.startedAt).toLocaleString()}${DOT}${fromNow(run.startedAt, true)}`;
				template.by.textContent = [run.ended === 'stopped' ? localize('voltHttp.perfStoppedShort', "stopped") : '', run.config.by === 'agent' ? localize('voltHttp.perfAgentShort', "agent") : ''].filter(Boolean).join(DOT);
				const unit = httpPerfUnit(run.mode);
				template.facts.textContent = [
					`${run.config.users} ${run.mode === 'http' ? localize('voltHttp.perfUsersWord4', "users") : localize('voltHttp.perfConnectionsWord4', "connections")}`,
					formatHttpPerfSeconds(run.measuredSec),
					`${formatHttpPerfNumber(run.rate)} ${unit.rate}`,
					`p95 ${formatHttpPerfMs(run.metrics.p95)}`,
					localize('voltHttp.perfErrorsFact', "{0} errors", formatHttpPerfPercent(run.metrics.errorRate)),
				].join(DOT);
			},
			disposeTemplate: () => { },
		};
		const list = this.runList = this.view.add(this.instantiationService.createInstance(WorkbenchList<IHttpPerfRun>, 'VoltHttpPerfRuns', this.runHost, { getHeight: () => RUN_ROW, getTemplateId: () => 'run' }, [renderer], {
			accessibilityProvider: {
				getAriaLabel: run => `${run.verdict.passed ? 'Passed' : 'Failed'}, ${new Date(run.startedAt).toLocaleString()}, ${formatHttpPerfNumber(run.rate)} per second, p95 ${formatHttpPerfMs(run.metrics.p95)}, ${formatHttpPerfPercent(run.metrics.errorRate)} errors`,
				getWidgetAriaLabel: () => localize('voltHttp.perfRunsAria', "Runs"),
			},
			multipleSelectionSupport: true,
			// A click selects (one run's summary, two compared); a double click shows it in Results.
			openOnSingleClick: false,
			identityProvider: { getId: run => run.id },
			alwaysConsumeMouseWheel: false,
		}));
		this.view.add(list.onDidChangeSelection(event => {
			// Cleared by the list being replaced, not by the user: keep the runs picked to compare.
			if (!event.elements.length && !event.browserEvent) {
				return;
			}
			this.state.memory.historySelection = event.elements.map(run => run.id);
			this.renderCompare();
		}));
		this.view.add(list.onDidOpen(event => {
			if (event.element) {
				this.state.memory.runId = event.element.id;
				this.setTab('results');
			}
		}));
		list.splice(0, 0, file.runs);
		const remembered = Array.isArray(this.state.memory.historySelection) ? this.state.memory.historySelection as string[] : [];
		const indexes = remembered.map(id => file.runs.findIndex(run => run.id === id)).filter(index => index >= 0);
		if (indexes.length) {
			list.setSelection(indexes);
			list.setFocus([indexes[0]]);
		}
		this.compareEl = append(page, $('.volt-http-perf-compare'));
		this.renderCompare();
	}

	private renderCompare(): void {
		const parent = this.compareEl;
		const file = this.file;
		if (!parent || !file) {
			return;
		}
		this.compareStore.clear();
		clearNode(parent);
		const ids = Array.isArray(this.state.memory.historySelection) ? this.state.memory.historySelection as string[] : [];
		const picked = ids.map(id => file.runs.find(run => run.id === id)).filter((run): run is IHttpPerfRun => !!run).sort((a, b) => a.startedAt - b.startedAt);
		if (!picked.length) {
			return;
		}
		if (picked.length === 1) {
			const run = picked[0];
			const head = append(parent, $('.volt-http-perf-compare-head'));
			append(head, $('.volt-http-perf-section-title')).textContent = new Date(run.startedAt).toLocaleString();
			append(head, $('.volt-http-spacer'));
			const open = this.compareStore.add(createVoltButton(head, 'secondary'));
			open.label = localize('voltHttp.perfShowRun', "Show in Results");
			this.compareStore.add(open.onDidClick(() => {
				this.state.memory.runId = run.id;
				this.setTab('results');
			}));
			append(parent, $('pre.volt-http-perf-run-text')).textContent = httpPerfRunText(file, run);
			return;
		}
		const [before, after] = [picked[0], picked[picked.length - 1]];
		const head = append(parent, $('.volt-http-perf-compare-head'));
		append(head, $('.volt-http-perf-section-title')).textContent = localize('voltHttp.perfCompareTitle', "{0} compared with {1}", fromNow(after.startedAt, true), fromNow(before.startedAt, true));
		if (picked.length > 2) {
			append(parent, $('.volt-http-note')).textContent = localize('voltHttp.perfCompareTwo', "The oldest and the newest of the selected runs are compared.");
		}
		const labels: Readonly<Record<HttpPerfCompareKey, string>> = {
			rps: localize('voltHttp.perfCmpRps', "{0}/s", httpPerfUnit(after.mode).many), mean: localize('voltHttp.perfCmpMean', "Mean"), p50: 'p50', p95: 'p95', p99: 'p99', max: localize('voltHttp.perfCmpMax', "Max"),
			errorRate: localize('voltHttp.perfCmpErrors', "Error rate"), count: localize('voltHttp.perfCmpCount', "Total"), bytesIn: localize('voltHttp.perfCmpBytes', "Data received"), peakUsers: localize('voltHttp.perfCmpPeak', "Peak users"),
		};
		const format = (key: HttpPerfCompareKey, value: number) => key === 'rps' || key === 'count' || key === 'peakUsers' ? formatHttpPerfNumber(value) : key === 'errorRate' ? formatHttpPerfPercent(value) : key === 'bytesIn' ? formatHttpPerfBytes(value) : formatHttpPerfMs(value);
		const section = append(parent, $('.volt-http-perf-table-scroll'));
		const table = append(section, $('table.volt-http-perf-table.compare'));
		const headRow = append(append(table, $('thead')), $('tr'));
		for (const [index, cell] of [localize('voltHttp.perfColMetric', "Metric"), new Date(before.startedAt).toLocaleString(), new Date(after.startedAt).toLocaleString(), localize('voltHttp.perfColChange', "Change")].entries()) {
			const th = append(headRow, $('th'));
			th.textContent = cell;
			th.classList.toggle('num', index > 0);
		}
		const body = append(table, $('tbody'));
		for (const delta of compareHttpPerfRuns(before, after)) {
			const tr = append(body, $('tr'));
			append(tr, $('td')).textContent = labels[delta.key];
			const a = append(tr, $('td.num'));
			a.textContent = format(delta.key, delta.before);
			const b = append(tr, $('td.num'));
			b.textContent = format(delta.key, delta.after);
			const change = append(tr, $('td.num.volt-http-perf-card-delta'));
			this.renderDelta(change, delta);
		}
		// The verdicts side by side.
		append(parent, $('.volt-http-note')).textContent = localize('voltHttp.perfCompareVerdicts', "Before: {0}. After: {1}.", before.verdict.passed ? localize('voltHttp.perfPassed4', "passed") : localize('voltHttp.perfFailed4', "failed"), after.verdict.passed ? localize('voltHttp.perfPassed5', "passed") : localize('voltHttp.perfFailed5', "failed"));
	}
}
