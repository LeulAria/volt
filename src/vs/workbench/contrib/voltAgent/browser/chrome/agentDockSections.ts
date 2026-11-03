/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IVoltAccountsService, IVoltClaudeAccountsState } from '../../../../../platform/voltAccounts/common/voltAccounts.js';
import { IVoltUsageLimitGroup, IVoltUsageService } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { createBrandIcon } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { IAutomation, IAutomationService } from '../../../../services/voltRuntime/common/automations/automations.js';
import { NEW_AUTOMATION_COMMAND_ID, OPEN_AUTOMATIONS_COMMAND_ID } from '../automations/automationCommands.js';
import { showVoltMenu } from '../ui/menu/voltMenu.js';
import { AgentUsageHoverCard, usageAccountRows } from '../usage/agentUsageHoverCard.js';

/**
 * A folding group of the toolbar (Open Tabs, Designs, Pull requests), headed like "Previous agents
 * (N)" in AgentLineageDock: a pane header with a chevron, the title in capitals, the count.
 * Folding lasts while the window is open, as it does for Previous agents.
 */
export class DockGroup extends Disposable {

	/** The group's rows go here; folding hides it. */
	readonly body: HTMLElement;
	private readonly head: HTMLButtonElement;
	private open = true;
	private count: number | undefined;

	constructor(section: HTMLElement, private readonly title: string) {
		super();
		// The lineage divider's class: the same header as Previous agents (agentSubagents.css).
		this.head = append(section, $('button.volt-agent-lineage-divider.volt-agent-dock-group-head')) as HTMLButtonElement;
		this.head.type = 'button';
		this.body = append(section, $('.volt-agent-dock-group-body'));
		this._register(addDisposableListener(this.head, 'click', () => {
			this.open = !this.open;
			this.render();
		}));
		this.render();
	}

	/** Undefined drops the count from the title. */
	setCount(count: number | undefined): void {
		if (count === this.count) {
			return;
		}
		this.count = count;
		this.render();
	}

	private render(): void {
		this.head.setAttribute('aria-expanded', String(this.open));
		this.head.replaceChildren(renderIcon(this.open ? Codicon.chevronDown : Codicon.chevronRight));
		append(this.head, $('span.label')).textContent = this.count === undefined
			? this.title
			: localize('voltAgent.dock.groupTitle', "{0} ({1})", this.title, this.count);
		this.body.classList.toggle('hidden', !this.open);
	}
}

//#region Which sections show

export type DockSectionId = 'agents' | 'tabs' | 'designs' | 'scratch' | 'workspace' | 'pullRequests' | 'automations' | 'usage' | 'previous';

interface IDockSectionInfo {
	readonly id: DockSectionId;
	readonly label: string;
	readonly shownByDefault: boolean;
}

/** The toolbar's sections, top to bottom. Automations and Usage are there for those who ask. */
export const DOCK_SECTIONS: readonly IDockSectionInfo[] = [
	{ id: 'agents', label: localize('voltAgent.dockSections.agents', "Running agents"), shownByDefault: true },
	{ id: 'tabs', label: localize('voltAgent.dockSections.tabs', "Open tabs"), shownByDefault: true },
	{ id: 'designs', label: localize('voltAgent.dockSections.designs', "Designs"), shownByDefault: true },
	{ id: 'scratch', label: localize('voltAgent.dockSections.scratch', "Scratch"), shownByDefault: true },
	{ id: 'workspace', label: localize('voltAgent.dockSections.workspace', "Files, terminal and browser"), shownByDefault: true },
	{ id: 'pullRequests', label: localize('voltAgent.dockSections.pullRequests', "Changes and pull requests"), shownByDefault: true },
	{ id: 'automations', label: localize('voltAgent.dockSections.automations', "Automations"), shownByDefault: false },
	{ id: 'usage', label: localize('voltAgent.dockSections.usage', "Usage"), shownByDefault: false },
	{ id: 'previous', label: localize('voltAgent.dockSections.previous', "Previous agents"), shownByDefault: true },
];

/** The user's picks that differ from the defaults, by section. */
const DOCK_SECTIONS_KEY = 'volt.agent.sideToolbar.sections';

