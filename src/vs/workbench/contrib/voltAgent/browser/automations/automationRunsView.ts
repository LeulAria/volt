/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { activeFilterCount, AutomationRunStatus, filterRuns, formatDuration, IAutomationRun, IAutomationService, isActiveRun, runDuration, runStats } from '../../../../services/voltRuntime/common/automations/automations.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { OPEN_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';
import { IMutableRunFilter, newRunFilter, runToolLabel, showRunFilterMenu, statusLabel } from './automationFilterMenu.js';
import { formatScheduleWhen } from './automationFormat.js';
import { providerIcon, statusIcon, toolKindIcon } from './automationIcons.js';
import { IAutomationsHost, IAutomationsPage } from './automationRoutes.js';
import { breadcrumb, button, iconButton } from './automationUi.js';

interface IRunRow extends IAutomationRun {
	readonly automationId: string;
	readonly automationName: string;
}

const ROWS_SHOWN = 200;

function runStatusLabel(status: AutomationRunStatus): string {
	switch (status) {
		case 'queued': return localize('voltAutomations.queuedStatus', "Queued");
		case 'cancelled': return localize('voltAutomations.stopped', "Stopped");
		default: return statusLabel(status);
	}
}

/**
 * Run History: search and filter (status, trigger, tools) beside the tabs, four counters, and the
 * runs table. One automation's runs, or every automation's (All Runs). Redraws are batched; a
 * running run's duration ticks once a second, and only while one is running.
 */
export class RunHistoryPanel extends Disposable {

	private readonly filter: IMutableRunFilter = newRunFilter();
	private readonly stats: HTMLElement;
	private readonly table: HTMLElement;
	private readonly badge: HTMLElement;
	private readonly searchBox: HTMLInputElement;
	private readonly rowStore = this._register(new DisposableStore());
	private readonly redraw = this._register(new RunOnceScheduler(() => this.render(), 60));
	private readonly ticker = this._register(new MutableDisposable());

	constructor(
		toolbar: HTMLElement,
		parent: HTMLElement,
		private readonly automationId: string | undefined,
		private readonly onLayout: () => void,
		@IAutomationService private readonly automations: IAutomationService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService contextView: IContextViewService,
	) {
		super();
		const store = this._register(new DisposableStore());
		const tools = append(toolbar, $('.volt-auto-run-tools'));
		this.searchBox = append(tools, $('input.volt-auto-run-search')) as HTMLInputElement;
		this.searchBox.placeholder = localize('voltAutomations.searchRuns', "Search runs...");
		this.searchBox.classList.add('hidden');
		store.add(addDisposableListener(this.searchBox, 'input', () => {
			this.filter.text = this.searchBox.value;
			this.render();
		}));
		store.add(addDisposableListener(this.searchBox, 'keydown', e => {
			if (e.key === 'Escape') {
				this.searchBox.value = '';
				this.filter.text = '';
				this.searchBox.classList.add('hidden');
				this.render();
			}
		}));
		iconButton(tools, Codicon.search, localize('voltAutomations.search', "Search"), store, () => {
			this.searchBox.classList.toggle('hidden');
			if (!this.searchBox.classList.contains('hidden')) {
				this.searchBox.focus();
			}
		});
		const filterButton = iconButton(tools, Codicon.filter, localize('voltAutomations.filter', "Filter"), store, () => showRunFilterMenu(contextView, filterButton, this.filter, () => this.render()));
		filterButton.classList.add('volt-auto-filter-button');
		this.badge = append(filterButton, $('span.volt-auto-badge'));
		this.stats = append(parent, $('.volt-auto-stats'));
		this.table = append(parent, $('.volt-auto-card.volt-auto-runs'));
		this._register(this.automations.onDidChange(() => this.redraw.schedule()));
		this.render();
	}

	private rows(): IRunRow[] {
		const list = this.automationId ? this.automations.get(this.automationId) ? [this.automations.get(this.automationId)!] : [] : this.automations.list();
		return list.flatMap(automation => automation.runs.map(run => ({ ...run, automationId: automation.id, automationName: automation.name })))
			.sort((a, b) => b.at - a.at);
	}

