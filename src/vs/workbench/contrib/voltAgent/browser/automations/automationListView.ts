/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IAutomation, IAutomationService, isActiveRun } from '../../../../services/voltRuntime/common/automations/automations.js';
import { AUTOMATION_TEMPLATE_CATEGORIES, automationTemplate, AutomationTemplateCategory, IAutomationTemplate, templatesIn } from '../../../../services/voltRuntime/common/automations/automationTemplates.js';
import { providerLabel } from '../../../../services/voltRuntime/common/automations/automationTriggers.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { showVoltMenu } from '../ui/menu/voltMenu.js';
import { automationJson } from './automationDetailView.js';
import { formatAge } from './automationFormat.js';
import { arrowUpRightIcon, clockIcon, providerIcon, templateIcon, toolKindIcon } from './automationIcons.js';
import { IAutomationsHost, IAutomationsPage } from './automationRoutes.js';
import { button, iconButton, pillTabs } from './automationUi.js';

/** Volt's own agents, shown above the table: each opens its automation (made from the template on first use). */
const BUILT_IN: readonly string[] = ['review-prs', 'fix-ci', 'triage-sentry'];

type Scope = 'mine' | 'team';

let lastScope: Scope = 'mine';
let lastCategory: AutomationTemplateCategory = 'popular';

/**
 * The Automations page: title and New Automation, Volt's built-in agents, the automations table
 * (Mine / Team, search, All Runs), and templates by category.
 */
export class AutomationListView extends Disposable implements IAutomationsPage {

	private readonly store = this._register(new DisposableStore());
	private readonly tableStore = this._register(new DisposableStore());
	private readonly builtInStore = this._register(new DisposableStore());
	private readonly templateStore = this._register(new DisposableStore());
	private readonly table: HTMLElement;
	private readonly builtIns: HTMLElement;
	private readonly searchInput: HTMLInputElement;
	private scope: Scope = lastScope;
	private readonly redraw = this._register(new RunOnceScheduler(() => this.renderDynamic(), 50));

	constructor(
		private readonly host: IAutomationsHost,
		@IAutomationService private readonly automations: IAutomationService,
		@IContextViewService private readonly contextView: IContextViewService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IDialogService private readonly dialogs: IDialogService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		const page = append(host.content, $('.volt-auto-page.list'));

		const head = append(page, $('.volt-auto-list-head'));
		const titles = append(head, $('.titles'));
		append(titles, $('h1.volt-auto-title')).textContent = localize('voltAutomations.tab', "Automations");
		append(titles, $('p.volt-auto-subtitle')).textContent = localize('voltAutomations.subtitle', "Automate repetitive tasks with always-on agents and configure Volt's built-in agents for your team.");
		button(head, 'volt-auto-primary', localize('voltAutomations.new', "New Automation"), this.store, () => host.navigate({ page: 'detail', tab: 'settings' }));

		append(page, $('.volt-auto-group-label')).textContent = localize('voltAutomations.fromVolt', "From Volt");
		this.builtIns = append(page, $('.volt-auto-builtins'));

		const tabsRow = append(page, $('.volt-auto-tabs-row'));
		pillTabs<Scope>(tabsRow, [
			{ id: 'mine', label: localize('voltAutomations.mine', "Mine") },
			{ id: 'team', label: localize('voltAutomations.team', "Team") },
		], this.scope, this.store, scope => {
			this.scope = lastScope = scope;
			this.renderTable();
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
		this.store.add(addDisposableListener(this.searchInput, 'input', () => this.renderTable()));

		this.table = append(page, $('.volt-auto-card.volt-auto-table'));

		const templates = append(page, $('.volt-auto-templates'));
		const grid = $('.volt-auto-template-grid');
		pillTabs<AutomationTemplateCategory>(templates, AUTOMATION_TEMPLATE_CATEGORIES, lastCategory, this.store, category => {
			lastCategory = category;
			this.renderTemplates(grid, category);
		}, 'categories');
		append(templates, grid);
		this.renderTemplates(grid, lastCategory);

		this._register(automations.onDidChange(() => this.redraw.schedule()));
		this.renderDynamic();
	}

	focus(): void {
		this.searchInput.focus();
	}

	private renderDynamic(): void {
		this.renderBuiltIns();
		this.renderTable();
	}

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
	}

	private visible(): IAutomation[] {
		const query = this.searchInput.value.trim().toLowerCase();
		return this.automations.list()
			.filter(automation => (this.scope === 'team') === !!automation.shared)
			.filter(automation => !query || automation.name.toLowerCase().includes(query) || automation.instructions.toLowerCase().includes(query) || automation.createdBy.toLowerCase().includes(query))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private renderTable(): void {
		this.tableStore.clear();
		clearNode(this.table);
		const head = append(this.table, $('.volt-auto-row.head'));
		for (const column of [localize('voltAutomations.colName', "Name"), localize('voltAutomations.colCreatedBy', "Created By"), localize('voltAutomations.colStatus', "Status"), localize('voltAutomations.colTools', "Tools"), '']) {
			append(head, $('span.cell')).textContent = column;
		}
		const rows = this.visible();
		if (!rows.length) {
			const empty = append(this.table, $('.volt-auto-empty.small'));
			empty.textContent = this.searchInput.value.trim()
				? localize('voltAutomations.noneMatch', "No automations match.")
				: this.scope === 'team'
					? localize('voltAutomations.noTeam', "Nothing shared with the team yet. Use Share with Team in an automation's menu.")
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
		type Action = 'open' | 'run' | 'toggle' | 'duplicate' | 'json' | 'share' | 'delete';
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
						{ id: 'share', label: automation.shared ? localize('voltAutomations.moveToMine', "Move to Mine") : localize('voltAutomations.share', "Share with Team"), data: 'share' },
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
					case 'share': await this.automations.update(automation.id, { shared: !automation.shared }); return;
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
}