/** Which of the side toolbar's sections show, as the user picked in its tune menu (per profile). */
export class DockSectionPrefs extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private picks: Partial<Record<DockSectionId, boolean>>;

	constructor(private readonly storage: IStorageService) {
		super();
		this.picks = this.read();
		this._register(storage.onDidChangeValue(StorageScope.PROFILE, DOCK_SECTIONS_KEY, this._store)(() => {
			this.picks = this.read();
			this._onDidChange.fire();
		}));
	}

	isShown(id: DockSectionId): boolean {
		return this.picks[id] ?? DOCK_SECTIONS.find(section => section.id === id)?.shownByDefault ?? true;
	}

	isDefault(): boolean {
		return DOCK_SECTIONS.every(section => this.isShown(section.id) === section.shownByDefault);
	}

	toggle(id: DockSectionId): void {
		const shown = !this.isShown(id);
		const next = { ...this.picks };
		if (shown === DOCK_SECTIONS.find(section => section.id === id)?.shownByDefault) {
			delete next[id];
		} else {
			next[id] = shown;
		}
		this.write(next);
	}

	reset(): void {
		this.write({});
	}

	private write(picks: Partial<Record<DockSectionId, boolean>>): void {
		this.picks = picks;
		if (Object.keys(picks).length) {
			this.storage.store(DOCK_SECTIONS_KEY, JSON.stringify(picks), StorageScope.PROFILE, StorageTarget.USER);
		} else {
			this.storage.remove(DOCK_SECTIONS_KEY, StorageScope.PROFILE);
		}
		this._onDidChange.fire();
	}

	private read(): Partial<Record<DockSectionId, boolean>> {
		try {
			const parsed: unknown = JSON.parse(this.storage.get(DOCK_SECTIONS_KEY, StorageScope.PROFILE, '{}'));
			const picks: Partial<Record<DockSectionId, boolean>> = {};
			for (const section of DOCK_SECTIONS) {
				const value = (parsed as Record<string, unknown> | null)?.[section.id];
				if (typeof value === 'boolean') {
					picks[section.id] = value;
				}
			}
			return picks;
		} catch {
			return {};
		}
	}
}

/** The tune button's menu: a check per section ("Show in side toolbar"), toggled in place, then Reset to default. */
export function showDockSectionsMenu(contextViewService: IContextViewService, anchor: HTMLElement, prefs: DockSectionPrefs, onHide: () => void) {
	type Pick = DockSectionId | 'reset';
	const handle = showVoltMenu<Pick>(contextViewService, {
		anchor,
		position: 'below',
		align: 'right',
		width: 240,
		ariaLabel: localize('voltAgent.dockSections.aria', "Show in side toolbar"),
		sections: () => [
			{
				id: 'sections',
				title: localize('voltAgent.dockSections.title', "Show in side toolbar"),
				items: DOCK_SECTIONS.map(section => ({ id: section.id, label: section.label, checked: prefs.isShown(section.id), keepOpen: true, data: section.id })),
			},
			{
				id: 'reset',
				items: [{ id: 'reset', label: localize('voltAgent.dockSections.reset', "Reset to default"), disabled: prefs.isDefault(), keepOpen: true, data: 'reset' }],
			},
		],
		onPick: item => {
			if (item.data === 'reset') {
				prefs.reset();
			} else {
				prefs.toggle(item.data);
			}
			handle.refresh();
		},
		onHide,
	});
	return handle;
}

//#endregion

//#region Usage

/** The bars refresh this often while they show (each read asks every provider for its limits). */
const USAGE_REFRESH_MS = 5 * 60_000;

/**
 * Usage in the side toolbar: a thin bar per account (its brand mark, then how much of its current
 * window is used), nothing else. Hovering the bars opens the full Usage limits card beside them.
 */
export class AgentDockUsage extends Disposable {

	readonly section: HTMLElement;
	private readonly bars: HTMLElement;
	private readonly usage: IVoltUsageService | undefined;
	private readonly accounts: IVoltAccountsService | undefined;
	private readonly visibleStore = this._register(new DisposableStore());
	private groups: readonly IVoltUsageLimitGroup[] | undefined;
	private accountsState: IVoltClaudeAccountsState | undefined;
	private loadedAt = 0;
	private loading = false;
	private shown = false;

	constructor(
		parent: HTMLElement,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.usage = instantiationService.invokeFunction(accessor => accessor.getIfExists(IVoltUsageService));
		this.accounts = instantiationService.invokeFunction(accessor => accessor.getIfExists(IVoltAccountsService));
		this.section = append(parent, $('.volt-agent-dock-section.volt-agent-dock-usage'));
		const group = this._register(new DockGroup(this.section, localize('voltAgent.dock.usage', "Usage")));
		this.bars = append(group.body, $('.volt-agent-dock-usage-bars'));
		this.bars.setAttribute('role', 'img');
		this._register(instantiationService.createInstance(AgentUsageHoverCard, this.bars, 'start'));
	}

