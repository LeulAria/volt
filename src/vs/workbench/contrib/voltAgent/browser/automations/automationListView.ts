/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IntervalTimer, RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IAutomation, IAutomationService, isActiveRun, nextRunOf, runStats } from '../../../../services/voltRuntime/common/automations/automations.js';
import { AUTOMATION_TEMPLATE_CATEGORIES, automationTemplate, AutomationTemplateCategory, IAutomationTemplate, templatesIn } from '../../../../services/voltRuntime/common/automations/automationTemplates.js';
import { providerLabel } from '../../../../services/voltRuntime/common/automations/automationTriggers.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { startOfDay } from '../ui/dateTime/voltDateTime.js';
import { showVoltMenu } from '../ui/menu/voltMenu.js';
import { AutomationCalendarView, CalendarView } from './automationCalendarView.js';
import { automationJson } from './automationDetailView.js';
import { formatAge, formatNextShort, formatScheduleWhen } from './automationFormat.js';
import { arrowUpRightIcon, clockIcon, providerIcon, templateIcon, toolKindIcon } from './automationIcons.js';
import { AutomationsRoute, AutomationsView, IAutomationsHost, IAutomationsPage } from './automationRoutes.js';
import { button, iconButton, pillTabs } from './automationUi.js';

/** Volt's own agents, shown under the table: each opens its automation (made from the template on first use). */
const BUILT_IN: readonly string[] = ['review-prs', 'fix-ci', 'triage-sentry'];

const VIEWS: readonly { readonly id: AutomationsView; readonly label: string; readonly key?: string }[] = [
	{ id: 'list', label: localize('voltAutomations.viewList', "List") },
	{ id: 'day', label: localize('voltAutomations.viewDay', "Day"), key: 'D' },
	{ id: 'week', label: localize('voltAutomations.viewWeek', "Week"), key: 'W' },
	{ id: 'month', label: localize('voltAutomations.viewMonth', "Month"), key: 'M' },
];

/** Remembered for the session: the page opens as it was left. */
let lastView: AutomationsView = 'list';
let lastDate: number | undefined;
let lastCategory: AutomationTemplateCategory = 'popular';

/**
 * The Automations page: title with New Automation and Workflows, a summary strip, the automations
 * as a table or a calendar (List · Month · Week · Day · Agenda), Volt's built-in agents, and
 * templates by category.
 */
export class AutomationListView extends Disposable implements IAutomationsPage {

	private readonly store = this._register(new DisposableStore());
	private readonly tableStore = this._register(new DisposableStore());
	private readonly builtInStore = this._register(new DisposableStore());
	private readonly templateStore = this._register(new DisposableStore());
	private readonly summaryStore = this._register(new DisposableStore());
	private readonly calendar = this._register(new MutableDisposable<AutomationCalendarView>());
	private readonly page: HTMLElement;
	private readonly summary: HTMLElement;
	private readonly viewTabs: HTMLElement;
	private readonly table: HTMLElement;
	private readonly calendarHost: HTMLElement;
	private readonly builtIns: HTMLElement;
	private readonly searchInput: HTMLInputElement;
	private view: AutomationsView;
	private date: number | undefined;
	private readonly redraw = this._register(new RunOnceScheduler(() => this.renderDynamic(), 50));
	/** "in 12 min" on the summary ages; one tick a minute keeps it true. */
	private readonly summaryClock = this._register(new IntervalTimer());

