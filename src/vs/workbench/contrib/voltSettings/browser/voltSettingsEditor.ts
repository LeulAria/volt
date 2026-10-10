/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltSettings.css';
import '../../voltAgent/browser/media/agentEditor.css';
import { $, addDisposableListener, append, Dimension, getWindow, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { ISelectOptionItem, SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { AWAKE_LID_CLOSED_MODE_SETTING, AWAKE_WHILE_AGENTS_WORK_SETTING, IAwakeState, IVoltAwakeService, readAwakePrefs } from '../../../../platform/voltAwake/common/voltAwake.js';
import { DisablementReason, IUpdateService, State as UpdateState, StateType } from '../../../../platform/update/common/update.js';
import { VOLT_RELEASE_CHANNEL_SETTING } from '../../../../platform/update/common/voltUpdateFeed.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles, getInputBoxStyle, getSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { Orientation, Sash } from '../../../../base/browser/ui/sash/sash.js';
import { getLayoutMode } from '../../../browser/parts/titlebar/layoutModeSwitch.js';
import { settingsSelectBackground, settingsSelectBorder, settingsSelectForeground, settingsSelectListBorder, settingsTextInputBackground, settingsTextInputBorder, settingsTextInputForeground } from '../../preferences/common/settingsEditorColorRegistry.js';
import { ACCESS_MODE_OPTIONS, accessModeOption, VoltAccessMode } from '../../../services/voltRuntime/common/access/accessModes.js';
import { IPermissionRule } from '../../../services/voltRuntime/common/access/accessTypes.js';
import { VOLT_MODES, VoltMode, modePolicy } from '../../../services/voltRuntime/common/modes.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { IVoltPredictionService } from '../../../services/voltRuntime/common/prediction.js';
import { IWorkbenchThemeService, ThemeSettings } from '../../../services/themes/common/workbenchThemeService.js';
import { AGENT_DEFAULT_MODEL_SETTING, AGENT_NEW_CHAT_DRAFT_SETTING, AGENT_PROMPT_HISTORY_SETTING } from '../../voltAgent/common/agentComposerSettings.js';
import { AGENT_AUTO_RESUME_AFTER_LIMIT_SETTING, AGENT_COMPACT_OLD_THREADS_SETTING, AGENT_RESUME_AFTER_RESTART_SETTING } from '../../voltAgent/common/agentWorkflowSettings.js';
import { AGENT_HOME_AUTO_SETTLE_DAYS_SETTING, AGENT_HOME_WORKING_SECTION_SETTING } from '../../voltAgent/common/agentHomeSettings.js';
import '../../voltAgent/common/agentAwakeSettings.js';

/** Settings on the Composer page whose rows redraw when they change. */
/** Settings on the Appearance page whose controls redraw when they change. */
const APPEARANCE_PAGE_SETTINGS = [ThemeSettings.DETECT_COLOR_SCHEME, ThemeSettings.PREFERRED_DARK_THEME, ThemeSettings.PREFERRED_LIGHT_THEME, ThemeSettings.FILE_ICON_THEME, 'editor.fontSize', 'window.zoomLevel'];
const COMPOSER_PAGE_SETTINGS = [AGENT_PROMPT_HISTORY_SETTING, AGENT_NEW_CHAT_DRAFT_SETTING, AGENT_RESUME_AFTER_RESTART_SETTING, AGENT_AUTO_RESUME_AFTER_LIMIT_SETTING, AGENT_COMPACT_OLD_THREADS_SETTING, AGENT_HOME_WORKING_SECTION_SETTING, AGENT_HOME_AUTO_SETTLE_DAYS_SETTING];
import { AgentModelPicker } from '../../voltAgent/browser/picker/agentModelPicker.js';
import { appendSettingsBlock, SettingsStickyHeads } from './settingsStickyHeads.js';
import { VoltSettingsEditorInput } from './voltSettingsEditorInput.js';
import { renderProjectsSection, renderStorageSection } from '../../voltSetup/browser/settingsSections.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { AppearancePage } from './appearancePage.js';
import { ProvidersPage } from './providersPage.js';
import { ConnectedAgentsPage } from './connectedAgentsPage.js';
import { createSettingsIcon } from './settingsIcons.js';
import { AgentUsagePage } from '../../voltAgent/browser/usage/agentUsagePage.js';

type SettingsSection = 'general' | 'appearance' | 'usage' | 'providers' | 'modes' | 'composer' | 'tab' | 'security' | 'connected' | 'projects' | 'storage';

/** The Modes nav glyph (a small robot face), drawn in currentColor like the codicons beside it. */
/** The nav, in groups separated by a gap. Icons come from settingsIcons.ts; the codicon is the fallback. */
const SECTIONS: { id: SettingsSection; label: string; icon: ThemeIcon; group: number }[] = [
	{ id: 'general', label: localize('voltSettings.general', "General"), icon: Codicon.settingsGear, group: 0 },
	{ id: 'appearance', label: localize('voltSettings.appearance', "Appearance"), icon: Codicon.symbolColor, group: 0 },
	{ id: 'usage', label: localize('voltSettings.usage', "Usage"), icon: Codicon.graph, group: 0 },
	{ id: 'providers', label: localize('voltSettings.providers', "Providers & Models"), icon: Codicon.plug, group: 1 },
	{ id: 'modes', label: localize('voltSettings.modes', "Modes"), icon: Codicon.sparkle, group: 1 },
	{ id: 'composer', label: localize('voltSettings.composer', "Composer"), icon: Codicon.commentDiscussion, group: 1 },
	{ id: 'tab', label: localize('voltSettings.tab', "Tab & Prediction"), icon: Codicon.keyboard, group: 1 },
	{ id: 'security', label: localize('voltSettings.security', "Security"), icon: Codicon.shield, group: 2 },
	{ id: 'connected', label: localize('voltSettings.connectedAgents', "Connected agents"), icon: Codicon.link, group: 2 },
	{ id: 'projects', label: localize('voltSettings.projects', "Projects"), icon: Codicon.repo, group: 2 },
	{ id: 'storage', label: localize('voltSettings.storage', "Storage"), icon: Codicon.database, group: 2 },
];

/** Bounds for dragging the nav's edge. */
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 480;

/** Pages that were folded into others; links to them still land somewhere sensible. */
const SECTION_ALIASES: Record<string, SettingsSection> = {
	common: 'providers',
	models: 'providers',
	agents: 'providers',
	acp: 'providers',
	theme: 'appearance',
};

const MODE_COPY: Record<VoltMode, { title: string; body: string }> = {
	agent: {
		title: localize('voltSettings.mode.agent', "Agent"),
		body: localize('voltSettings.mode.agent.desc', "Writes files, runs terminal commands, and uses MCP. Pick the model in the agent composer."),
	},
	plan: {
		title: localize('voltSettings.mode.plan', "Plan"),
		body: localize('voltSettings.mode.plan.desc', "Read-only reasoning. No file writes or terminal. Choose the model from the composer."),
	},
	ask: {
		title: localize('voltSettings.mode.ask', "Ask"),
		body: localize('voltSettings.mode.ask.desc', "Fast Q&A. No writes, terminal, or MCP. Choose the model from the composer."),
	},
	debug: {
		title: localize('voltSettings.mode.debug', "Debug"),
		body: localize('voltSettings.mode.debug.desc', "Reasoning with writes and terminal for diagnosing failures."),
	},
	multitask: {
		title: localize('voltSettings.mode.multitask', "Multitask"),
		body: localize('voltSettings.mode.multitask.desc', "Balanced routing for parallel work. Writes and terminal are allowed."),
	},
};


export class VoltSettingsEditor extends EditorPane {

	static readonly ID = VoltSettingsEditorInput.EditorID;

	private container!: HTMLElement;
	private content!: HTMLElement;
	/** Where the page being rendered appends: the body of its last titled block. */
	private block: HTMLElement | undefined;
	/** Bumped on every render, so a late async result never lands on a newer page. */
	private renderGeneration = 0;
	/**
	 * Set while a model picker menu is open. Its picks change the catalog, and a re-render then
	 * would remove the button the menu hangs from, so the page waits for the menu to close.
	 */
	private pickerOpen = false;
	private renderDeferred = false;
	private contentScroll!: DomScrollableElement;
	private stickyHeads!: SettingsStickyHeads;
	private toc!: HTMLElement;
	private tocScroll!: DomScrollableElement;
	private search = '';
	private section: SettingsSection = 'general';
	/** The page on screen; re-rendering the same page keeps its scroll position. */
	private renderedSection: SettingsSection | undefined;
	private providers!: ProvidersPage;
	private appearance!: AppearancePage;
	private connectedAgents!: ConnectedAgentsPage;
	/** Made on first visit and kept, so its data and range survive leaving the page. */
	private usage: AgentUsagePage | undefined;
	private sidebar!: HTMLElement;
	private sidebarSash!: Sash;
	/** The nav's width when there is no agent sidebar to follow (IDE layout). */
	private ownSidebarWidth: number | undefined;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly scrollSync = this._register(new MutableDisposable());
	/** Lid-Closed Mode lives in the main process; absent in the web build. */
	private readonly awake: IVoltAwakeService | undefined;
	private awakeState: IAwakeState | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltPredictionService private readonly prediction: IVoltPredictionService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchThemeService private readonly workbenchThemeService: IWorkbenchThemeService,
	) {
		super(VoltSettingsEditor.ID, group, telemetryService, themeService, storageService);
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (this.section === 'composer' && COMPOSER_PAGE_SETTINGS.some(key => e.affectsConfiguration(key))) {
				this.renderContent();
			}
		}));
		this._register(this.runtime.onDidChangeCatalog(() => this.renderContent()));
		this._register(this.runtime.onDidChangeProfiles(() => this.renderContent()));
		this._register(this.runtime.onDidChangeProviderStatus(() => this.renderContent()));
		this._register(this.runtime.onDidChangeAccess(() => this.renderContent()));
		this._register(this.workbenchThemeService.onDidColorThemeChange(() => {
			if (this.section === 'appearance') {
				this.renderContent();
			}
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if ((this.section === 'appearance' && APPEARANCE_PAGE_SETTINGS.some(key => e.affectsConfiguration(key)))
				|| (this.section === 'general' && (e.affectsConfiguration(AGENT_DEFAULT_MODEL_SETTING) || e.affectsConfiguration('volt.awake')))) {
				this.renderContent();
			}
		}));
		this.awake = this.instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(IVoltAwakeService);
			} catch {
				return undefined;
			}
		});
		if (this.awake) {
			const shown = (state: IAwakeState | undefined) => JSON.stringify(state && [state.lid, state.tier, state.blockedBy, state.lastError]);
			const update = (state: IAwakeState) => {
				const changed = shown(state) !== shown(this.awakeState);
				this.awakeState = state;
				if (changed && this.section === 'general') {
					this.renderContent();
				}
			};
			this._register(this.awake.onDidChange(update));
			void this.awake.getState().then(update, () => undefined);
		}
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.volt-settings'));
		this._register(toDisposable(() => {
			this.container.remove();
			this.layoutService.mainContainer.classList.remove('volt-settings-open');
		}));

		const sidebar = this.sidebar = append(this.container, $('.volt-settings-sidebar'));

		const searchHost = append(sidebar, $('.volt-settings-search'));
		append(searchHost, $('span.volt-settings-search-icon')).appendChild(renderIcon(Codicon.search));
		const search = this._register(new InputBox(searchHost, this.contextViewService, {
			placeholder: localize('voltSettings.search', "Search Settings"),
			ariaLabel: localize('voltSettings.search', "Search Settings"),
			inputBoxStyles: this.inputBoxStyles(),
		}));
		this._register(search.onDidChange(value => {
			this.search = value;
			this.applyNavFilter();
			this.renderContent();
		}));

		this.toc = $('.volt-settings-toc');
		this.tocScroll = this._register(new DomScrollableElement(this.toc, {
			className: 'volt-settings-toc-scroll',
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Auto,
			useShadows: false,
		}));
		append(sidebar, this.tocScroll.getDomNode());
		for (const [index, section] of SECTIONS.entries()) {
			if (index > 0 && SECTIONS[index - 1].group !== section.group) {
				append(this.toc, $('.volt-settings-toc-gap'));
			}
			const item = append(this.toc, $('button.volt-settings-toc-item')) as HTMLButtonElement;
			item.type = 'button';
			append(item, $('span.volt-settings-toc-icon')).appendChild(createSettingsIcon(section.id) ?? renderIcon(section.icon));
			append(item, $('span.volt-settings-toc-text')).textContent = section.label;
			item.dataset.section = section.id;
			if (section.id === this.section) {
				item.classList.add('active');
			}
			this._register(addDisposableListener(item, 'click', () => this.setSection(section.id)));
		}

		// Back sits at the foot of the nav, where the agent list puts it while Usage is open.
		const footer = append(sidebar, $('.volt-settings-footer'));
		const back = append(footer, $('button.volt-settings-back')) as HTMLButtonElement;
		back.type = 'button';
		back.appendChild(renderIcon(Codicon.arrowLeft));
		append(back, $('span')).textContent = localize('voltSettings.back', "Back");
		back.setAttribute('aria-label', localize('voltSettings.backToChat', "Close settings"));
		this._register(addDisposableListener(back, 'click', () => this.close()));

		const scroll = $('.volt-settings-content');
		this.content = append(scroll, $('.volt-settings-content-inner'));
		this.contentScroll = this._register(new DomScrollableElement(scroll, {
			className: 'volt-settings-content-scroll',
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Auto,
			useShadows: false,
		}));
		append(this.container, this.contentScroll.getDomNode());
		this.createSidebarSash();
		this._register(this.layoutService.onDidLayoutMainContainer(() => this.syncSidebarWidth()));
		this.stickyHeads = this._register(new SettingsStickyHeads(scroll, this.content));
		this._register(this.contentScroll.onScroll(() => this.stickyHeads.sync()));
		// Storage sizes, projects and detected agents land after the page renders; without this the
		// scrollbar keeps the height of the first, empty page and the rest cannot be reached.
		const resize = new (getWindow(parent).ResizeObserver)(() => this.contentScroll.scanDomNode());
		resize.observe(this.content);
		this._register(toDisposable(() => resize.disconnect()));
		this.providers = new ProvidersPage(this.instantiationService, {
			target: () => this.target,
			sectionLabel: label => this.sectionLabel(label),
			store: this.renderStore,
			search: () => this.search,
			rerender: () => this.renderContent(),
			revealWorkbench: () => this.close(),
			switch: (parent, on, label, onClick) => this.switch(parent, on, label, onClick),
			inputBoxStyles: () => this.inputBoxStyles(),
			selectBoxStyles: () => this.selectBoxStyles(),
		});
		this._register(toDisposable(() => this.providers.dispose()));
		this.appearance = new AppearancePage(this.instantiationService, this.renderStore, () => this.section === 'appearance');
		this.connectedAgents = new ConnectedAgentsPage(this.instantiationService, {
			store: this.renderStore,
			target: () => this.target,
			sectionLabel: label => this.sectionLabel(label),
			settingsGroup: () => this.settingsGroup(),
			settingRow: (parent, title, desc, render) => this.settingRow(parent, title, desc, render),
			empty: text => this.empty(text),
			switch: (parent, on, label, onClick) => this.switch(parent, on, label, onClick),
			inputBoxStyles: () => this.inputBoxStyles(),
			rerender: () => this.renderContent(),
		});
		this._register(this.connectedAgents.onDidChange(() => {
			if (this.section === 'connected') {
				this.renderContent();
			}
		}));
		this.renderContent();
	}

	private close(): void {
		const input = this.input;
		if (input) {
			void this.group.closeEditor(input);
		}
	}

	protected override setEditorVisible(visible: boolean): void {
		if (!this.container) {
			return;
		}
		if (visible) {
			this.container.classList.add('volt-settings-overlay');
			this.layoutService.mainContainer.classList.add('volt-settings-open');
			this.layoutService.mainContainer.appendChild(this.container);
			this.syncSidebarWidth();
			this.usage?.setVisible(this.section === 'usage');
			this.scheduleScrollSync();
			return;
		}
		this.usage?.setVisible(false);
		this.container.classList.remove('volt-settings-overlay');
		this.layoutService.mainContainer.classList.remove('volt-settings-open');
		this.container.remove();
	}

	/**
	 * In the agent layout the left sidebar is the auxiliary bar. The nav takes its width, and
	 * dragging the nav's edge resizes that sidebar too, so both always match.
	 */
	private agentSidebarWidth(): number | undefined {
		if (getLayoutMode(this.layoutService) !== 'agent' || !this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			return undefined;
		}
		return this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width || undefined;
	}

	private syncSidebarWidth(): void {
		if (!this.container?.isConnected) {
			return;
		}
		const width = this.agentSidebarWidth() ?? this.ownSidebarWidth;
		this.container.style.setProperty('--volt-settings-sidebar-width', width ? `${width}px` : '');
		this.sidebarSash.layout();
	}

	private createSidebarSash(): void {
		const sash = this.sidebarSash = this._register(new Sash(this.container, {
			getVerticalSashLeft: () => this.sidebar.offsetWidth,
		}, { orientation: Orientation.VERTICAL }));
		let start = 0;
		this._register(sash.onDidStart(() => start = this.sidebar.offsetWidth));
		this._register(sash.onDidChange(e => {
			const width = Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, start + e.currentX - e.startX)));
			if (this.agentSidebarWidth() !== undefined) {
				const { height } = this.layoutService.getSize(Parts.AUXILIARYBAR_PART);
				this.layoutService.setSize(Parts.AUXILIARYBAR_PART, { width, height });
			} else {
				this.ownSidebarWidth = width;
			}
			// The layout may clamp the sidebar; the nav follows whatever it settled on.
			this.syncSidebarWidth();
		}));
	}

	private applyNavFilter(): void {
		const needle = this.search.trim().toLowerCase();
		for (const child of this.toc.querySelectorAll<HTMLElement>('.volt-settings-toc-item')) {
			const label = child.querySelector('.volt-settings-toc-text')?.textContent?.toLowerCase() ?? '';
			child.hidden = needle.length > 0 && !label.includes(needle);
		}
	}

	/** Opens a page by id, e.g. `storage` from Volt: Manage Storage. */
	showSection(section: string): void {
		const id = SECTION_ALIASES[section] ?? section;
		const known = SECTIONS.find(candidate => candidate.id === id);
		if (known) {
			this.setSection(known.id);
		}
	}

	private setSection(section: SettingsSection): void {
		this.section = section;
		if (section === 'providers') {
			void this.providers.checkSetup(true);
		}
		for (const child of this.toc.querySelectorAll('.volt-settings-toc-item')) {
			child.classList.toggle('active', (child as HTMLElement).dataset.section === section);
		}
		this.contentScroll.setScrollPosition({ scrollTop: 0 });
		this.renderContent();
	}

	private renderContent(): void {
		if (this.pickerOpen) {
			this.renderDeferred = true;
			return;
		}
		this.renderDeferred = false;
		// A re-render of the same page (a click, a theme or setting change) keeps its place. Emptying
		// the page would collapse it, the browser would clamp scrollTop to 0 and the scrollbar would
		// pick that up, so the page holds its old height until the new content (some of it async,
		// like the theme gallery) is in.
		const samePage = this.renderedSection === this.section;
		const scrollTop = samePage ? this.contentScroll.getScrollPosition().scrollTop : 0;
		this.content.style.minHeight = samePage && scrollTop > 0 ? `${this.content.offsetHeight}px` : '';
		this.renderedSection = this.section;
		this.renderStore.clear();
		this.content.replaceChildren();
		this.block = undefined;
		this.renderGeneration++;
		const generation = this.renderGeneration;
		let pending: Promise<unknown> | undefined;
		if (this.section !== 'usage') {
			this.usage?.setVisible(false);
		}
		switch (this.section) {
			case 'general':
				this.renderGeneral();
				break;
			case 'usage':
				this.renderUsage();
				break;
			case 'appearance':
				pending = this.renderAppearance();
				break;
			case 'providers':
				this.providers.render(this.pageHead(
					localize('voltSettings.providers', "Providers & Models"),
					localize('voltSettings.providersLead2', "Install and sign in to coding agents, add API keys, and choose which models show up in the picker."),
				));
				break;
			case 'modes':
				this.renderModes();
				break;
			case 'composer':
				this.renderComposer();
				break;
			case 'tab':
				this.renderTab();
				break;
			case 'security':
				this.renderSecurity();
				break;
			case 'connected': {
				this.pageHead(
					localize('voltSettings.connectedAgents', "Connected agents"),
					localize('voltSettings.connectedAgentsLead', "Let Claude Code, Codex, Cursor and other agents outside Volt run your chats over MCP, and see or revoke the ones you allowed."),
				);
				const generation = this.renderGeneration;
				pending = this.connectedAgents.render(() => generation === this.renderGeneration && this.section === 'connected').finally(() => this.scheduleScrollSync());
				break;
			}
			case 'projects':
				this.pageHead(localize('voltSettings.projects', "Projects"), localize('voltSettings.projectsLead', "What new chats in each project start with, its worktree setup and its agents' environment."));
				renderProjectsSection(this.target, this.instantiationService, this.renderStore, this.search.trim().toLowerCase());
				break;
			case 'storage':
				this.pageHead(localize('voltSettings.storage', "Storage"), localize('voltSettings.storageLead', "What Volt keeps on this machine, and what can go. Nothing in use is removed."));
				renderStorageSection(this.target, this.instantiationService, this.renderStore);
				break;
		}
		this.scheduleScrollSync();
		if (samePage) {
			this.contentScroll.setScrollPosition({ scrollTop });
		}
		if (this.content.style.minHeight) {
			const release = () => {
				if (generation !== this.renderGeneration) {
					return;
				}
				this.content.style.minHeight = '';
				this.contentScroll.scanDomNode();
				this.contentScroll.setScrollPosition({ scrollTop });
			};
			if (pending) {
				void pending.finally(release);
			} else {
				this.renderStore.add(scheduleAtNextAnimationFrame(getWindow(this.content), release));
			}
		}
	}

	private scheduleScrollSync(): void {
		this.contentScroll?.scanDomNode();
		this.tocScroll?.scanDomNode();
		if (!this.container?.isConnected) {
			return;
		}
		this.scrollSync.value = scheduleAtNextAnimationFrame(getWindow(this.container), () => {
			this.contentScroll.scanDomNode();
			this.tocScroll.scanDomNode();
			this.stickyHeads.sync();
		});
	}

	private renderUsage(): void {
		this.pageHead(
			localize('voltSettings.usage', "Usage"),
			localize('voltSettings.usageLead', "What your agents cost at API prices, the tokens they used, and how much of each plan's limits is left."),
		);
		// The model dialog centers over the whole settings overlay, not the tall scrolled page.
		this.usage ??= this._register(this.instantiationService.createInstance(AgentUsagePage, () => this.container));
		this.target.appendChild(this.usage.element);
		this.usage.setVisible(this.isVisible());
	}

	private get target(): HTMLElement {
		return this.block ?? this.content;
	}

	/** The page title; it sticks to the top while the page scrolls under it. Returns the title row. */
	private pageHead(title: string, lead?: string): HTMLElement {
		const { head, body } = appendSettingsBlock(this.content, 'volt-settings-page-title');
		append(head, $('h2')).textContent = title;
		this.block = body;
		if (lead) {
			append(body, $('.volt-settings-lead')).textContent = lead;
		}
		return head;
	}

	/** A section title; it sticks like the page title until the next one pushes it out. */
	private sectionLabel(label: string): void {
		const { head, body } = appendSettingsBlock(this.content, 'volt-settings-section-label');
		append(head, $('span')).textContent = label;
		this.block = body;
	}

	private settingsGroup(): HTMLElement {
		return append(this.target, $('.volt-settings-group'));
	}

	private settingRow(parent: HTMLElement, title: string, desc: string | undefined, renderControl?: (host: HTMLElement) => void): HTMLElement {
		const row = append(parent, $('.volt-settings-row'));
		const copy = append(row, $('.volt-settings-row-copy'));
		append(copy, $('label')).textContent = title;
		if (desc) {
			append(copy, $('.desc')).textContent = desc;
		}
		if (renderControl) {
			renderControl(append(row, $('.volt-settings-row-control')));
		}
		return row;
	}

	private stepper(parent: HTMLElement, valueText: string, unit: string, onCommit: (next: number) => number, step: number): void {
		const stepper = append(parent, $('.volt-settings-stepper'));
		const minus = append(stepper, $('button.step')) as HTMLButtonElement;
		minus.textContent = '\u2212';
		const value = append(stepper, $('input.value')) as HTMLInputElement;
		value.type = 'text';
		value.inputMode = 'numeric';
		value.value = valueText;
		const plus = append(stepper, $('button.step')) as HTMLButtonElement;
		plus.textContent = '+';
		append(parent, $('.volt-settings-stepper-unit')).textContent = unit;
		const commit = (next: number) => {
			value.value = String(onCommit(next));
		};
		this.renderStore.add(addDisposableListener(minus, 'click', () => commit(Number(value.value) - step)));
		this.renderStore.add(addDisposableListener(plus, 'click', () => commit(Number(value.value) + step)));
		this.renderStore.add(addDisposableListener(value, 'change', () => commit(Number(value.value) || 0)));
	}

	private empty(text: string): void {
		append(this.target, $('.volt-settings-empty')).textContent = text;
	}

	private renderGeneral(): void {
		this.pageHead(
			localize('voltSettings.general', "General"),
			localize('voltSettings.generalLead', "App-wide choices that apply to every chat."),
		);
		this.sectionLabel(localize('voltSettings.newChats', "New chats"));
		const defaults = this.settingsGroup();
		this.settingRow(
			defaults,
			localize('voltSettings.defaultModel', "Default model"),
			localize('voltSettings.defaultModelDesc', "The model a new chat starts on. Last used keeps whatever you picked most recently. A project's own default wins."),
			host => this.modelPicker(host, {
				get: () => this.configurationService.getValue<string>(AGENT_DEFAULT_MODEL_SETTING) || undefined,
				set: ref => void this.configurationService.updateValue(AGENT_DEFAULT_MODEL_SETTING, ref ?? ''),
			}, localize('voltSettings.defaultModel', "Default model"), localize('voltSettings.lastUsed', "Last used"), localize('voltSettings.lastUsedDesc', "Start on the model you picked last")),
		);
		this.settingRow(
			defaults,
			localize('voltSettings.accessMode', "Default access"),
			accessModeOption(this.runtime.getAccessMode()).description,
			host => this.accessModeControl(host),
		);

		this.sectionLabel(localize('voltSettings.textGeneration', "Generated text"));
		const generated = this.settingsGroup();
		this.settingRow(
			generated,
			localize('voltSettings.textGenerationModel', "Text generation model"),
			localize('voltSettings.textGenerationModelDesc', "Used for chat titles and other generated text. Follow chat runs each one on the model the chat uses."),
			host => this.textGenerationPicker(host, 'title', localize('voltSettings.textGenerationModel', "Text generation model"), localize('voltSettings.followChat', "Follow chat"), localize('voltSettings.followChatDesc', "Use the model the chat runs on")),
		);
		this.settingRow(
			generated,
			localize('voltSettings.gitTextModel', "Git text model"),
			localize('voltSettings.gitTextModelDesc', "Used for AI commit messages and pull request titles and descriptions."),
			host => this.textGenerationPicker(host, 'git', localize('voltSettings.gitTextModel', "Git text model"), localize('voltSettings.gitTextDefault', "Default"), localize('voltSettings.gitTextDefaultDesc', "Use the text generation model")),
		);
		this.renderPower();
		this.renderUpdates();
	}

	/** Lid-Closed Mode, and staying awake while agents work. */
	private renderPower(): void {
		if (!this.awake) {
			return;
		}
		const awake = this.awake;
		const prefs = readAwakePrefs(key => this.configurationService.getValue(key));
		this.sectionLabel(localize('voltSettings.power', "Power"));
		const group = this.settingsGroup();
		this.settingSwitch(
			group,
			AWAKE_LID_CLOSED_MODE_SETTING,
			localize('voltSettings.lidClosedMode', "Lid-Closed Mode"),
			localize('voltSettings.lidClosedModeDesc', "Agents keep working when you close the laptop lid. The computer can sleep again once they finish, below {0}% battery, if it gets too hot, or after {1} hours. Use it on a hard, ventilated surface, never in a bag.", prefs.batteryFloorPercent, prefs.maxHours),
		);
		if (prefs.lidClosedMode) {
			const state = this.awakeState;
			this.settingRow(group, localize('voltSettings.lidClosedModeStatus', "Status"), describeLidClosedMode(state), host => {
				const action = (label: string, secondary: boolean, run: () => Promise<unknown>) => {
					const button = this.renderStore.add(new Button(host, { ...defaultButtonStyles, secondary }));
					button.label = label;
					this.renderStore.add(button.onDidClick(() => {
						button.enabled = false;
						void run().finally(() => button.enabled = true);
					}));
				};
				switch (state?.lid.kind) {
					case 'needsSetup':
						action(localize('voltSettings.lidClosedModeSetUp', "Set Up…"), false, () => awake.setUpLidClosedMode());
						break;
					case 'ready':
						if (isMacintosh) {
							action(localize('voltSettings.lidClosedModeRemove', "Remove Permission"), true, () => awake.removeLidClosedModePermission());
						}
						break;
					case 'foreign':
					case 'unsupported':
						action(localize('voltSettings.lidClosedModeCheck', "Check Again"), true, () => awake.refreshCapability());
						break;
				}
			});
		}
		this.settingSwitch(
			group,
			AWAKE_WHILE_AGENTS_WORK_SETTING,
			localize('voltSettings.awakeWhileWorking', "Stay awake while agents work"),
			prefs.graceMinutes === 0
				? localize('voltSettings.awakeWhileWorkingDescNoGrace', "The computer doesn't go to sleep while an agent is working. Without Lid-Closed Mode, closing the lid still puts it to sleep.")
				: prefs.graceMinutes === 1
					? localize('voltSettings.awakeWhileWorkingDescOne', "The computer doesn't go to sleep while an agent is working, or for a minute after. Without Lid-Closed Mode, closing the lid still puts it to sleep.")
					: localize('voltSettings.awakeWhileWorkingDesc', "The computer doesn't go to sleep while an agent is working, or for {0} minutes after. Without Lid-Closed Mode, closing the lid still puts it to sleep.", prefs.graceMinutes),
		);
	}

	/** Supervised · Accept edits · Auto · Full access, as one segmented control. */
	private accessModeControl(host: HTMLElement): void {
		host.classList.add('wide');
		const control = append(host, $('.volt-settings-segmented'));
		control.setAttribute('role', 'radiogroup');
		control.setAttribute('aria-label', localize('voltSettings.accessMode', "Default access"));
		const current = this.runtime.getAccessMode();
		const short: Record<VoltAccessMode, string> = {
			'supervised': localize('voltSettings.access.supervised', "Supervised"),
			'auto-accept-edits': localize('voltSettings.access.edits', "Accept edits"),
			'auto': localize('voltSettings.access.auto', "Auto"),
			'full-access': localize('voltSettings.access.full', "Full access"),
		};
		for (const option of ACCESS_MODE_OPTIONS) {
			const button = append(control, $('button.volt-settings-segment')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'radio');
			button.setAttribute('aria-checked', String(option.id === current));
			button.classList.toggle('active', option.id === current);
			button.classList.toggle('danger', option.id === 'full-access');
			append(button, $('span')).textContent = short[option.id];
			setAgentTooltip(button, option.description);
			this.renderStore.add(addDisposableListener(button, 'click', () => void this.runtime.setAccessMode(option.id)));
		}
	}

	/** Resolves once the theme gallery (drawn after the themes load their colors) is in. */
	private renderAppearance(): Promise<void> {
		this.pageHead(
			localize('voltSettings.appearance', "Appearance"),
			localize('voltSettings.appearanceLead', "Pick a color theme. Volt's own themes come first; every VS Code theme you install shows up here too."),
		);
		this.settingRow(
			this.settingsGroup(),
			localize('voltSettings.appearanceMode', "Mode"),
			localize('voltSettings.appearanceModeDesc', "System follows macOS and switches between your dark and light picks."),
			host => this.appearance.renderModeControl(host),
		);
		this.sectionLabel(localize('voltSettings.colorTheme', "Color theme"));
		const gallery = append(this.target, $('.volt-settings-theme-gallery'));
		const generation = this.renderGeneration;
		const galleryReady = this.appearance.renderGallery(gallery, this.search.trim().toLowerCase()).then(() => {
			if (generation === this.renderGeneration) {
				this.scheduleScrollSync();
			}
		}, () => undefined);

		this.sectionLabel(localize('voltSettings.typography', "Typography"));
		const type = this.settingsGroup();
		this.settingRow(
			type,
			localize('voltSettings.codeFontSize', "Code font size"),
			localize('voltSettings.codeFontSizeDesc', "Editors, diffs and code blocks."),
			host => this.stepper(host, String(this.configurationService.getValue<number>('editor.fontSize') ?? 13), localize('voltSettings.px', "px"), size => {
				const clamped = Math.max(8, Math.min(32, Math.round(size)));
				void this.configurationService.updateValue('editor.fontSize', clamped);
				return clamped;
			}, 1),
		);
		this.settingRow(
			type,
			localize('voltSettings.zoom', "Interface zoom"),
			localize('voltSettings.zoomDesc', "Scales the whole window, text and icons alike."),
			host => this.stepper(host, String(Math.round(100 * Math.pow(1.2, this.configurationService.getValue<number>('window.zoomLevel') ?? 0))), '%', percent => {
				const steps = [67, 80, 90, 100, 110, 120, 133, 150, 170, 200];
				const current = Math.round(100 * Math.pow(1.2, this.configurationService.getValue<number>('window.zoomLevel') ?? 0));
				// The buttons move one step; a typed value snaps to the nearest step.
				const index = steps.reduce((best, value, i) => Math.abs(value - percent) < Math.abs(steps[best] - percent) ? i : best, 0);
				const next = percent > current && steps[index] <= current ? steps[Math.min(steps.length - 1, index + 1)] : percent < current && steps[index] >= current ? steps[Math.max(0, index - 1)] : steps[index];
				void this.configurationService.updateValue('window.zoomLevel', Math.log(next / 100) / Math.log(1.2));
				return next;
			}, 1),
		);
		this.settingRow(
			type,
			localize('voltSettings.fileIcons', "File icons"),
			localize('voltSettings.fileIconsDesc', "Icons next to files in the explorer, changes and tabs."),
			host => {
				const select = append(host, $('.volt-settings-select'));
				void this.workbenchThemeService.getFileIconThemes().then(themes => {
					if (generation !== this.renderGeneration) {
						return;
					}
					const options = [{ id: '', label: localize('voltSettings.noFileIcons', "None") }, ...themes.map(theme => ({ id: theme.settingsId ?? '', label: theme.label }))];
					const current = this.workbenchThemeService.getFileIconTheme().settingsId ?? '';
					const box = this.selectBox(select, options.map(option => ({ text: option.label })), Math.max(0, options.findIndex(option => option.id === current)), localize('voltSettings.fileIcons', "File icons"));
					this.renderStore.add(box.onDidSelect(e => void this.workbenchThemeService.setFileIconTheme(options[e.index].id || undefined, 'auto')));
				});
			},
		);
		return galleryReady;
	}

	/** Release channel, version and a manual update check. */
	private renderUpdates(): void {
		const { product, updates } = this.instantiationService.invokeFunction(accessor => ({ product: accessor.get(IProductService), updates: accessor.get(IUpdateService) }));
		this.sectionLabel(localize('voltSettings.updates', "Updates"));
		const group = this.settingsGroup();

		const channels = [
			{ id: 'default', text: localize('voltSettings.channelDefault', "This app's channel") },
			{ id: 'stable', text: localize('voltSettings.channelStable', "Stable") },
			{ id: 'beta', text: localize('voltSettings.channelBeta', "Beta") },
			{ id: 'nightly', text: localize('voltSettings.channelNightly', "Nightly") },
		];
		this.settingRow(
			group,
			localize('voltSettings.releaseChannel', "Release channel"),
			localize('voltSettings.releaseChannelDesc', "Volt, Volt Beta and Volt Nightly are separate apps that install side by side. Picking another channel offers its download."),
			host => {
				const current = this.configurationService.getValue<string>(VOLT_RELEASE_CHANNEL_SETTING);
				const selected = Math.max(0, channels.findIndex(c => c.id === current));
				const box = this.selectBox(append(host, $('.volt-settings-select')), channels.map(c => ({ text: c.text })), selected, localize('voltSettings.releaseChannel', "Release channel"));
				this.renderStore.add(box.onDidSelect(e => void this.configurationService.updateValue(VOLT_RELEASE_CHANNEL_SETTING, channels[e.index].id)));
			},
		);

		const version = product.voltVersion ?? product.version;
		const build = [product.quality, product.commit?.slice(0, 8)].filter(Boolean).join(' · ');
		this.settingRow(
			group,
			localize('voltSettings.version', "{0} {1}", product.nameLong, version),
			build || localize('voltSettings.devBuild', "Development build"),
			host => {
				host.classList.add('volt-settings-update-control');
				const status = append(host, $('span.volt-settings-update-status'));
				const check = this.renderStore.add(new Button(host, { ...defaultButtonStyles, secondary: true }));
				check.label = localize('voltSettings.checkForUpdates', "Check for Updates");
				const render = (state: UpdateState) => {
					status.textContent = describeUpdateState(state);
					check.enabled = state.type === StateType.Idle;
				};
				render(updates.state);
				this.renderStore.add(updates.onStateChange(render));
				this.renderStore.add(check.onDidClick(() => void updates.checkForUpdates(true)));
			},
		);
	}

	/** The composer's model picker, bound to a generated-text slot instead of the composer's model. */
	private textGenerationPicker(host: HTMLElement, slot: 'title' | 'git', ariaLabel: string, autoLabel: string, autoDescription: string): void {
		this.modelPicker(host, {
			get: () => this.runtime.getTaskModels()[slot],
			set: ref => void this.runtime.setTaskModel(slot, ref),
		}, ariaLabel, autoLabel, autoDescription);
	}

	/** The composer's model picker, bound to a setting instead of the composer's model. */
	private modelPicker(host: HTMLElement, binding: { get(): string | undefined; set(ref: string | undefined): void }, ariaLabel: string, autoLabel: string, autoDescription: string): void {
		const button = append(host, $('button.volt-agent-model.volt-settings-model')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-haspopup', 'dialog');
		button.setAttribute('aria-label', ariaLabel);
		const picker = this.renderStore.add(this.instantiationService.createInstance(AgentModelPicker, {
			binding: {
				get: binding.get,
				set: binding.set,
				autoLabel,
				autoDescription,
			},
			position: AnchorPosition.BELOW,
			alignment: AnchorAlignment.RIGHT,
			onDidChange: () => render(),
		}));
		const render = () => {
			button.replaceChildren();
			picker.renderTrigger(button);
			button.appendChild(renderIcon(Codicon.chevronDown));
		};
		render();
		this.renderStore.add(addDisposableListener(button, 'click', () => {
			this.pickerOpen = true;
			picker.show(button, () => {
				if (!this.pickerOpen) {
					return;
				}
				this.pickerOpen = false;
				if (this.renderDeferred) {
					this.renderContent();
				} else {
					button.focus();
				}
			});
		}));
	}

	private renderModes(): void {
		this.pageHead(
			localize('voltSettings.modes', "Modes"),
			localize('voltSettings.modesLead', "What the agent is allowed to do."),
		);
		const list = append(this.target, $('.volt-settings-list'));
		for (const mode of VOLT_MODES) {
			const policy = modePolicy(mode);
			const info = MODE_COPY[mode];
			const row = append(list, $('.volt-settings-mode'));
			const copy = append(row, $('.volt-settings-row-copy'));
			append(copy, $('label')).textContent = info.title;
			append(copy, $('.desc')).textContent = info.body;
			const pills = append(row, $('.volt-settings-pills'));
			this.policyPill(pills, localize('voltSettings.writes', "Writes"), policy.allowWrites);
			this.policyPill(pills, localize('voltSettings.terminal', "Terminal"), policy.allowTerminal);
			this.policyPill(pills, localize('voltSettings.mcp', "MCP"), policy.allowMcp);
		}
	}

	private renderComposer(): void {
		this.pageHead(
			localize('voltSettings.composer', "Composer"),
			localize('voltSettings.composerLead2', "How the prompt box behaves, and what chats do on their own."),
		);
		this.sectionLabel(localize('voltSettings.promptBox', "Prompt box"));
		const group = this.settingsGroup();
		this.settingSwitch(
			group,
			AGENT_PROMPT_HISTORY_SETTING,
			localize('voltSettings.promptHistory', "Load previous prompts with Arrow Up"),
			localize('voltSettings.promptHistoryDesc', "Arrow Up in an empty composer brings back what you sent before, newest first. Arrow Down goes back to newer ones, then to the text you were typing."),
		);
		this.settingSwitch(
			group,
			AGENT_NEW_CHAT_DRAFT_SETTING,
			localize('voltSettings.restoreDraft', "Keep unsent text for a new chat"),
			localize('voltSettings.restoreDraftDesc', "If a new chat was left with text you never sent, New Agent opens it again with the text still in the composer."),
		);

		this.sectionLabel(localize('voltSettings.chatsSection', "Chats"));
		const workflow = this.settingsGroup();
		const resumeOptions: ISelectOptionItem[] = [
			{ text: localize('voltSettings.resumeSubagents', "Delegated tasks"), detail: 'subagents' },
			{ text: localize('voltSettings.resumeAll', "Every chat"), detail: 'all' },
			{ text: localize('voltSettings.resumeOff', "Nothing"), detail: 'off' },
		];
		const resume = this.configurationService.getValue<string>(AGENT_RESUME_AFTER_RESTART_SETTING);
		this.settingRow(
			workflow,
			localize('voltSettings.resumeAfterRestart', "Continue after a restart"),
			localize('voltSettings.resumeAfterRestartDesc', "What keeps working on its own when Volt restarts in the middle of a run. Everything else shows Resume."),
			host => {
				const box = this.selectBox(append(host, $('.volt-settings-select')), resumeOptions, Math.max(0, resumeOptions.findIndex(option => option.detail === resume)), localize('voltSettings.resumeAfterRestart', "Continue after a restart"));
				this.renderStore.add(box.onDidSelect(e => void this.configurationService.updateValue(AGENT_RESUME_AFTER_RESTART_SETTING, resumeOptions[e.index].detail)));
			},
		);
		this.settingSwitch(
			workflow,
			AGENT_AUTO_RESUME_AFTER_LIMIT_SETTING,
			localize('voltSettings.autoResumeLimit', "Resume chats when usage limits reset"),
			localize('voltSettings.autoResumeLimitDesc', "A chat stopped by a provider's usage limit waits with a countdown and continues where it left off once the limit resets. Without a reset time, Volt checks again with a growing delay."),
		);
		this.settingSwitch(
			workflow,
			AGENT_COMPACT_OLD_THREADS_SETTING,
			localize('voltSettings.compactOld', "Compact old chats before resuming them"),
			localize('voltSettings.compactOldDesc', "A chat with 100K tokens or more that sat idle for over an hour is compacted before your next message, so its whole history is not resent at full price."),
		);
		this.settingSwitch(
			workflow,
			AGENT_HOME_WORKING_SECTION_SETTING,
			localize('voltSettings.workingSection', "Working section"),
			localize('voltSettings.workingSectionDesc', "Chats that are busy fold into a Working section in the sidebar and come back when they finish or need you."),
		);
		const settleOptions: ISelectOptionItem[] = [0, 1, 3, 7, 14].map(days => ({
			text: days === 0 ? localize('voltSettings.settleNever', "Never") : days === 1 ? localize('voltSettings.settleDay', "After 1 day") : localize('voltSettings.settleDays', "After {0} days", days),
			detail: String(days),
		}));
		const settleDays = String(this.configurationService.getValue<number>(AGENT_HOME_AUTO_SETTLE_DAYS_SETTING) ?? 3);
		this.settingRow(
			workflow,
			localize('voltSettings.autoSettle', "Settle idle chats"),
			localize('voltSettings.autoSettleDesc', "Move a chat to Settled after it goes this long without a message from you. Each chat's Auto-settle switch can keep it out."),
			host => {
				const box = this.selectBox(append(host, $('.volt-settings-select')), settleOptions, Math.max(0, settleOptions.findIndex(option => option.detail === settleDays)), localize('voltSettings.autoSettle', "Settle idle chats"));
				this.renderStore.add(box.onDidSelect(e => void this.configurationService.updateValue(AGENT_HOME_AUTO_SETTLE_DAYS_SETTING, Number(settleOptions[e.index].detail))));
			},
		);
	}

	/** A row whose switch flips a boolean setting; the page re-renders when the setting changes. */
	private settingSwitch(parent: HTMLElement, key: string, title: string, desc: string): void {
		const on = this.configurationService.getValue<boolean>(key) !== false;
		this.settingRow(parent, title, desc, host => this.switch(host, on, title, () => {
			void this.configurationService.updateValue(key, !on);
		}));
	}

	private policyPill(parent: HTMLElement, label: string, allowed: boolean): void {
		const pill = append(parent, $(`span.volt-settings-pill.${allowed ? 'on' : 'off'}`));
		pill.textContent = label;
	}

	private renderTab(): void {
		this.pageHead(
			localize('voltSettings.tab', "Tab & Prediction"),
			localize('voltSettings.tabLead', "Ghost text as you type, from the composer model or one you pin."),
		);
		const settings = this.prediction.getSettings();
		const group = this.settingsGroup();

		this.settingRow(
			group,
			localize('voltSettings.tabEnabled', "Enable predictions"),
			localize('voltSettings.tabEnabledDesc', "Show AI suggestions as you type. Accept with Tab."),
			host => this.switch(host, settings.enabled, localize('voltSettings.tabEnabled', "Enable predictions"), () => {
				this.prediction.updateSettings({ enabled: !settings.enabled });
				this.renderContent();
			}),
		);

		const models = this.runtime.listCatalog().filter(item => item.enabled);
		const taskModels = this.runtime.getTaskModels();
		const options: ISelectOptionItem[] = [
			{ text: localize('voltSettings.tabFollow', "Follow composer (Cursor, Claude, ...)"), detail: '' },
			...models.map(model => ({ text: model.qualifier ? `${model.label} - ${model.qualifier}` : model.label, detail: model.ref })),
		];
		const selected = Math.max(0, options.findIndex(option => option.detail === (taskModels.tab ?? '')));
		this.settingRow(
			group,
			localize('voltSettings.tabModel', "Tab model"),
			localize('voltSettings.tabModelDesc', "Follow the composer selection, or pin a specific model or agent just for predictions."),
			host => {
				const box = this.selectBox(append(host, $('.volt-settings-select')), options, selected, localize('voltSettings.tabModel', "Tab model"));
				this.renderStore.add(box.onDidSelect(e => {
					void this.runtime.setTaskModel('tab', options[e.index].detail || undefined);
				}));
			},
		);

		const modeOptions: ISelectOptionItem[] = [
			{ text: localize('voltSettings.tabEager', "Eager"), detail: 'eager' },
			{ text: localize('voltSettings.tabSubtle', "Subtle"), detail: 'subtle' },
		];
		this.settingRow(
			group,
			localize('voltSettings.tabMode', "Prediction mode"),
			localize('voltSettings.tabModeDesc', "Eager predicts while you type. Subtle only predicts on the explicit trigger (Alt+\\)."),
			host => {
				const modeBox = this.selectBox(append(host, $('.volt-settings-select')), modeOptions, settings.mode === 'subtle' ? 1 : 0, localize('voltSettings.tabMode', "Prediction mode"));
				this.renderStore.add(modeBox.onDidSelect(e => {
					this.prediction.updateSettings({ mode: modeOptions[e.index].detail as 'eager' | 'subtle' });
				}));
			},
		);

		this.settingRow(
			group,
			localize('voltSettings.tabDebounce', "Debounce"),
			localize('voltSettings.tabDebounceDesc', "Extra wait before a model request is sent. Lower is snappier; higher saves tokens while typing fast."),
			host => this.stepper(host, String(settings.debounceMs), localize('voltSettings.ms', "ms"), ms => {
				const clamped = Math.max(0, Math.min(2000, Math.round(ms)));
				this.prediction.updateSettings({ debounceMs: clamped });
				return clamped;
			}, 25),
		);

		this.settingRow(
			group,
			localize('voltSettings.tabGlobs', "Disabled files"),
			localize('voltSettings.tabGlobsDesc', "Glob patterns that never receive predictions (comma separated). Secrets and lockfiles are excluded by default."),
			host => {
				const globInput = this.renderStore.add(new InputBox(append(host, $('.volt-settings-input.wide')), this.contextViewService, {
					ariaLabel: localize('voltSettings.tabGlobs', "Disabled files"),
					inputBoxStyles: this.inputBoxStyles(),
				}));
				globInput.value = settings.disabledGlobs.join(', ');
				this.renderStore.add(addDisposableListener(globInput.inputElement, 'change', () => {
					this.prediction.updateSettings({ disabledGlobs: globInput.value.split(',').map(glob => glob.trim()).filter(Boolean) });
				}));
			},
		);
	}

	private renderSecurity(): void {
		this.pageHead(
			localize('voltSettings.security', "Security"),
			localize('voltSettings.securityLead', "Where keys are stored and what the agent is allowed to run."),
		);

		const basics = this.settingsGroup();
		this.settingRow(
			basics,
			localize('voltSettings.secrets', "Secrets"),
			localize('voltSettings.securityBody', "API keys are stored in OS secret storage, never in settings.json."),
		);
		this.settingRow(
			basics,
			localize('voltSettings.accessMode', "Default access"),
			localize('voltSettings.accessModeDescSecurity', "What agents may do without asking. Each chat can still change it from the composer."),
			host => this.accessModeControl(host),
		);

		this.sectionLabel(localize('voltSettings.projectRules', "Project rules"));
		append(this.target, $('.volt-settings-section-hint')).textContent = localize('voltSettings.projectRulesDesc', "Explicit deny rules still win under Full access. Format: action resource effect.");
		this.renderRuleEditor();

		this.sectionLabel(localize('voltSettings.savedApprovals', "Saved approvals"));
		const saved = this.runtime.listSavedApprovals();
		if (!saved.length) {
			this.empty(localize('voltSettings.noSavedApprovals', "No always-allow rules yet."));
		} else {
			const list = append(this.target, $('.volt-settings-list'));
			saved.forEach((rule, index) => {
				const row = append(list, $('.volt-settings-card'));
				append(append(row, $('.volt-settings-card-copy')), $('div.title')).textContent = `${rule.action} ${rule.resource} -> ${rule.effect}`;
				const revoke = this.renderStore.add(new Button(row, { ...defaultButtonStyles, secondary: true }));
				revoke.label = localize('voltSettings.revoke', "Revoke");
				this.renderStore.add(revoke.onDidClick(() => void this.runtime.revokeSavedApproval(index)));
			});
		}

		this.sectionLabel(localize('voltSettings.recentDecisions', "Recent decisions"));
		const receipts = this.runtime.listReceipts().slice(-12).reverse();
		if (!receipts.length) {
			this.empty(localize('voltSettings.noReceipts', "No access decisions recorded in this session."));
		} else {
			const list = append(this.target, $('.volt-settings-list'));
			for (const receipt of receipts) {
				const row = append(list, $('.volt-settings-card'));
				const copy = append(row, $('.volt-settings-card-copy'));
				append(copy, $('div.title')).textContent = `${receipt.action} ${receipt.resource}`;
				append(copy, $('.meta')).textContent = localize(
					'voltSettings.receipt',
					"{0} - {1} - {2}",
					receipt.decision,
					receipt.risk,
					receipt.policySource,
				);
			}
		}
	}

	private renderRuleEditor(): void {
		const rules = this.runtime.listProjectRules();
		const form = append(this.target, $('.volt-settings-form'));
		append(form, $('label.volt-settings-form-title')).textContent = localize('voltSettings.addRuleTitle', "Add a rule");
		const action = this.labeledInput(form, localize('voltSettings.ruleAction', "Action"), 'shell');
		const resource = this.labeledInput(form, localize('voltSettings.ruleResource', "Resource"), 'git push --force*');
		const effectHost = append(form, $('.volt-settings-field'));
		append(effectHost, $('label')).textContent = localize('voltSettings.ruleEffect', "Effect");
		let effect: IPermissionRule['effect'] = 'deny';
		const box = this.selectBox(append(effectHost, $('.volt-settings-control')), [
			{ text: 'deny' },
			{ text: 'ask' },
			{ text: 'allow' },
		], 0, localize('voltSettings.ruleEffect', "Effect"));
		this.renderStore.add(box.onDidSelect(e => {
			effect = (['deny', 'ask', 'allow'][e.index] ?? 'deny') as IPermissionRule['effect'];
		}));
		const actions = append(form, $('.volt-settings-actions'));
		const add = this.renderStore.add(new Button(actions, defaultButtonStyles));
		add.label = localize('voltSettings.addRule', "Add rule");
		this.renderStore.add(add.onDidClick(() => {
			const next = [...rules, { action: action.value.trim() || '*', resource: resource.value.trim() || '*', effect, source: 'project' as const }];
			void this.runtime.setProjectRules(next);
		}));
		if (rules.length) {
			const list = append(this.target, $('.volt-settings-list'));
			for (const [index, rule] of rules.entries()) {
				const row = append(list, $('.volt-settings-card'));
				append(append(row, $('.volt-settings-card-copy')), $('div.title')).textContent = `${rule.action} ${rule.resource} -> ${rule.effect}`;
				const remove = this.renderStore.add(new Button(row, { ...defaultButtonStyles, secondary: true }));
				remove.label = localize('voltSettings.removeRule', "Remove");
				this.renderStore.add(remove.onDidClick(() => {
					void this.runtime.setProjectRules(rules.filter((_, i) => i !== index));
				}));
			}
		}
	}

	private switch(parent: HTMLElement, on: boolean, label: string, onClick: () => void): HTMLButtonElement {
		const toggle = append(parent, $('button.volt-settings-toggle')) as HTMLButtonElement;
		toggle.classList.toggle('on', on);
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-checked', String(on));
		toggle.setAttribute('aria-label', label);
		this.renderStore.add(addDisposableListener(toggle, 'click', onClick));
		return toggle;
	}

	private field(parent: HTMLElement, title: string, render: (host: HTMLElement) => void): HTMLElement {
		const field = append(parent, $('.volt-settings-field'));
		append(field, $('label')).textContent = title;
		const host = append(field, $('.volt-settings-control'));
		render(host);
		return field;
	}

	private labeledInput(parent: HTMLElement, title: string, placeholder: string, type: 'text' | 'password' = 'text'): InputBox {
		let box!: InputBox;
		this.field(parent, title, host => {
			box = this.renderStore.add(new InputBox(host, this.contextViewService, {
				placeholder,
				ariaLabel: title,
				type,
				inputBoxStyles: this.inputBoxStyles(),
			}));
		});
		return box;
	}

	private selectBox(host: HTMLElement, options: ISelectOptionItem[], selected: number, ariaLabel: string): SelectBox {
		const box = this.renderStore.add(new SelectBox(options, selected, this.contextViewService, this.selectBoxStyles(), {
			ariaLabel,
			useCustomDrawn: true,
		}));
		box.render(host);
		return box;
	}

	private inputBoxStyles() {
		return getInputBoxStyle({
			inputBackground: settingsTextInputBackground,
			inputForeground: settingsTextInputForeground,
			inputBorder: settingsTextInputBorder,
		});
	}

	private selectBoxStyles() {
		return getSelectBoxStyles({
			selectBackground: settingsSelectBackground,
			selectForeground: settingsSelectForeground,
			selectBorder: settingsSelectBorder,
			selectListBorder: settingsSelectListBorder,
		});
	}

	override async setInput(input: VoltSettingsEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.renderContent();
	}

	override layout(_dimension: Dimension): void {
		this.scheduleScrollSync();
	}
}