	/** Reads and draws while the section is on screen; nothing runs while it is hidden. */
	setShown(shown: boolean): void {
		if (shown === this.shown) {
			return;
		}
		this.shown = shown;
		this.visibleStore.clear();
		if (!shown) {
			return;
		}
		if (this.accounts) {
			this.visibleStore.add(this.accounts.onDidChangeClaudeAccounts(() => void this.load()));
		}
		const win = getWindow(this.section);
		const timer = win.setInterval(() => {
			if (win.document.hasFocus()) {
				void this.load();
			}
		}, USAGE_REFRESH_MS);
		this.visibleStore.add(toDisposable(() => win.clearInterval(timer)));
		this.render();
		if (Date.now() - this.loadedAt > USAGE_REFRESH_MS) {
			void this.load();
		}
	}

	private async load(): Promise<void> {
		if (this.loading || (!this.usage && !this.accounts)) {
			return;
		}
		this.loading = true;
		try {
			// The last reading at once, then a fresh one.
			this.groups ??= await this.usage?.peekLimits().catch(() => undefined);
			this.render();
			const [groups, accounts] = await Promise.all([
				this.usage?.getLimits(false).catch(() => this.groups),
				this.accounts?.getClaudeAccounts(false).catch(() => this.accountsState),
			]);
			this.groups = groups ?? this.groups;
			this.accountsState = accounts ?? this.accountsState;
			this.loadedAt = Date.now();
		} finally {
			this.loading = false;
		}
		this.render();
	}

	private render(): void {
		if (!this.shown) {
			return;
		}
		const now = Date.now();
		const rows = usageAccountRows(this.groups, this.accountsState);
		this.bars.replaceChildren();
		const labels: string[] = [];
		for (const row of rows) {
			// The account's first window is its current one (Claude's session, Codex's 30 days, Grok's week).
			const window = row.limits?.windows[0];
			const passed = window?.resetsAt !== undefined && window.resetsAt <= now;
			const used = window ? (passed ? 0 : Math.max(0, Math.round(window.usedPercent))) : undefined;
			const line = append(this.bars, $('.volt-agent-dock-usage-line'));
			line.classList.toggle('active', row.active);
			line.classList.toggle('high', used !== undefined && used >= 80);
			line.classList.toggle('unknown', used === undefined);
			line.appendChild(createBrandIcon(row.provider, 12));
			const bar = append(line, $('span.volt-agent-dock-usage-bar'));
			append(bar, $('span.volt-agent-dock-usage-fill')).style.width = `${Math.min(100, used ?? 0)}%`;
			labels.push(used === undefined ? row.name : `${row.name}: ${used}%`);
		}
		if (!rows.length) {
			append(this.bars, $('.volt-agent-dock-usage-empty')).textContent = this.groups === undefined && !this.accountsState
				? localize('voltAgent.dock.usageLoading', "Reading your limits...")
				: localize('voltAgent.dock.usageNone', "No subscription limits found");
		}
		this.bars.setAttribute('aria-label', labels.length ? localize('voltAgent.dock.usageAria', "Usage: {0}", labels.join(', ')) : localize('voltAgent.dock.usage', "Usage"));
	}
}

//#endregion

//#region Automations

const AUTOMATION_ROW_HEIGHT = 26;
/** More than this many scroll inside the group. */
const AUTOMATION_ROWS_VISIBLE = 6;

interface IAutomationTemplate {
	readonly title: HTMLElement;
	readonly when: HTMLElement;
	readonly row: HTMLElement;
}

class AutomationDelegate implements IListVirtualDelegate<IAutomation> {
	getHeight(): number {
		return AUTOMATION_ROW_HEIGHT;
	}
	getTemplateId(): string {
		return AutomationRenderer.TEMPLATE_ID;
	}
}

/** When it runs next ("in 3 hrs"), "Off" when paused, nothing for one that only runs on events. */
function automationWhen(automation: IAutomation, now: number): string {
	if (!automation.enabled) {
		return localize('voltAgent.dock.automationOff', "Off");
	}
	const next = Math.min(...Object.values(automation.nextRuns).filter(at => at > now));
	return Number.isFinite(next) ? fromNow(next, true) : '';
}

class AutomationRenderer implements IListRenderer<IAutomation, IAutomationTemplate> {
	static readonly TEMPLATE_ID = 'voltAgentDockAutomation';
	readonly templateId = AutomationRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IAutomationTemplate {
		container.classList.add('volt-agent-dock-automation-row');
		const icon = append(container, $('span.volt-agent-dock-automation-icon'));
		icon.appendChild(renderIcon(Codicon.history));
		const title = append(container, $('span.volt-agent-dock-automation-title'));
		const when = append(container, $('span.volt-agent-dock-automation-when'));
		return { title, when, row: container };
	}