	constructor(
		private readonly host: IAutomationsHost,
		route: Extract<AutomationsRoute, { page: 'list' }> | undefined,
		@IAutomationService private readonly automations: IAutomationService,
		@IContextViewService private readonly contextView: IContextViewService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IDialogService private readonly dialogs: IDialogService,
		@INotificationService private readonly notifications: INotificationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		// Back from an automation is a plain list route: the page comes back as it was left.
		this.view = route?.view ?? lastView;
		this.date = route?.date ?? lastDate;
		this.page = append(host.content, $('.volt-auto-page.list'));

		const head = append(this.page, $('.volt-auto-list-head'));
		const titles = append(head, $('.titles'));
		append(titles, $('h1.volt-auto-title')).textContent = localize('voltAutomations.tab', "Automations");
		append(titles, $('p.volt-auto-subtitle')).textContent = localize('voltAutomations.subtitle', "Always-on agents that run on a schedule, on an event from your tools, or as a workflow.");
		const actions = append(head, $('.volt-auto-head-actions'));
		const workflows = button(actions, 'volt-auto-outline-button', localize('voltAutomations.workflows', "Workflows"), this.store, () => host.navigate({ page: 'workflows' }), Codicon.typeHierarchy);
		setAgentTooltip(workflows, localize('voltAutomations.workflowsHelp', "Chain agents, shell steps, checks and messages into a workflow"));
		button(actions, 'volt-auto-primary', localize('voltAutomations.new', "New Automation"), this.store, () => host.navigate({ page: 'detail', tab: 'settings' }));

		this.summary = append(this.page, $('.volt-auto-stats.volt-auto-summary'));

		const tabsRow = append(this.page, $('.volt-auto-tabs-row'));
		this.viewTabs = pillTabs<AutomationsView>(tabsRow, VIEWS, this.view, this.store, view => this.setView(view), 'views');
		VIEWS.forEach((view, index) => {
			const tab = this.viewTabs.children[index];
			if (view.key && isHTMLElement(tab)) {
				setAgentTooltip(tab, view.label, view.key);
			}
		});
		append(tabsRow, $('span.volt-auto-spacer'));
		const allRuns = append(tabsRow, $('a.volt-auto-all-runs'));
		allRuns.tabIndex = 0;
		append(allRuns, $('span')).textContent = localize('voltAutomations.allRuns', "All Runs");
		allRuns.appendChild(arrowUpRightIcon());
		this.store.add(addDisposableListener(allRuns, 'click', () => host.navigate({ page: 'runs' })));
		this.searchInput = append(tabsRow, $('input.volt-auto-search')) as HTMLInputElement;
		this.searchInput.placeholder = localize('voltAutomations.searchPlaceholder', "Search...");
		this.searchInput.setAttribute('aria-label', localize('voltAutomations.searchAutomations', "Search automations"));
		this.store.add(addDisposableListener(this.searchInput, 'input', () => this.view === 'list' ? this.renderTable() : this.calendar.value?.refresh()));

		this.table = append(this.page, $('.volt-auto-card.volt-auto-table'));
		this.calendarHost = append(this.page, $('.volt-auto-calendar-host'));

		append(this.page, $('.volt-auto-group-label')).textContent = localize('voltAutomations.fromVolt', "From Volt");
		this.builtIns = append(this.page, $('.volt-auto-builtins'));

		const templates = append(this.page, $('.volt-auto-templates'));
		append(templates, $('.volt-auto-group-label.templates')).textContent = localize('voltAutomations.templates', "Start from a template");
		const grid = $('.volt-auto-template-grid');
		pillTabs<AutomationTemplateCategory>(templates, AUTOMATION_TEMPLATE_CATEGORIES, lastCategory, this.store, category => {
			lastCategory = category;
			this.renderTemplates(grid, category);
		}, 'categories');
		append(templates, grid);
		this.renderTemplates(grid, lastCategory);
		this.renderWorkflowsPromo(templates);

		this._register(automations.onDidChange(() => this.redraw.schedule()));
		this.applyView(false);
		this.renderDynamic();
	}

	focus(): void {
		if (this.calendar.value) {
			this.calendar.value.focus();
		} else {
			this.searchInput.focus();
		}
	}

	//#region Views

	private setView(view: AutomationsView): void {
		if (view === this.view) {
			return;
		}
		this.view = lastView = view;
		this.applyView(true);
	}

	/** Shows the table or the calendar at the current view, and keeps the route in step. */
	private applyView(record: boolean): void {
		const view = this.view;
		this.applyTabs();
		this.page.classList.toggle('calendar-view', view !== 'list');
		this.table.classList.toggle('hidden', view !== 'list');
		this.calendarHost.classList.toggle('hidden', view === 'list');
		if (view === 'list') {
			this.calendar.clear();
			clearNode(this.calendarHost);
			this.renderTable();
		} else if (this.calendar.value) {
			this.calendar.value.show(view, this.date);
		} else {
			this.calendar.value = this.instantiationService.createInstance(AutomationCalendarView, this.calendarHost, {
				view,
				date: this.date ?? Date.now(),
				automations: () => this.visible(),
				host: this.host,
				onDidNavigate: (calendarView: CalendarView, date: number) => {
					this.view = lastView = calendarView;
					this.date = lastDate = date;
					this.applyTabs();
					this.recordRoute();
				},
			});
		}
		if (record) {
			this.recordRoute();
		}
		this.host.relayout();
	}