	private render(): void {
		const now = Date.now();
		const all = this.rows();
		const count = activeFilterCount(this.filter);
		this.badge.textContent = count ? String(count) : '';
		this.badge.classList.toggle('hidden', !count);
		this.renderStats(all, now);
		const shown = filterRuns(all, this.filter, row => row.automationName).slice(0, ROWS_SHOWN);
		this.renderTable(shown, all.length, now);
		// Durations of running runs move every second; nothing ticks when nothing runs.
		const running = all.some(isActiveRun);
		if (running && !this.ticker.value) {
			const win = getWindow(this.table);
			const handle = win.setInterval(() => this.tick(), 1000);
			this.ticker.value = { dispose: () => win.clearInterval(handle) };
		} else if (!running) {
			this.ticker.clear();
		}
		this.onLayout();
	}

	private tick(): void {
		const now = Date.now();
		for (const cell of this.table.querySelectorAll<HTMLElement>('[data-live-start]')) {
			cell.textContent = formatDuration(now - Number(cell.dataset.liveStart));
		}
	}

	private renderStats(runs: readonly IAutomationRun[], now: number): void {
		clearNode(this.stats);
		const stats = runStats(runs, now);
		const cards: [string, number][] = [
			[localize('voltAutomations.ok24', "Successful · 24h"), stats.succeeded24h],
			[localize('voltAutomations.fail24', "Failed · 24h"), stats.failed24h],
			[localize('voltAutomations.ok7', "Successful · 7d"), stats.succeeded7d],
			[localize('voltAutomations.fail7', "Failed · 7d"), stats.failed7d],
		];
		for (const [label, value] of cards) {
			const card = append(this.stats, $('.volt-auto-stat'));
			append(card, $('.label')).textContent = label;
			append(card, $('.value')).textContent = String(value);
		}
	}

	private renderTable(runs: readonly IRunRow[], total: number, now: number): void {
		this.rowStore.clear();
		clearNode(this.table);
		const columns = this.automationId
			? [localize('voltAutomations.colTrigger', "Trigger"), localize('voltAutomations.colTriggered', "Triggered"), localize('voltAutomations.colTools', "Tools"), localize('voltAutomations.colStatus', "Status"), localize('voltAutomations.colDuration', "Duration")]
			: [localize('voltAutomations.colAutomation', "Automation"), localize('voltAutomations.colTrigger', "Trigger"), localize('voltAutomations.colTriggered', "Triggered"), localize('voltAutomations.colTools', "Tools"), localize('voltAutomations.colStatus', "Status"), localize('voltAutomations.colDuration', "Duration")];
		this.table.classList.toggle('all', !this.automationId);
		const head = append(this.table, $('.volt-auto-row.head'));
		for (const column of columns) {
			append(head, $('span.cell')).textContent = column;
		}
		if (!runs.length) {
			const empty = append(this.table, $('.volt-auto-empty'));
			if (total) {
				append(empty, $('span')).textContent = localize('voltAutomations.noMatch', "No runs match");
				const clear = append(empty, $('a.volt-auto-link')) as HTMLAnchorElement;
				clear.textContent = localize('voltAutomations.clearFilters', "Clear filters");
				clear.tabIndex = 0;
				this.rowStore.add(addDisposableListener(clear, 'click', () => {
					this.filter.statuses.clear();
					this.filter.triggers.clear();
					this.filter.tools.clear();
					this.filter.text = '';
					this.searchBox.value = '';
					this.render();
				}));
			} else {
				empty.textContent = localize('voltAutomations.noRuns', "No Runs Yet");
			}
			return;
		}
		for (const run of runs) {
			this.renderRow(run, now);
		}
	}

