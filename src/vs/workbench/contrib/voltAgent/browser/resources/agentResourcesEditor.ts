/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentCustomize.css';
import '../media/agentResourcesEditor.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { Orientation, Sash } from '../../../../../base/browser/ui/sash/sash.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { getLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService, SIDE_GROUP } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { ITextEditorService } from '../../../../services/textfile/common/textEditorService.js';
import { AGENT_RESOURCE_FILTER_ICON, AgentResourceScopeKind, agentResourceScopeKind } from '../../common/agentResources.js';
import { AGENT_NAV_BACK_COMMAND_ID, canAgentNavGoBack } from '../chrome/agentNav.contribution.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { createAgentScrollable } from '../editor/agentScrollable.js';
import { createHomeSearchIcon } from '../home/agentHomeIcons.js';
import { AgentMarketplaceView, IAgentMarketplaceScope } from '../customize/agentMarketplaceView.js';
import { createVoltDropdown } from '../ui/dropdown/voltDropdown.js';
import { AgentSurfaceHost } from '../workspace/agentSurfaceHost.js';
import { createSurfaceStrokeIcon } from '../workspace/agentSurfaceMenu.js';
import { hasSavedAgentTools } from '../workspace/agentToolsEditorPart.js';
import { AgentHarnessSection } from './agentHarnessSection.js';
import { agentResourceName, agentResourcePath } from './agentResourceList.js';
import { AGENT_RESOURCES_SECTIONS, AgentResourcesSectionId, agentResourcesSection, IAgentResourcesSection, IAgentResourcesSectionContext } from './agentResourcesPage.js';
import { agentResourceScopeFilterOptions, AgentResourcesSections } from './agentResourcesSections.js';
import { IAgentResource, IAgentResourcesService } from './agentResourcesService.js';

export const AGENT_RESOURCES_EDITOR_ID = 'workbench.editor.voltAgentResources';
export const AGENT_RESOURCES_INPUT_ID = 'workbench.input.voltAgentResources';

// Stacked layers: instructions, skills, tools and the harness under the agent. (The books glyph read as "|||\".)
const AgentResourcesIcon = registerIcon('volt-agent-resources-editor-label-icon', Codicon.layers, localize('agentResources.editorIcon', "Icon of the Agent Resources tab."));

const STATE_KEY = 'volt.agentResources.page';
/** The left nav's width, as its sash last left it. */
const NAV_WIDTH_KEY = 'volt.agentResources.navWidth';
const NAV_WIDTH_DEFAULT = 236;
const NAV_WIDTH_MIN = 180;
const NAV_WIDTH_MAX = 420;
/** The right panel's tabs are kept under this id, like a chat's. */
const TOOLS_ID = 'volt-agent-resources';

export class AgentResourcesEditorInput extends EditorInput {

	static readonly TypeID = AGENT_RESOURCES_INPUT_ID;
	static readonly EditorID = AGENT_RESOURCES_EDITOR_ID;

	readonly resource = URI.from({ scheme: Schemas.voltAgentResources, path: 'resources' });

	override get typeId(): string {
		return AgentResourcesEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return AgentResourcesEditorInput.EditorID;
	}

	override getName(): string {
		return localize('agentResources.tab', "Agent Resources");
	}

	override getIcon(): ThemeIcon {
		return AgentResourcesIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof AgentResourcesEditorInput;
	}
}

export class AgentResourcesEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(AgentResourcesEditorInput);
	}
}

/** Where the page should go the next time it shows: a section, and the folder it is about. */
export interface IAgentResourcesRequest {
	readonly section?: AgentResourcesSectionId;
	readonly folder?: URI;
}

interface IPageState {
	readonly section?: AgentResourcesSectionId;
	readonly scope?: 'all' | AgentResourceScopeKind;
}

interface INavRow {
	readonly section: IAgentResourcesSection;
	readonly count?: number;
	readonly issues: number;
}

class NavDelegate implements IListVirtualDelegate<INavRow> {
	getHeight(): number {
		return 30;
	}
	getTemplateId(): string {
		return NavRenderer.ID;
	}
}

interface INavTemplate {
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly issues: HTMLElement;
	readonly count: HTMLElement;
}

class NavRenderer implements IListRenderer<INavRow, INavTemplate> {
	static readonly ID = 'voltAgentResourcesNav';
	readonly templateId = NavRenderer.ID;