	private applyTabs(): void {
		for (const [index, tab] of [...this.viewTabs.children].entries()) {
			const active = VIEWS[index]?.id === this.view;
			tab.classList.toggle('active', active);
			tab.setAttribute('aria-selected', String(active));
		}
	}

	private recordRoute(): void {
		// The day only matters away from today; a reload opens on today otherwise.
		const date = this.date !== undefined && startOfDay(this.date) !== startOfDay(Date.now()) ? this.date : undefined;
		this.host.setRoute({ page: 'list', ...(this.view !== 'list' ? { view: this.view } : {}), ...(this.view !== 'list' && date !== undefined ? { date } : {}) });
	}

	//#endregion

	private renderDynamic(): void {
		this.renderSummary();
		this.renderBuiltIns();
		if (this.view === 'list') {
			this.renderTable();
		} else {
			this.calendar.value?.refresh();
		}
	}

	//#region Summary

	/** Active automations, runs today, the week's success rate, and the next run. */
	private renderSummary(): void {
		this.summaryStore.clear();
		clearNode(this.summary);
		const now = Date.now();
		const list = this.automations.list();
		const today = startOfDay(now);
		let succeeded = 0, failed = 0, running = 0, succeeded7d = 0, failed7d = 0;
		let next: { readonly automation: IAutomation; readonly at: number } | undefined;
		for (const automation of list) {
			for (const run of automation.runs) {
				if (run.at >= today && run.status !== 'skipped') {
					succeeded += run.status === 'succeeded' ? 1 : 0;
					failed += run.status === 'failed' || run.status === 'cancelled' ? 1 : 0;
					running += isActiveRun(run) ? 1 : 0;
				}
			}
			const stats = runStats(automation.runs, now);
			succeeded7d += stats.succeeded7d;
			failed7d += stats.failed7d;
			const at = nextRunOf(automation);
			if (at !== undefined && (!next || at < next.at)) {
				next = { automation, at };
			}
		}
		const card = (label: string) => {
			const element = append(this.summary, $('.volt-auto-stat'));
			append(element, $('.label')).textContent = label;
			return append(element, $('.value'));
		};
		const active = card(localize('voltAutomations.sumActive', "Active automations"));
		append(active, $('span')).textContent = String(list.filter(automation => automation.enabled).length);
		append(active, $('span.muted.of')).textContent = localize('voltAutomations.sumOf', "of {0}", list.length);

		const runs = card(localize('voltAutomations.sumToday', "Runs today"));
		append(runs, $('span')).textContent = String(succeeded + failed + running);
		const split = append(runs, $('span.split'));
		const part = (icon: typeof Codicon.check, count: number, className: string, tooltip: string) => {
			const element = append(split, $(`span.part.${className}`));
			element.appendChild(renderIcon(icon));
			append(element, $('span')).textContent = String(count);
			setAgentTooltip(element, tooltip);
		};
		part(Codicon.check, succeeded, 'ok', localize('voltAutomations.sumSucceeded', "Succeeded"));
		part(Codicon.close, failed, 'bad', localize('voltAutomations.sumFailed', "Failed or stopped"));
		if (running) {
			part(Codicon.loading, running, 'live', localize('voltAutomations.sumRunning', "Running now"));
		}

		const rate = card(localize('voltAutomations.sumRate', "Success rate, 7 days"));
		const finished = succeeded7d + failed7d;
		rate.textContent = finished ? `${Math.round((succeeded7d / finished) * 100)}%` : '\u2013';
		setAgentTooltip(rate.parentElement!, finished ? localize('voltAutomations.sumRateHelp', "{0} of {1} finished runs succeeded", succeeded7d, finished) : localize('voltAutomations.sumRateNone', "No finished runs this week"));

		const nextCard = card(localize('voltAutomations.sumNext', "Next run"));
		if (next) {
			const target = next.automation;
			const holder = nextCard.parentElement!;
			holder.classList.add('clickable');
			holder.tabIndex = 0;
			holder.setAttribute('role', 'button');
			append(nextCard, $('span.name')).textContent = target.name;
			// The time sits on the label's line, so a long name keeps the whole value line.
			append(holder.firstElementChild as HTMLElement, $('span.when')).textContent = formatScheduleWhen(next.at, now);
			setAgentTooltip(holder, localize('voltAutomations.sumNextHelp', "Open {0}", target.name));
			const open = () => this.host.navigate({ page: 'detail', id: target.id, tab: 'settings' });
			this.summaryStore.add(addDisposableListener(holder, 'click', open));
			this.summaryStore.add(addDisposableListener(holder, 'keydown', e => {
				if (e.key === 'Enter') {
					open();
				}
			}));
			this.summaryClock.cancelAndSet(() => this.page.isConnected && this.renderSummary(), 60_000, getWindow(this.page));
		} else {
			nextCard.textContent = localize('voltAutomations.sumNoneScheduled', "Nothing scheduled");
			nextCard.classList.add('muted');
			this.summaryClock.cancel();
		}
	}

