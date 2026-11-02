/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentWorkflowLibrary.css';
import { $, addDisposableListener, append, clearNode, EventHelper, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { AutomationProvider, providerLabel } from '../../../../services/voltRuntime/common/automations/automationTriggers.js';
import { getWorkflowNodeType } from '../../../../services/voltRuntime/common/workflows/workflowNodes.js';
import { resolveTemplateSource } from '../../../../services/voltRuntime/common/workflows/workflowTemplates.js';
import { IWorkflowDefinition, IWorkflowIssue, IWorkflowService, IWorkflowSource, IWorkflowSummary, IWorkflowTrigger, WorkflowPermission, WorkflowRunMode } from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createHomeSearchIcon } from '../home/agentHomeIcons.js';
import { formatAge } from '../automations/automationFormat.js';
import { clockIcon, providerIcon } from '../automations/automationIcons.js';
import { AutomationsRoute, IAutomationsHost, IAutomationsPage } from '../automations/automationRoutes.js';
import { button, field, flashLabel, iconButton, IAutomationDialog, pillTabs, showAutomationDialog } from '../automations/automationUi.js';
import { showVoltMenu } from '../ui/menu/voltMenu.js';
import { WorkflowEditorModel } from '../../common/workflows/workflowEditorModel.js';
import { WorkflowCanvas } from './canvas/workflowCanvas.js';
import { WorkflowCodeEditor } from './workflowCodeEditor.js';
import { isLiveRun, runStatusLabel, stepStateIcon } from './workflowRunPanel.js';
import { IWorkflowTemplate, IWorkflowTemplateService, IWorkflowTemplateSourceInfo, templateSourceLabel, withWorkflowSource, workflowPermissions } from './workflowTemplateService.js';

type LibraryTab = 'mine' | 'templates';

let lastSourceFilter: string | undefined;

//#region Labels

export function permissionLabel(permission: WorkflowPermission): string {
	switch (permission) {
		case 'agent': return localize('voltWorkflows.permAgent', "Agents");
		case 'shell': return localize('voltWorkflows.permShell', "Shell commands");
		case 'network': return localize('voltWorkflows.permNetwork', "Network");
		case 'git': return localize('voltWorkflows.permGit', "Git");
		case 'filesystem': return localize('voltWorkflows.permFiles', "Files");
		case 'messaging': return localize('voltWorkflows.permMessaging', "Messages");
	}
}

function permissionDescription(permission: WorkflowPermission): string {
	switch (permission) {
		case 'agent': return localize('voltWorkflows.permAgentDesc', "Starts agent sessions that read and change your repository.");
		case 'shell': return localize('voltWorkflows.permShellDesc', "Runs shell commands on this machine.");
		case 'network': return localize('voltWorkflows.permNetworkDesc', "Sends HTTP requests to other services.");
		case 'git': return localize('voltWorkflows.permGitDesc', "Commits, pushes, opens pull requests.");
		case 'filesystem': return localize('voltWorkflows.permFilesDesc', "Reads and writes files.");
		case 'messaging': return localize('voltWorkflows.permMessagingDesc', "Posts to Slack, Teams or email.");
	}
}

function permissionIcon(permission: WorkflowPermission): ThemeIcon {
	switch (permission) {
		case 'agent': return Codicon.robot;
		case 'shell': return Codicon.terminal;
		case 'network': return Codicon.globe;
		case 'git': return Codicon.gitPullRequest;
		case 'filesystem': return Codicon.files;
		case 'messaging': return Codicon.commentDiscussion;
	}
}

function triggerSummary(trigger: IWorkflowTrigger): { readonly icon: () => Element; readonly label: string } {
	switch (trigger.type) {
		case 'schedule':
			return {
				icon: () => clockIcon(),
				label: trigger.everyMinutes
					? localize('voltWorkflows.everyMinutes', "Every {0} min", trigger.everyMinutes)
					: trigger.cron ? trigger.cron : localize('voltWorkflows.scheduled', "Scheduled"),
			};
		case 'event': {
			const provider = (trigger.provider ?? 'webhook') as AutomationProvider;
			return { icon: () => providerIcon(provider), label: [providerLabel(provider), trigger.event].filter(Boolean).join(' · ') };
		}
		default:
			return { icon: () => providerIcon('manual'), label: localize('voltWorkflows.manual', "Manual") };
	}
}

function nodeTypeIcon(type: string): ThemeIcon {
	const nodeType = getWorkflowNodeType(type);
	return nodeType ? ThemeIcon.fromId(nodeType.icon) : Codicon.symbolMisc;
}

function issueCount(issues: readonly IWorkflowIssue[], severity: IWorkflowIssue['severity'] = 'error'): number {
	return issues.filter(issue => issue.severity === severity).length;
}

//#endregion

//#region My workflows list

const WORKFLOW_ROW_HEIGHT = 52;

interface IWorkflowTemplateData {
	readonly name: HTMLElement;
	readonly badges: HTMLElement;
	readonly description: HTMLElement;
	readonly trigger: HTMLElement;
	readonly nodes: HTMLElement;
	readonly lastRun: HTMLElement;
	readonly automations: HTMLElement;
	readonly more: HTMLElement;
	readonly store: DisposableStore;
	readonly ref: { current?: IWorkflowSummary };
}

class WorkflowRowRenderer implements IListRenderer<IWorkflowSummary, IWorkflowTemplateData> {
	static readonly ID = 'voltWorkflowSummary';
	readonly templateId = WorkflowRowRenderer.ID;

	constructor(private readonly onMore: (anchor: HTMLElement, summary: IWorkflowSummary) => void, private readonly running: (id: string) => boolean) { }