	private renderRow(run: IRunRow, now: number): void {
		const row = append(this.table, $('.volt-auto-row.run'));
		row.classList.toggle('clickable', !!run.threadId);
		row.classList.add(`status-${run.status}`);
		if (!this.automationId) {
			append(row, $('span.cell.name')).textContent = run.automationName;
		}
		const trigger = append(row, $('span.cell.trigger'));
		append(trigger, $('span.icon')).appendChild(providerIcon(run.provider));
		const label = append(trigger, $('span.text'));
		label.textContent = run.label;
		const details = [run.label, run.repository && localize('voltAutomations.inRepo', "Repository: {0}", run.repository), run.note].filter(Boolean).join('\n');
		setAgentTooltip(trigger, details);

		const when = append(row, $('span.cell.muted'));
		when.textContent = formatScheduleWhen(run.at, now);
		setAgentTooltip(when, new Date(run.at).toLocaleString());

		const tools = append(row, $('span.cell.tools'));
		if (run.tools?.length) {
			for (const tool of run.tools) {
				const chip = append(tools, $(`span.volt-auto-tool-chip.status-${tool.status}`));
				chip.appendChild(toolKindIcon(tool.kind));
				setAgentTooltip(chip, `${runToolLabel(tool.kind)}${tool.detail ? ` · ${tool.detail}` : ''}: ${statusLabel(tool.status)}`);
			}
		} else {
			append(tools, $('span.muted')).textContent = '-';
		}

		const status = append(row, $('span.cell.status'));
		append(status, $('span.icon')).appendChild(statusIcon(run.status));
		append(status, $('span.text')).textContent = runStatusLabel(run.status);
		if (run.error || run.note) {
			setAgentTooltip(status, run.error ?? run.note ?? '');
		}

		const duration = append(row, $('span.cell.muted.duration'));
		const ms = runDuration(run, now);
		duration.textContent = ms === undefined ? '-' : formatDuration(ms);
		if (isActiveRun(run) && run.status === 'running') {
			duration.dataset.liveStart = String(run.startedAt ?? run.at);
		}
		if (isActiveRun(run) && run.threadId) {
			const stop = iconButton(row, Codicon.debugStop, localize('voltAutomations.stopRun', "Stop run"), this.rowStore, () => void this.automations.stopRuns(run.automationId));
			stop.classList.add('row-action');
		}
		if (run.threadId) {
			const threadId = run.threadId;
			row.tabIndex = 0;
			this.rowStore.add(addDisposableListener(row, 'click', () => void this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, threadId)));
			this.rowStore.add(addDisposableListener(row, 'keydown', e => {
				if (e.key === 'Enter') {
					void this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, threadId);
				}
			}));
		}
	}
}

/** Every automation's runs (the list page's All Runs). */
export class AllRunsView extends Disposable implements IAutomationsPage {

	constructor(
		host: IAutomationsHost,
		@IAutomationService automations: IAutomationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const store = this._register(new DisposableStore());
		breadcrumb(host.bar, [
			{ label: localize('voltAutomations.tab', "Automations"), onClick: () => host.navigate({ page: 'list' }) },
			{ label: localize('voltAutomations.allRuns', "All Runs") },
		], store);
		const actions = append(host.bar, $('.volt-auto-bar-actions'));
		const stopAll = button(actions, 'volt-auto-outline-button', localize('voltAutomations.stopAll', "Stop All Runs"), store, () => void automations.stopRuns(), Codicon.debugStop);
		const syncStop = () => stopAll.disabled = !automations.list().some(automation => automation.runs.some(isActiveRun));
		syncStop();
		this._register(automations.onDidChange(syncStop));

		const page = append(host.content, $('.volt-auto-page'));
		const head = append(page, $('.volt-auto-detail-head'));
		append(head, $('h1.volt-auto-detail-title.static')).textContent = localize('voltAutomations.allRuns', "All Runs");
		append(head, $('p.volt-auto-subtitle')).textContent = localize('voltAutomations.allRunsSubtitle', "Every automation's runs, newest first. Click a run to open its chat.");
		const toolbar = append(page, $('.volt-auto-tabs-row'));
		append(toolbar, $('span.volt-auto-spacer'));
		this._register(instantiationService.createInstance(RunHistoryPanel, toolbar, page, undefined, () => host.relayout()));
	}
}