	//#endregion

	private renderBuiltIns(): void {
		this.builtInStore.clear();
		clearNode(this.builtIns);
		for (const id of BUILT_IN) {
			const template = automationTemplate(id);
			if (!template) {
				continue;
			}
			const existing = this.automations.list().find(automation => automation.templateId === id);
			const card = append(this.builtIns, $('button.volt-auto-builtin')) as HTMLButtonElement;
			card.type = 'button';
			const icon = append(card, $('span.volt-auto-round-icon.small'));
			icon.appendChild(renderIcon(templateIcon(template.icon)));
			const text = append(card, $('span.text'));
			append(text, $('span.name')).textContent = template.title;
			const state = append(text, $('span.state'));
			state.textContent = !existing ? localize('voltAutomations.setUp', "Set up") : existing.enabled ? localize('voltAutomations.active', "Active") : localize('voltAutomations.inactive', "Inactive");
			state.classList.toggle('on', !!existing?.enabled);
			setAgentTooltip(card, template.description);
			this.builtInStore.add(addDisposableListener(card, 'click', () => this.host.navigate(existing
				? { page: 'detail', id: existing.id, tab: 'settings' }
				: { page: 'detail', tab: 'settings', seed: { templateId: id } })));
		}
		this.host.relayout();
	}

	//#region Table