	renderElement(automation: IAutomation, _index: number, template: IAutomationTemplate): void {
		template.title.textContent = automation.name;
		template.when.textContent = automationWhen(automation, Date.now());
		template.row.classList.toggle('off', !automation.enabled);
	}

	disposeTemplate(): void { }
}

/**
 * Automations in the side toolbar: the ones that run in this chat or were made from it, then the
 * ones that work on its project, each with when it runs next. A row opens it on the Automations
 * page; "New automation" starts one from this chat.
 */
export class AgentDockAutomations extends Disposable {

	readonly section: HTMLElement;
	private readonly group: DockGroup;
	private readonly host: HTMLElement;
	private readonly list: WorkbenchList<IAutomation>;
	private readonly automations: IAutomationService | undefined;
	private readonly visibleStore = this._register(new DisposableStore());
	private sessionId: string | undefined;
	private folder: URI | undefined;
	private shown = false;

	constructor(
		parent: HTMLElement,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.automations = instantiationService.invokeFunction(accessor => accessor.getIfExists(IAutomationService));
		this.section = append(parent, $('.volt-agent-dock-section.volt-agent-dock-automations'));
		this.group = this._register(new DockGroup(this.section, localize('voltAgent.dock.automations', "Automations")));
		this.host = append(this.group.body, $('.volt-agent-dock-automation-list'));
		this.list = this._register(instantiationService.createInstance(WorkbenchList<IAutomation>, 'voltAgentDockAutomations', this.host, new AutomationDelegate(), [new AutomationRenderer()], {
			identityProvider: { getId: (automation: IAutomation) => automation.id },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltAgent.dock.automations', "Automations"),
				getAriaLabel: (automation: IAutomation) => {
					const when = automationWhen(automation, Date.now());
					return when ? `${automation.name}, ${when}` : automation.name;
				},
			},
		}));
		this._register(this.list.onDidOpen(e => {
			if (e.element) {
				void this.commandService.executeCommand(OPEN_AUTOMATIONS_COMMAND_ID, e.element.id);
			}
		}));
		const create = append(this.group.body, $('button.volt-agent-dock-row.volt-agent-dock-automation-new')) as HTMLButtonElement;
		create.type = 'button';
		create.appendChild(renderIcon(Codicon.add));
		append(create, $('span')).textContent = localize('voltAgent.dock.newAutomation', "New automation");
		this._register(addDisposableListener(create, 'click', () => {
			void this.commandService.executeCommand(NEW_AUTOMATION_COMMAND_ID, this.sessionId ? { threadId: this.sessionId } : undefined);
		}));
	}

	/** The chat on screen, and its project folder. */
	setSession(sessionId: string | undefined, folder: URI | undefined): void {
		if (sessionId === this.sessionId && isEqual(folder, this.folder)) {
			return;
		}
		this.sessionId = sessionId;
		this.folder = folder;
		this.render();
	}

	/** Lists and follows the automations while the section is on screen. */
	setShown(shown: boolean): void {
		if (shown === this.shown) {
			return;
		}
		this.shown = shown;
		this.visibleStore.clear();
		if (shown && this.automations) {
			this.visibleStore.add(this.automations.onDidChange(() => this.render()));
			void this.automations.whenReady.then(() => this.render());
		}
		this.render();
	}

	private rows(): IAutomation[] {
		const all = this.automations?.list() ?? [];
		const chat = this.sessionId;
		const folder = this.folder;
		const ofChat = all.filter(automation => !!chat && (automation.threadId === chat || automation.sourceThreadId === chat));
		const ofProject = folder ? all.filter(automation => !ofChat.includes(automation) && automation.repositories.some(repository => {
			try {
				return isEqual(URI.parse(repository.root), folder);
			} catch {
				return false;
			}
		})) : [];
		return [...ofChat, ...ofProject];
	}

	private render(): void {
		if (!this.shown) {
			return;
		}
		const rows = this.rows();
		this.group.setCount(rows.length || undefined);
		const height = Math.min(rows.length, AUTOMATION_ROWS_VISIBLE) * AUTOMATION_ROW_HEIGHT;
		this.host.style.height = `${height}px`;
		this.host.style.display = height ? '' : 'none';
		this.list.layout(height);
		this.list.splice(0, this.list.length, rows);
	}
}

//#endregion