	renderTemplate(container: HTMLElement): IWorkflowTemplateData {
		const store = new DisposableStore();
		const ref: IWorkflowTemplateData['ref'] = {};
		const row = append(container, $('.volt-wf-lib-row'));
		const main = append(row, $('span.cell.main'));
		const top = append(main, $('span.volt-wf-lib-name-line'));
		const name = append(top, $('span.volt-wf-lib-name'));
		const badges = append(top, $('span.volt-wf-lib-badges'));
		const description = append(main, $('span.volt-wf-lib-description'));
		const trigger = append(row, $('span.cell.trigger'));
		const nodes = append(row, $('span.cell.nodes'));
		const lastRun = append(row, $('span.cell.last-run'));
		const automations = append(row, $('span.cell.automations'));
		const actions = append(row, $('span.cell.actions'));
		// A span, not a button: the row is the list's.
		const more = append(actions, $('span.volt-wf-row-action.always'));
		more.setAttribute('role', 'button');
		more.setAttribute('aria-label', localize('voltWorkflows.moreActions', "More actions"));
		more.appendChild(renderIcon(Codicon.ellipsis));
		setAgentTooltip(more, localize('voltWorkflows.moreActions', "More actions"));
		for (const type of [EventType.MOUSE_DOWN, EventType.POINTER_DOWN, EventType.MOUSE_UP, EventType.DBLCLICK]) {
			store.add(addDisposableListener(more, type, e => EventHelper.stop(e, true)));
		}
		store.add(addDisposableListener(more, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			if (ref.current) {
				this.onMore(more, ref.current);
			}
		}));
		return { name, badges, description, trigger, nodes, lastRun, automations, more, store, ref };
	}

	renderElement(summary: IWorkflowSummary, _index: number, template: IWorkflowTemplateData): void {
		template.ref.current = summary;
		template.name.textContent = summary.name;
		clearNode(template.badges);
		if (this.running(summary.id)) {
			const live = append(template.badges, $('span.volt-auto-live'));
			setAgentTooltip(live, localize('voltWorkflows.runningNow', "Running now"));
		}
		if (!summary.trusted) {
			const chip = append(template.badges, $('span.volt-wf-badge.untrusted'));
			chip.textContent = localize('voltWorkflows.unreviewed', "Unreviewed");
			setAgentTooltip(chip, localize('voltWorkflows.unreviewedHint', "Came from a community template or an import. Volt asks before it runs for real."));
		}
		if (summary.issues) {
			const chip = append(template.badges, $('span.volt-wf-badge.issues'));
			chip.textContent = summary.issues === 1 ? localize('voltWorkflows.oneIssue', "1 issue") : localize('voltWorkflows.issuesCount', "{0} issues", summary.issues);
		}
		template.description.textContent = summary.description ?? '';
		template.description.style.display = summary.description ? '' : 'none';
		clearNode(template.trigger);
		const trigger = triggerSummary(summary.trigger);
		append(template.trigger, $('span.icon')).appendChild(trigger.icon());
		append(template.trigger, $('span.text')).textContent = trigger.label;
		setAgentTooltip(template.trigger, trigger.label);
		template.nodes.textContent = String(summary.nodeCount);
		clearNode(template.lastRun);
		const last = summary.lastRun;
		if (last) {
			const state = last.status === 'succeeded' ? 'success' : last.status === 'failed' ? 'failed' : last.status === 'cancelled' ? 'cancelled' : 'running';
			append(template.lastRun, $(`span.icon.state-${state}`)).appendChild(renderIcon(stepStateIcon(state)));
			append(template.lastRun, $('span.text')).textContent = isLiveRun(last) ? runStatusLabel(last.status) : formatAge(last.at, Date.now());
			setAgentTooltip(template.lastRun, `${runStatusLabel(last.status)}${last.mode === 'simulate' ? ` · ${localize('voltWorkflows.simulation', "Simulation")}` : ''} · ${new Date(last.at).toLocaleString()}`);
		} else {
			append(template.lastRun, $('span.muted')).textContent = localize('voltWorkflows.never', "Never");
			setAgentTooltip(template.lastRun, undefined);
		}
		template.automations.textContent = summary.automationIds.length ? String(summary.automationIds.length) : '-';
		template.automations.classList.toggle('muted', !summary.automationIds.length);
		setAgentTooltip(template.automations, summary.automationIds.length
			? localize('voltWorkflows.usedBy', "Run by {0} automations", summary.automationIds.length)
			: localize('voltWorkflows.notUsed', "No automation runs it yet"));
	}

	disposeElement(_summary: IWorkflowSummary, _index: number, template: IWorkflowTemplateData): void {
		template.ref.current = undefined;
	}

	disposeTemplate(template: IWorkflowTemplateData): void {
		template.store.dispose();
	}
}

//#endregion

//#region Dialog lists (issues, permissions)

const ISSUE_ROW_HEIGHT = 24;

class IssueRenderer implements IListRenderer<IWorkflowIssue, { readonly icon: HTMLElement; readonly message: HTMLElement; readonly where: HTMLElement }> {
	static readonly ID = 'voltWorkflowIssue';
	readonly templateId = IssueRenderer.ID;

	renderTemplate(container: HTMLElement) {
		const row = append(container, $('.volt-wf-issue-row'));
		return { icon: append(row, $('span.icon')), message: append(row, $('span.message')), where: append(row, $('span.where')) };
	}

	renderElement(issue: IWorkflowIssue, _index: number, template: { readonly icon: HTMLElement; readonly message: HTMLElement; readonly where: HTMLElement }): void {
		template.icon.className = `icon severity-${issue.severity}`;
		template.icon.replaceChildren(renderIcon(issue.severity === 'error' ? Codicon.error : issue.severity === 'warning' ? Codicon.warning : Codicon.info));
		template.message.textContent = issue.message;
		setAgentTooltip(template.message, issue.message.length > 70 ? issue.message : undefined);
		template.where.textContent = issue.line ? localize('voltWorkflows.lineCol', "Ln {0}, Col {1}", issue.line, issue.column ?? 1) : issue.nodeId ?? '';
	}

	disposeTemplate(): void { }
}

function renderIssueList(instantiationService: IInstantiationService, parent: HTMLElement, store: DisposableStore, maxRows: number): { set(issues: readonly IWorkflowIssue[]): void } {
	const host = append(parent, $('.volt-wf-issue-list'));
	const list = store.add(instantiationService.createInstance(WorkbenchList<IWorkflowIssue>, 'VoltWorkflowIssues', host, {
		getHeight: () => ISSUE_ROW_HEIGHT,
		getTemplateId: () => IssueRenderer.ID,
	} satisfies IListVirtualDelegate<IWorkflowIssue>, [new IssueRenderer()], {
		multipleSelectionSupport: false,
		horizontalScrolling: false,
		alwaysConsumeMouseWheel: false,
		accessibilityProvider: {
			getWidgetAriaLabel: () => localize('voltWorkflows.issuesAria', "Problems"),
			getAriaLabel: (issue: IWorkflowIssue) => `${issue.severity}: ${issue.message}${issue.line ? `, line ${issue.line}` : ''}`,
		},
	}));
	return {
		set: issues => {
			const height = Math.min(issues.length, maxRows) * ISSUE_ROW_HEIGHT;
			host.style.height = `${height}px`;
			host.style.display = issues.length ? '' : 'none';
			list.layout(height);
			list.splice(0, list.length, [...issues]);
		},
	};
}

interface IPermissionRow {
	readonly permission: WorkflowPermission;
	readonly nodes: readonly string[];
}

const PERMISSION_ROW_HEIGHT = 46;

class PermissionRenderer implements IListRenderer<IPermissionRow, { readonly icon: HTMLElement; readonly label: HTMLElement; readonly detail: HTMLElement }> {
	static readonly ID = 'voltWorkflowPermission';
	readonly templateId = PermissionRenderer.ID;

	renderTemplate(container: HTMLElement) {
		const row = append(container, $('.volt-wf-perm-row'));
		const icon = append(row, $('span.icon'));
		const text = append(row, $('span.text'));
		return { icon, label: append(text, $('span.label')), detail: append(text, $('span.detail')) };
	}

	renderElement(row: IPermissionRow, _index: number, template: { readonly icon: HTMLElement; readonly label: HTMLElement; readonly detail: HTMLElement }): void {
		template.icon.replaceChildren(renderIcon(permissionIcon(row.permission)));
		template.label.textContent = permissionLabel(row.permission);
		template.detail.textContent = `${permissionDescription(row.permission)} ${localize('voltWorkflows.permUsedBy', "Used by {0}.", row.nodes.join(', '))}`;
	}