	renderTemplate(container: HTMLElement): INavTemplate {
		const row = append(container, $('.volt-ares-nav-row'));
		const icon = append(row, $('span.volt-ares-nav-icon'));
		const label = append(row, $('span.volt-ares-nav-label'));
		const issues = append(row, $('span.volt-ares-nav-issues'));
		issues.appendChild(renderIcon(Codicon.warning));
		const count = append(row, $('span.volt-ares-nav-count'));
		return { icon, label, issues, count };
	}

	renderElement(row: INavRow, _index: number, template: INavTemplate): void {
		template.icon.replaceChildren(createSurfaceStrokeIcon(template.icon.ownerDocument, row.section.icon));
		// The narrow page folds the nav to its icons: the icon says which section it is.
		setAgentTooltip(template.icon, row.section.label, undefined, undefined, 'end');
		template.label.textContent = row.section.label;
		template.count.textContent = row.count === undefined ? '' : String(row.count);
		template.issues.classList.toggle('hidden', !row.issues);
	}

	disposeTemplate(): void { }
}

/** Which of the page's discovered files a section counts. */
const SECTION_GROUPS: Partial<Record<AgentResourcesSectionId, readonly IAgentResource['group'][]>> = {
	instructions: ['instructions'],
	skills: ['skills'],
	agents: ['subagents'],
	integrations: ['integrations'],
	workflows: ['commands', 'hooks'],
	harness: ['config'],
};

/**
 * Agent Resources: the files and settings behind the agents, for this project and for you, in one
 * page. Its sections separate what agents know (instructions), what they can do (skills, agents,
 * commands, hooks), what they can reach (MCP and integrations) and how they run (the harness). Every
 * file shows its scope: Workspace, Global, External or Managed. Files open in the right panel.
 */
export class AgentResourcesEditor extends EditorPane {

	static readonly ID = AGENT_RESOURCES_EDITOR_ID;

	private static readonly onDidRequest = new Emitter<IAgentResourcesRequest>();
	private static pending: IAgentResourcesRequest | undefined;

	/** Shows `request` the next time the page is on screen (now, if it is). */
	static request(request: IAgentResourcesRequest): void {
		AgentResourcesEditor.pending = request;
		AgentResourcesEditor.onDidRequest.fire(request);
	}

	private rootEl!: HTMLElement;
	private mainEl!: HTMLElement;
	private navList!: WorkbenchList<INavRow>;
	private navEl!: HTMLElement;
	private navSash!: Sash;
	private navHost!: HTMLElement;
	private titleEl!: HTMLElement;
	private leadEl!: HTMLElement;
	private toolbarEl!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private scopeHost!: HTMLElement;
	private marketHeader!: HTMLElement;
	private bodyEl!: HTMLElement;
	private sectionEl!: HTMLElement;
	private marketBody!: HTMLElement;
	private scroll!: ReturnType<typeof createAgentScrollable>;
	private marketplace!: AgentMarketplaceView;
	private surfaceHost: AgentSurfaceHost | undefined;
	private presented = false;

	private section: AgentResourcesSectionId = 'overview';
	private scope: 'all' | AgentResourceScopeKind = 'all';
	private query = '';
	private folder: URI | undefined;
	/** A folder asked for by a request (a chat's worktree), offered beside the workspace's. */
	private extraFolder: URI | undefined;