	private visible(): IAutomation[] {
		const query = this.searchInput.value.trim().toLowerCase();
		return this.automations.list()
			.filter(automation => !query || automation.name.toLowerCase().includes(query) || automation.instructions.toLowerCase().includes(query) || automation.createdBy.toLowerCase().includes(query))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private renderTable(): void {
		this.tableStore.clear();
		clearNode(this.table);
		if (this.view !== 'list') {
			return;
		}
		const head = append(this.table, $('.volt-auto-row.head'));
		for (const column of [localize('voltAutomations.colName', "Name"), localize('voltAutomations.colNextRun', "Next Run"), localize('voltAutomations.colCreatedBy', "Created By"), localize('voltAutomations.colStatus', "Status"), localize('voltAutomations.colTools', "Tools"), '']) {
			append(head, $('span.cell')).textContent = column;
		}
		const rows = this.visible();
		if (!rows.length) {
			const empty = append(this.table, $('.volt-auto-empty.small'));
			empty.textContent = this.searchInput.value.trim()
				? localize('voltAutomations.noneMatch', "No automations match.")
				: localize('voltAutomations.none', "No automations yet. Start from a template below or create one.");
			this.host.relayout();
			return;
		}
		const now = Date.now();
		for (const automation of rows) {
			const row = append(this.table, $('.volt-auto-row.item'));
			row.tabIndex = 0;
			const open = () => this.host.navigate({ page: 'detail', id: automation.id, tab: 'settings' });
			this.tableStore.add(addDisposableListener(row, 'click', open));
			this.tableStore.add(addDisposableListener(row, 'keydown', e => {
				if (e.key === 'Enter') {
					open();
				}
			}));
			const name = append(row, $('span.cell.name'));
			name.textContent = automation.name;
			if (automation.runs.some(isActiveRun)) {
				append(name, $('span.volt-auto-live')).title = localize('voltAutomations.runningNow', "Running now");
			}
			const next = append(row, $('span.cell.next'));
			const nextAt = nextRunOf(automation);
			if (nextAt !== undefined) {
				next.textContent = formatNextShort(nextAt, now);
				setAgentTooltip(next, formatScheduleWhen(nextAt, now));
			} else {
				next.classList.add('muted');
				next.textContent = !automation.enabled
					? '-'
					: automation.triggers.length ? localize('voltAutomations.onEvent', "On event") : localize('voltAutomations.manualOnly', "Manual");
			}
			const by = append(row, $('span.cell.by'));
			append(by, $('span')).textContent = automation.createdBy;
			append(by, $('span.muted')).textContent = formatAge(automation.createdAt, now);
			const status = append(row, $('span.cell.status'));
			status.classList.toggle('on', automation.enabled);
			status.appendChild(renderIcon(automation.enabled ? Codicon.check : Codicon.close));
			append(status, $('span')).textContent = automation.enabled ? localize('voltAutomations.active', "Active") : localize('voltAutomations.inactive', "Inactive");
			const tools = append(row, $('span.cell.tools'));
			const shown = automation.tools.filter(tool => tool.kind !== 'memories');
			const providers = [...new Set(automation.triggers.map(trigger => trigger.provider))];
			if (!shown.length && !providers.length) {
				append(tools, $('span.muted')).textContent = '-';
			}
			for (const provider of providers) {
				const chip = append(tools, $('span.volt-auto-mini-icon'));
				chip.appendChild(provider === 'schedule' ? clockIcon() : providerIcon(provider));
				setAgentTooltip(chip, providerLabel(provider));
			}
			for (const tool of shown) {
				const chip = append(tools, $('span.volt-auto-mini-icon'));
				chip.appendChild(toolKindIcon(tool.kind));
				setAgentTooltip(chip, tool.server ?? tool.kind.replace('_', ' '));
			}
			const actions = append(row, $('span.cell.actions'));
			const more = iconButton(actions, Codicon.ellipsis, localize('voltAutomations.more', "More actions"), this.tableStore, () => this.showRowMenu(more, automation));
		}
		this.host.relayout();
	}

	private showRowMenu(anchor: HTMLElement, automation: IAutomation): void {
		type Action = 'open' | 'run' | 'toggle' | 'duplicate' | 'json' | 'delete';
		showVoltMenu<Action>(this.contextView, {
			anchor,
			align: 'right',
			gap: 4,
			width: 200,
			className: 'volt-auto-menu',
			ariaLabel: localize('voltAutomations.more', "More actions"),
			sections: [
				{
					id: 'main', items: [
						{ id: 'open', label: localize('voltAutomations.open', "Open"), data: 'open' },
						{ id: 'run', label: localize('voltAutomations.runNow', "Run Now"), data: 'run' },
						{ id: 'toggle', label: automation.enabled ? localize('voltAutomations.deactivate', "Deactivate") : localize('voltAutomations.activate', "Activate"), data: 'toggle' },
						{ id: 'duplicate', label: localize('voltAutomations.duplicate', "Duplicate"), data: 'duplicate' },
						{ id: 'json', label: localize('voltAutomations.copyJson', "Copy as JSON"), data: 'json' },
					],
				},
				{ id: 'danger', items: [{ id: 'delete', label: localize('voltAutomations.delete', "Delete"), className: 'danger', data: 'delete' }] },
			],
			onPick: async item => {
				switch (item.data) {
					case 'open': this.host.navigate({ page: 'detail', id: automation.id, tab: 'settings' }); return;
					case 'run': {
						const runs = await this.automations.runNow(automation.id);
						if (runs.some(run => run.status === 'failed')) {
							this.notifications.error(localize('voltAutomations.runFailed', "{0} did not start: {1}", automation.name, runs.find(run => run.error)?.error ?? ''));
						}
						return;
					}
					case 'toggle': await this.automations.setEnabled(automation.id, !automation.enabled); return;
					case 'duplicate': await this.automations.duplicate(automation.id); return;
					case 'json': await this.clipboard.writeText(automationJson(automation)); return;
					case 'delete': {
						const { confirmed } = await this.dialogs.confirm({
							message: localize('voltAutomations.deleteConfirm', "Delete \"{0}\"?", automation.name),
							detail: localize('voltAutomations.deleteDetail', "Its triggers stop and its webhook URLs stop answering. Chats its runs started stay."),
							primaryButton: localize('voltAutomations.deleteButton', "Delete"),
						});
						if (confirmed) {
							await this.automations.delete(automation.id);
						}
						return;
					}
				}
			},
		});
	}

	//#endregion

	//#region Templates

	private renderTemplates(grid: HTMLElement, category: AutomationTemplateCategory): void {
		this.templateStore.clear();
		clearNode(grid);
		for (const template of templatesIn(category)) {
			this.renderTemplate(grid, template);
		}
		this.host.relayout();
	}

	private renderTemplate(grid: HTMLElement, template: IAutomationTemplate): void {
		const card = append(grid, $('button.volt-auto-template')) as HTMLButtonElement;
		card.type = 'button';
		const icon = append(card, $('span.volt-auto-round-icon'));
		icon.appendChild(renderIcon(templateIcon(template.icon)));
		const text = append(card, $('span.text'));
		append(text, $('span.name')).textContent = template.title;
		append(text, $('span.description')).textContent = template.description;
		const flow = append(text, $('span.flow'));
		const trigger = template.triggers[0];
		if (trigger) {
			const chip = append(flow, $('span.chip'));
			chip.appendChild(trigger.provider === 'schedule' ? clockIcon() : providerIcon(trigger.provider));
			append(chip, $('span')).textContent = trigger.provider === 'schedule' ? localize('voltAutomations.scheduled', "Scheduled") : providerLabel(trigger.provider);
		}
		const output = template.tools.find(tool => tool === 'slack_send' || tool === 'teams_send');
		const action = output ?? (template.triggers.some(entry => entry.provider === 'github') || /pr_comment|open a PR|opened a PR/.test(template.instructions) ? 'github' : undefined);
		if (action) {
			append(flow, $('span.arrow')).appendChild(renderIcon(Codicon.arrowRight));
			const chip = append(flow, $('span.chip'));
			chip.appendChild(action === 'github' ? providerIcon('github') : toolKindIcon(action));
			append(chip, $('span')).textContent = action === 'slack_send'
				? localize('voltAutomations.sendSlackShort', "Send Slack")
				: action === 'teams_send'
					? localize('voltAutomations.sendTeamsShort', "Send Teams")
					: localize('voltAutomations.githubAction', "GitHub");
		}
		this.templateStore.add(addDisposableListener(card, 'click', () => this.host.navigate({ page: 'detail', tab: 'settings', seed: { templateId: template.id } })));
	}

	/** Under the templates: for more than one agent step, a workflow. */
	private renderWorkflowsPromo(parent: HTMLElement): void {
		const promo = append(parent, $('.volt-auto-workflow-promo'));
		const icon = append(promo, $('span.volt-auto-round-icon'));
		icon.appendChild(renderIcon(Codicon.typeHierarchy));
		const text = append(promo, $('span.text'));
		append(text, $('span.name')).textContent = localize('voltAutomations.promoTitle', "Need more than one step?");
		append(text, $('span.description')).textContent = localize('voltAutomations.promoText', "Workflows chain agents, shell commands, HTTP calls, checks and messages, with branches and loops. Any automation can run one.");
		const actions = append(promo, $('.actions'));
		button(actions, 'volt-auto-outline-button.small', localize('voltAutomations.promoTemplates', "Browse Templates"), this.store, () => this.host.navigate({ page: 'workflows', tab: 'templates' }));
		button(actions, 'volt-auto-outline-button.small.primary', localize('voltAutomations.promoOpen', "Open Workflows"), this.store, () => this.host.navigate({ page: 'workflows' }));
	}

	//#endregion
}
