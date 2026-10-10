/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentCustomize.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { IActionViewItem } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { IBaseActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IAction } from '../../../../../base/common/actions.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename, joinPath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { getLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService, SIDE_GROUP } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IAgentRuntimeService, IVoltMcpServerStatus } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltMemoryService, VoltMemoryScope } from '../../../../services/voltRuntime/common/memory/voltMemory.js';
import { IVoltHookExecution, IVoltHooksService } from '../../../../services/voltRuntime/common/hooks/voltHooks.js';
import '../../../../services/voltRuntime/browser/hooks/voltHooksService.js';
import { createModeIcon } from '../chrome/agentModeIcons.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createAgentScrollable } from '../editor/agentScrollable.js';
import { createAgentTitleActionViewItem } from '../editor/agentTitleActions.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { AgentSurfaceHost } from '../workspace/agentSurfaceHost.js';
import { hasSavedAgentTools } from '../workspace/agentToolsEditorPart.js';
import { AgentCustomizationKind, customizationGroupKey, IAgentCustomization, IAgentPluginInfo, kindInfo, ORIGIN_LABELS, safeItemName } from './agentCustomize.js';
import { IAgentCustomizeService } from './agentCustomizeService.js';
import { itemNameError, showCustomizeConfirmDialog, showCustomizeInputDialog } from './agentCustomizeDialogs.js';
import { formatInstalls, IAgentMarketplaceService, IMarketplace, IMarketplacePlugin, ISkillsShSkill, MarketplaceScope } from './agentMarketplace.js';
import { AgentMarketplaceView, IAgentMarketplaceScope } from './agentMarketplaceView.js';

export const AGENT_CUSTOMIZE_EDITOR_ID = 'workbench.editor.voltCustomize';
export const AGENT_CUSTOMIZE_INPUT_ID = 'workbench.input.voltCustomize';

const CustomizeIcon = registerIcon('volt-customize-editor-label-icon', Codicon.extensions, localize('voltCustomizeIcon', 'Icon of the agent Customize tab.'));

export class AgentCustomizeEditorInput extends EditorInput {

	static readonly TypeID = AGENT_CUSTOMIZE_INPUT_ID;
	static readonly EditorID = AGENT_CUSTOMIZE_EDITOR_ID;

	readonly resource = URI.from({ scheme: Schemas.voltCustomize, path: 'customize' });

	override get typeId(): string {
		return AgentCustomizeEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return AgentCustomizeEditorInput.EditorID;
	}

	override getName(): string {
		return localize('voltCustomize.tab', "Customize");
	}

	override getIcon(): ThemeIcon {
		return CustomizeIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof AgentCustomizeEditorInput;
	}
}

export class AgentCustomizeEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(AgentCustomizeEditorInput);
	}
}

/** The tabs of the page, in Cursor's order; Memories is Volt's own. */
type KindTab = 'plugin' | 'mcp' | 'skill' | 'subagent' | 'rule' | 'command' | 'hook' | 'memory';
const TABS: readonly KindTab[] = ['plugin', 'mcp', 'skill', 'subagent', 'rule', 'command', 'hook', 'memory'];
/** Kinds a section's + New creates from a template and a name. */
const NAMED_KINDS: ReadonlySet<AgentCustomizationKind> = new Set(['skill', 'subagent', 'rule', 'command']);

type SortOrder = 'name' | 'source';
type View = 'manage' | 'marketplace';

interface IPageState {
	readonly kind?: KindTab;
	readonly sort?: SortOrder;
	readonly descriptions?: boolean;
	/** Scopes the user unchecked: `user`, or a folder URI. New folders start checked. */
	readonly excluded?: readonly string[];
}

interface ISection {
	readonly key: string;
	readonly title: string;
	readonly items: IAgentCustomization[];
	/** Where + New creates items for this section. */
	readonly base?: { readonly kind: 'user' } | { readonly kind: 'workspace'; readonly folder: URI };
	readonly plugin?: IAgentPluginInfo;
}

interface IRowSpec {
	readonly icon: HTMLElement;
	readonly name: string;
	readonly badge?: string;
	readonly description?: string;
	readonly tooltip?: string;
	readonly onOpen?: () => void;
	readonly trailing?: (row: HTMLElement) => void;
	readonly menu?: () => readonly IVoltMenuItem<() => void>[];
}

const STATE_KEY = 'volt.customize.page';
/** The right panel's tabs are kept under this id, like a chat's. */
const CUSTOMIZE_TOOLS_ID = 'volt-customize';
const ROWS_PER_SECTION = 5;
const SEARCH_DEBOUNCE_MS = 250;
const MAX_SCOPE_FOLDERS = 4;

const OUTCOME_LABELS: Record<IVoltHookExecution['outcome'], string> = {
	ok: localize('voltCustomize.outcomeOk', "OK"),
	blocked: localize('voltCustomize.outcomeBlocked', "Blocked"),
	rewrote: localize('voltCustomize.outcomeRewrote', "Rewrote"),
	followup: localize('voltCustomize.outcomeFollowup', "Follow-up"),
	error: localize('voltCustomize.outcomeError', "Error"),
};

function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

const KIND_TITLES: Record<KindTab, string> = {
	plugin: localize('voltCustomize.tabPlugins', "Plugins"),
	mcp: localize('voltCustomize.tabMcps', "MCPs"),
	skill: localize('voltCustomize.tabSkills', "Skills"),
	subagent: localize('voltCustomize.tabSubagents', "Subagents"),
	rule: localize('voltCustomize.tabRules', "Rules"),
	command: localize('voltCustomize.tabCommands', "Commands"),
	hook: localize('voltCustomize.tabHooks', "Hooks"),
	memory: localize('voltCustomize.tabMemories', "Memories"),
};

/**
 * Customize: everything that shapes the agent (plugins, MCP servers, skills, subagents, rules,
 * commands, hooks, memories) found in the open folders, the home folder and installed plugins
 * of Volt, Claude Code, Cursor and Codex, plus a marketplace to add more. Items open in the right
 * panel, like a chat's tools.
 */
export class AgentCustomizeEditor extends EditorPane {

	static readonly ID = AGENT_CUSTOMIZE_EDITOR_ID;

	private static readonly onDidRequestView = new Emitter<View>();
	private static pendingView: View | undefined;

	/** Shows the marketplace in the Customize page the next time it is on screen (now, if it is). */
	static requestView(view: View): void {
		AgentCustomizeEditor.pendingView = view;
		AgentCustomizeEditor.onDidRequestView.fire(view);
	}

	private rootEl!: HTMLElement;
	private mainEl!: HTMLElement;
	private headerEl!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private primaryButton!: HTMLButtonElement;
	private filtersEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private listEl!: HTMLElement;
	private scroll!: ReturnType<typeof createAgentScrollable>;
	private surfaceHost: AgentSurfaceHost | undefined;
	private presented = false;
	private marketplaceView!: AgentMarketplaceView;

	private view: View = 'manage';
	private items: readonly IAgentCustomization[] = [];
	private loaded = false;
	private query = '';
	private kind: KindTab = 'skill';
	private sort: SortOrder = 'name';
	private showDescriptions = true;
	private excluded = new Set<string>();
	private showAllScopes = false;
	private editingPlugins = false;
	private readonly expanded = new Set<string>();
	private mcpStatus: readonly IVoltMcpServerStatus[] | undefined;
	private mcpLoading = false;
	private readonly logos = new Map<string, string | null>();
	private readonly slugs = new Map<string, string | null>();
	private userName = '';

	/** skills.sh results and marketplace plugins for the current search. */
	private remoteSkills: readonly ISkillsShSkill[] | undefined;
	private remotePlugins: readonly IMarketplace[] | undefined;
	private remoteTimer: ReturnType<typeof setTimeout> | undefined;
	private remoteCts: CancellationTokenSource | undefined;
	private readonly busy = new Set<string>();