	private readonly renderStore = this._register(new DisposableStore());
	private readonly chromeStore = this._register(new DisposableStore());
	private readonly renderScheduler = this._register(new RunOnceScheduler(() => this.render(), 80));
	/** Search and scope only change the section: the nav and the toolbar stay. */
	private readonly bodyScheduler = this._register(new RunOnceScheduler(() => this.renderBody(), 80));
	/** Set when a change comes in while the page is hidden; it renders when shown again. */
	private dirty = false;
	/** What the harness page read from other harnesses' files, until the files change. */
	private readonly harnessSummaries = new Map<string, Promise<string | undefined>>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storage: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentResourcesService private readonly resources: IAgentResourcesService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ITextEditorService private readonly textEditorService: ITextEditorService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(AgentResourcesEditor.ID, group, telemetryService, themeService, storage);
		this.restoreState();
	}

	//#region Setup

	protected override createEditor(parent: HTMLElement): void {
		// Customize's root and main classes: the same layout beside the right panel, and the tokens its marketplace view paints with.
		this.rootEl = append(parent, $('.volt-ares-root.volt-customize-root'));
		this.mainEl = append(this.rootEl, $('.volt-ares-main.volt-customize-main'));
		const page = append(this.mainEl, $('.volt-ares'));

		const nav = this.navEl = append(page, $('nav.volt-ares-nav'));
		const brand = append(nav, $('.volt-ares-brand'));
		append(brand, $('.volt-ares-brand-title')).textContent = localize('agentResources.title', "Agent Resources");
		append(brand, $('.volt-ares-brand-lead')).textContent = localize('agentResources.brandLead', "Inspect, configure and extend your agents.");
		this.navHost = append(nav, $('.volt-ares-nav-list'));
		this.navList = this._register(this.instantiationService.createInstance(WorkbenchList<INavRow>, 'VoltAgentResourcesNav', this.navHost, new NavDelegate(), [new NavRenderer()], {
			identityProvider: { getId: (row: INavRow) => row.section.id },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('agentResources.navAria', "Agent Resources sections"),
				getAriaLabel: (row: INavRow) => row.count === undefined ? row.section.label : localize('agentResources.navRowAria', "{0}, {1}", row.section.label, row.count),
			},
		}));
		this._register(this.navList.onDidOpen(e => e.element && this.setSection(e.element.section.id)));

		const content = append(page, $('.volt-ares-content'));
		this.createNavSash(page);
		const header = append(content, $('.volt-ares-header'));
		const headingRow = append(header, $('.volt-ares-heading-row'));
		const heading = append(headingRow, $('.volt-ares-heading'));
		this.titleEl = append(heading, $('h2.volt-ares-title'));
		this.leadEl = append(heading, $('.volt-ares-lead'));
		const back = this._register(createVoltButton(headingRow, 'secondary', { supportIcons: true }));
		back.label = `$(${Codicon.arrowLeft.id}) ${localize('agentResources.back', "Back")}`;
		back.element.classList.add('volt-ares-back');
		setAgentTooltip(back.element, localize('agentResources.backTooltip', "Back to where you were"));
		this._register(back.onDidClick(() => void this.goBack()));
		this.toolbarEl = append(header, $('.volt-ares-toolbar'));
		const search = append(this.toolbarEl, $('.volt-customize-search.volt-ares-search'));
		// The agent sidebar's own magnifier, as on every Volt search field.
		search.appendChild(createHomeSearchIcon());
		this.searchInput = append(search, $('input.volt-customize-search-input')) as HTMLInputElement;
		this.searchInput.type = 'text';
		this.searchInput.spellcheck = false;
		this._register(addDisposableListener(this.searchInput, EventType.INPUT, () => this.onQuery(this.searchInput.value)));
		this._register(addDisposableListener(this.searchInput, EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && this.searchInput.value) {
				e.preventDefault();
				this.searchInput.value = '';
				this.onQuery('');
			}
		}));
		this.scopeHost = append(this.toolbarEl, $('.volt-ares-scope'));
		this.marketHeader = append(header, $('.volt-ares-market-header'));

		this.bodyEl = $('.volt-ares-body');
		this.sectionEl = append(this.bodyEl, $('.volt-ares-section'));
		this.marketBody = append(this.bodyEl, $('.volt-ares-market-body'));
		this.scroll = this._register(createAgentScrollable(this.bodyEl));
		append(content, this.scroll.getDomNode()).classList.add('volt-ares-scroll');

		this.marketplace = this._register(this.instantiationService.createInstance(AgentMarketplaceView, this.marketHeader, this.marketBody, {
			scopes: () => this.installScopes(),
			openResource: resource => void this.openResource(resource),
			openUrl: url => this.openUrl(url),
			dialogHost: () => this.layoutService.activeContainer,
			relayout: () => this.scroll.scanDomNode(),
			scrollTop: () => this.scroll.getScrollPosition().scrollTop,
			setScrollTop: scrollTop => this.scroll.setScrollPosition({ scrollTop }),
			setCrumbs: () => undefined,
		}));
		this.marketplace.setVisible(false);

		this.surfaceHost = this._register(this.instantiationService.createInstance(AgentSurfaceHost, this.rootEl, this.mainEl));

		this._register(this.resources.onDidChange(folder => {
			this.harnessSummaries.clear();
			if (this.folder && folder.toString() === this.folder.toString()) {
				this.scheduleRender();
			}
		}));
		this._register(this.resources.onDidChangeGlobal(() => {
			this.harnessSummaries.clear();
			this.scheduleRender();
		}));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this.folder = this.pickFolder(this.folder);
			this.load();
		}));
		this._register(AgentResourcesEditor.onDidRequest.event(request => {
			if (this.isVisible()) {
				AgentResourcesEditor.pending = undefined;
				this.apply(request);
			}
		}));
	}

	override async setInput(input: AgentResourcesEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}
		if (!this.presented && hasSavedAgentTools(this.storage, TOOLS_ID)) {
			this.presentTools();
		}
		const pending = AgentResourcesEditor.pending;
		AgentResourcesEditor.pending = undefined;
		this.folder = this.pickFolder(pending?.folder ?? this.folder);
		if (pending) {
			this.apply(pending);
		} else {
			this.load();
		}
		if (!options?.preserveFocus) {
			this.searchInput.focus();
		}
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible && this.dirty) {
			this.render();
		}
	}

	override layout(dimension: Dimension): void {
		this.rootEl.style.height = `${dimension.height}px`;
		this.surfaceHost?.layout(dimension);
		this.navList.layout(AGENT_RESOURCES_SECTIONS.length * 30);
		this.navSash.layout();
		this.scroll.scanDomNode();
	}

	/** The nav's right edge drags to resize it (double-click: back to the default); the width is kept. */
	private createNavSash(page: HTMLElement): void {
		this.setNavWidth(this.storage.getNumber(NAV_WIDTH_KEY, StorageScope.PROFILE, NAV_WIDTH_DEFAULT));
		this.navSash = this._register(new Sash(page, { getVerticalSashLeft: () => this.navEl.offsetWidth }, { orientation: Orientation.VERTICAL }));
		let startWidth = 0;
		this._register(this.navSash.onDidStart(() => startWidth = this.navEl.offsetWidth));
		this._register(this.navSash.onDidChange(e => this.setNavWidth(startWidth + e.currentX - e.startX)));
		this._register(this.navSash.onDidReset(() => {
			this.setNavWidth(NAV_WIDTH_DEFAULT);
			this.storage.remove(NAV_WIDTH_KEY, StorageScope.PROFILE);
		}));
		this._register(this.navSash.onDidEnd(() => this.storage.store(NAV_WIDTH_KEY, this.navEl.offsetWidth, StorageScope.PROFILE, StorageTarget.USER)));
	}

	private setNavWidth(width: number): void {
		const clamped = Math.round(Math.min(NAV_WIDTH_MAX, Math.max(NAV_WIDTH_MIN, width)));
		this.navEl.style.setProperty('--volt-ares-nav-width', `${clamped}px`);
		this.navSash?.layout();
	}

	/** Back through the agent window's history (the chat the page was opened from); with none, the page closes. */
	private async goBack(): Promise<void> {
		if (canAgentNavGoBack()) {
			await this.commandService.executeCommand(AGENT_NAV_BACK_COMMAND_ID);
		} else if (this.input) {
			await this.group.closeEditor(this.input);
		}
	}

	override focus(): void {
		if (this.searchInput.ownerDocument.activeElement !== this.searchInput) {
			this.searchInput.focus();
		}
	}

	private restoreState(): void {
		try {
			const state = JSON.parse(this.storage.get(STATE_KEY, StorageScope.PROFILE, '{}')) as IPageState;
			if (state.section && AGENT_RESOURCES_SECTIONS.some(section => section.id === state.section)) {
				this.section = state.section;
			}
			if (state.scope && agentResourceScopeFilterOptions().some(option => option.id === state.scope)) {
				this.scope = state.scope;
			}
		} catch {
			// A broken record starts the page from its defaults.
		}
	}

	private storeState(): void {
		const state: IPageState = { section: this.section, scope: this.scope };
		this.storage.store(STATE_KEY, JSON.stringify(state), StorageScope.PROFILE, StorageTarget.USER);
	}

	//#endregion

	//#region State

	private apply(request: IAgentResourcesRequest): void {
		if (request.folder) {
			const workspace = this.workspaceService.getWorkspace().folders.some(folder => folder.uri.toString() === request.folder!.toString());
			this.extraFolder = workspace ? undefined : request.folder;
			this.folder = request.folder;
		}
		if (request.section) {
			this.section = request.section;
			this.storeState();
		}
		this.load();
	}

	/** The folder the page is about: the one asked for, else the window's first. */
	private pickFolder(preferred: URI | undefined): URI | undefined {
		const folders = this.workspaceService.getWorkspace().folders.map(folder => folder.uri);
		if (preferred && (folders.some(folder => folder.toString() === preferred.toString()) || preferred.toString() === this.extraFolder?.toString())) {
			return preferred;
		}
		return folders[0] ?? this.extraFolder;
	}

	private load(): void {
		this.render();
		const folder = this.folder;
		void Promise.all([folder ? this.resources.load(folder) : Promise.resolve([]), this.resources.loadGlobal()]).then(() => {
			if (folder?.toString() === this.folder?.toString()) {
				this.render();
			}
		});
	}

	private setSection(section: AgentResourcesSectionId): void {
		if (section === this.section) {
			return;
		}
		this.section = section;
		this.storeState();
		this.render();
		this.scroll.setScrollPosition({ scrollTop: 0 });
	}

	private onQuery(value: string): void {
		this.query = value.trim().toLowerCase();
		if (this.section === 'marketplace') {
			this.marketplace.setQuery(value);
			return;
		}
		this.bodyScheduler.schedule();
	}

	/** Renders soon, or once the page is shown again when it is hidden. */
	private scheduleRender(): void {
		if (this.isVisible()) {
			this.renderScheduler.schedule();
		} else {
			this.dirty = true;
		}
	}

	private allItems(): IAgentResource[] {
		const workspace = this.folder ? this.resources.get(this.folder) ?? [] : [];
		const global = this.resources.getGlobal() ?? [];
		// With the home folder (or ~/.claude) open, the workspace scan finds the global files again: list them once, as Global.
		const globalKeys = new Set(global.map(item => this.uriIdentityService.extUri.getComparisonKey(item.resource)));
		return [...workspace.filter(item => !globalKeys.has(this.uriIdentityService.extUri.getComparisonKey(item.resource))), ...global];
	}

	private filtered(items: readonly IAgentResource[]): IAgentResource[] {
		return items.filter(item => {
			if (this.scope !== 'all' && agentResourceScopeKind(item.scope) !== this.scope) {
				return false;
			}
			if (!this.query) {
				return true;
			}
			const haystack = [agentResourceName(item), agentResourcePath(item, this.resources.home), item.name, item.description, item.kind, item.source].filter(Boolean).join(' ').toLowerCase();
			return haystack.includes(this.query);
		});
	}

	//#endregion

	//#region Rendering

	/** The whole page: nav, header and toolbar, and the section. */
	private render(): void {
		if (!this.sectionEl) {
			return;
		}
		this.renderScheduler.cancel();
		if (!this.isVisible()) {
			this.dirty = true;
			return;
		}
		this.dirty = false;
		const all = this.allItems();
		const section = agentResourcesSection(this.section);
		this.renderNav(all);
		this.renderChrome(section);
		const market = section.id === 'marketplace';
		this.marketplace.setVisible(market);
		this.sectionEl.classList.toggle('hidden', market);
		this.renderBody(all);
	}

	/** The section alone, for a search or scope change: the nav and the scope dropdown are kept. */
	private renderBody(all = this.allItems()): void {
		if (!this.sectionEl) {
			return;
		}
		this.bodyScheduler.cancel();
		if (!this.isVisible()) {
			this.dirty = true;
			return;
		}
		this.renderStore.clear();
		const items = this.filtered(all);
		const section = agentResourcesSection(this.section);
		clearNode(this.sectionEl);
		if (section.id !== 'marketplace') {
			const ctx: IAgentResourcesSectionContext = {
				store: this.renderStore,
				folder: this.folder,
				home: this.resources.home,
				items,
				allItems: all,
				openResource: resource => void this.openResource(resource),
				openDiff: (original, modified, label) => void this.openDiff(original, modified, label),
				navigate: id => this.setSection(id),
				rerender: () => this.renderScheduler.schedule(),
				harnessSummaries: this.harnessSummaries,
			};
			if (section.id === 'harness') {
				this.renderStore.add(this.instantiationService.createInstance(AgentHarnessSection, this.sectionEl, ctx)).render();
			} else {
				this.instantiationService.createInstance(AgentResourcesSections, ctx).render(section.id, this.sectionEl);
			}
			if (!this.folder && section.id !== 'harness') {
				append(this.sectionEl, $('.volt-ares-footnote')).textContent = localize('agentResources.noFolder', "Open a folder to see its workspace resources. Global ones are listed above.");
			}
		}
		this.scroll.scanDomNode();
	}

	private renderNav(all: readonly IAgentResource[]): void {
		const rows: INavRow[] = AGENT_RESOURCES_SECTIONS.map(section => {
			const groups = SECTION_GROUPS[section.id];
			const items = groups ? all.filter(item => groups.includes(item.group)) : undefined;
			return {
				section,
				count: section.id === 'overview' ? all.length : items?.length,
				issues: items?.filter(item => item.status.kind !== 'ok').length ?? 0,
			};
		});
		this.navList.splice(0, this.navList.length, rows);
		const index = rows.findIndex(row => row.section.id === this.section);
		this.navList.setSelection([index]);
		this.navList.setFocus([index]);
	}

	private renderChrome(section: IAgentResourcesSection): void {
		this.chromeStore.clear();
		this.titleEl.textContent = section.label;
		this.leadEl.textContent = section.lead;
		this.searchInput.placeholder = section.id === 'marketplace'
			? localize('agentResources.searchMarket', "Search skills.sh and marketplaces")
			: localize('agentResources.search', "Search by name, path or description");
		this.searchInput.setAttribute('aria-label', this.searchInput.placeholder);
		this.marketHeader.classList.toggle('hidden', section.id !== 'marketplace');
		// The scope filter means nothing on the marketplace, and the harness page lists settings, not files.
		this.scopeHost.classList.toggle('hidden', section.id === 'marketplace' || section.id === 'harness');
		this.toolbarEl.classList.toggle('hidden', section.id === 'harness');
		clearNode(this.scopeHost);
		createVoltDropdown(this.scopeHost, this.contextViewService, {
			options: agentResourceScopeFilterOptions(),
			value: this.scope,
			ariaLabel: localize('agentResources.scopeFilter', "Scope"),
			align: 'right',
			width: 280,
			leadingIcon: () => createSurfaceStrokeIcon(this.scopeHost.ownerDocument, AGENT_RESOURCE_FILTER_ICON),
			onChange: value => {
				this.scope = value;
				this.storeState();
				this.renderBody();
			},
		}, this.chromeStore);
	}

	//#endregion

	//#region Right panel

	private presentTools(): void {
		if (!this.presented && this.surfaceHost) {
			this.presented = true;
			this.surfaceHost.present(TOOLS_ID);
		}
	}

	private canUseRightPanel(): boolean {
		return !!this.surfaceHost && getLayoutMode(this.layoutService) === 'agent' && this.editorGroupsService.mainPart.groups.includes(this.group);
	}

	/** Opens a file in the right panel beside the page; without one (IDE layout) beside the page's group. */
	private async openResource(resource: URI): Promise<void> {
		if (this.canUseRightPanel()) {
			this.presentTools();
			if (this.surfaceHost!.canOpenTools()) {
				this.surfaceHost!.openFile(resource);
				return;
			}
		}
		await this.editorService.openEditor({ resource, options: { pinned: true } }, SIDE_GROUP);
	}

	private async openDiff(original: URI, modified: URI, label: string): Promise<void> {
		const input = this.textEditorService.createTextEditor({ original: { resource: original }, modified: { resource: modified }, label });
		if (this.canUseRightPanel()) {
			this.presentTools();
			if (this.surfaceHost!.canOpenTools()) {
				await this.surfaceHost!.openEditorInTools(input, { pinned: true });
				return;
			}
		}
		await this.editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
	}

	private openUrl(url: string): void {
		if (this.canUseRightPanel()) {
			this.presentTools();
			if (this.surfaceHost!.canOpenTools()) {
				this.surfaceHost!.openBrowser(url, undefined, true);
				return;
			}
		}
		void this.openerService.open(URI.parse(url));
	}

	/** Where the marketplace installs a skill: you, then each project folder. */
	private installScopes(): readonly IAgentMarketplaceScope[] {
		const home = this.resources.home;
		const scopes: IAgentMarketplaceScope[] = [{ label: localize('agentResources.globalScope', "Global"), subtitle: home ? `~ (${basename(home)})` : undefined, scope: { kind: 'user' } }];
		for (const folder of this.workspaceService.getWorkspace().folders) {
			scopes.push({ label: folder.name, subtitle: folder.uri.fsPath, scope: { kind: 'workspace', folder: folder.uri } });
		}
		return scopes;
	}

	//#endregion
}