	disposeTemplate(): void { }
}

function permissionRows(definition: IWorkflowDefinition): IPermissionRow[] {
	return workflowPermissions(definition).map(permission => ({
		permission,
		nodes: definition.nodes.filter(node => !node.disabled && getWorkflowNodeType(node.type)?.permissions.includes(permission)).map(node => node.name?.trim() || node.id),
	}));
}

//#endregion

/**
 * The workflow library: the user's workflows (open, simulate, run, export, publish) and the
 * template gallery (built-in, Volt's repository, community sources the user added). Templates are
 * previewed read-only and installed as copies; nothing in a template runs until the user does.
 */
export class WorkflowLibraryPage extends Disposable implements IAutomationsPage {

	private readonly store = this._register(new DisposableStore());
	private readonly sectionStore = this._register(new DisposableStore());
	private readonly gridStore = this._register(new DisposableStore());
	private readonly sourcesStore = this._register(new DisposableStore());
	private readonly dialog = this._register(new MutableDisposable<IAutomationDialog>());
	private readonly section: HTMLElement;
	private readonly searchInput: HTMLInputElement;
	private tab: LibraryTab;
	private sourceFilter: string | undefined = lastSourceFilter;
	private list: WorkbenchList<IWorkflowSummary> | undefined;
	private listHost: HTMLElement | undefined;
	private tableEmpty: HTMLElement | undefined;
	private grid: HTMLElement | undefined;
	private sourcesBar: HTMLElement | undefined;
	private readonly redrawMine = this._register(new RunOnceScheduler(() => this.renderWorkflows(), 50));
	private readonly redrawTemplates = this._register(new RunOnceScheduler(() => this.renderTemplatesBody(), 50));

	constructor(
		private readonly host: IAutomationsHost,
		route: Extract<AutomationsRoute, { page: 'workflows' }>,
		@IWorkflowService private readonly workflows: IWorkflowService,
		@IWorkflowTemplateService private readonly templates: IWorkflowTemplateService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextView: IContextViewService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IDialogService private readonly dialogs: IDialogService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notifications: INotificationService,
		@IOpenerService private readonly opener: IOpenerService,
		@ILayoutService private readonly layoutService: ILayoutService,
	) {
		super();
		this.tab = route.tab ?? 'mine';
		host.setCrumbs([{ label: localize('voltWorkflows.title', "Workflows") }]);
		iconButton(host.bar, Codicon.arrowLeft, localize('voltWorkflows.backToAutomations', "Back to Automations"), this.store, () => host.navigate({ page: 'list' }), 'volt-auto-icon-button.volt-auto-back');

		const page = append(host.content, $('.volt-auto-page.list.volt-wf-library'));
		const head = append(page, $('.volt-auto-list-head'));
		const titles = append(head, $('.titles'));
		append(titles, $('h1.volt-auto-title')).textContent = localize('voltWorkflows.title', "Workflows");
		append(titles, $('p.volt-auto-subtitle')).textContent = localize('voltWorkflows.subtitle', "Chain agents, checks and git steps on a canvas. Simulate them without side effects, then run them by hand or from an automation.");
		const actions = append(head, $('.volt-auto-bar-actions'));
		button(actions, 'volt-auto-outline-button', localize('voltWorkflows.import', "Import"), this.store, () => void this.importFile(), Codicon.cloudDownload);
		button(actions, 'volt-auto-outline-button', localize('voltWorkflows.pasteYaml', "Paste YAML"), this.store, () => this.showPasteDialog(), Codicon.code);
		button(actions, 'volt-auto-primary', localize('voltWorkflows.new', "New Workflow"), this.store, () => host.navigate({ page: 'workflow' }));

		const tabsRow = append(page, $('.volt-auto-tabs-row'));
		pillTabs<LibraryTab>(tabsRow, [
			{ id: 'mine', label: localize('voltWorkflows.mine', "My Workflows") },
			{ id: 'templates', label: localize('voltWorkflows.templates', "Templates") },
		], this.tab, this.store, tab => {
			this.tab = tab;
			host.setRoute({ page: 'workflows', tab });
			this.renderSection();
		});
		append(tabsRow, $('span.volt-auto-spacer'));
		const searchBox = append(tabsRow, $('label.volt-wf-lib-search'));
		append(searchBox, $('span.icon')).appendChild(createHomeSearchIcon());
		this.searchInput = append(searchBox, $('input.volt-wf-lib-search-input')) as HTMLInputElement;
		this.searchInput.placeholder = localize('voltWorkflows.searchWorkflows', "Search workflows");
		this.searchInput.setAttribute('aria-label', localize('voltWorkflows.searchAria', "Search workflows and templates"));
		this.store.add(addDisposableListener(this.searchInput, EventType.INPUT, () => this.tab === 'mine' ? this.renderWorkflows() : this.renderTemplatesBody()));

		this.section = append(page, $('.volt-wf-lib-section'));
		this._register(workflows.onDidChange(() => this.redrawMine.schedule()));
		this._register(workflows.onDidChangeRun(event => {
			if (event.kind === 'run' && this.tab === 'mine') {
				this.redrawMine.schedule();
			}
		}));
		this._register(templates.onDidChange(() => this.redrawTemplates.schedule()));
		void workflows.whenReady.then(() => {
			if (!this._store.isDisposed && this.tab === 'mine') {
				this.renderWorkflows();
			}
		});
		this.renderSection();
	}

	focus(): void {
		this.searchInput.focus();
	}

	private renderSection(): void {
		this.sectionStore.clear();
		this.gridStore.clear();
		this.sourcesStore.clear();
		clearNode(this.section);
		this.list = undefined;
		this.listHost = undefined;
		this.tableEmpty = undefined;
		this.grid = undefined;
		this.sourcesBar = undefined;
		if (this.tab === 'mine') {
			this.renderMine();
		} else {
			this.renderTemplatesTab();
		}
		this.host.relayout();
	}

	//#region My workflows