function describeUpdateState(state: UpdateState): string {
	switch (state.type) {
		case StateType.Disabled:
			return state.reason === DisablementReason.NotBuilt
				? localize('voltSettings.updatesDev', "Updates are off in development builds.")
				: localize('voltSettings.updatesOff', "Updates are turned off.");
		case StateType.CheckingForUpdates: return localize('voltSettings.updatesChecking', "Checking…");
		case StateType.AvailableForDownload: return localize('voltSettings.updatesAvailable', "{0} is available.", state.update.productVersion ?? '');
		case StateType.Downloading: return localize('voltSettings.updatesDownloading', "Downloading…");
		case StateType.Downloaded:
		case StateType.Updating: return localize('voltSettings.updatesInstalling', "Installing…");
		case StateType.Ready: return localize('voltSettings.updatesReady', "Restart to update to {0}.", state.update.productVersion ?? '');
		case StateType.Idle: return state.error ? localize('voltSettings.updatesError', "The last check failed.") : '';
		default: return '';
	}
}

/** The status line under Lid-Closed Mode: whether it can hold, whether it holds now, and what went wrong. */
function describeLidClosedMode(state: IAwakeState | undefined): string {
	if (!state) {
		return localize('voltSettings.lidChecking', "Checking this computer…");
	}
	const parts: string[] = [];
	switch (state.lid.kind) {
		case 'ready':
			parts.push(state.tier === 'lid'
				? localize('voltSettings.lidOn', "On now: agents are working, so closing the lid won't put the computer to sleep.")
				: localize('voltSettings.lidReady', "Ready. It turns on by itself whenever agents are working."));
			break;
		case 'needsSetup':
		case 'foreign':
			parts.push(state.lid.detail);
			break;
		case 'unsupported':
			parts.push(localize('voltSettings.lidUnsupported', "Not available: {0}", state.lid.detail));
			break;
		case 'checking':
			parts.push(localize('voltSettings.lidChecking', "Checking this computer…"));
			break;
	}
	if (state.blockedBy === 'battery') {
		parts.push(localize('voltSettings.lidBattery', "Paused: the battery is low."));
	} else if (state.blockedBy === 'thermal') {
		parts.push(localize('voltSettings.lidThermal', "Paused: the computer is too hot."));
	} else if (state.blockedBy === 'cap') {
		parts.push(localize('voltSettings.lidCap', "Paused: agents hit the time limit."));
	}
	if (state.lastError) {
		parts.push(localize('voltSettings.lidLastError', "Last problem: {0}", state.lastError));
	}
	return parts.join(' ');
}
