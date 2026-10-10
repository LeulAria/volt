/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IVoltPullRequestService } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IVoltRelayService, IVoltRelayState } from '../../../../../platform/voltRelay/common/voltRelay.js';
import { IWorkspacesService, isRecentFolder } from '../../../../../platform/workspaces/common/workspaces.js';
import {
	AutomationSchedule, AutomationToolKind, defaultSchedule, describeSchedule, formatTimeOfDay, gmtOffsetLabel, IAutomation, IAutomationDraft, IAutomationRepository, IAutomationService,
	IAutomationTool, IAutomationTrigger, isActiveRun, nextScheduleAt, parseTimeOfDay, validateSchedule, weekdayName,
} from '../../../../services/voltRuntime/common/automations/automations.js';
import { automationTemplate } from '../../../../services/voltRuntime/common/automations/automationTemplates.js';
import { AutomationProvider, eventLabel, eventOption, providerLabel, providerSignature } from '../../../../services/voltRuntime/common/automations/automationTriggers.js';
import { formatWebhookFilter, IAgentWebhookFilter, IAgentWebhookTrigger, newWebhookTrigger, parseWebhookFilter } from '../../../../services/voltRuntime/common/automations/automationWebhooks.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { OPEN_AGENT_COMMAND_ID, OPEN_AGENT_CUSTOMIZE_COMMAND_ID } from '../editor/agentEditorInput.js';
import { IVoltMenuHandle, IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';
import { formatNextRun, formatScheduleWhen } from './automationFormat.js';
import { connectVoltRelay, hookUrl } from './automationHooks.js';
import { clockIcon, mcpIcon, memoriesIcon, providerIcon, toolKindIcon } from './automationIcons.js';
import { forgetRemoteNames, IRepositoryCandidate, modelButtonLabel, modelChoices, showMinuteMenu, showModelMenu, showRepositoryMenu, showTimeMenu, showToolMenu, showTriggerMenu, showWeekdayMenu, ToolPick } from './automationPickers.js';
import { AutomationsRoute, IAutomationSeed, IAutomationsHost, IAutomationsPage } from './automationRoutes.js';
import { RunHistoryPanel } from './automationRunsView.js';
import { breadcrumb, button, field, flashLabel, iconButton, pillTabs, sectionLabel, showAutomationDialog, toggleSwitch } from './automationUi.js';

type Tab = 'settings' | 'runs';

type MutableDraft = { -readonly [K in keyof IAutomationDraft]: IAutomationDraft[K] };

function newId(prefix: string): string {
	return `${prefix}-${generateUuid().replace(/-/g, '').slice(0, 10)}`;
}

function newHook(): IAgentWebhookTrigger {
	return newWebhookTrigger(`hook_${generateUuid().replace(/-/g, '')}`, generateUuid().replace(/-/g, ''));
}

function configOf(automation: IAutomationDraft): IAutomationDraft {
	return {
		name: automation.name,
		instructions: automation.instructions,
		enabled: automation.enabled,
		triggers: automation.triggers,
		repositories: automation.repositories,
		tools: automation.tools,
		...(automation.modelRef ? { modelRef: automation.modelRef } : {}),
		...(automation.mode ? { mode: automation.mode } : {}),
		...(automation.shared ? { shared: true } : {}),
		...(automation.templateId ? { templateId: automation.templateId } : {}),
		...(automation.threadId ? { threadId: automation.threadId } : {}),
	};
}

/** The automation as JSON without its secrets (signing secrets, webhook URLs, tokens): safe to paste anywhere. */
export function automationJson(automation: IAutomationDraft): string {
	const config = configOf(automation);
	return JSON.stringify({
		...config,
		triggers: config.triggers.map(trigger => ({
			provider: trigger.provider,
			event: trigger.event,
			...(trigger.schedule ? { schedule: trigger.schedule } : {}),
			...(trigger.option ? { option: trigger.option } : {}),
			...(trigger.hook ? { signature: trigger.hook.signature.kind, filters: trigger.hook.filters.map(formatWebhookFilter) } : {}),
		})),
		tools: config.tools.map(tool => ({ kind: tool.kind, ...(tool.server ? { server: tool.server } : {}), ...(tool.channel ? { channel: tool.channel } : {}) })),
		repositories: config.repositories.map(repository => repository.owner ? `${repository.owner}/${repository.name}` : repository.name),
	}, null, 2);
}

function seededDraft(seed: IAutomationSeed | undefined, defaults: { readonly modelRef?: string; readonly repository?: IAutomationRepository }): MutableDraft {
	const template = automationTemplate(seed?.templateId);
	const triggers: IAutomationTrigger[] = (template?.triggers ?? []).map(trigger => ({
		id: newId('tr'),
		provider: trigger.provider,
		event: trigger.event,
		...(trigger.schedule ? { schedule: trigger.schedule } : {}),
		...(trigger.provider !== 'schedule' ? { hook: newHook() } : {}),
	}));
	const tools: IAutomationTool[] = [{ id: newId('t'), kind: 'memories' }, ...(template?.tools ?? []).map(kind => ({ id: newId('t'), kind }))];
	const modelRef = seed?.modelRef ?? defaults.modelRef;
	return {
		name: template?.title ?? localize('voltAutomations.untitled', "Untitled"),
		instructions: template?.instructions ?? seed?.instructions ?? '',
		enabled: false,
		triggers,
		repositories: defaults.repository ? [defaults.repository] : [],
		tools,
		...(modelRef ? { modelRef } : {}),
		...(seed?.mode ? { mode: seed.mode } : {}),
		...(template ? { templateId: template.id } : {}),
	};
}

/** Short how-to under a trigger's URL: where the sender takes it. */
function setupHint(provider: AutomationProvider): string {
	switch (provider) {
		case 'github': return localize('voltAutomations.hintGithub', "GitHub: Settings → Webhooks → Add webhook. Paste the URL, content type application/json, the secret below, and pick the events (or Send me everything).");
		case 'slack': return localize('voltAutomations.hintSlack', "Slack app: Event Subscriptions → Request URL (Volt answers the challenge), subscribe to message.channels / reaction_added / channel_created. Signing secret from Basic Information.");
		case 'teams': return localize('voltAutomations.hintTeams', "Teams: create an Outgoing Webhook with this URL; its security token goes in the secret. Or a Microsoft Graph subscription to channel messages.");
		case 'sentry': return localize('voltAutomations.hintSentry', "Sentry: Settings → Developer Settings → Internal Integration. Webhook URL, enable Issue alerts; the client secret signs requests.");
		case 'linear': return localize('voltAutomations.hintLinear', "Linear: Settings → API → Webhooks → New webhook. Resource types Issues and Cycles; copy its signing secret here.");
		case 'pagerduty': return localize('voltAutomations.hintPagerDuty', "PagerDuty: Integrations → Generic Webhooks (v3). Add this URL, choose incident events, and copy the signing secret.");
		default: return localize('voltAutomations.hintWebhook', "POST JSON to the URL from anything. Use {{payload.field}} in the instructions to insert a value. With a secret, sign the body as HMAC-SHA256 in X-Volt-Signature: sha256=<hex>.");
	}
}

function toolLabel(tool: IAutomationTool): string {
	switch (tool.kind) {
		case 'memories': return localize('voltAutomations.memories', "Memories");
		case 'mcp': return tool.server ?? localize('voltAutomations.mcpServer', "MCP Server");
		case 'slack_send': return localize('voltAutomations.sendSlack', "Send to Slack");
		case 'slack_read': return localize('voltAutomations.readSlack', "Read Public Slack Channels");
		case 'teams_send': return localize('voltAutomations.sendTeams', "Send to Microsoft Teams");
		case 'teams_read': return localize('voltAutomations.readTeams', "Read Microsoft Teams Channels");
	}
}

function toolNeedsSetup(tool: IAutomationTool): boolean {
	switch (tool.kind) {
		case 'slack_send':
		case 'teams_send': return !tool.url;
		case 'slack_read':
		case 'teams_read': return !tool.token || !tool.channel;
		default: return false;
	}
}

/** Snippets for `/` in the instructions. */
const COMMANDS: readonly { readonly id: string; readonly label: string; readonly detail: string; readonly text: string }[] = [
	{ id: 'memory', label: '/memory', detail: localize('voltAutomations.cmdMemory', "Keep a memory across runs"), text: 'Before doing anything else, read MEMORIES.md. Skip anything already recorded there, and record what you report (one line each, with a link and today\'s date) before finishing.' },
	{ id: 'report', label: '/report', detail: localize('voltAutomations.cmdReport', "End with a short report"), text: '## Output\n\nEnd with a short report: what you checked, what you found, what you changed (with links). If nothing needed doing, say so in one line.' },
	{ id: 'pr', label: '/pr', detail: localize('voltAutomations.cmdPr', "Open a PR only when confident"), text: 'Only open a pull request when you are highly confident the change is correct and tested. One PR per run, with a clear description.' },
	{ id: 'quiet', label: '/quiet', detail: localize('voltAutomations.cmdQuiet', "Stay quiet when nothing is found"), text: 'If there is nothing worth reporting, do not send any message; finish with "Nothing to report."' },
	{ id: 'payload', label: '/payload', detail: localize('voltAutomations.cmdPayload', "Insert a webhook field"), text: '{{payload.}}' },
];

/**
 * One automation: its name, Active switch, repository and author; Settings (triggers, agent
 * instructions with the model, tools) and Run History. Edits stay a draft until Save; the switch
 * applies at once. A new automation (from New Automation or a template) is unsaved until Save.
 */
export class AutomationDetailView extends Disposable implements IAutomationsPage {

	private draft: MutableDraft;
	private baseline: string;
	private saved: IAutomation | undefined;
	private id: string | undefined;
	private tab: Tab;
	private readonly seeded: boolean;
	private repoTouched = false;
	private relayState: IVoltRelayState = { status: 'off' };
	private readonly expanded = new Set<string>();
	private candidates: IRepositoryCandidate[] = [];

	private readonly barStore = this._register(new DisposableStore());
	/** The header's controls: they live as long as the page, unlike the body's. */
	private readonly headStore = this._register(new DisposableStore());
	private readonly bodyStore = this._register(new DisposableStore());
	private readonly triggerStore = this._register(new DisposableStore());
	private readonly toolStore = this._register(new DisposableStore());
	private readonly panel = this._register(new MutableDisposable<RunHistoryPanel>());
	private readonly mentionMenu = this._register(new MutableDisposable<IVoltMenuHandle>());
	private readonly refresh = this._register(new RunOnceScheduler(() => this.onServiceChange(), 40));

	private readonly page: HTMLElement;
	private saveButton: HTMLButtonElement | undefined;
	private crumbName: HTMLElement | undefined;
	private titleInput!: HTMLInputElement;
	private switchEl!: HTMLButtonElement;
	private statusLabel!: HTMLElement;
	private repoButton: HTMLButtonElement | undefined;
	private tabsRow!: HTMLElement;
	private toolbar!: HTMLElement;
	private body!: HTMLElement;
	private triggersCard: HTMLElement | undefined;
	private toolsCard: HTMLElement | undefined;
	private instructions: HTMLTextAreaElement | undefined;

	constructor(
		private readonly host: IAutomationsHost,
		route: Extract<AutomationsRoute, { page: 'detail' }>,
		@IAutomationService private readonly automations: IAutomationService,
		@IContextViewService private readonly contextView: IContextViewService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IDialogService private readonly dialogs: IDialogService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@INotificationService private readonly notifications: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IVoltPullRequestService private readonly pullRequests: IVoltPullRequestService,
		@IVoltRelayService private readonly relay: IVoltRelayService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IWorkspacesService private readonly workspaces: IWorkspacesService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.tab = route.tab;
		this.saved = route.id ? automations.get(route.id) : undefined;
		this.id = this.saved?.id;
		this.seeded = !this.saved && !!(route.seed?.templateId || route.seed?.instructions);
		if (this.saved) {
			this.draft = { ...configOf(this.saved) };
		} else {
			const threadProject = route.seed?.threadId ? this.sessionContext.bindingFor(route.seed.threadId) : undefined;
			const project = threadProject ? this.sessionContext.getProject(threadProject.projectId) : undefined;
			this.draft = seededDraft(route.seed, {
				...(runtime.getActiveCatalogRef() ? { modelRef: runtime.getActiveCatalogRef() } : {}),
				...(project && !project.scratch ? { repository: { root: project.root.toString(), name: project.displayName } } : {}),
			});
			this.repoTouched = !!project;
		}
		this.baseline = JSON.stringify(configOf(this.draft));
		this.page = append(host.content, $('.volt-auto-page.detail'));
		if (route.id && !this.saved) {
			this.renderMissing();
			return;
		}
		this.render();
		this._register(automations.onDidChange(() => this.refresh.schedule()));
		this._register(relay.onDidChangeState(state => {
			this.relayState = state;
			this.renderTriggersIfIdle();
		}));
		void relay.getState().then(state => {
			this.relayState = state;
			this.renderTriggersIfIdle();
		});
		void this.loadCandidates();
	}

	focus(): void {
		if (!this.saved && !this.seeded) {
			this.titleInput?.select();
		}
		(this.titleInput ?? this.page).focus();
	}

	//#region Draft

	private isDirty(): boolean {
		return JSON.stringify(configOf(this.draft)) !== this.baseline;
	}

	private canSave(): boolean {
		return this.isDirty() || (!this.saved && this.seeded);
	}

	private changed(): void {
		this.saveButton?.classList.toggle('dirty', this.canSave());
		if (this.saveButton) {
			this.saveButton.disabled = !this.canSave();
		}
	}

	private setDraft(patch: Partial<MutableDraft>, redraw?: 'triggers' | 'tools' | 'meta'): void {
		this.draft = { ...this.draft, ...patch };
		this.changed();
		if (redraw === 'triggers') {
			this.renderTriggers();
		} else if (redraw === 'tools') {
			this.renderTools();
		} else if (redraw === 'meta') {
			this.syncMeta();
		}
	}

	async canLeave(): Promise<boolean> {
		if (!this.isDirty() || (!this.saved && !this.seeded && this.draft.instructions.trim() === '' && !this.draft.triggers.length)) {
			return true;
		}
		const { confirmed } = await this.dialogs.confirm({
			message: localize('voltAutomations.unsaved', "Discard unsaved changes to \"{0}\"?", this.draft.name),
			primaryButton: localize('voltAutomations.discard', "Discard"),
		});
		return confirmed;
	}

	private validate(): string | undefined {
		for (const trigger of this.draft.triggers) {
			const error = trigger.schedule ? validateSchedule(trigger.schedule) : undefined;
			if (error) {
				return localize('voltAutomations.badTrigger', "{0}: {1}", describeSchedule(trigger.schedule!), error);
			}
		}
		return undefined;
	}

	private async save(): Promise<IAutomation | undefined> {
		const error = this.validate();
		if (error) {
			this.notifications.error(error);
			return undefined;
		}
		const draft = { ...this.draft, name: this.draft.name.trim() || localize('voltAutomations.untitled', "Untitled") };
		let result: IAutomation | undefined;
		if (this.id) {
			// Optional fields left out of the draft (Auto model, not shared) must clear the stored ones.
			result = await this.automations.update(this.id, { ...draft, modelRef: draft.modelRef, mode: draft.mode, shared: draft.shared, templateId: draft.templateId, threadId: draft.threadId });
		} else {
			result = await this.automations.create(draft);
			this.id = result.id;
			this.host.setRoute({ page: 'detail', id: result.id, tab: this.tab });
		}
		if (result) {
			this.saved = result;
			this.draft = { ...configOf(result) };
			this.baseline = JSON.stringify(configOf(this.draft));
			this.changed();
			this.syncMeta();
			if (!this.triggersCard?.contains(getWindow(this.page).document.activeElement)) {
				this.renderTriggers();
			}
		}
		return result;
	}

	//#endregion

	//#region Service updates

	private onServiceChange(): void {
		if (!this.id) {
			return;
		}
		const latest = this.automations.get(this.id);
		if (!latest) {
			this.host.navigate({ page: 'list' });
			return;
		}
		this.saved = latest;
		// Changes made elsewhere (the row's switch, an agent) show at once when nothing here is unsaved.
		if (!this.isDirty() && JSON.stringify(configOf(latest)) !== this.baseline) {
			this.draft = { ...configOf(latest) };
			this.baseline = JSON.stringify(configOf(this.draft));
			if (this.tab === 'settings' && !this.page.contains(getWindow(this.page).document.activeElement)) {
				this.renderBody();
			}
		} else if (this.draft.enabled !== latest.enabled && !this.isDirty()) {
			this.draft = { ...this.draft, enabled: latest.enabled };
			this.baseline = JSON.stringify(configOf(this.draft));
		}
		this.syncMeta();
		this.syncBar();
		this.renderTriggersIfIdle();
	}

	private renderTriggersIfIdle(): void {
		if (this.tab === 'settings' && this.triggersCard && !this.triggersCard.contains(getWindow(this.page).document.activeElement)) {
			this.renderTriggers();
		}
	}

	//#endregion

	//#region Layout

	private renderMissing(): void {
		breadcrumb(this.host.bar, [{ label: localize('voltAutomations.tab', "Automations"), onClick: () => this.host.navigate({ page: 'list' }) }, { label: localize('voltAutomations.notFound', "Not found") }], this.barStore);
		append(this.page, $('.volt-auto-empty')).textContent = localize('voltAutomations.missing', "This automation was deleted.");
	}

	private render(): void {
		this.renderBar();
		const head = append(this.page, $('.volt-auto-detail-head'));
		this.titleInput = append(head, $('input.volt-auto-detail-title')) as HTMLInputElement;
		this.titleInput.value = this.draft.name;
		this.titleInput.placeholder = localize('voltAutomations.untitled', "Untitled");
		this.titleInput.setAttribute('aria-label', localize('voltAutomations.name', "Name"));
		this.titleInput.spellcheck = false;
		this._register(addDisposableListener(this.titleInput, 'input', () => {
			this.setDraft({ name: this.titleInput.value });
			if (this.crumbName) {
				this.crumbName.textContent = this.titleInput.value || localize('voltAutomations.untitled', "Untitled");
			}
		}));
		this._register(addDisposableListener(this.titleInput, 'keydown', e => {
			if (e.key === 'Enter') {
				this.instructions?.focus();
			}
		}));

		const meta = append(head, $('.volt-auto-meta'));
		this.switchEl = toggleSwitch(meta, this.draft.enabled, localize('voltAutomations.activeSwitch', "Active"), this.headStore, on => void this.setEnabled(on));
		this.statusLabel = append(meta, $('span.volt-auto-meta-status'));
		append(meta, $('span.volt-auto-meta-divider'));
		this.repoButton = button(meta, 'volt-auto-meta-button.repo', '', this.headStore, () => this.showRepositories());
		this.repoButton.appendChild(renderIcon(Codicon.chevronDown));
		append(meta, $('span.volt-auto-meta-divider.repo'));
		append(meta, $('span.volt-auto-meta-by')).textContent = localize('voltAutomations.by', "By {0}", this.saved?.createdBy ?? this.automations.creator());

		this.tabsRow = append(this.page, $('.volt-auto-tabs-row.detail'));
		pillTabs<Tab>(this.tabsRow, [
			{ id: 'settings', label: localize('voltAutomations.settings', "Settings") },
			{ id: 'runs', label: localize('voltAutomations.runHistory', "Run History") },
		], this.tab, this.headStore, tab => this.switchTab(tab));
		append(this.tabsRow, $('span.volt-auto-spacer'));
		this.toolbar = append(this.tabsRow, $('.volt-auto-tab-toolbar'));
		this.body = append(this.page, $('.volt-auto-detail-body'));
		this.syncMeta();
		this.renderBody();
	}

	private switchTab(tab: Tab): void {
		this.tab = tab;
		if (this.id) {
			this.host.setRoute({ page: 'detail', id: this.id, tab });
		}
		this.renderBar();
		this.syncMeta();
		this.renderBody();
	}

	private renderBar(): void {
		this.barStore.clear();
		clearNode(this.host.bar);
		const parts = [
			{ label: localize('voltAutomations.tab', "Automations"), onClick: () => this.host.navigate({ page: 'list' }) },
			{ label: this.draft.name || localize('voltAutomations.untitled', "Untitled"), ...(this.tab === 'runs' ? { onClick: () => this.switchTab('settings') } : {}) },
			...(this.tab === 'runs' ? [{ label: localize('voltAutomations.runs', "Runs") }] : []),
		];
		const nav = breadcrumb(this.host.bar, parts, this.barStore);
		this.crumbName = nav.querySelectorAll<HTMLElement>('.crumb')[1];
		const actions = append(this.host.bar, $('.volt-auto-bar-actions'));
		if (this.tab === 'runs') {
			this.saveButton = undefined;
			const stop = button(actions, 'volt-auto-outline-button.stop-all', localize('voltAutomations.stopAll', "Stop All Runs"), this.barStore, () => void this.stopAll(), () => renderIcon(Codicon.debugStop));
			stop.dataset.role = 'stop-all';
			this.syncBar();
			return;
		}
		this.saveButton = button(actions, 'volt-auto-save', localize('voltAutomations.save', "Save"), this.barStore, () => void this.save());
		this.changed();
		iconButton(actions, Codicon.play, localize('voltAutomations.runNow', "Run Now"), this.barStore, () => void this.runNow());
		const more = iconButton(actions, Codicon.ellipsis, localize('voltAutomations.more', "More actions"), this.barStore, () => this.showMore(more));
	}

	private syncBar(): void {
		const stop = this.host.bar.querySelector<HTMLButtonElement>('[data-role="stop-all"]');
		if (stop) {
			stop.disabled = !this.saved?.runs.some(isActiveRun);
		}
	}

	private syncMeta(): void {
		this.switchEl.classList.toggle('on', this.draft.enabled);
		this.switchEl.setAttribute('aria-checked', String(this.draft.enabled));
		this.statusLabel.textContent = this.draft.enabled ? localize('voltAutomations.active', "Active") : localize('voltAutomations.inactive', "Inactive");
		const repos = this.draft.repositories;
		const label = !repos.length
			? (this.saved || this.repoTouched ? localize('voltAutomations.noRepository', "No Repository") : localize('voltAutomations.selectRepository', "Select repository"))
			: repos.length === 1 ? repos[0].name : localize('voltAutomations.reposMore', "{0} +{1}", repos[0].name, repos.length - 1);
		if (this.repoButton) {
			const text = this.repoButton.querySelector('.label');
			if (text) {
				text.textContent = label;
			}
			setAgentTooltip(this.repoButton, repos.length ? repos.map(repo => repo.owner ? `${repo.owner}/${repo.name}` : repo.name).join('\n') : localize('voltAutomations.repoTooltip', "Where runs work. No Repository: each run gets its own empty folder."));
		}
		this.page.classList.toggle('runs-tab', this.tab === 'runs');
	}

	private renderBody(): void {
		this.bodyStore.clear();
		this.panel.clear();
		this.mentionMenu.clear();
		clearNode(this.body);
		clearNode(this.toolbar);
		this.triggersCard = this.toolsCard = this.instructions = undefined;
		if (this.tab === 'runs') {
			this.panel.value = this.instantiationService.createInstance(RunHistoryPanel, this.toolbar, this.body, this.id ?? 'unsaved', () => this.host.relayout());
			this.host.relayout();
			return;
		}
		sectionLabel(this.body, localize('voltAutomations.triggers', "Triggers"));
		this.triggersCard = append(this.body, $('.volt-auto-card.volt-auto-list-card.triggers'));
		this.renderTriggers();

		sectionLabel(this.body, localize('voltAutomations.instructions', "Agent Instructions")).classList.add('spaced');
		this.renderInstructions(append(this.body, $('.volt-auto-card.volt-auto-instructions')));

		sectionLabel(this.body, localize('voltAutomations.tools', "Tools")).classList.add('spaced');
		this.toolsCard = append(this.body, $('.volt-auto-card.volt-auto-list-card.tools'));
		this.renderTools();
		this.host.relayout();
	}

	//#endregion

	//#region Actions

	private async setEnabled(on: boolean): Promise<void> {
		if (on && !this.draft.triggers.length) {
			this.notifications.info(localize('voltAutomations.noTriggers', "Add a trigger so the automation runs on its own. Run Now works either way."));
		}
		this.draft = { ...this.draft, enabled: on };
		if (this.id && this.saved) {
			// The switch applies at once; the rest of the draft stays a draft.
			const baseline = JSON.parse(this.baseline) as MutableDraft;
			this.baseline = JSON.stringify(configOf({ ...baseline, enabled: on }));
			await this.automations.setEnabled(this.id, on);
		}
		this.changed();
		this.syncMeta();
	}

	private async runNow(): Promise<void> {
		if (!this.id || this.isDirty()) {
			if (!await this.save()) {
				return;
			}
		}
		const runs = await this.automations.runNow(this.id!);
		const failed = runs.filter(run => run.status === 'failed');
		if (failed.length === runs.length && failed.length) {
			this.notifications.error(localize('voltAutomations.runFailedOne', "The run did not start: {0}", failed[0].error ?? ''));
		}
		this.switchTab('runs');
	}

	private async stopAll(): Promise<void> {
		if (this.id) {
			await this.automations.stopRuns(this.id);
		}
	}

	private showMore(anchor: HTMLElement): void {
		type Action = 'duplicate' | 'json' | 'share' | 'delete';
		showVoltMenu<Action>(this.contextView, {
			anchor,
			align: 'right',
			gap: 6,
			width: 200,
			className: 'volt-auto-menu',
			ariaLabel: localize('voltAutomations.more', "More actions"),
			sections: [
				{
					id: 'main', items: [
						{ id: 'duplicate', label: localize('voltAutomations.duplicate', "Duplicate"), disabled: !this.id, data: 'duplicate' },
						{ id: 'json', label: localize('voltAutomations.copyJson', "Copy as JSON"), data: 'json' },
						{ id: 'share', label: this.draft.shared ? localize('voltAutomations.moveToMine', "Move to Mine") : localize('voltAutomations.share', "Share with Team"), data: 'share' },
					],
				},
				{ id: 'danger', items: [{ id: 'delete', label: this.id ? localize('voltAutomations.delete', "Delete") : localize('voltAutomations.discardNew', "Discard"), className: 'danger', data: 'delete' }] },
			],
			onPick: async item => {
				switch (item.data) {
					case 'duplicate': {
						const copy = this.id ? await this.automations.duplicate(this.id) : undefined;
						if (copy) {
							this.host.navigate({ page: 'detail', id: copy.id, tab: 'settings' });
						}
						return;
					}
					case 'json':
						await this.clipboard.writeText(automationJson(this.draft));
						return;
					case 'share':
						this.setDraft({ shared: !this.draft.shared });
						if (this.id) {
							await this.automations.update(this.id, { shared: this.draft.shared });
							const baseline = JSON.parse(this.baseline) as MutableDraft;
							this.baseline = JSON.stringify(configOf({ ...baseline, shared: this.draft.shared }));
							this.changed();
						}
						return;
					case 'delete': {
						if (!this.id) {
							this.baseline = JSON.stringify(configOf(this.draft));
							this.host.navigate({ page: 'list' });
							return;
						}
						const { confirmed } = await this.dialogs.confirm({
							message: localize('voltAutomations.deleteConfirm', "Delete \"{0}\"?", this.draft.name),
							detail: localize('voltAutomations.deleteDetail', "Its triggers stop and its webhook URLs stop answering. Chats its runs started stay."),
							primaryButton: localize('voltAutomations.deleteButton', "Delete"),
						});
						if (confirmed) {
							const id = this.id;
							this.id = undefined;
							this.baseline = JSON.stringify(configOf(this.draft));
							await this.automations.delete(id);
							this.host.navigate({ page: 'list' });
						}
						return;
					}
				}
			},
		});
	}

	//#endregion

	//#region Repository

	private async loadCandidates(): Promise<void> {
		const seen = new Set<string>();
		const list: IRepositoryCandidate[] = [];
		const add = (uri: URI) => {
			const key = uri.toString();
			if (!seen.has(key)) {
				seen.add(key);
				list.push({ root: key, folderName: basename(uri) || key });
			}
		};
		for (const project of this.sessionContext.projects) {
			add(project.root);
		}
		try {
			const recent = await this.workspaces.getRecentlyOpened();
			for (const entry of recent.workspaces) {
				if (isRecentFolder(entry) && entry.folderUri.scheme === 'file') {
					add(entry.folderUri);
				}
			}
		} catch {
			// Projects only.
		}
		this.candidates = list.sort((a, b) => a.folderName.localeCompare(b.folderName, undefined, { sensitivity: 'base' }));
	}

	private showRepositories(): void {
		if (!this.repoButton) {
			return;
		}
		const recents = this.automations.list().flatMap(automation => automation.repositories).filter((repo, index, all) => all.findIndex(other => other.root === repo.root) === index);
		showRepositoryMenu(this.contextView, this.pullRequests, this.repoButton, {
			candidates: () => this.candidates,
			toFsPath: root => uriFromStoredRoot(root).fsPath,
			selected: () => this.draft.repositories,
			recents,
			onPick: repositories => {
				this.repoTouched = true;
				this.setDraft({ repositories: [...repositories] }, 'meta');
			},
			onAdd: () => void this.addRepositories(),
			onRefresh: () => {
				forgetRemoteNames();
				void this.loadCandidates();
			},
		});
	}

	private async addRepositories(): Promise<void> {
		const folders = await this.fileDialogs.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: true,
			title: localize('voltAutomations.addReposTitle', "Add Repositories"),
			openLabel: localize('voltAutomations.addReposOpen', "Add"),
		});
		if (!folders?.length) {
			return;
		}
		const added = folders.map(folder => {
			const project = this.sessionContext.registerProject(folder, basename(folder));
			return { root: project.root.toString(), name: project.displayName };
		});
		await this.loadCandidates();
		this.repoTouched = true;
		const repositories = [...this.draft.repositories.filter(repo => !added.some(entry => entry.root === repo.root)), ...added];
		this.setDraft({ repositories }, 'meta');
	}

	//#endregion

	//#region Triggers

	private updateTrigger(id: string, patch: Partial<IAutomationTrigger>, redraw = true): void {
		this.setDraft({ triggers: this.draft.triggers.map(trigger => trigger.id === id ? { ...trigger, ...patch } : trigger) }, redraw ? 'triggers' : undefined);
	}

	private updateHook(trigger: IAutomationTrigger, patch: Partial<IAgentWebhookTrigger>, redraw = false): void {
		const current = this.draft.triggers.find(entry => entry.id === trigger.id)?.hook ?? trigger.hook ?? newHook();
		this.updateTrigger(trigger.id, { hook: { ...current, ...patch } }, redraw);
	}

	private renderTriggers(): void {
		const card = this.triggersCard;
		if (!card) {
			return;
		}
		this.triggerStore.clear();
		clearNode(card);
		const now = Date.now();
		for (const trigger of this.draft.triggers) {
			if (trigger.provider === 'schedule') {
				this.renderScheduleRow(card, trigger, now);
			} else {
				this.renderEventRow(card, trigger);
			}
		}
		const add = append(card, $('button.volt-auto-list-row.add')) as HTMLButtonElement;
		add.type = 'button';
		append(add, $('span.icon')).appendChild(renderIcon(Codicon.add));
		append(add, $('span.label')).textContent = localize('voltAutomations.addTrigger', "Add Trigger");
		this.triggerStore.add(addDisposableListener(add, 'click', () => showTriggerMenu(this.contextView, add, pick => this.addTrigger(pick.provider, pick.event))));
		this.host.relayout();
	}

	private addTrigger(provider: AutomationProvider, event: string): void {
		const trigger: IAutomationTrigger = provider === 'schedule'
			? { id: newId('tr'), provider, event, schedule: defaultSchedule(event) }
			: { id: newId('tr'), provider, event, hook: newHook() };
		if (trigger.hook) {
			this.expanded.add(trigger.id);
		}
		this.setDraft({ triggers: [...this.draft.triggers, trigger] }, 'triggers');
	}

	private removeButton(row: HTMLElement, trigger: IAutomationTrigger): void {
		const remove = iconButton(row, Codicon.trash, localize('voltAutomations.removeTrigger', "Remove trigger"), this.triggerStore, () => {
			this.expanded.delete(trigger.id);
			this.setDraft({ triggers: this.draft.triggers.filter(entry => entry.id !== trigger.id) }, 'triggers');
		});
		remove.classList.add('row-hover');
	}

	private chip(parent: HTMLElement, label: string, onClick: (anchor: HTMLElement) => void): HTMLButtonElement {
		const chip = button(parent, 'volt-auto-chip-button', label, this.triggerStore, () => onClick(chip));
		chip.appendChild(renderIcon(Codicon.chevronDown));
		return chip;
	}

	private renderScheduleRow(card: HTMLElement, trigger: IAutomationTrigger, now: number): void {
		const row = append(card, $('.volt-auto-list-row.schedule'));
		append(row, $('span.icon')).appendChild(clockIcon());
		const line = append(row, $('span.schedule-line'));
		const spec = trigger.schedule!;
		const set = (schedule: AutomationSchedule) => this.updateTrigger(trigger.id, { schedule, event: schedule.type === 'interval' ? 'hourly' : schedule.type });
		const word = (text: string, muted = false) => append(line, $(muted ? 'span.word.muted' : 'span.word')).textContent = text;
		switch (spec.type) {
			case 'hourly':
				word(localize('voltAutomations.everyHour', "Every hour"));
				word(localize('voltAutomations.at', "at"), true);
				this.chip(line, `:${String(spec.minute).padStart(2, '0')}`, anchor => showMinuteMenu(this.contextView, anchor, spec.minute, minute => set({ type: 'hourly', minute })));
				break;
			case 'daily':
				word(localize('voltAutomations.everyDay', "Every day"));
				word(localize('voltAutomations.at', "at"), true);
				this.chip(line, spec.time, anchor => showTimeMenu(this.contextView, anchor, parseTimeOfDay(spec.time) ?? 540, minutes => set({ type: 'daily', time: formatTimeOfDay(minutes) })));
				break;
			case 'weekly': {
				word(localize('voltAutomations.every', "Every"));
				const days = [...spec.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
				const dayLabel = days.length === 1 ? weekdayName(days[0]) : days.map(day => weekdayName(day, true)).join(', ');
				let picked = [...spec.weekdays];
				this.chip(line, dayLabel, anchor => showWeekdayMenu(this.contextView, anchor, () => picked, day => {
					picked = picked.includes(day) ? (picked.length > 1 ? picked.filter(entry => entry !== day) : picked) : [...picked, day].sort((a, b) => a - b);
					this.updateTrigger(trigger.id, { schedule: { type: 'weekly', weekdays: picked, time: spec.time } }, false);
				}, () => this.renderTriggers()));
				word(localize('voltAutomations.at', "at"), true);
				this.chip(line, spec.time, anchor => showTimeMenu(this.contextView, anchor, parseTimeOfDay(spec.time) ?? 540, minutes => set({ type: 'weekly', weekdays: spec.weekdays, time: formatTimeOfDay(minutes) })));
				break;
			}
			case 'cron': {
				word(localize('voltAutomations.cron', "Cron"));
				const input = append(line, $('input.volt-auto-cron')) as HTMLInputElement;
				input.value = spec.expr;
				input.spellcheck = false;
				input.placeholder = '0 9 * * 1-5';
				setAgentTooltip(input, localize('voltAutomations.cronHelp', "minute hour day-of-month month day-of-week, in your local time. Examples: */15 * * * *, 0 9 * * 1-5, @daily"));
				const update = new RunOnceScheduler(() => {
					this.updateTrigger(trigger.id, { schedule: { type: 'cron', expr: input.value.trim() } }, false);
					this.syncNext(row, { type: 'cron', expr: input.value.trim() }, Date.now());
				}, 150);
				this.triggerStore.add(update);
				this.triggerStore.add(addDisposableListener(input, 'input', () => update.schedule()));
				break;
			}
			case 'interval':
				word(describeSchedule(spec));
				break;
		}
		append(line, $('span.word.tz')).textContent = gmtOffsetLabel(now);
		append(line, $('span.next'));
		this.syncNext(row, spec, now, trigger.id);
		this.removeButton(row, trigger);
	}

	private syncNext(row: HTMLElement, spec: AutomationSchedule, now: number, triggerId?: string): void {
		const next = row.querySelector<HTMLElement>('.next');
		const error = validateSchedule(spec);
		row.classList.toggle('invalid', !!error);
		if (!next) {
			return;
		}
		if (error) {
			next.textContent = error;
			return;
		}
		const saved = triggerId ? this.saved?.nextRuns[triggerId] : undefined;
		const unchanged = triggerId && this.saved?.triggers.find(entry => entry.id === triggerId && JSON.stringify(entry.schedule) === JSON.stringify(spec));
		const at = saved !== undefined && unchanged && this.draft.enabled ? saved : nextScheduleAt(spec, now);
		next.textContent = at !== undefined ? localize('voltAutomations.nextRun', "Next run {0} {1}", formatNextRun(at), gmtOffsetLabel(at)) : '';
		setAgentTooltip(next, at !== undefined ? formatScheduleWhen(at, now) : '');
	}

	private renderEventRow(card: HTMLElement, trigger: IAutomationTrigger): void {
		const open = this.expanded.has(trigger.id);
		const row = append(card, $('.volt-auto-list-row.event'));
		row.classList.toggle('open', open);
		row.tabIndex = 0;
		append(row, $('span.icon')).appendChild(providerIcon(trigger.provider));
		append(row, $('span.provider')).textContent = providerLabel(trigger.provider);
		append(row, $('span.event')).textContent = eventLabel(trigger.provider, trigger.event) + (trigger.option?.trim() ? ` · ${trigger.option.trim()}` : '');
		const hook = trigger.hook!;
		const signed = hook.signature.kind !== 'none';
		const state = append(row, $('span.hook-state'));
		state.classList.toggle('warn', !signed && trigger.provider !== 'webhook');
		state.textContent = signed ? localize('voltAutomations.signed', "Signed") : trigger.provider === 'webhook' ? '' : localize('voltAutomations.unsigned', "No secret");
		append(row, $('span.volt-auto-spacer'));
		const url = this.saved ? hookUrl(this.saved, hook, this.relayState) : undefined;
		const copy = button(row, 'volt-auto-small-button', url ? localize('voltAutomations.copyUrl', "Copy URL") : localize('voltAutomations.saveForUrl', "Save for URL"), this.triggerStore, () => {
			if (url) {
				void this.clipboard.writeText(url).then(() => flashLabel(copy, localize('voltAutomations.copied', "Copied")));
			} else {
				void this.save();
			}
		});
		append(row, $('span.chevron')).appendChild(renderIcon(open ? Codicon.chevronUp : Codicon.chevronDown));
		this.removeButton(row, trigger);
		const toggle = () => {
			if (open) {
				this.expanded.delete(trigger.id);
			} else {
				this.expanded.add(trigger.id);
			}
			this.renderTriggers();
		};
		this.triggerStore.add(addDisposableListener(row, 'click', toggle));
		this.triggerStore.add(addDisposableListener(row, 'keydown', e => {
			if (e.key === 'Enter' && e.target === row) {
				toggle();
			}
		}));
		if (open) {
			this.renderHookPanel(append(card, $('.volt-auto-hook-panel')), trigger, hook, url);
		}
	}

	private renderHookPanel(panel: HTMLElement, trigger: IAutomationTrigger, hook: IAgentWebhookTrigger, url: string | undefined): void {
		const store = this.triggerStore;
		const urlField = field(panel, localize('voltAutomations.webhookUrl', "Webhook URL"));
		const urlRow = append(urlField, $('.volt-auto-url-row'));
		const urlInput = append(urlRow, $('input.volt-auto-input.mono')) as HTMLInputElement;
		urlInput.readOnly = true;
		urlInput.value = url ?? '';
		urlInput.placeholder = localize('voltAutomations.urlAfterSave', "Save the automation to get its URL");
		button(urlRow, 'volt-auto-small-button', localize('voltAutomations.copy', "Copy"), store, e => {
			if (urlInput.value) {
				void this.clipboard.writeText(urlInput.value).then(() => flashLabel(e.currentTarget as HTMLElement, localize('voltAutomations.copied', "Copied")));
			}
		}).disabled = !url;
		const rotate = button(urlRow, 'volt-auto-small-button', localize('voltAutomations.rotate', "Rotate"), store, () => {
			const fresh = newHook();
			this.updateHook(trigger, { id: fresh.id, localToken: fresh.localToken, relayUrl: undefined, relayId: undefined }, true);
			this.notifications.info(localize('voltAutomations.rotated', "A new URL is made when you save; the old one stops answering."));
		});
		setAgentTooltip(rotate, localize('voltAutomations.rotateHelp', "Replace the URL (if it leaked). Senders need the new one."));

		const relayNote = append(panel, $('.volt-auto-note'));
		if (this.relayState.status === 'online') {
			relayNote.textContent = localize('voltAutomations.relayOnline', "Public URL on {0}: deliveries wait on the relay while Volt is closed.", this.relayState.relayName ?? this.relayState.url ?? 'Volt Relay');
		} else {
			relayNote.textContent = localize('voltAutomations.relayOffline', "Local URL: answers only on this machine while Volt runs. Connect Volt Relay for a public URL that holds deliveries while Volt is closed.");
			button(relayNote, 'volt-auto-link-button', localize('voltAutomations.connectRelay', "Connect Volt Relay…"), store, () => void connectVoltRelay(this.relay, this.quickInput, this.notifications));
		}
		append(panel, $('.volt-auto-note.hint')).textContent = setupHint(trigger.provider);

		const option = eventOption(trigger.provider, trigger.event);
		if (option) {
			const input = append(field(panel, option.label), $('input.volt-auto-input')) as HTMLInputElement;
			input.value = trigger.option ?? '';
			input.placeholder = option.placeholder;
			store.add(addDisposableListener(input, 'input', () => this.updateTrigger(trigger.id, { option: input.value.trim() || undefined }, false)));
		}

		const secretField = field(panel, localize('voltAutomations.secret', "Signing secret"));
		const secret = append(secretField, $('input.volt-auto-input')) as HTMLInputElement;
		secret.type = 'password';
		secret.autocomplete = 'off';
		secret.placeholder = hook.signature.secret
			? localize('voltAutomations.secretSaved', "Saved. Type to replace it; clear the field and save to remove.")
			: localize('voltAutomations.secretPlaceholder', "Recommended: the secret the sender signs with");
		store.add(addDisposableListener(secret, 'input', () => {
			const value = secret.value.trim();
			const kind = trigger.provider === 'webhook' ? 'generic' : providerSignature(trigger.provider);
			this.updateHook(trigger, { signature: value ? { kind, secret: value } : hook.signature.secret ? hook.signature : { kind: 'none' } });
		}));
		if (hook.signature.secret) {
			const removeSecret = button(secretField, 'volt-auto-link-button', localize('voltAutomations.removeSecret', "Remove secret"), store, () => this.updateHook(trigger, { signature: { kind: 'none' } }, true));
			removeSecret.classList.add('inline');
		}

		const filters = append(field(panel, localize('voltAutomations.onlyWhen', "Only when")), $('textarea.volt-auto-input.filters')) as HTMLTextAreaElement;
		filters.rows = 2;
		filters.spellcheck = false;
		filters.placeholder = 'payload.pull_request.base.ref = main';
		filters.value = hook.filters.map(formatWebhookFilter).join('\n');
		const filterNote = append(panel, $('.volt-auto-note'));
		filterNote.textContent = localize('voltAutomations.filtersHelp', "One per line, all must match: = != contains matches in exists missing. Paths: payload.…, headers.…, query.…, event.");
		store.add(addDisposableListener(filters, 'input', () => {
			const parsed = filters.value.split('\n').map(line => line.trim()).filter(Boolean).map(parseWebhookFilter);
			const ok = parsed.every((entry): entry is IAgentWebhookFilter => !!entry);
			filters.classList.toggle('invalid', !ok);
			filterNote.classList.toggle('error', !ok);
			if (ok) {
				this.updateHook(trigger, { filters: parsed as IAgentWebhookFilter[] });
			}
		}));

		const holdRow = append(panel, $('label.volt-auto-check'));
		const hold = append(holdRow, $('input')) as HTMLInputElement;
		hold.type = 'checkbox';
		hold.checked = hook.holdOffline !== false;
		append(holdRow, $('span')).textContent = localize('voltAutomations.holdOffline', "Hold deliveries on the relay while Volt is offline");
		store.add(addDisposableListener(hold, 'change', () => this.updateHook(trigger, hold.checked ? { holdOffline: undefined } : { holdOffline: false })));

		if (this.saved && this.relayState.status === 'online') {
			this.renderDeliveries(append(panel, $('.volt-auto-deliveries')), hook.id);
		}
	}

	private renderDeliveries(box: HTMLElement, hookId: string): void {
		append(box, $('.volt-auto-field-label')).textContent = localize('voltAutomations.deliveries', "Recent deliveries");
		const list = append(box, $('.volt-auto-delivery-list'));
		void this.relay.request<{ deliveries: { id: string; status: string; receivedAt: number; event?: string; result?: { error?: string; note?: string; threadId?: string } }[] }>('GET', `/deliveries?hook=${encodeURIComponent(hookId)}&limit=6`).then(reply => {
			if (!box.isConnected) {
				return;
			}
			const rows = [...reply.deliveries].reverse();
			if (!rows.length) {
				append(list, $('.volt-auto-note')).textContent = localize('voltAutomations.noDeliveries', "No deliveries yet.");
			}
			for (const delivery of rows) {
				const row = append(list, $(`.volt-auto-delivery.status-${delivery.status}`));
				append(row, $('span.when')).textContent = formatScheduleWhen(delivery.receivedAt, Date.now());
				append(row, $('span.state')).textContent = delivery.status;
				append(row, $('span.what')).textContent = [delivery.event, delivery.result?.error ?? delivery.result?.note].filter(Boolean).join(' · ');
				if (delivery.result?.threadId) {
					const threadId = delivery.result.threadId;
					button(row, 'volt-auto-link-button', localize('voltAutomations.openChat', "Open chat"), this.triggerStore, () => void this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, threadId));
				}
				if (delivery.status !== 'held') {
					button(row, 'volt-auto-link-button', localize('voltAutomations.redeliver', "Redeliver"), this.triggerStore, () => void this.relay.request('POST', `/deliveries/${encodeURIComponent(delivery.id)}/redeliver`).catch(err => this.notifications.error(String(err))));
				}
			}
			this.host.relayout();
		}, () => undefined);
	}

	//#endregion

	//#region Instructions

	private renderInstructions(card: HTMLElement): void {
		const area = append(card, $('textarea.volt-auto-instructions-input')) as HTMLTextAreaElement;
		this.instructions = area;
		area.value = this.draft.instructions;
		area.placeholder = localize('voltAutomations.instructionsPlaceholder', "Type @ for tools, / for commands...");
		area.spellcheck = false;
		area.setAttribute('aria-label', localize('voltAutomations.instructions', "Agent Instructions"));
		const fit = () => {
			area.style.height = 'auto';
			area.style.height = `${Math.min(Math.max(area.scrollHeight, 150), 520)}px`;
			card.classList.toggle('overflowing', area.scrollHeight > 520 && area.scrollTop + area.clientHeight < area.scrollHeight - 4);
		};
		this.bodyStore.add(addDisposableListener(area, 'input', () => {
			this.setDraft({ instructions: area.value });
			fit();
			this.maybeAssist(area);
		}));
		this.bodyStore.add(addDisposableListener(area, 'scroll', () => card.classList.toggle('overflowing', area.scrollTop + area.clientHeight < area.scrollHeight - 4)));
		getWindow(area).requestAnimationFrame(fit);

		const footer = append(card, $('.volt-auto-instructions-footer'));
		const choices = modelChoices(this.runtime.listCatalog());
		const modelButton = button(footer, 'volt-auto-model-button', modelButtonLabel(choices, this.draft.modelRef), this.bodyStore, () => {
			showModelMenu(this.contextView, modelButton, modelChoices(this.runtime.listCatalog()), this.draft.modelRef, ref => {
				this.setDraft({ modelRef: ref });
				const label = modelButton.querySelector('.label');
				if (label) {
					label.textContent = modelButtonLabel(modelChoices(this.runtime.listCatalog()), ref);
				}
			});
		});
		modelButton.appendChild(renderIcon(Codicon.chevronDown));
	}

	/** `@` lists tools (adding one adds it to Tools), `/` lists snippets, at the start of a word. */
	private maybeAssist(area: HTMLTextAreaElement): void {
		const caret = area.selectionStart;
		const before = area.value.slice(0, caret);
		const match = /(^|\s)([@/])([\w-]*)$/.exec(before);
		if (!match) {
			this.mentionMenu.clear();
			return;
		}
		const trigger = match[2];
		const start = caret - match[3].length - 1;
		const insert = (text: string) => {
			area.focus();
			area.setRangeText(text, start, area.selectionStart, 'end');
			this.setDraft({ instructions: area.value });
			area.dispatchEvent(new Event('input'));
		};
		if (trigger === '/') {
			this.mentionMenu.value = showVoltMenu<string>(this.contextView, {
				anchor: area,
				gap: 4,
				width: 320,
				className: 'volt-auto-menu',
				ariaLabel: localize('voltAutomations.commands', "Commands"),
				sections: [{ id: 'commands', items: COMMANDS.filter(command => command.id.startsWith(match[3].toLowerCase())).map(command => ({ id: command.id, label: command.label, detail: command.detail, data: command.text })) }],
				onPick: item => insert(item.data),
			});
			return;
		}
		const tools: IVoltMenuItem<{ kind?: AutomationToolKind; text: string }>[] = [
			{ id: 'memories', label: localize('voltAutomations.memories', "Memories"), icon: () => memoriesIcon(), data: { kind: 'memories', text: 'MEMORIES.md' } },
			{ id: 'slack_send', label: localize('voltAutomations.sendSlack', "Send to Slack"), icon: () => providerIcon('slack'), data: { kind: 'slack_send', text: 'send a Slack message' } },
			{ id: 'slack_read', label: localize('voltAutomations.readSlack', "Read Public Slack Channels"), icon: () => providerIcon('slack'), data: { kind: 'slack_read', text: 'read the Slack channel' } },
			{ id: 'teams_send', label: localize('voltAutomations.sendTeams', "Send to Microsoft Teams"), icon: () => providerIcon('teams'), data: { kind: 'teams_send', text: 'send a Microsoft Teams message' } },
			{ id: 'pr_comment', label: localize('voltAutomations.prComment', "PR Comment"), icon: () => providerIcon('github'), data: { text: 'comment on the pull request (pr_comment)' } },
			{ id: 'open_pr', label: localize('voltAutomations.pullRequest', "Pull Request"), icon: () => providerIcon('github'), data: { text: 'open a pull request (open_pr)' } },
			...this.draft.tools.filter(tool => tool.kind === 'mcp' && tool.server).map(tool => ({ id: `mcp:${tool.server}`, label: tool.server!, icon: () => mcpIcon(), data: { text: `the ${tool.server} MCP server` } })),
		];
		this.mentionMenu.value = showVoltMenu(this.contextView, {
			anchor: area,
			gap: 4,
			width: 280,
			className: 'volt-auto-menu',
			ariaLabel: localize('voltAutomations.tools', "Tools"),
			sections: [{ id: 'tools', items: tools.filter(item => item.label.toLowerCase().includes(match[3].toLowerCase()) || item.id.includes(match[3].toLowerCase())) }],
			onPick: item => {
				insert(item.data.text);
				const kind = item.data.kind;
				if (kind && !this.draft.tools.some(tool => tool.kind === kind)) {
					this.setDraft({ tools: [...this.draft.tools, { id: newId('t'), kind }] }, 'tools');
				}
			},
		});
	}

	//#endregion

	//#region Tools

	private renderTools(): void {
		const card = this.toolsCard;
		if (!card) {
			return;
		}
		this.toolStore.clear();
		clearNode(card);
		for (const tool of this.draft.tools) {
			const row = append(card, $('.volt-auto-list-row.tool'));
			append(row, $('span.icon')).appendChild(tool.kind === 'memories' ? memoriesIcon() : toolKindIcon(tool.kind));
			append(row, $('span.provider')).textContent = toolLabel(tool);
			if (toolNeedsSetup(tool)) {
				append(row, $('span.hook-state.warn')).textContent = localize('voltAutomations.notSetUp', "Not set up");
			} else if (tool.channel) {
				append(row, $('span.event')).textContent = tool.channel;
			}
			append(row, $('span.volt-auto-spacer'));
			if (tool.kind === 'memories') {
				button(row, 'volt-auto-outline-button.small', localize('voltAutomations.manage', "Manage"), this.toolStore, () => void this.openMemory());
			} else {
				iconButton(row, Codicon.edit, localize('voltAutomations.editTool', "Edit"), this.toolStore, () => tool.kind === 'mcp' ? void this.commandService.executeCommand(OPEN_AGENT_CUSTOMIZE_COMMAND_ID) : this.editTool(tool));
			}
			iconButton(row, Codicon.trash, localize('voltAutomations.removeTool', "Remove"), this.toolStore, () => this.setDraft({ tools: this.draft.tools.filter(entry => entry.id !== tool.id) }, 'tools'));
		}
		const add = append(card, $('button.volt-auto-list-row.add')) as HTMLButtonElement;
		add.type = 'button';
		append(add, $('span.icon')).appendChild(renderIcon(Codicon.add));
		append(add, $('span.label')).textContent = localize('voltAutomations.addTool', "Add Tool or MCP");
		this.toolStore.add(addDisposableListener(add, 'click', () => showToolMenu(this.contextView, add, {
			hasMemories: this.draft.tools.some(tool => tool.kind === 'memories'),
			added: this.draft.tools.map(tool => tool.kind === 'mcp' ? `mcp:${tool.server}` : tool.kind),
			servers: () => this.runtime.listMcpServers(this.draft.repositories[0] ? uriFromStoredRoot(this.draft.repositories[0].root) : this.sessionContext.activeProject?.root),
			onPick: pick => this.addTool(pick),
		})));
		this.host.relayout();
	}

	private addTool(pick: ToolPick): void {
		if (pick.kind === 'new-mcp') {
			void this.commandService.executeCommand(OPEN_AGENT_CUSTOMIZE_COMMAND_ID);
			return;
		}
		const tool: IAutomationTool = { id: newId('t'), kind: pick.kind, ...(pick.kind === 'mcp' && 'server' in pick && pick.server ? { server: pick.server } : {}) };
		this.setDraft({ tools: [...this.draft.tools, tool] }, 'tools');
		if (toolNeedsSetup(tool)) {
			this.editTool(tool);
		}
	}

	/** Setup for Slack and Teams tools: webhook URL to send, token and channel to read. */
	private editTool(tool: IAutomationTool): void {
		const reading = tool.kind === 'slack_read' || tool.kind === 'teams_read';
		const slack = tool.kind === 'slack_send' || tool.kind === 'slack_read';
		const dialog = showAutomationDialog(this.layoutService.activeContainer, toolLabel(tool), slack
			? (reading ? localize('voltAutomations.slackReadHelp', "A Slack bot token (xoxb-…) with channels:history, and the channel id the run reads by default.") : localize('voltAutomations.slackSendHelp', "A Slack incoming webhook URL (Slack app → Incoming Webhooks). Runs post there with send_slack."))
			: (reading ? localize('voltAutomations.teamsReadHelp', "A Microsoft Graph token with ChannelMessage.Read.All, and the channel as teamId/channelId.") : localize('voltAutomations.teamsSendHelp', "A Teams Workflows or incoming webhook URL. Runs post there with send_teams.")), 'tool');
		const url = reading ? undefined : append(field(dialog.body, localize('voltAutomations.webhookUrl', "Webhook URL")), $('input.volt-auto-input')) as HTMLInputElement;
		if (url) {
			url.value = tool.url ?? '';
			url.placeholder = slack ? 'https://hooks.slack.com/services/…' : 'https://…logic.azure.com/workflows/…';
			url.type = 'password';
		}
		const token = reading ? append(field(dialog.body, localize('voltAutomations.token', "Token")), $('input.volt-auto-input')) as HTMLInputElement : undefined;
		if (token) {
			token.type = 'password';
			token.value = tool.token ?? '';
			token.placeholder = slack ? 'xoxb-…' : 'eyJ0…';
		}
		const channel = append(field(dialog.body, reading ? localize('voltAutomations.channel', "Channel") : localize('voltAutomations.channelLabel', "Channel (label only)")), $('input.volt-auto-input')) as HTMLInputElement;
		channel.value = tool.channel ?? '';
		channel.placeholder = slack ? (reading ? 'C0123456789' : '#alerts') : (reading ? 'teamId/channelId' : 'Engineering / Alerts');
		button(dialog.footer, 'volt-auto-outline-button.small', localize('voltAutomations.cancel', "Cancel"), dialog.store, () => dialog.close());
		button(dialog.footer, 'volt-auto-outline-button.small.primary', localize('voltAutomations.save', "Save"), dialog.store, () => {
			const next: IAutomationTool = {
				id: tool.id,
				kind: tool.kind,
				...(url?.value.trim() ? { url: url.value.trim() } : {}),
				...(token?.value.trim() ? { token: token.value.trim() } : {}),
				...(channel.value.trim() ? { channel: channel.value.trim() } : {}),
			};
			this.setDraft({ tools: this.draft.tools.map(entry => entry.id === tool.id ? next : entry) }, 'tools');
			dialog.close();
		});
	}

	/** Memory Notes: the files the agent keeps across runs (MEMORIES.md first). */
	private async openMemory(): Promise<void> {
		if (!this.id) {
			if (!await this.save()) {
				return;
			}
		}
		const id = this.id!;
		const dialog = showAutomationDialog(this.layoutService.activeContainer, localize('voltAutomations.memoryNotes', "Memory Notes"), localize('voltAutomations.memoryHelp', "View and edit files the agent keeps in memories/"), 'memory');
		const select = append(append(field(dialog.body, localize('voltAutomations.file', "File")), $('.volt-auto-select')), $('select')) as HTMLSelectElement;
		const content = append(field(dialog.body, localize('voltAutomations.content', "Content")), $('textarea.volt-auto-input.memory')) as HTMLTextAreaElement;
		content.placeholder = localize('voltAutomations.memoryPlaceholder', "Add memory notes...");
		content.spellcheck = false;
		let original = '';
		const reset = button(dialog.footer, 'volt-auto-outline-button.small', localize('voltAutomations.reset', "Reset"), dialog.store, () => {
			content.value = original;
			sync();
		});
		const remove = button(dialog.footer, 'volt-auto-outline-button.small', localize('voltAutomations.deleteFile', "Delete"), dialog.store, async () => {
			await this.automations.deleteMemory(id, select.value);
			await load(select.value);
		});
		const save = button(dialog.footer, 'volt-auto-outline-button.small.primary', localize('voltAutomations.save', "Save"), dialog.store, async () => {
			await this.automations.writeMemory(id, select.value, content.value);
			original = content.value;
			sync();
			flashLabel(save, localize('voltAutomations.saved', "Saved"));
		});
		const sync = () => {
			const changed = content.value !== original;
			save.disabled = !changed;
			reset.disabled = !changed;
			remove.disabled = !original && !content.value;
		};
		const load = async (file: string) => {
			const files = await this.automations.listMemoryFiles(id);
			clearNode(select);
			for (const name of files) {
				const option = append(select, $('option')) as HTMLOptionElement;
				option.value = name;
				option.textContent = name;
			}
			select.value = files.includes(file) ? file : files[0];
			original = await this.automations.readMemory(id, select.value).catch(() => '');
			content.value = original;
			sync();
		};
		dialog.store.add(addDisposableListener(select, 'change', () => void load(select.value)));
		dialog.store.add(addDisposableListener(content, 'input', sync));
		await load('MEMORIES.md');
	}

	//#endregion
}