	private renderMine(): void {
		const card = append(this.section, $('.volt-wf-lib-table'));
		const head = append(card, $('.volt-wf-lib-row.head'));
		for (const [className, column] of [
			['main', localize('voltWorkflows.colName', "Name")],
			['trigger', localize('voltWorkflows.colTrigger', "Trigger")],
			['nodes', localize('voltWorkflows.colNodes', "Nodes")],
			['last-run', localize('voltWorkflows.colLastRun', "Last run")],
			['automations', localize('voltWorkflows.colAutomations', "Automations")],
			['actions', ''],
		]) {
			append(head, $(`span.cell.${className}`)).textContent = column;
		}
		this.listHost = append(card, $('.volt-wf-lib-list'));
		this.tableEmpty = append(card, $('.volt-auto-empty.small'));
		const list = this.list = this.sectionStore.add(this.instantiationService.createInstance(WorkbenchList<IWorkflowSummary>, 'VoltWorkflowLibrary', this.listHost, {
			getHeight: () => WORKFLOW_ROW_HEIGHT,
			getTemplateId: () => WorkflowRowRenderer.ID,
		} satisfies IListVirtualDelegate<IWorkflowSummary>, [new WorkflowRowRenderer((anchor, summary) => this.showRowMenu(anchor, summary), id => this.isRunning(id))], {
			identityProvider: { getId: (summary: IWorkflowSummary) => summary.id },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltWorkflows.myWorkflowsAria', "My workflows"),
				getAriaLabel: (summary: IWorkflowSummary) => `${summary.name}, ${triggerSummary(summary.trigger).label}, ${localize('voltWorkflows.nodesAria', "{0} nodes", summary.nodeCount)}`,
			},
		}));
		this.sectionStore.add(list.onDidOpen(e => e.element && this.host.navigate({ page: 'workflow', id: e.element.id })));
		this.sectionStore.add(list.onContextMenu(e => {
			if (!e.element) {
				return;
			}
			EventHelper.stop(e.browserEvent, true);
			const row = e.index !== undefined ? list.getHTMLElement().querySelector<HTMLElement>(`.monaco-list-row[data-index="${e.index}"] .volt-wf-row-action`) : undefined;
			this.showRowMenu(row ?? list.getHTMLElement(), e.element);
		}));
		this.renderWorkflows();
	}

	private isRunning(id: string): boolean {
		const execution = this.workflows.activeExecution(id);
		return !!execution && isLiveRun(execution.run);
	}

	private visibleWorkflows(): IWorkflowSummary[] {
		const query = this.searchInput.value.trim().toLowerCase();
		return this.workflows.list()
			.filter(summary => !query || summary.name.toLowerCase().includes(query) || (summary.description ?? '').toLowerCase().includes(query) || summary.id.includes(query))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private renderWorkflows(): void {
		const list = this.list;
		if (!list || !this.listHost || !this.tableEmpty) {
			return;
		}
		const rows = this.visibleWorkflows();
		const height = rows.length * WORKFLOW_ROW_HEIGHT;
		this.listHost.style.height = `${height}px`;
		this.listHost.style.display = rows.length ? '' : 'none';
		list.layout(height);
		list.splice(0, list.length, rows);
		clearNode(this.tableEmpty);
		this.tableEmpty.style.display = rows.length ? 'none' : '';
		if (!rows.length) {
			if (this.searchInput.value.trim()) {
				this.tableEmpty.textContent = localize('voltWorkflows.noneMatch', "No workflows match.");
			} else {
				append(this.tableEmpty, $('span')).textContent = localize('voltWorkflows.none', "No workflows yet.");
				const templates = append(this.tableEmpty, $('a.volt-auto-link')) as HTMLAnchorElement;
				templates.tabIndex = 0;
				templates.textContent = localize('voltWorkflows.startFromTemplate', "Start from a template");
				this.sectionStore.add(addDisposableListener(templates, EventType.CLICK, () => this.switchTab('templates')));
				append(this.tableEmpty, $('span')).textContent = localize('voltWorkflows.or', "or");
				const create = append(this.tableEmpty, $('a.volt-auto-link')) as HTMLAnchorElement;
				create.tabIndex = 0;
				create.textContent = localize('voltWorkflows.createOne', "create one");
				this.sectionStore.add(addDisposableListener(create, EventType.CLICK, () => this.host.navigate({ page: 'workflow' })));
			}
		}
		this.host.relayout();
	}

	private switchTab(tab: LibraryTab): void {
		// The pill tabs own their buttons; a click on the right one keeps them in sync.
		const index = tab === 'mine' ? 0 : 1;
		this.host.content.querySelectorAll<HTMLButtonElement>('.volt-wf-library > .volt-auto-tabs-row .volt-auto-tab')[index]?.click();
	}

	private showRowMenu(anchor: HTMLElement, summary: IWorkflowSummary): void {
		type Action = 'open' | 'simulate' | 'run' | 'duplicate' | 'export' | 'copy' | 'publish' | 'update' | 'delete';
		const definition = this.workflows.get(summary.id);
		const update = definition ? this.templates.updatesFor(definition) : undefined;
		showVoltMenu<Action>(this.contextView, {
			anchor,
			align: 'right',
			gap: 4,
			width: 220,
			className: 'volt-auto-menu',
			ariaLabel: localize('voltWorkflows.moreActions', "More actions"),
			sections: [
				{
					id: 'main', items: [
						{ id: 'open', label: localize('voltWorkflows.open', "Open"), icon: Codicon.edit, data: 'open' },
						{ id: 'simulate', label: localize('voltWorkflows.simulate', "Simulate"), icon: Codicon.debugAlt, data: 'simulate' },
						{ id: 'run', label: localize('voltWorkflows.run', "Run"), icon: Codicon.play, data: 'run' },
						{ id: 'duplicate', label: localize('voltWorkflows.duplicate', "Duplicate"), icon: Codicon.copy, data: 'duplicate' },
					],
				},
				{
					id: 'share', items: [
						{ id: 'export', label: localize('voltWorkflows.exportYaml', "Export YAML"), icon: Codicon.save, data: 'export' },
						{ id: 'copy', label: localize('voltWorkflows.copyYaml', "Copy YAML"), icon: Codicon.code, data: 'copy' },
						{ id: 'publish', label: localize('voltWorkflows.publish', "Publish as Template"), icon: Codicon.github, data: 'publish' },
						...(update ? [{ id: 'update', label: localize('voltWorkflows.updateAvailable', "Template Update Available"), description: update.sourceLabel, icon: Codicon.sync, data: 'update' as Action }] : []),
					],
				},
				{ id: 'danger', items: [{ id: 'delete', label: localize('voltWorkflows.delete', "Delete"), icon: Codicon.trash, className: 'danger', data: 'delete' }] },
			],
			onPick: async item => {
				switch (item.data) {
					case 'open': this.host.navigate({ page: 'workflow', id: summary.id }); return;
					case 'simulate': await this.start(summary, 'simulate'); return;
					case 'run': await this.start(summary, 'execute'); return;
					case 'duplicate': {
						const copy = await this.workflows.duplicate(summary.id);
						if (copy) {
							this.notifications.info(localize('voltWorkflows.duplicated', "Made \"{0}\".", copy.name));
						}
						return;
					}
					case 'export': await this.exportYaml(summary); return;
					case 'copy': await this.clipboard.writeText(this.workflows.getYaml(summary.id) ?? (definition ? this.workflows.serialize(definition) : '')); return;
					case 'publish':
						if (definition) {
							this.showPublishDialog(definition);
						}
						return;
					case 'update':
						if (update) {
							this.showPreview(update);
						}
						return;
					case 'delete': {
						const { confirmed } = await this.dialogs.confirm({
							message: localize('voltWorkflows.deleteConfirm', "Delete \"{0}\"?", summary.name),
							detail: summary.automationIds.length
								? localize('voltWorkflows.deleteDetailUsed', "Its history and executions are deleted too. {0} automations run it; they stop running it.", summary.automationIds.length)
								: localize('voltWorkflows.deleteDetail', "Its history and executions are deleted too."),
							primaryButton: localize('voltWorkflows.deleteButton', "Delete"),
						});
						if (confirmed) {
							await this.workflows.delete(summary.id);
						}
						return;
					}
				}
			},
		});
	}

	private async start(summary: IWorkflowSummary, mode: WorkflowRunMode): Promise<void> {
		try {
			const execution = await this.workflows.start(summary.id, { mode, trigger: { kind: 'manual', label: mode === 'simulate' ? localize('voltWorkflows.simulatedFromLibrary', "Simulated from the library") : localize('voltWorkflows.ranFromLibrary', "Run from the library") } });
			// The builder's executions panel shows it live.
			this.host.navigate({ page: 'workflow', id: summary.id, run: execution.run.id });
		} catch (error) {
			this.notifications.error(localize('voltWorkflows.startFailed', "{0} did not start: {1}", summary.name, error instanceof Error ? error.message : String(error)));
		}
	}

	private async exportYaml(summary: IWorkflowSummary): Promise<void> {
		const definition = this.workflows.get(summary.id);
		const yaml = this.workflows.getYaml(summary.id) ?? (definition ? this.workflows.serialize(definition) : undefined);
		if (yaml === undefined) {
			return;
		}
		const target = await this.fileDialogs.showSaveDialog({
			title: localize('voltWorkflows.exportTitle', "Export Workflow"),
			defaultUri: joinPath(await this.fileDialogs.defaultFilePath(), `${summary.id}.yaml`),
			filters: [{ name: localize('voltWorkflows.yamlFiles', "Workflow YAML"), extensions: ['yaml', 'yml'] }],
		});
		if (target) {
			await this.fileService.writeFile(target, VSBuffer.fromString(yaml));
		}
	}

	//#endregion

	//#region Import and paste

	private async importFile(): Promise<void> {
		const picked = await this.fileDialogs.showOpenDialog({
			title: localize('voltWorkflows.importTitle', "Import Workflow"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: [{ name: localize('voltWorkflows.yamlFiles', "Workflow YAML"), extensions: ['yaml', 'yml'] }],
		});
		const file = picked?.[0];
		if (!file) {
			return;
		}
		let text: string;
		try {
			text = (await this.fileService.readFile(file)).value.toString();
		} catch (error) {
			this.notifications.error(localize('voltWorkflows.importRead', "Could not read {0}: {1}", file.fsPath, error instanceof Error ? error.message : String(error)));
			return;
		}
		const parsed = this.workflows.parse(text);
		if (!parsed.definition || issueCount(parsed.issues)) {
			// Problems: show them where the text can be fixed before importing.
			this.showPasteDialog(text, file);
			return;
		}
		await this.importText(text, file.toString());
	}

	private async importText(text: string, url?: string): Promise<boolean> {
		// Imported files stay untrusted, whatever `source:` they declare.
		const source: IWorkflowSource = { kind: 'import', ...(url ? { url } : {}) };
		const result = await this.workflows.saveYaml(withWorkflowSource(this.workflows, text, source));
		if (!result.definition) {
			this.notifications.error(localize('voltWorkflows.importFailed', "Not imported: {0}", result.issues.find(issue => issue.severity === 'error')?.message ?? localize('voltWorkflows.unknownProblem', "unknown problem")));
			return false;
		}
		this.host.navigate({ page: 'workflow', id: result.definition.id });
		return true;
	}

	private showPasteDialog(initial = '', file?: URI): void {
		const dialog = this.dialog.value = showAutomationDialog(this.layoutService.activeContainer, file ? localize('voltWorkflows.importProblems', "Fix and Import") : localize('voltWorkflows.pasteYaml', "Paste YAML"), file
			? localize('voltWorkflows.importProblemsHint', "{0} has problems. Fix them here, or import it as is and fix it in the builder.", file.path.split('/').pop() ?? '')
			: localize('voltWorkflows.pasteHint', "Paste a workflow file. It is checked as you type, and imported workflows stay unreviewed until you trust them."), 'volt-wf-paste-dialog');
		const store = dialog.store;
		const box = field(dialog.body, localize('voltWorkflows.yaml', "YAML"));
		const input = store.add(this.instantiationService.createInstance(WorkflowCodeEditor, box, { value: initial, language: 'yaml', ariaLabel: localize('voltWorkflows.pasteYaml', "Paste YAML"), height: 280 }));
		const status = append(dialog.body, $('.volt-wf-parse-status'));
		const issues = renderIssueList(this.instantiationService, dialog.body, store, 6);
		const cancel = button(dialog.footer, 'volt-auto-outline-button', localize('voltWorkflows.cancel', "Cancel"), store, () => dialog.close());
		cancel.classList.add('small');
		const importButton = button(dialog.footer, 'volt-auto-outline-button.small.primary', localize('voltWorkflows.importButton', "Import"), store, async () => {
			importButton.disabled = true;
			const done = await this.importText(input.value, file?.toString());
			if (done) {
				dialog.close();
			} else {
				importButton.disabled = false;
			}
		});
		const check = () => {
			clearNode(status);
			const text = input.value;
			if (!text.trim()) {
				status.className = 'volt-wf-parse-status muted';
				status.textContent = localize('voltWorkflows.pasteEmpty', "Paste YAML above.");
				issues.set([]);
				importButton.disabled = true;
				return;
			}
			const parsed = this.workflows.parse(text);
			const errors = issueCount(parsed.issues);
			const warnings = issueCount(parsed.issues, 'warning');
			importButton.disabled = !parsed.definition;
			status.className = `volt-wf-parse-status ${parsed.definition && !errors ? 'ok' : 'error'}`;
			append(status, $('span.icon')).appendChild(renderIcon(parsed.definition && !errors ? Codicon.pass : Codicon.error));
			const definition = parsed.definition;
			append(status, $('span')).textContent = definition
				? [
					definition.name,
					localize('voltWorkflows.nodesCount', "{0} nodes", definition.nodes.length),
					triggerSummary(definition.trigger).label,
					errors ? localize('voltWorkflows.errorsCount', "{0} errors", errors) : undefined,
					warnings ? localize('voltWorkflows.warningsCount', "{0} warnings", warnings) : undefined,
				].filter(Boolean).join(' · ')
				: localize('voltWorkflows.notAWorkflow', "Not a workflow yet: {0} problems", Math.max(1, errors));
			importButton.querySelector('.label')!.textContent = definition && errors
				? localize('voltWorkflows.importAnyway', "Import with Problems")
				: localize('voltWorkflows.importButton', "Import");
			issues.set(parsed.issues);
		};
		const debounce = store.add(new RunOnceScheduler(check, 200));
		store.add(input.onDidChange(() => debounce.schedule()));
		check();
		input.focus();
	}

	//#endregion

	//#region Publish

	private showPublishDialog(definition: IWorkflowDefinition): void {
		const info = this.templates.publishUrl(definition);
		const dialog = this.dialog.value = showAutomationDialog(this.layoutService.activeContainer, localize('voltWorkflows.publishTitle', "Publish \"{0}\" as a Template", definition.name), localize('voltWorkflows.publishHint', "Templates are YAML files in Volt's repository. GitHub opens a new file under workflow-templates/templates and offers to fork the repository and open a pull request. CI checks the file, and a maintainer reviews it."), 'volt-wf-publish-dialog');
		const store = dialog.store;
		const step1 = field(dialog.body, localize('voltWorkflows.publishStep1', "1. Create {0} on GitHub", info.fileName));
		const row1 = append(step1, $('.volt-wf-dialog-row'));
		button(row1, 'volt-auto-outline-button.small.primary', localize('voltWorkflows.openGithub', "Open GitHub"), store, () => void this.opener.open(URI.parse(info.url), { openExternal: true }), Codicon.github);
		const copyYaml = button(row1, 'volt-auto-outline-button.small', localize('voltWorkflows.copyYaml', "Copy YAML"), store, () => {
			void this.clipboard.writeText(info.yaml);
			flashLabel(copyYaml, localize('voltWorkflows.copied', "Copied"));
		}, Codicon.copy);
		append(step1, $('.volt-auto-note')).textContent = info.prefilled
			? localize('voltWorkflows.prefilled', "The page opens with the workflow filled in.")
			: localize('voltWorkflows.notPrefilled', "The workflow is too long to fill in: copy the YAML and paste it into the page.");
		const step2 = field(dialog.body, localize('voltWorkflows.publishStep2', "2. Add this entry to workflow-templates/index.json in the same pull request"));
		store.add(this.instantiationService.createInstance(WorkflowCodeEditor, step2, {
			value: info.indexEntry,
			language: 'json',
			readOnly: true,
			ariaLabel: localize('voltWorkflows.indexEntry', "index.json entry"),
			height: Math.min(14, info.indexEntry.split('\n').length) * 18 + 16,
		}));
		const row2 = append(step2, $('.volt-wf-dialog-row'));
		const copyEntry = button(row2, 'volt-auto-outline-button.small', localize('voltWorkflows.copyEntry', "Copy Entry"), store, () => {
			void this.clipboard.writeText(info.indexEntry);
			flashLabel(copyEntry, localize('voltWorkflows.copied', "Copied"));
		}, Codicon.copy);
		const permissions = workflowPermissions(definition);
		if (permissions.length) {
			append(dialog.body, $('.volt-auto-note')).textContent = localize('voltWorkflows.publishPermissions', "People who use it will see that it needs: {0}.", permissions.map(permissionLabel).join(', '));
		}
		button(dialog.footer, 'volt-auto-outline-button.small', localize('voltWorkflows.done', "Done"), store, () => dialog.close());
	}

	//#endregion

	//#region Templates

	private renderTemplatesTab(): void {
		this.sourcesBar = append(this.section, $('.volt-wf-sources'));
		append(this.section, $('p.volt-auto-note.volt-wf-lib-note')).textContent = localize('voltWorkflows.communityNote', "Community templates are YAML files in GitHub repositories. Volt checks each one, and copies stay unreviewed until you trust them: nothing runs on install. Publish yours from its menu in My Workflows.");
		this.grid = append(this.section, $('.volt-auto-template-grid.volt-wf-template-grid'));
		this.renderTemplatesBody();
		void this.templates.ensureFresh();
	}

	private renderTemplatesBody(): void {
		if (!this.grid || !this.sourcesBar) {
			return;
		}
		const sources = this.templates.sources();
		if (this.sourceFilter && !sources.some(info => info.source.id === this.sourceFilter)) {
			this.sourceFilter = lastSourceFilter = undefined;
		}
		this.renderSources(sources);
		this.gridStore.clear();
		clearNode(this.grid);
		const query = this.searchInput.value.trim().toLowerCase();
		const templates = this.templates.list(this.sourceFilter).filter(template => !query
			|| template.name.toLowerCase().includes(query)
			|| template.description.toLowerCase().includes(query)
			|| (template.author ?? '').toLowerCase().includes(query)
			|| template.tags.some(tag => tag.toLowerCase().includes(query))
			|| template.nodeTypes.some(type => type.includes(query) || (getWorkflowNodeType(type)?.label.toLowerCase().includes(query) ?? false)));
		if (!templates.length) {
			const loading = sources.some(info => info.loading && (!this.sourceFilter || info.source.id === this.sourceFilter));
			const empty = append(this.grid, $('.volt-auto-empty.small.volt-wf-grid-empty'));
			empty.textContent = loading
				? localize('voltWorkflows.loadingTemplates', "Loading templates…")
				: query ? localize('voltWorkflows.noTemplatesMatch', "No templates match.") : localize('voltWorkflows.noTemplates', "No templates here yet.");
		}
		for (const template of templates) {
			this.renderCard(this.grid, template);
		}
		this.host.relayout();
	}

	private renderSources(sources: readonly IWorkflowTemplateSourceInfo[]): void {
		const bar = this.sourcesBar!;
		this.sourcesStore.clear();
		clearNode(bar);
		const chip = (id: string | undefined, label: string, count: number | undefined, info?: IWorkflowTemplateSourceInfo) => {
			const element = append(bar, $('.volt-wf-source-chip'));
			element.classList.toggle('active', this.sourceFilter === id);
			const pick = append(element, $('button.volt-wf-source-pick')) as HTMLButtonElement;
			pick.type = 'button';
			pick.setAttribute('aria-pressed', String(this.sourceFilter === id));
			if (info?.loading) {
				append(pick, $('span.icon')).appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
			} else if (info?.error) {
				append(pick, $('span.icon.error')).appendChild(renderIcon(Codicon.warning));
			} else if (info) {
				append(pick, $('span.icon')).appendChild(renderIcon(info.kind === 'builtIn' ? Codicon.package : info.kind === 'official' ? Codicon.verifiedFilled : Codicon.github));
			}
			append(pick, $('span.label')).textContent = label;
			if (count !== undefined) {
				append(pick, $('span.count')).textContent = String(count);
			}
			const tooltip = info ? [
				info.source.url || localize('voltWorkflows.bundled', "Bundled with Volt"),
				info.kind === 'community' ? localize('voltWorkflows.communitySource', "Community source: copies stay unreviewed until you trust them.") : undefined,
				info.fetchedAt ? localize('voltWorkflows.fetched', "Fetched {0} ago", formatAge(info.fetchedAt, Date.now())) : undefined,
				info.invalid ? localize('voltWorkflows.invalidCount', "{0} templates have problems", info.invalid) : undefined,
				info.error ? localize('voltWorkflows.sourceError', "Last refresh failed: {0}", info.error) : undefined,
			].filter(Boolean).join('\n') : localize('voltWorkflows.allSources', "Every source");
			setAgentTooltip(pick, tooltip);
			this.sourcesStore.add(addDisposableListener(pick, EventType.CLICK, () => {
				this.sourceFilter = lastSourceFilter = this.sourceFilter === id || id === undefined ? undefined : id;
				this.renderTemplatesBody();
			}));
			if (info && info.kind !== 'builtIn') {
				const tools = append(element, $('span.volt-wf-source-tools'));
				const refresh = iconButton(tools, Codicon.refresh, localize('voltWorkflows.refreshSource', "Refresh {0}", label), this.sourcesStore, () => void this.templates.refresh(info.source.id), 'volt-auto-icon-button.volt-wf-source-tool');
				refresh.disabled = info.loading;
				if (info.kind === 'community') {
					iconButton(tools, Codicon.close, localize('voltWorkflows.removeSource', "Remove {0}", label), this.sourcesStore, () => void this.removeSource(info), 'volt-auto-icon-button.volt-wf-source-tool');
				}
			}
		};
		chip(undefined, localize('voltWorkflows.all', "All"), undefined);
		for (const info of sources) {
			chip(info.source.id, info.kind === 'builtIn' ? localize('voltWorkflows.builtIn', "Built-in") : info.source.label, info.loading && !info.count ? undefined : info.count, info);
		}
		const add = button(bar, 'volt-auto-outline-button.small.volt-wf-add-source', localize('voltWorkflows.addSource', "Add Source"), this.sourcesStore, () => this.showAddSourceDialog(), Codicon.add);
		setAgentTooltip(add, localize('voltWorkflows.addSourceHint', "Add a GitHub repository or a .yaml URL with workflow templates"));
	}

	private async removeSource(info: IWorkflowTemplateSourceInfo): Promise<void> {
		const { confirmed } = await this.dialogs.confirm({
			message: localize('voltWorkflows.removeSourceConfirm', "Remove {0}?", info.source.label),
			detail: localize('voltWorkflows.removeSourceDetail', "Its templates leave the gallery. Workflows you made from them stay."),
			primaryButton: localize('voltWorkflows.remove', "Remove"),
		});
		if (confirmed) {
			this.templates.removeSource(info.source.id);
		}
	}

	private showAddSourceDialog(): void {
		const dialog = this.dialog.value = showAutomationDialog(this.layoutService.activeContainer, localize('voltWorkflows.addSourceTitle', "Add a Template Source"), localize('voltWorkflows.addSourceSubtitle', "A GitHub repository (with an index.json, or .yaml files), an index.json URL, or a single .yaml file. Every template in it is checked, and copies stay unreviewed until you trust them."));
		const store = dialog.store;
		const box = field(dialog.body, localize('voltWorkflows.sourceUrl', "URL"));
		const input = append(box, $('input.volt-auto-input')) as HTMLInputElement;
		input.placeholder = 'https://github.com/owner/repo';
		input.spellcheck = false;
		const note = append(dialog.body, $('.volt-auto-note'));
		const cancel = button(dialog.footer, 'volt-auto-outline-button', localize('voltWorkflows.cancel', "Cancel"), store, () => dialog.close());
		cancel.classList.add('small');
		const add = button(dialog.footer, 'volt-auto-outline-button.small.primary', localize('voltWorkflows.add', "Add"), store, () => void submit());
		const validate = (): string | undefined => {
			const value = input.value.trim();
			if (!value) {
				return '';
			}
			let url: URL;
			try {
				url = new URL(value);
			} catch {
				return localize('voltWorkflows.sourceNotUrl', "Enter a GitHub repository, an index.json or a .yaml URL.");
			}
			if (url.protocol !== 'https:') {
				return localize('voltWorkflows.sourceHttps', "Template sources must use https.");
			}
			return resolveTemplateSource(value).error;
		};
		const sync = () => {
			const problem = validate();
			add.disabled = problem !== undefined;
			input.classList.toggle('invalid', !!problem);
			note.classList.toggle('error', !!problem);
			note.textContent = problem || (input.value.trim() ? localize('voltWorkflows.sourceWillBe', "Shown as {0}.", templateSourceLabel(input.value.trim())) : '');
		};
		const submit = async () => {
			if (add.disabled) {
				return;
			}
			add.disabled = true;
			input.disabled = true;
			note.classList.remove('error');
			note.textContent = localize('voltWorkflows.checkingSource', "Fetching and checking templates…");
			try {
				const info = await this.templates.addSource(input.value);
				this.sourceFilter = lastSourceFilter = info.source.id;
				dialog.close();
				this.renderTemplatesBody();
				if (info.invalid) {
					this.notifications.warn(localize('voltWorkflows.sourceAddedInvalid', "Added {0}: {1} templates, {2} with problems.", info.source.label, info.count, info.invalid));
				}
			} catch (error) {
				input.disabled = false;
				add.disabled = false;
				note.classList.add('error');
				note.textContent = error instanceof Error ? error.message : String(error);
				input.focus();
			}
		};
		store.add(addDisposableListener(input, EventType.INPUT, sync));
		store.add(addDisposableListener(input, EventType.KEY_DOWN, e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void submit();
			}
		}));
		sync();
	}

	private renderCard(grid: HTMLElement, template: IWorkflowTemplate): void {
		const card = append(grid, $('button.volt-auto-template.volt-wf-template-card')) as HTMLButtonElement;
		card.type = 'button';
		card.classList.toggle('invalid', !template.valid);
		const icon = append(card, $('span.volt-auto-round-icon'));
		icon.appendChild(renderIcon(template.icon ? ThemeIcon.fromId(template.icon) : template.nodeTypes[0] ? nodeTypeIcon(template.nodeTypes[0]) : Codicon.typeHierarchy));
		const text = append(card, $('span.text'));
		append(text, $('span.name')).textContent = template.name;
		if (template.description) {
			append(text, $('span.description')).textContent = template.description;
		}
		const chips = append(text, $('span.volt-wf-chips'));
		const types = template.nodeTypes.slice(0, 7);
		for (const type of types) {
			const chip = append(chips, $('span.volt-wf-type-chip'));
			chip.appendChild(renderIcon(nodeTypeIcon(type)));
			setAgentTooltip(chip, getWorkflowNodeType(type)?.label ?? type);
		}
		if (template.nodeTypes.length > types.length) {
			append(chips, $('span.volt-wf-more-chip')).textContent = `+${template.nodeTypes.length - types.length}`;
		}
		for (const permission of template.permissions) {
			const chip = append(chips, $('span.volt-wf-perm-chip'));
			chip.textContent = permissionLabel(permission);
			setAgentTooltip(chip, permissionDescription(permission));
		}
		const foot = append(text, $('span.volt-wf-card-foot'));
		const errors = issueCount(template.issues);
		if (!template.valid) {
			append(foot, $('span.volt-wf-invalid')).textContent = errors === 1
				? localize('voltWorkflows.invalidOne', "Invalid: 1 issue")
				: localize('voltWorkflows.invalidMany', "Invalid: {0} issues", Math.max(1, errors));
		}
		append(foot, $('span')).textContent = [template.author, template.sourceKind === 'builtIn' ? localize('voltWorkflows.builtIn', "Built-in") : template.sourceLabel].filter(Boolean).join(' · ');
		if (template.sourceKind === 'community') {
			append(foot, $('span.volt-wf-badge.untrusted')).textContent = localize('voltWorkflows.community', "Community");
		}
		this.gridStore.add(addDisposableListener(card, EventType.CLICK, () => this.showPreview(template)));
	}

	//#endregion

	//#region Template preview

	private showPreview(template: IWorkflowTemplate): void {
		const dialog = this.dialog.value = showAutomationDialog(this.layoutService.activeContainer, template.name, template.description || undefined, 'volt-wf-template-dialog');
		const store = dialog.store;
		const meta = append(dialog.body, $('.volt-wf-preview-meta'));
		append(meta, $('span')).textContent = [
			template.sourceKind === 'builtIn' ? localize('voltWorkflows.builtIn', "Built-in") : template.sourceLabel,
			template.author,
			template.definition ? localize('voltWorkflows.nodesCount', "{0} nodes", template.definition.nodes.length) : undefined,
			template.definition ? triggerSummary(template.definition.trigger).label : undefined,
		].filter(Boolean).join(' · ');
		if (template.sourceKind === 'community') {
			const note = append(dialog.body, $('.volt-wf-untrusted-note'));
			append(note, $('span.icon')).appendChild(renderIcon(Codicon.shield));
			append(note, $('span')).textContent = localize('voltWorkflows.untrustedNote', "Untrusted until you review it. Using it saves a copy and runs nothing; before it runs for real, Volt lists what it can do and asks you.");
		}

		type PreviewTab = 'preview' | 'yaml' | 'permissions' | 'issues';
		const issues = template.issues;
		const tabs: { id: PreviewTab; label: string }[] = [
			{ id: 'preview', label: localize('voltWorkflows.preview', "Preview") },
			{ id: 'yaml', label: 'YAML' },
			{ id: 'permissions', label: localize('voltWorkflows.permissions', "Permissions") },
			...(issues.length ? [{ id: 'issues' as PreviewTab, label: localize('voltWorkflows.issuesTab', "Issues ({0})", issues.length) }] : []),
		];
		const initial: PreviewTab = template.valid ? 'preview' : 'issues';
		pillTabs<PreviewTab>(dialog.body, tabs, initial, store, tab => show(tab), 'volt-wf-preview-tabs');
		const panes = new Map<PreviewTab, HTMLElement>();
		for (const tab of tabs) {
			panes.set(tab.id, append(dialog.body, $(`.volt-wf-preview-pane.pane-${tab.id}`)));
		}
		const rendered = new Set<PreviewTab>();
		const show = (tab: PreviewTab) => {
			for (const [id, pane] of panes) {
				pane.style.display = id === tab ? '' : 'none';
			}
			if (!rendered.has(tab)) {
				rendered.add(tab);
				this.renderPreviewPane(tab, panes.get(tab)!, template, store);
			}
		};
		show(initial);

		if (template.htmlUrl || template.url) {
			const url = template.htmlUrl ?? template.url!;
			button(dialog.footer, 'volt-auto-outline-button.small', localize('voltWorkflows.openSource', "Open Source"), store, () => void this.opener.open(URI.parse(url), { openExternal: true }), Codicon.linkExternal);
		}
		const use = button(dialog.footer, 'volt-auto-outline-button.small.primary', localize('voltWorkflows.useTemplate', "Use Template"), store, async () => {
			use.disabled = true;
			try {
				const definition = await this.templates.install(template);
				dialog.close();
				this.host.navigate({ page: 'workflow', id: definition.id });
			} catch (error) {
				use.disabled = false;
				this.notifications.error(error instanceof Error ? error.message : String(error));
			}
		});
		use.disabled = !template.valid;
		if (!template.valid) {
			setAgentTooltip(use, localize('voltWorkflows.cantUse', "Fix the issues in the template's repository first."));
		}
	}

	private renderPreviewPane(tab: 'preview' | 'yaml' | 'permissions' | 'issues', pane: HTMLElement, template: IWorkflowTemplate, store: DisposableStore): void {
		const definition = template.definition;
		switch (tab) {
			case 'preview': {
				if (!definition) {
					append(pane, $('.volt-wf-run-empty.small')).textContent = localize('voltWorkflows.noPreview', "Nothing to preview: the file did not parse.");
					return;
				}
				this.mountPreviewCanvas(pane, definition, store);
				return;
			}
			case 'yaml': {
				store.add(this.instantiationService.createInstance(WorkflowCodeEditor, pane, { value: template.yaml ?? '', language: 'yaml', readOnly: true, ariaLabel: localize('voltWorkflows.templateYaml', "Template YAML"), height: 400 }));
				return;
			}
			case 'permissions': {
				if (!definition) {
					append(pane, $('.volt-wf-run-empty.small')).textContent = localize('voltWorkflows.noPermissionsParse', "Permissions show once the file parses.");
					return;
				}
				const rows = permissionRows(definition);
				if (!rows.length) {
					append(pane, $('.volt-wf-run-empty.small')).textContent = localize('voltWorkflows.noPermissions', "Needs no permissions: it only moves data between its own steps.");
					return;
				}
				const host = append(pane, $('.volt-wf-perm-list'));
				const height = rows.length * PERMISSION_ROW_HEIGHT;
				host.style.height = `${height}px`;
				const list = store.add(this.instantiationService.createInstance(WorkbenchList<IPermissionRow>, 'VoltWorkflowPermissions', host, {
					getHeight: () => PERMISSION_ROW_HEIGHT,
					getTemplateId: () => PermissionRenderer.ID,
				} satisfies IListVirtualDelegate<IPermissionRow>, [new PermissionRenderer()], {
					multipleSelectionSupport: false,
					horizontalScrolling: false,
					alwaysConsumeMouseWheel: false,
					accessibilityProvider: {
						getWidgetAriaLabel: () => localize('voltWorkflows.permissions', "Permissions"),
						getAriaLabel: (row: IPermissionRow) => `${permissionLabel(row.permission)}: ${row.nodes.join(', ')}`,
					},
				}));
				list.layout(height);
				list.splice(0, 0, rows);
				return;
			}
			case 'issues': {
				const list = renderIssueList(this.instantiationService, pane, store, 12);
				list.set(template.issues);
				return;
			}
		}
	}

	/** The builder's canvas, read-only (pan and zoom, fitted), over the parsed definition. */
	private mountPreviewCanvas(pane: HTMLElement, definition: IWorkflowDefinition, store: DisposableStore): void {
		const host = append(pane, $('.volt-wf-preview-canvas'));
		const model = store.add(new WorkflowEditorModel(definition));
		const canvas = store.add(this.instantiationService.createInstance(WorkflowCanvas, host, model, { readOnly: true, minimap: false }));
		// The dialog sizes itself to the window: follow it.
		const win = getWindow(host);
		const observer = new win.ResizeObserver(() => canvas.layout(host.clientWidth, host.clientHeight));
		observer.observe(host);
		store.add({ dispose: () => observer.disconnect() });
		canvas.layout(host.clientWidth, host.clientHeight);
	}

	//#endregion
}