	private readonly renderStore = this._register(new DisposableStore());
	private readonly filterStore = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storage: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVoltMemoryService private readonly memory: IVoltMemoryService,
		@INotificationService private readonly notificationService: INotificationService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IAgentCustomizeService private readonly customize: IAgentCustomizeService,
		@IAgentMarketplaceService private readonly marketplace: IAgentMarketplaceService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltHooksService private readonly hooks: IVoltHooksService,
	) {
		super(AgentCustomizeEditor.ID, group, telemetryService, themeService, storage);
		this.restoreState();
	}

	//#region Setup

	protected override createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.volt-customize-root'));
		this.mainEl = append(this.rootEl, $('.volt-customize-main'));
		const page = append(this.mainEl, $('.volt-customize'));

		this.headerEl = append(page, $('.volt-customize-header-area'));
		const top = append(this.headerEl, $('.volt-customize-top'));
		const search = append(top, $('.volt-customize-search'));
		search.appendChild(renderIcon(Codicon.search));
		this.searchInput = append(search, $('input.volt-customize-search-input')) as HTMLInputElement;
		this.searchInput.type = 'text';
		this.searchInput.spellcheck = false;
		this.searchInput.placeholder = localize('voltCustomize.searchPlaceholder', "Search Plugins, Skills, MCPs...");
		this.searchInput.setAttribute('aria-label', this.searchInput.placeholder);
		this._register(addDisposableListener(this.searchInput, EventType.INPUT, () => this.onQuery(this.searchInput.value)));
		this._register(addDisposableListener(this.searchInput, EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && this.searchInput.value) {
				e.preventDefault();
				this.searchInput.value = '';
				this.onQuery('');
			}
		}));
		this.primaryButton = append(top, $('button.volt-customize-primary')) as HTMLButtonElement;
		this.primaryButton.type = 'button';
		this._register(addDisposableListener(this.primaryButton, EventType.CLICK, () => this.setView(this.view === 'manage' ? 'marketplace' : 'manage')));

		this.filtersEl = append(this.headerEl, $('.volt-customize-filters'));

		this.bodyEl = $('.volt-customize-body');
		this.listEl = append(this.bodyEl, $('.volt-customize-list'));
		this.scroll = this._register(createAgentScrollable(this.bodyEl));
		const scrollNode = append(page, this.scroll.getDomNode());
		scrollNode.classList.add('volt-customize-scroll');

		this.marketplaceView = this._register(this.instantiationService.createInstance(AgentMarketplaceView, this.headerEl, this.bodyEl, {
			scopes: () => this.installScopes(),
			openResource: resource => void this.openResource(resource),
			dialogHost: () => this.layoutService.activeContainer,
			relayout: () => this.scroll.scanDomNode(),
		}));
		this.marketplaceView.setVisible(false);

		this.surfaceHost = this._register(this.instantiationService.createInstance(AgentSurfaceHost, this.rootEl, this.mainEl));

		this._register(this.customize.onDidChange(() => {
			this.items = this.customize.items;
			this.loaded = true;
			this.mcpStatus = undefined;
			this.render();
		}));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this.render()));
		this._register(this.hooks.onDidChangeExecutions(() => {
			if (this.kind === 'hook' && this.view === 'manage' && !this.query) {
				this.render();
			}
		}));
		this._register(AgentCustomizeEditor.onDidRequestView.event(view => {
			if (this.isVisible()) {
				AgentCustomizeEditor.pendingView = undefined;
				this.setView(view);
			}
		}));
		this._register({ dispose: () => this.cancelRemote() });
		this.render();
	}

	override async setInput(input: AgentCustomizeEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}
		if (!this.presented && hasSavedAgentTools(this.storage, CUSTOMIZE_TOOLS_ID)) {
			this.presentTools();
		}
		const pending = AgentCustomizeEditor.pendingView;
		AgentCustomizeEditor.pendingView = undefined;
		if (pending) {
			this.setView(pending);
		}
		void this.customize.userHome().then(home => {
			this.userName = home ? basename(home) : '';
		});
		this.items = this.customize.items;
		this.loaded = this.items.length > 0;
		this.render();
		const items = await this.customize.getItems();
		if (token.isCancellationRequested) {
			return;
		}
		this.items = items;
		this.loaded = true;
		this.render();
		if (!options?.preserveFocus) {
			this.searchInput.focus();
		}
	}

	private restoreState(): void {
		try {
			const state = JSON.parse(this.storage.get(STATE_KEY, StorageScope.PROFILE, '{}')) as IPageState;
			if (state.kind && TABS.includes(state.kind)) {
				this.kind = state.kind;
			}
			if (state.sort === 'name' || state.sort === 'source') {
				this.sort = state.sort;
			}
			if (typeof state.descriptions === 'boolean') {
				this.showDescriptions = state.descriptions;
			}
			if (Array.isArray(state.excluded)) {
				this.excluded = new Set(state.excluded.filter((key): key is string => typeof key === 'string'));
			}
		} catch {
			// A broken record starts the page from its defaults.
		}
	}

	private storePageState(): void {
		const state: IPageState = { kind: this.kind, sort: this.sort, descriptions: this.showDescriptions, excluded: [...this.excluded] };
		this.storage.store(STATE_KEY, JSON.stringify(state), StorageScope.PROFILE, StorageTarget.USER);
	}

	//#endregion

	//#region Right panel

	private presentTools(): void {
		if (!this.presented && this.surfaceHost) {
			this.presented = true;
			this.surfaceHost.present(CUSTOMIZE_TOOLS_ID);
		}
	}

	/**
	 * Opens a file in the right panel beside the page, with the same tabs and chrome as a chat's
	 * tools. Without that panel (the IDE layout, or the page in the side panel) it opens beside.
	 */
	private async openResource(resource: URI): Promise<void> {
		const host = this.surfaceHost;
		if (host && getLayoutMode(this.layoutService) === 'agent' && this.editorGroupsService.mainPart.groups.includes(this.group)) {
			this.presentTools();
			if (host.canOpenTools()) {
				host.openFile(resource);
				return;
			}
		}
		const inMainPart = this.editorGroupsService.mainPart.groups.includes(this.group);
		await this.editorService.openEditor({ resource, options: { pinned: true } }, inMainPart ? SIDE_GROUP : this.editorGroupsService.mainPart.activeGroup);
	}

	//#endregion

	//#region State changes

	private setView(view: View): void {
		if (this.view === view) {
			return;
		}
		this.view = view;
		this.cancelRemote();
		if (view === 'manage' && this.query) {
			this.scheduleRemoteSearch();
		}
		this.render();
		this.scroll.setScrollPosition({ scrollTop: 0 });
	}

	private onQuery(value: string): void {
		this.query = value.trim();
		if (this.view === 'marketplace') {
			this.marketplaceView.setQuery(this.query);
			return;
		}
		this.scheduleRemoteSearch();
		this.render();
	}

	private setKind(kind: KindTab): void {
		this.kind = kind;
		this.editingPlugins = false;
		this.storePageState();
		this.render();
		this.scroll.setScrollPosition({ scrollTop: 0 });
	}

	private cancelRemote(): void {
		clearTimeout(this.remoteTimer);
		this.remoteCts?.dispose(true);
		this.remoteCts = undefined;
	}

	/** The search also asks skills.sh and the plugin marketplaces, after a pause in typing. */
	private scheduleRemoteSearch(): void {
		this.cancelRemote();
		this.remoteSkills = undefined;
		const query = this.query;
		if (query.length < 2) {
			return;
		}
		this.remoteTimer = setTimeout(() => {
			const cts = this.remoteCts = new CancellationTokenSource();
			void Promise.all([
				this.marketplace.searchSkills(query, 20, cts.token).catch(() => [] as readonly ISkillsShSkill[]),
				this.remotePlugins ? Promise.resolve(this.remotePlugins) : this.marketplace.listMarketplaces().catch(() => [] as readonly IMarketplace[]),
			]).then(([skills, marketplaces]) => {
				if (cts.token.isCancellationRequested || query !== this.query) {
					return;
				}
				this.remoteSkills = skills;
				this.remotePlugins = marketplaces;
				this.render();
			});
		}, SEARCH_DEBOUNCE_MS);
	}

	//#endregion

	//#region Rendering

	private render(): void {
		if (!this.listEl) {
			return;
		}
		const marketplace = this.view === 'marketplace';
		clearNode(this.primaryButton);
		if (marketplace) {
			append(this.primaryButton, $('span')).textContent = localize('voltCustomize.manage', "Manage");
		} else {
			append(this.primaryButton, $('span.long')).textContent = localize('voltCustomize.marketplace', "Browse Marketplace");
			append(this.primaryButton, $('span.short')).textContent = localize('voltCustomize.browse', "Browse");
		}
		this.primaryButton.classList.toggle('manage', marketplace);
		this.filtersEl.classList.toggle('hidden', marketplace);
		this.listEl.classList.toggle('hidden', marketplace);
		this.marketplaceView.setVisible(marketplace);
		if (marketplace) {
			this.marketplaceView.setQuery(this.query);
			this.scroll.scanDomNode();
			return;
		}
		this.renderFilters();
		this.renderStore.clear();
		clearNode(this.listEl);
		if (this.query) {
			this.renderSearch();
		} else {
			switch (this.kind) {
				case 'plugin': this.renderPlugins(); break;
				case 'mcp': this.renderMcps(); break;
				case 'hook': this.renderHooks(); break;
				default: this.renderKind(this.kind); break;
			}
		}
		this.scroll.scanDomNode();
	}

	private renderFilters(): void {
		const chipsScroll = this.filtersEl.querySelector('.volt-customize-chips')?.scrollLeft ?? 0;
		this.filterStore.clear();
		clearNode(this.filtersEl);
		const scope = append(this.filtersEl, $('button.volt-customize-chip.scope')) as HTMLButtonElement;
		scope.type = 'button';
		scope.appendChild(renderIcon(Codicon.globe));
		append(scope, $('span')).textContent = this.scopeLabel();
		scope.appendChild(renderIcon(Codicon.chevronDown));
		scope.setAttribute('aria-haspopup', 'true');
		this.filterStore.add(addDisposableListener(scope, EventType.CLICK, () => this.showScopeMenu(scope)));
		if (this.query) {
			return;
		}
		append(this.filtersEl, $('span.volt-customize-divider'));
		const chips = append(this.filtersEl, $('.volt-customize-chips'));
		for (const kind of TABS) {
			const chip = append(chips, $('button.volt-customize-chip')) as HTMLButtonElement;
			chip.type = 'button';
			chip.textContent = KIND_TITLES[kind];
			chip.classList.toggle('active', kind === this.kind);
			chip.setAttribute('aria-pressed', String(kind === this.kind));
			this.filterStore.add(addDisposableListener(chip, EventType.CLICK, () => this.setKind(kind)));
		}
		chips.scrollLeft = chipsScroll;
		const active = chips.querySelector<HTMLElement>('.volt-customize-chip.active');
		if (active && (active.offsetLeft < chips.scrollLeft || active.offsetLeft + active.offsetWidth > chips.scrollLeft + chips.clientWidth)) {
			chips.scrollLeft = Math.max(0, active.offsetLeft - 24);
		}
		const sort = append(this.filtersEl, $('button.volt-customize-icon-button.filter')) as HTMLButtonElement;
		sort.type = 'button';
		sort.appendChild(renderIcon(Codicon.listFilter));
		const sortLabel = localize('voltCustomize.viewOptions', "View Options");
		sort.setAttribute('aria-label', sortLabel);
		setAgentTooltip(sort, sortLabel);
		this.filterStore.add(addDisposableListener(sort, EventType.CLICK, () => this.showViewMenu(sort)));
	}

	private message(parent: HTMLElement, text: string, error = false): HTMLElement {
		const message = append(parent, $('.volt-customize-message'));
		message.classList.toggle('error', error);
		message.textContent = text;
		return message;
	}

	/** Items of the scopes checked in the scope menu. */
	private visibleItems(): IAgentCustomization[] {
		return this.items.filter(item => this.inScope(item));
	}

	private inScope(item: IAgentCustomization): boolean {
		if (item.scope === 'user') {
			return !this.excluded.has('user');
		}
		const folder = item.folder ?? this.workspaceService.getWorkspace().folders.find(candidate => item.resource.toString().startsWith(candidate.uri.toString()))?.uri;
		return !folder || !this.excluded.has(folder.toString());
	}

	private selectedFolders(): URI[] {
		return this.workspaceService.getWorkspace().folders.map(folder => folder.uri).filter(uri => !this.excluded.has(uri.toString()));
	}

	private sorted(items: IAgentCustomization[]): IAgentCustomization[] {
		return [...items].sort((a, b) => this.sort === 'source'
			? (ORIGIN_LABELS[a.origin ?? 'volt'].localeCompare(ORIGIN_LABELS[b.origin ?? 'volt']) || a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
			: a.name.localeCompare(b.name));
	}

	/** User first, then plugins by name, then the open folders in workspace order. */
	private sections(items: readonly IAgentCustomization[], kind: KindTab): ISection[] {
		const byKey = new Map<string, ISection>();
		const folders = this.workspaceService.getWorkspace().folders;
		const get = (item: IAgentCustomization): ISection => {
			const key = customizationGroupKey(item);
			let section = byKey.get(key);
			if (!section) {
				const folder = item.folder ?? folders.find(candidate => key === `workspace:${candidate.uri.toString()}`)?.uri;
				section = item.plugin
					? { key, title: item.plugin.displayName, items: [], plugin: item.plugin }
					: item.scope === 'user'
						? { key, title: localize('voltCustomize.user', "User"), items: [], base: { kind: 'user' } }
						: { key, title: folder ? basename(folder) : item.source, items: [], base: folder ? { kind: 'workspace', folder } : undefined };
				byKey.set(key, section);
			}
			return section;
		};
		for (const item of items) {
			get(item).items.push(item);
		}
		// Kinds created by name always offer a User section and a section per checked folder, so + New is there.
		if (NAMED_KINDS.has(kind as AgentCustomizationKind) || kind === 'memory') {
			if (!this.excluded.has('user') && !byKey.has('user')) {
				byKey.set('user', { key: 'user', title: localize('voltCustomize.user', "User"), items: [], base: { kind: 'user' } });
			}
			if (kind !== 'memory') {
				for (const folder of this.selectedFolders()) {
					const key = `workspace:${folder.toString()}`;
					if (!byKey.has(key)) {
						byKey.set(key, { key, title: basename(folder), items: [], base: { kind: 'workspace', folder } });
					}
				}
			}
		}
		const order = (section: ISection) => section.key === 'user' ? 0 : section.plugin ? 1 : 2;
		const folderIndex = (section: ISection) => section.base?.kind === 'workspace' ? folders.findIndex(folder => folder.uri.toString() === (section.base as { folder: URI }).folder.toString()) : 0;
		return [...byKey.values()]
			.map(section => ({ ...section, items: this.sorted(section.items) }))
			.sort((a, b) => order(a) - order(b) || (order(a) === 2 ? folderIndex(a) - folderIndex(b) : a.title.localeCompare(b.title)));
	}

	private sectionHeader(parent: HTMLElement, title: string, count: number | undefined, actions?: (container: HTMLElement) => void): HTMLElement {
		const header = append(parent, $('.volt-customize-section-header'));
		const heading = append(header, $('h3.volt-customize-section-title'));
		append(heading, $('span')).textContent = title;
		if (count !== undefined) {
			append(heading, $('span.count')).textContent = String(count);
		}
		if (actions) {
			actions(append(header, $('.volt-customize-section-actions')));
		}
		return header;
	}

	private newButton(parent: HTMLElement, label: string, run: () => void): HTMLButtonElement {
		const button = append(parent, $('button.volt-customize-outline-button')) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(renderIcon(Codicon.add));
		append(button, $('span')).textContent = label;
		this.renderStore.add(addDisposableListener(button, EventType.CLICK, run));
		return button;
	}

	/** A section's rows: the first five, then Show N more. */
	private renderRows(section: HTMLElement, id: string, rows: readonly IRowSpec[], empty?: string): void {
		if (!rows.length) {
			if (empty) {
				const card = append(section, $('.volt-customize-card.empty'));
				append(card, $('.volt-customize-card-empty')).textContent = empty;
			}
			return;
		}
		const expanded = this.expanded.has(id);
		const visible = expanded ? rows : rows.slice(0, ROWS_PER_SECTION);
		const card = append(section, $('.volt-customize-card'));
		for (const spec of visible) {
			this.renderRow(card, spec);
		}
		if (rows.length > ROWS_PER_SECTION) {
			const more = append(section, $('button.volt-customize-show-more')) as HTMLButtonElement;
			more.type = 'button';
			append(more, $('span')).textContent = expanded
				? localize('voltCustomize.showLess', "Show less")
				: localize('voltCustomize.showMore', "Show {0} more", rows.length - ROWS_PER_SECTION);
			more.appendChild(renderIcon(expanded ? Codicon.chevronUp : Codicon.chevronDown));
			this.renderStore.add(addDisposableListener(more, EventType.CLICK, () => {
				if (expanded) {
					this.expanded.delete(id);
				} else {
					this.expanded.add(id);
				}
				this.render();
			}));
		}
	}

	private renderRow(card: HTMLElement, spec: IRowSpec): HTMLElement {
		const row = append(card, $('.volt-customize-row'));
		row.appendChild(spec.icon);
		const copy = append(row, $('.volt-customize-row-copy'));
		const line = append(copy, $('.volt-customize-row-line'));
		append(line, $('span.name')).textContent = spec.name;
		if (spec.badge) {
			append(line, $('span.volt-customize-badge')).textContent = spec.badge;
		}
		if (spec.description) {
			append(copy, $('span.description')).textContent = spec.description;
		} else {
			row.classList.add('single');
		}
		if (spec.tooltip) {
			setAgentTooltip(copy, spec.tooltip);
		}
		spec.trailing?.(row);
		if (spec.menu) {
			const more = append(row, $('button.volt-customize-row-more')) as HTMLButtonElement;
			more.type = 'button';
			more.appendChild(renderIcon(Codicon.ellipsis));
			more.setAttribute('aria-label', localize('voltCustomize.moreActions', "More Actions"));
			const menu = spec.menu;
			this.renderStore.add(addDisposableListener(more, EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				this.showRowMenu(more, menu());
			}));
		}
		if (spec.onOpen) {
			const open = spec.onOpen;
			row.tabIndex = 0;
			row.setAttribute('role', 'button');
			row.classList.add('clickable');
			this.renderStore.add(addDisposableListener(row, EventType.CLICK, e => {
				if (!(e.target as HTMLElement).closest('button')) {
					open();
				}
			}));
			this.renderStore.add(addDisposableListener(row, EventType.KEY_DOWN, e => {
				if ((e.key === 'Enter' || e.key === ' ') && e.target === row) {
					e.preventDefault();
					open();
				}
			}));
		}
		return row;
	}

	private iconTile(item: IAgentCustomization | undefined, kind: AgentCustomizationKind, status?: 'ready' | 'connecting' | 'idle' | 'error'): HTMLElement {
		const tile = $('.volt-customize-tile');
		const plugin = item?.plugin;
		if (plugin?.logo) {
			const cached = this.logos.get(plugin.id);
			if (cached) {
				this.logoImage(tile, cached);
			} else {
				this.kindIcon(tile, kind);
				if (cached === undefined) {
					this.logos.set(plugin.id, null);
					void this.customize.pluginLogo(plugin).then(url => {
						this.logos.set(plugin.id, url ?? null);
						if (url) {
							this.render();
						}
					});
				}
			}
		} else {
			this.kindIcon(tile, kind);
		}
		if (status) {
			append(tile, $(`span.volt-customize-status.${status}`));
		}
		return tile;
	}

	private logoImage(tile: HTMLElement, url: string): void {
		tile.classList.add('logo');
		const image = append(tile, $('img')) as HTMLImageElement;
		image.alt = '';
		image.src = url;
	}

	private kindIcon(tile: HTMLElement, kind: AgentCustomizationKind): void {
		switch (kind) {
			case 'subagent':
				tile.appendChild(createModeIcon('agent'));
				break;
			case 'skill': tile.appendChild(renderIcon(Codicon.zap)); break;
			case 'rule': tile.appendChild(renderIcon(Codicon.listUnordered)); break;
			case 'command': tile.appendChild(renderIcon(Codicon.terminal)); break;
			case 'hook': tile.appendChild(renderIcon(Codicon.file)); break;
			case 'mcp': tile.appendChild(renderIcon(Codicon.mcp)); break;
			case 'plugin': tile.appendChild(renderIcon(Codicon.package)); break;
			case 'memory': tile.appendChild(renderIcon(Codicon.bookmark)); break;
		}
	}

	private itemRow(item: IAgentCustomization, options?: { badge?: string; descriptionFallback?: string }): IRowSpec {
		const description = this.showDescriptions ? (item.description || options?.descriptionFallback) : undefined;
		return {
			icon: this.iconTile(item, item.kind),
			name: item.name,
			badge: options?.badge,
			description,
			tooltip: item.resource.scheme === Schemas.file ? item.resource.fsPath : item.resource.toString(),
			onOpen: () => void this.openResource(item.resource),
			menu: () => this.itemMenu(item),
		};
	}

	private renderKind(kind: Exclude<KindTab, 'plugin' | 'mcp' | 'hook'>): void {
		const items = this.visibleItems().filter(item => item.kind === kind);
		if (!this.loaded && !items.length) {
			this.message(this.listEl, localize('voltCustomize.loading', "Looking for customizations…"));
			return;
		}
		const sections = this.sections(items, kind);
		if (!sections.length) {
			this.emptyBox(localize('voltCustomize.noScope', "Nothing to show"), localize('voltCustomize.noScopeHint', "Check User or a workspace in the scope menu to see its {0}.", KIND_TITLES[kind].toLowerCase()));
			return;
		}
		for (const section of sections) {
			const element = append(this.listEl, $('section.volt-customize-section'));
			const base = section.base;
			this.sectionHeader(element, section.title, section.items.length, base ? actions => {
				this.newButton(actions, localize('voltCustomize.new', "New"), () => void (kind === 'memory' ? this.addMemory() : this.createNamed(kind, section.title, base)));
			} : undefined);
			const rows = section.items.map(item => this.itemRow(item, {
				descriptionFallback: kind === 'command' ? (item.scope === 'user' ? 'user' : section.title) : undefined,
			}));
			this.renderRows(element, `${kind}:${section.key}`, rows, base ? this.emptyText(kind) : undefined);
		}
	}

	private emptyText(kind: KindTab): string {
		switch (kind) {
			case 'skill': return localize('voltCustomize.emptySkills', "No skills yet. Create one, or add one from the marketplace.");
			case 'subagent': return localize('voltCustomize.emptySubagents', "No subagents yet.");
			case 'rule': return localize('voltCustomize.emptyRules', "No rules yet.");
			case 'command': return localize('voltCustomize.emptyCommands', "No commands yet.");
			case 'memory': return localize('voltCustomize.emptyMemories', "No memories yet.");
			default: return '';
		}
	}

	private emptyBox(title: string, hint: string): void {
		const box = append(this.listEl, $('.volt-customize-empty-box'));
		append(box, $('.title')).textContent = title;
		append(box, $('.hint')).textContent = hint;
	}

	private renderPlugins(): void {
		const plugins = this.visibleItems().filter(item => item.kind === 'plugin');
		const section = append(this.listEl, $('section.volt-customize-section'));
		this.sectionHeader(section, localize('voltCustomize.installed', "Installed"), plugins.length, actions => {
			if (plugins.some(plugin => plugin.plugin?.origin === 'volt')) {
				const edit = append(actions, $('button.volt-customize-text-button')) as HTMLButtonElement;
				edit.type = 'button';
				edit.textContent = this.editingPlugins ? localize('voltCustomize.done', "Done") : localize('voltCustomize.edit', "Edit");
				this.renderStore.add(addDisposableListener(edit, EventType.CLICK, () => {
					this.editingPlugins = !this.editingPlugins;
					this.render();
				}));
			}
			this.newButton(actions, localize('voltCustomize.add', "Add"), () => this.setView('marketplace'));
		});
		if (!this.loaded && !plugins.length) {
			this.message(section, localize('voltCustomize.loading', "Looking for customizations…"));
			return;
		}
		const rows = this.sorted(plugins).map((item): IRowSpec => {
			const plugin = item.plugin!;
			return {
				icon: this.iconTile(item, 'plugin'),
				name: plugin.displayName,
				description: plugin.publisher,
				tooltip: plugin.description || plugin.root.fsPath,
				onOpen: () => void this.openPlugin(plugin),
				trailing: this.editingPlugins ? row => {
					if (plugin.origin === 'volt') {
						const remove = append(row, $('button.volt-customize-add-button.remove')) as HTMLButtonElement;
						remove.type = 'button';
						remove.textContent = localize('voltCustomize.remove', "Remove");
						this.renderStore.add(addDisposableListener(remove, EventType.CLICK, e => {
							e.stopPropagation();
							void this.removePlugin(plugin);
						}));
					} else {
						const tag = append(row, $('span.volt-customize-badge'));
						tag.textContent = localize('voltCustomize.managedBy', "Managed by {0}", plugin.origin === 'claude' ? 'Claude Code' : ORIGIN_LABELS[plugin.origin]);
					}
				} : undefined,
				menu: () => this.pluginMenu(plugin),
			};
		});
		this.renderRows(section, 'plugin:installed', rows, localize('voltCustomize.noPlugins', "No plugins installed. Add one from the marketplace."));
	}

	private async openPlugin(plugin: IAgentPluginInfo): Promise<void> {
		const readme = joinPath(plugin.root, 'README.md');
		await this.openResource(await this.fileService.exists(readme) ? readme : plugin.manifest ?? readme);
	}

	private async removePlugin(plugin: IAgentPluginInfo): Promise<void> {
		const confirmed = await showCustomizeConfirmDialog(this.layoutService.activeContainer, {
			title: localize('voltCustomize.removePluginTitle', "Remove {0}?", plugin.displayName),
			message: localize('voltCustomize.removePluginMessage', "Its skills, rules, commands and MCP servers stop loading. The folder is moved to the trash."),
			confirmLabel: localize('voltCustomize.remove', "Remove"),
			destructive: true,
		});
		if (!confirmed) {
			return;
		}
		try {
			await this.marketplace.uninstallPlugin(plugin.name);
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}

	private renderMcps(): void {
		const servers = this.visibleItems().filter(item => item.kind === 'mcp');
		if (!this.mcpStatus && !this.mcpLoading) {
			this.mcpLoading = true;
			const root = this.selectedFolders()[0];
			void this.runtime.listMcpServers(root).then(status => status, () => [] as readonly IVoltMcpServerStatus[]).then(status => {
				this.mcpLoading = false;
				this.mcpStatus = status;
				if (this.kind === 'mcp') {
					this.render();
				}
			});
		}
		const statusOf = (item: IAgentCustomization) => this.mcpStatus?.find(candidate => candidate.name === item.name && (candidate.scope === 'user') === (item.scope === 'user'))
			?? this.mcpStatus?.find(candidate => candidate.name === item.name);
		const attention: IAgentCustomization[] = [];
		const connected: IAgentCustomization[] = [];
		for (const item of this.sorted(servers)) {
			const state = statusOf(item)?.state;
			if (state === 'error' || item.mcp?.disabled) {
				attention.push(item);
			} else {
				connected.push(item);
			}
		}
		const badge = (item: IAgentCustomization) => item.plugin ? localize('voltCustomize.badgePlugin', "Plugin") : item.scope === 'user' ? localize('voltCustomize.badgeUser', "User") : localize('voltCustomize.badgeProject', "Project");
		if (attention.length) {
			const section = append(this.listEl, $('section.volt-customize-section'));
			this.sectionHeader(section, localize('voltCustomize.needsAttention', "Needs Attention"), attention.length);
			this.renderRows(section, 'mcp:attention', attention.map((item): IRowSpec => {
				const disabled = !!item.mcp?.disabled;
				return {
					icon: this.iconTile(item, 'mcp'),
					name: item.name,
					badge: badge(item),
					description: disabled ? localize('voltCustomize.mcpDisabled', "Disabled in {0}", basename(item.resource)) : item.mcp?.url ? localize('voltCustomize.mcpNeedsAuth', "Couldn't connect. It may need authentication") : localize('voltCustomize.mcpFailed', "Failed to start"),
					tooltip: item.description,
					onOpen: () => void this.openResource(item.resource),
					trailing: row => {
						const action = append(row, $('button.volt-customize-link-button')) as HTMLButtonElement;
						action.type = 'button';
						action.textContent = item.mcp?.url && !disabled ? localize('voltCustomize.authenticate', "Authenticate") : localize('voltCustomize.showConfig', "Show Config");
						this.renderStore.add(addDisposableListener(action, EventType.CLICK, e => {
							e.stopPropagation();
							void this.openResource(item.resource);
						}));
					},
					menu: () => this.itemMenu(item),
				};
			}));
		}
		const section = append(this.listEl, $('section.volt-customize-section'));
		this.sectionHeader(section, localize('voltCustomize.connected', "Connected"), connected.length);
		if (!this.loaded && !servers.length) {
			this.message(section, localize('voltCustomize.loading', "Looking for customizations…"));
		} else {
			this.renderRows(section, 'mcp:connected', connected.map((item): IRowSpec => {
				const status = statusOf(item);
				const state = status?.state ?? 'idle';
				const pluginNote = item.plugin && item.plugin.origin !== 'volt' ? localize('voltCustomize.mcpUsedBy', "Used by {0}", item.plugin.origin === 'claude' ? 'Claude Code' : ORIGIN_LABELS[item.plugin.origin]) : undefined;
				const stateText = state === 'ready' ? localize('voltCustomize.mcpReady', "Running") : state === 'connecting' ? localize('voltCustomize.mcpConnecting', "Starting…") : undefined;
				return {
					icon: this.iconTile(item, 'mcp', status ? state : undefined),
					name: item.name,
					badge: badge(item),
					description: [stateText, pluginNote, item.description].filter(Boolean).join(' · ') || undefined,
					tooltip: state === 'idle' ? localize('voltCustomize.mcpIdle', "Starts with the next chat that needs its tools") : item.description,
					onOpen: () => void this.openResource(item.resource),
					menu: () => this.itemMenu(item),
				};
			}), localize('voltCustomize.noMcps', "No MCP servers yet."));
		}
		const add = append(this.listEl, $('.volt-customize-card.volt-customize-new-row'));
		const row = this.renderRow(add, {
			icon: (() => { const tile = $('.volt-customize-tile'); tile.appendChild(renderIcon(Codicon.add)); return tile; })(),
			name: localize('voltCustomize.newMcp', "New MCP Server"),
			description: localize('voltCustomize.newMcpHint', "Add a Custom MCP Server"),
			onOpen: () => this.showNewMcpMenu(row),
		});
	}

	private renderHooks(): void {
		const hooks = this.visibleItems().filter(item => item.kind === 'hook');
		const groups = new Map<string, { title: string; items: IAgentCustomization[]; base?: ISection['base'] }>();
		for (const item of this.sorted(hooks)) {
			const origin = ORIGIN_LABELS[item.origin ?? 'volt'];
			const folder = item.folder;
			const key = item.plugin ? `plugin:${item.plugin.id}` : item.scope === 'user' ? `user:${item.origin}` : `workspace:${folder?.toString()}:${item.origin}`;
			const title = item.plugin
				? item.plugin.displayName
				: item.scope === 'user'
					? localize('voltCustomize.hooksUser', "{0} User", origin)
					: `${folder ? basename(folder) : item.source} / ${origin}`;
			let group = groups.get(key);
			if (!group) {
				group = { title, items: [] };
				groups.set(key, group);
			}
			group.items.push(item);
		}
		const settingsBar = append(this.listEl, $('.volt-customize-hooks-bar'));
		const settingsHint = append(settingsBar, $('span.hint'));
		settingsHint.textContent = localize('voltCustomize.hooksHint', "Hooks from Volt, Cursor and Claude Code run around the agent's actions.");
		const settings = append(settingsBar, $('button.volt-customize-text-button')) as HTMLButtonElement;
		settings.type = 'button';
		settings.appendChild(renderIcon(Codicon.settingsGear));
		append(settings, $('span')).textContent = localize('voltCustomize.hookSettings', "Settings");
		this.renderStore.add(addDisposableListener(settings, EventType.CLICK, () => this.openHookSettings()));
		if (!groups.size) {
			const section = append(this.listEl, $('section.volt-customize-section'));
			this.sectionHeader(section, localize('voltCustomize.user', "User"), 0, actions => {
				this.newButton(actions, localize('voltCustomize.new', "New"), () => void this.createHooksFile({ kind: 'user' }));
			});
			this.renderRows(section, 'hook:none', [], this.loaded ? localize('voltCustomize.noHooks', "No hooks yet. Hooks run a command before or after the agent's actions.") : localize('voltCustomize.loading', "Looking for customizations…"));
		}
		for (const [key, group] of groups) {
			const section = append(this.listEl, $('section.volt-customize-section'));
			this.sectionHeader(section, group.title, group.items.length, key.startsWith('user:volt') ? actions => {
				this.newButton(actions, localize('voltCustomize.new', "New"), () => void this.createHooksFile({ kind: 'user' }));
			} : undefined);
			this.renderRows(section, `hook:${key}`, group.items.map(item => ({
				icon: this.iconTile(item, 'hook'),
				name: item.name,
				description: item.command || item.description,
				tooltip: item.command,
				onOpen: () => void this.openResource(item.resource),
				menu: () => this.itemMenu(item),
			})));
		}
		const executions = this.hooks.executions;
		const log = append(this.listEl, $('section.volt-customize-section'));
		this.sectionHeader(log, localize('voltCustomize.executionLog', "Execution Log"), executions.length, actions => {
			const clear = append(actions, $('button.volt-customize-outline-button.subtle')) as HTMLButtonElement;
			clear.type = 'button';
			clear.disabled = !executions.length;
			clear.appendChild(renderIcon(Codicon.trash));
			append(clear, $('span')).textContent = localize('voltCustomize.clearLog', "Clear log");
			this.renderStore.add(addDisposableListener(clear, EventType.CLICK, () => this.hooks.clearExecutions()));
		});
		if (!executions.length) {
			const empty = append(log, $('.volt-customize-empty-box.bordered'));
			append(empty, $('.title')).textContent = localize('voltCustomize.noHookRuns', "No hook executions yet");
			append(empty, $('.hint')).textContent = localize('voltCustomize.noHookRunsHint', "Hooks that run during the agent's loop will show up here.");
			return;
		}
		this.renderRows(log, 'hook:log', executions.map(execution => this.executionRow(execution)));
	}

	private executionRow(execution: IVoltHookExecution): IRowSpec {
		const tile = $('.volt-customize-tile');
		tile.appendChild(renderIcon(execution.outcome === 'blocked' ? Codicon.circleSlash : execution.outcome === 'error' ? Codicon.warning : Codicon.symbolEvent));
		const title = execution.toolName ? `${execution.sourceEvent} · ${execution.toolName}` : execution.sourceEvent;
		const duration = execution.timedOut
			? localize('voltCustomize.hookTimedOut', "timed out after {0}", formatDuration(execution.durationMs))
			: formatDuration(execution.durationMs);
		const description = [fromNow(execution.startedAt, true), execution.label, duration, execution.message?.replace(/\s+/g, ' ').trim()].filter(Boolean).join(' · ');
		return {
			icon: tile,
			name: title,
			description,
			tooltip: [execution.command, execution.exitCode !== null ? localize('voltCustomize.hookExit', "Exit code {0}", execution.exitCode) : undefined, execution.message].filter(Boolean).join('\n'),
			trailing: row => {
				const badge = append(row, $(`span.volt-customize-outcome.${execution.outcome}`));
				badge.textContent = OUTCOME_LABELS[execution.outcome];
			},
		};
	}

	private openHookSettings(): void {
		void this.commandService.executeCommand('workbench.action.openSettings', 'volt.agent.hooks');
	}

	private renderSearch(): void {
		const query = this.query.toLowerCase();
		const matches = this.visibleItems().filter(item => `${item.name} ${item.description} ${item.source} ${item.plugin?.displayName ?? ''}`.toLowerCase().includes(query));
		let any = false;
		for (const kind of TABS) {
			const items = this.sorted(matches.filter(item => item.kind === kind));
			if (!items.length) {
				continue;
			}
			any = true;
			const section = append(this.listEl, $('section.volt-customize-section'));
			this.sectionHeader(section, KIND_TITLES[kind], items.length);
			this.renderRows(section, `search:${kind}`, items.map(item => kind === 'plugin'
				? { ...this.itemRow(item), name: item.plugin?.displayName ?? item.name, description: item.plugin?.publisher, onOpen: () => item.plugin && void this.openPlugin(item.plugin) }
				: this.itemRow(item)));
		}
		const remote = this.remoteRows(query);
		if (remote) {
			any = true;
			const section = append(this.listEl, $('section.volt-customize-section'));
			this.sectionHeader(section, localize('voltCustomize.marketplaceResults', "Marketplace"), remote.length);
			this.renderRows(section, `search:marketplace:${query}`, remote, localize('voltCustomize.noMarketplaceMatches', "Nothing in the marketplace matches \"{0}\".", this.query));
		} else if (this.query.length >= 2) {
			const section = append(this.listEl, $('section.volt-customize-section'));
			this.sectionHeader(section, localize('voltCustomize.marketplaceResults', "Marketplace"), undefined);
			this.message(section, localize('voltCustomize.searchingMarketplace', "Searching the marketplace…"));
			any = true;
		}
		if (!any) {
			this.emptyBox(localize('voltCustomize.noMatches', "Nothing matches \"{0}\".", this.query), localize('voltCustomize.noMatchesHint', "Try another word, or browse the marketplace."));
		}
	}

	/** skills.sh results and marketplace plugins for the search, with Add. Undefined while loading. */
	private remoteRows(query: string): IRowSpec[] | undefined {
		if (!this.remoteSkills || !this.remotePlugins) {
			return undefined;
		}
		const installedSkills = new Set(this.items.filter(item => item.kind === 'skill' && !item.plugin).map(item => item.name.toLowerCase()));
		const rows: IRowSpec[] = [];
		for (const plugin of this.remotePlugins.flatMap(marketplace => marketplace.plugins)) {
			if (!`${plugin.name} ${plugin.description} ${plugin.author}`.toLowerCase().includes(query)) {
				continue;
			}
			const id = `plugin:${plugin.marketplace}/${plugin.name}`;
			rows.push({
				icon: (() => { const tile = $('.volt-customize-tile.box'); tile.appendChild(renderIcon(Codicon.package)); return tile; })(),
				name: plugin.name,
				description: plugin.description || plugin.author,
				tooltip: plugin.description,
				trailing: row => this.addButton(row, plugin.installed, this.busy.has(id), plugin.source.kind === 'unsupported', () => void this.installPlugin(plugin, id)),
			});
		}
		for (const skill of this.remoteSkills) {
			const id = `skill:${skill.id}`;
			const installed = installedSkills.has(skill.name.toLowerCase()) || installedSkills.has(skill.skillId.toLowerCase());
			rows.push({
				icon: this.avatarTile(skill.source),
				name: skill.name,
				description: `${skill.source} · ${localize('voltCustomize.installs', "{0} installs", formatInstalls(skill.installs))}`,
				tooltip: `${skill.source}/${skill.skillId}`,
				trailing: row => this.addButton(row, installed, this.busy.has(id), false, anchor => this.pickSkillScope(anchor, skill, id)),
			});
		}
		return rows;
	}

	private avatarTile(source: string): HTMLElement {
		const tile = $('.volt-customize-tile');
		const owner = /^([\w.-]+)\/[\w.-]+$/.exec(source)?.[1];
		if (owner) {
			tile.classList.add('logo');
			const image = append(tile, $('img')) as HTMLImageElement;
			image.alt = '';
			image.loading = 'lazy';
			image.referrerPolicy = 'no-referrer';
			image.src = `https://github.com/${encodeURIComponent(owner)}.png?size=64`;
			this.renderStore.add(addDisposableListener(image, 'error', () => {
				image.remove();
				tile.classList.remove('logo');
				tile.appendChild(renderIcon(Codicon.zap));
			}));
		} else {
			tile.appendChild(renderIcon(Codicon.zap));
		}
		return tile;
	}

	private addButton(row: HTMLElement, added: boolean, busy: boolean, unsupported: boolean, run: (anchor: HTMLElement) => void): void {
		const button = append(row, $('button.volt-customize-add-button')) as HTMLButtonElement;
		button.type = 'button';
		button.classList.toggle('added', added);
		if (busy) {
			button.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
			append(button, $('span')).textContent = localize('voltCustomize.adding', "Adding");
		} else if (added) {
			button.appendChild(renderIcon(Codicon.check));
			append(button, $('span')).textContent = localize('voltCustomize.added', "Added");
		} else {
			button.textContent = localize('voltCustomize.addButton', "Add");
		}
		button.disabled = (unsupported && !added) || busy;
		this.renderStore.add(addDisposableListener(button, EventType.CLICK, e => {
			e.stopPropagation();
			if (!added && !busy) {
				run(button);
			}
		}));
	}

	//#endregion

	//#region Menus

	private scopeLabel(): string {
		const folders = this.workspaceService.getWorkspace().folders;
		const selectedFolders = folders.filter(folder => !this.excluded.has(folder.uri.toString()));
		const user = !this.excluded.has('user');
		if (user) {
			const name = this.userName || localize('voltCustomize.user', "User");
			return selectedFolders.length ? `${name} +${selectedFolders.length}` : name;
		}
		if (selectedFolders.length) {
			return selectedFolders.length > 1 ? `${selectedFolders[0].name} +${selectedFolders.length - 1}` : selectedFolders[0].name;
		}
		return localize('voltCustomize.noScopeSelected', "No scope");
	}

	private showScopeMenu(anchor: HTMLElement): void {
		type ScopeKey = string;
		const sections = (): IVoltMenuSection<ScopeKey>[] => {
			const folders = this.workspaceService.getWorkspace().folders;
			const shown = this.showAllScopes ? folders : folders.slice(0, MAX_SCOPE_FOLDERS);
			const result: IVoltMenuSection<ScopeKey>[] = [{
				id: 'user',
				items: [{
					id: 'user',
					label: localize('voltCustomize.user', "User"),
					subtitle: this.userName || undefined,
					checked: !this.excluded.has('user'),
					trailingIcon: Codicon.blank,
					keepOpen: true,
					data: 'user',
				}],
			}];
			if (folders.length) {
				const items: IVoltMenuItem<ScopeKey>[] = shown.map(folder => {
					const slug = this.repoSlug(folder.uri);
					return {
						id: folder.uri.toString(),
						label: folder.name,
						subtitle: slug ?? undefined,
						checked: !this.excluded.has(folder.uri.toString()),
						trailingIcon: Codicon.blank,
						keepOpen: true,
						data: folder.uri.toString(),
					};
				});
				if (folders.length > shown.length) {
					items.push({ id: 'more', label: localize('voltCustomize.moreScopes', "{0} more", folders.length - shown.length), icon: Codicon.ellipsis, keepOpen: true, data: '__more__' });
				}
				result.push({ id: 'workspaces', title: localize('voltCustomize.workspaces', "Workspaces"), items });
			}
			return result;
		};
		const handle = showVoltMenu<ScopeKey>(this.contextViewService, {
			anchor,
			gap: 6,
			width: 340,
			className: 'volt-customize-menu volt-customize-scope-menu',
			ariaLabel: localize('voltCustomize.scopes', "Scopes"),
			sections: (_query, _token) => sections(),
			onPick: item => {
				if (item.data === '__more__') {
					this.showAllScopes = true;
				} else if (this.excluded.has(item.data)) {
					this.excluded.delete(item.data);
				} else {
					this.excluded.add(item.data);
				}
				this.mcpStatus = undefined;
				this.storePageState();
				this.render();
				handle.refresh();
			},
		});
		// Repository names load in the background; the menu shows them once read.
		for (const folder of this.workspaceService.getWorkspace().folders.slice(0, 20)) {
			if (!this.slugs.has(folder.uri.toString())) {
				void this.loadRepoSlug(folder.uri).then(() => handle.refresh());
			}
		}
	}

	private repoSlug(folder: URI): string | undefined {
		const slug = this.slugs.get(folder.toString());
		return slug === null ? folder.fsPath.replace(/^\/Users\/[^/]+/, '~') : slug;
	}

	/** `owner/repo` from the folder's origin remote. */
	private async loadRepoSlug(folder: URI): Promise<void> {
		this.slugs.set(folder.toString(), null);
		try {
			const config = (await this.fileService.readFile(joinPath(folder, '.git', 'config'), { limits: { size: 64 * 1024 } })).value.toString();
			const origin = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1] ?? /url\s*=\s*(\S+)/.exec(config)?.[1];
			const slug = origin ? /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(origin)?.[1] : undefined;
			if (slug) {
				this.slugs.set(folder.toString(), slug);
			}
		} catch {
			// Not a repository, or a worktree whose .git is a file: the path stands in.
		}
	}

	private showViewMenu(anchor: HTMLElement): void {
		type Choice = 'name' | 'source' | 'descriptions' | 'refresh';
		const handle = showVoltMenu<Choice>(this.contextViewService, {
			anchor,
			align: 'right',
			gap: 6,
			width: 220,
			className: 'volt-customize-menu',
			ariaLabel: localize('voltCustomize.viewOptions', "View Options"),
			sections: () => [
				{
					id: 'sort',
					title: localize('voltCustomize.sortBy', "Sort by"),
					items: [
						{ id: 'name', label: localize('voltCustomize.sortName', "Name"), checked: this.sort === 'name', keepOpen: true, data: 'name' },
						{ id: 'source', label: localize('voltCustomize.sortSource', "Source"), checked: this.sort === 'source', keepOpen: true, data: 'source' },
					],
				},
				{
					id: 'show',
					items: [
						{ id: 'descriptions', label: localize('voltCustomize.showDescriptions', "Show Descriptions"), checked: this.showDescriptions, keepOpen: true, data: 'descriptions' },
						{ id: 'refresh', label: localize('voltCustomize.refresh', "Refresh"), icon: Codicon.refresh, data: 'refresh' },
					],
				},
			],
			onPick: item => {
				switch (item.data) {
					case 'name':
					case 'source':
						this.sort = item.data;
						break;
					case 'descriptions':
						this.showDescriptions = !this.showDescriptions;
						break;
					case 'refresh':
						this.mcpStatus = undefined;
						void this.customize.refresh();
						return;
				}
				this.storePageState();
				this.render();
				handle.refresh();
			},
		});
	}

	private showRowMenu(anchor: HTMLElement, items: readonly IVoltMenuItem<() => void>[]): void {
		showVoltMenu<() => void>(this.contextViewService, {
			anchor,
			align: 'right',
			gap: 4,
			width: 200,
			className: 'volt-customize-menu',
			ariaLabel: localize('voltCustomize.moreActions', "More Actions"),
			sections: [{ id: 'actions', items }],
			onPick: item => item.data(),
		});
	}

	private itemMenu(item: IAgentCustomization): IVoltMenuItem<() => void>[] {
		const items: IVoltMenuItem<() => void>[] = [
			{ id: 'open', label: localize('voltCustomize.open', "Open"), icon: Codicon.goToFile, data: () => void this.openResource(item.resource) },
		];
		if (item.resource.scheme === Schemas.file) {
			items.push(
				{ id: 'reveal', label: localize('voltCustomize.revealInFinder', "Reveal in Finder"), icon: Codicon.folderOpened, data: () => void this.commandService.executeCommand('revealFileInOS', item.resource) },
				{ id: 'copy', label: localize('voltCustomize.copyPath', "Copy Path"), icon: Codicon.copy, data: () => void this.clipboardService.writeText(item.resource.fsPath) },
			);
		}
		const deletable = !item.plugin && (item.kind === 'skill' || item.kind === 'subagent' || item.kind === 'rule' || item.kind === 'command' || item.kind === 'memory');
		if (deletable) {
			items.push({ id: 'delete', label: localize('voltCustomize.delete', "Delete"), icon: Codicon.trash, data: () => void this.removeItem(item) });
		}
		return items;
	}

	private pluginMenu(plugin: IAgentPluginInfo): IVoltMenuItem<() => void>[] {
		const items: IVoltMenuItem<() => void>[] = [
			{ id: 'open', label: localize('voltCustomize.open', "Open"), icon: Codicon.goToFile, data: () => void this.openPlugin(plugin) },
			{ id: 'reveal', label: localize('voltCustomize.revealInFinder', "Reveal in Finder"), icon: Codicon.folderOpened, data: () => void this.commandService.executeCommand('revealFileInOS', plugin.root) },
		];
		if (plugin.origin === 'volt') {
			items.push({ id: 'remove', label: localize('voltCustomize.remove', "Remove"), icon: Codicon.trash, data: () => void this.removePlugin(plugin) });
		}
		return items;
	}

	private showNewMcpMenu(anchor: HTMLElement): void {
		type Target = { readonly kind: 'user' } | { readonly kind: 'workspace'; readonly folder: URI };
		const folders = this.workspaceService.getWorkspace().folders;
		const sections: IVoltMenuSection<Target>[] = [{
			id: 'user',
			items: [{ id: 'user', label: localize('voltCustomize.user', "User"), icon: Codicon.person, data: { kind: 'user' } }],
		}];
		if (folders.length) {
			sections.push({
				id: 'workspaces',
				title: localize('voltCustomize.workspaces', "Workspaces"),
				items: folders.map(folder => ({
					id: folder.uri.toString(),
					label: folder.name,
					subtitle: this.repoSlug(folder.uri) ?? folder.uri.fsPath,
					icon: Codicon.folder,
					data: { kind: 'workspace', folder: folder.uri },
				})),
			});
		}
		showVoltMenu<Target>(this.contextViewService, {
			anchor,
			gap: 6,
			width: 340,
			className: 'volt-customize-menu volt-customize-menu-large',
			ariaLabel: localize('voltCustomize.newMcp', "New MCP Server"),
			sections,
			onPick: async item => {
				const base = item.data.kind === 'user' ? await this.customize.userHome() : item.data.folder;
				if (!base) {
					return;
				}
				try {
					await this.openResource(await this.customize.ensureMcpConfig(base));
				} catch (err) {
					this.notificationService.error(err instanceof Error ? err.message : String(err));
				}
			},
		});
		for (const folder of folders.slice(0, 20)) {
			if (!this.slugs.has(folder.uri.toString())) {
				void this.loadRepoSlug(folder.uri);
			}
		}
	}

	//#endregion

	//#region Actions

	private async baseFor(base: NonNullable<ISection['base']>): Promise<URI | undefined> {
		return base.kind === 'user' ? this.customize.userHome() : base.folder;
	}

	private async createNamed(kind: AgentCustomizationKind, scopeTitle: string, section: NonNullable<ISection['base']>): Promise<void> {
		const label = kindInfo(kind).label;
		const lower = label.toLowerCase();
		let created: URI | undefined;
		await showCustomizeInputDialog(this.layoutService.activeContainer, {
			title: localize('voltCustomize.newTitle', "New {0} {1}", scopeTitle, label),
			subtitle: localize('voltCustomize.newSubtitle', "Enter a name for the new {0}", lower),
			placeholder: localize('voltCustomize.newPlaceholder', "e.g., my-custom-{0}", kind),
			validate: itemNameError,
			onConfirm: async name => {
				const base = await this.baseFor(section);
				if (!base) {
					throw new Error(localize('voltCustomize.noHome', "Volt could not find your home folder."));
				}
				const target = this.customize.newItemLocation(kind, name, base);
				if (await this.fileService.exists(target)) {
					throw new Error(localize('voltCustomize.exists', "A {0} named {1} already exists here.", lower, name));
				}
				created = await this.customize.createItem(kind, name, base);
			},
		});
		if (created) {
			await this.openResource(created);
		}
	}

	private async createHooksFile(section: NonNullable<ISection['base']>): Promise<void> {
		const base = await this.baseFor(section);
		if (!base) {
			return;
		}
		try {
			await this.openResource(await this.customize.createItem('hook', '', base));
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}

	private async removeItem(item: IAgentCustomization): Promise<void> {
		const shared = this.items.filter(other => other.resource.toString() === item.resource.toString()).length;
		const confirmed = await showCustomizeConfirmDialog(this.layoutService.activeContainer, {
			title: localize('voltCustomize.removeConfirm', "Delete {0}?", item.name),
			message: shared > 1
				? localize('voltCustomize.removeShared', "{0} entries are defined in this file; all of them go away. The file is moved to the trash.", shared)
				: item.kind === 'skill'
					? localize('voltCustomize.removeSkill', "The skill's folder is moved to the trash.")
					: localize('voltCustomize.removeDetail', "The file is moved to the trash."),
			confirmLabel: localize('voltCustomize.delete', "Delete"),
			destructive: true,
		});
		if (!confirmed) {
			return;
		}
		try {
			await this.customize.deleteItem(item);
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}

	/** Where a marketplace skill can be installed: User, then each open folder. */
	private installScopes(): readonly IAgentMarketplaceScope[] {
		const scopes: IAgentMarketplaceScope[] = [{ label: localize('voltCustomize.user', "User"), subtitle: this.userName || undefined, scope: { kind: 'user' } }];
		for (const folder of this.workspaceService.getWorkspace().folders) {
			scopes.push({ label: folder.name, subtitle: this.repoSlug(folder.uri) ?? folder.uri.fsPath, scope: { kind: 'workspace', folder: folder.uri } });
		}
		return scopes;
	}

	private pickSkillScope(anchor: HTMLElement, skill: ISkillsShSkill, id: string): void {
		const scopes = this.installScopes();
		const toItem = (scope: IAgentMarketplaceScope): IVoltMenuItem<IAgentMarketplaceScope> => ({
			id: scope.scope.kind === 'user' ? 'user' : scope.scope.folder.toString(),
			label: scope.label,
			subtitle: scope.subtitle,
			icon: scope.scope.kind === 'user' ? Codicon.person : Codicon.folder,
			data: scope,
		});
		const sections: IVoltMenuSection<IAgentMarketplaceScope>[] = [{ id: 'user', items: scopes.filter(scope => scope.scope.kind === 'user').map(toItem) }];
		const workspaces = scopes.filter(scope => scope.scope.kind === 'workspace');
		if (workspaces.length) {
			sections.push({ id: 'workspaces', title: localize('voltCustomize.workspaces', "Workspaces"), items: workspaces.map(toItem) });
		}
		showVoltMenu<IAgentMarketplaceScope>(this.contextViewService, {
			anchor,
			align: 'right',
			gap: 4,
			width: 280,
			className: 'volt-customize-menu',
			ariaLabel: localize('voltCustomize.installWhere', "Add the skill for"),
			sections,
			onPick: item => void this.installSkill(skill, item.data.scope, item.data.label, id),
		});
	}

	private async installSkill(skill: ISkillsShSkill, scope: MarketplaceScope, scopeLabel: string, id: string): Promise<void> {
		this.busy.add(id);
		this.render();
		const cts = new CancellationTokenSource();
		try {
			const resource = await this.marketplace.installSkill(skill, scope, cts.token);
			this.notificationService.notify({
				severity: Severity.Info,
				message: localize('voltCustomize.skillAdded', "Added {0} to {1}. Use it with /{2} in the composer.", skill.name, scopeLabel, safeItemName(skill.skillId) || skill.name),
			});
			await this.openResource(resource);
		} catch (err) {
			this.notificationService.error(localize('voltCustomize.skillFailed', "Couldn't add {0}: {1}", skill.name, err instanceof Error ? err.message : String(err)));
		} finally {
			cts.dispose();
			this.busy.delete(id);
			this.render();
		}
	}

	private async installPlugin(plugin: IMarketplacePlugin, id: string): Promise<void> {
		this.busy.add(id);
		this.render();
		const cts = new CancellationTokenSource();
		try {
			await this.marketplace.installPlugin(plugin, cts.token);
			this.notificationService.info(localize('voltCustomize.pluginAdded', "Added the {0} plugin. Its skills, rules and commands are available in new chats.", plugin.name));
			this.remotePlugins = await this.marketplace.listMarketplaces().catch(() => this.remotePlugins);
		} catch (err) {
			this.notificationService.error(localize('voltCustomize.pluginFailed', "Couldn't add {0}: {1}", plugin.name, err instanceof Error ? err.message : String(err)));
		} finally {
			cts.dispose();
			this.busy.delete(id);
			this.render();
		}
	}

	//#endregion

	//#region Memories

	private async addMemory(): Promise<void> {
		const choice = await this.quickInputService.pick([
			{ id: 'new', label: localize('voltCustomize.memoryNew', "New note"), description: localize('voltCustomize.memoryNewHint', "Something Volt should recall in every chat") },
			{ id: 'import', label: localize('voltCustomize.memoryImport', "Import from another assistant"), description: localize('voltCustomize.memoryImportHint', "Copies CLAUDE.md, AGENTS.md and Claude Code memory notes") },
		], { placeHolder: localize('voltCustomize.memoryPick', "How do you want to add a memory?") });
		if (choice?.id === 'new') {
			await this.newMemory();
		} else if (choice?.id === 'import') {
			await this.importMemories();
		}
	}

	private async newMemory(): Promise<void> {
		const name = await this.quickInputService.input({
			prompt: localize('voltCustomize.memoryName', "What should Volt remember?"),
			placeHolder: localize('voltCustomize.memoryNamePlaceholder', "e.g. Prefers small diffs"),
			validateInput: async value => value.trim() ? undefined : localize('voltCustomize.memoryNameRequired', "Write a short name."),
		});
		if (name === undefined) {
			return;
		}
		const body = await this.quickInputService.input({
			prompt: localize('voltCustomize.memoryBody', "The fact, and why it matters"),
			placeHolder: localize('voltCustomize.memoryBodyPlaceholder', "e.g. Split large refactors; reviews stall otherwise."),
			validateInput: async value => value.trim() ? undefined : localize('voltCustomize.memoryBodyRequired', "Write the fact to remember."),
		});
		if (body === undefined) {
			return;
		}
		try {
			const saved = await this.memory.write({ name: name.trim(), description: body.replace(/\s+/g, ' ').trim().slice(0, 140), body: body.trim() });
			const note = await this.memory.read(saved.name, saved.scope);
			if (note?.resource) {
				await this.openResource(note.resource);
			}
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}

	private async importMemories(): Promise<void> {
		const candidates = await this.importCandidates();
		if (!candidates.length) {
			this.notificationService.info(localize('voltCustomize.memoryNoImports', "No CLAUDE.md, AGENTS.md or Claude Code memory notes were found."));
			return;
		}
		const picks = await this.quickInputService.pick(candidates, {
			canPickMany: true,
			placeHolder: localize('voltCustomize.memoryPickImports', "Pick the files to copy into Volt memory. The originals stay as they are."),
		});
		if (!picks?.length) {
			return;
		}
		let imported = 0;
		let existing = 0;
		for (const pick of picks) {
			try {
				const result = await this.memory.importFile(pick.resource, pick.scope);
				if (result === 'imported') {
					imported++;
				} else if (result === 'exists') {
					existing++;
				}
			} catch (err) {
				this.notificationService.warn(localize('voltCustomize.memoryImportFailed', "Couldn't import {0}: {1}", pick.label, err instanceof Error ? err.message : String(err)));
			}
		}
		this.notificationService.info(localize('voltCustomize.memoryImported', "Imported {0} notes. {1} already saved under the same name were left as they are.", imported, existing));
	}

	/** CLAUDE.md and AGENTS.md in the open folders, and the Claude Code memory notes in the user home. */
	private async importCandidates(): Promise<(IQuickPickItem & { resource: URI; scope: VoltMemoryScope })[]> {
		const found: (IQuickPickItem & { resource: URI; scope: VoltMemoryScope })[] = [];
		for (const folder of this.workspaceService.getWorkspace().folders) {
			for (const name of ['CLAUDE.md', 'AGENTS.md']) {
				const resource = joinPath(folder.uri, name);
				if (await this.fileService.exists(resource)) {
					found.push({ label: name, description: folder.name, resource, scope: 'project' });
				}
			}
		}
		const home = await this.customize.userHome();
		if (!home) {
			return found;
		}
		const userClaude = joinPath(home, '.claude', 'CLAUDE.md');
		if (await this.fileService.exists(userClaude)) {
			found.push({ label: '~/.claude/CLAUDE.md', resource: userClaude, scope: 'user' });
		}
		const notes = await this.claudeMemoryNotes(joinPath(home, '.claude', 'projects'));
		return [...found, ...notes].slice(0, 200);
	}

	/** Claude Code keeps one `memory/` folder per project; its index file only lists the other notes, so it is skipped. */
	private async claudeMemoryNotes(projects: URI): Promise<(IQuickPickItem & { resource: URI; scope: VoltMemoryScope })[]> {
		const dirs = (await this.children(projects)).filter(child => child.isDirectory);
		const notes = await Promise.all(dirs.map(async dir => (await this.children(joinPath(dir.resource, 'memory')))
			.filter(child => !child.isDirectory && /\.md$/i.test(child.name) && child.name !== 'MEMORY.md')
			.map(child => ({ label: child.name, description: `~/.claude/projects/${dir.name}`, resource: child.resource, scope: 'user' as const }))));
		return notes.flat();
	}

	private async children(dir: URI): Promise<IFileStat[]> {
		try {
			return (await this.fileService.resolve(dir)).children ?? [];
		} catch {
			return [];
		}
	}

	//#endregion

	/** The panel is narrow: let the tab bar shrink instead of overflowing. */
	override get minimumWidth(): number {
		return 120;
	}

	override getActionViewItem(action: IAction, options: IBaseActionViewItemOptions): IActionViewItem | undefined {
		return createAgentTitleActionViewItem(
			this.instantiationService,
			action,
			options,
			this.commandService,
			this.contextViewService,
		);
	}

	override layout(dimension: Dimension): void {
		this.rootEl.style.height = `${dimension.height}px`;
		this.surfaceHost?.layout(dimension);
		this.scroll.scanDomNode();
	}

	override focus(): void {
		if (getWindow(this.searchInput).document.activeElement !== this.searchInput) {
			this.searchInput.focus();
		}
	}
}
