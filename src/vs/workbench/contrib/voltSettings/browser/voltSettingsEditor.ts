/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltSettings.css';
import '../../voltAgent/browser/media/agentEditor.css';
import { $, addDisposableListener, append, Dimension, getWindow, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
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
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { AWAKE_LID_CLOSED_MODE_SETTING, AWAKE_WHILE_AGENTS_WORK_SETTING, IAwakeState, IVoltAwakeService, readAwakePrefs } from '../../../../platform/voltAwake/common/voltAwake.js';
import { DisablementReason, IUpdateService, State as UpdateState, StateType } from '../../../../platform/update/common/update.js';
import { VOLT_RELEASE_CHANNEL_SETTING } from '../../../../platform/update/common/voltUpdateFeed.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { getInputBoxStyle } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { Orientation, Sash } from '../../../../base/browser/ui/sash/sash.js';
import { getLayoutMode } from '../../../browser/parts/titlebar/layoutModeSwitch.js';
import { settingsTextInputBackground, settingsTextInputBorder, settingsTextInputForeground } from '../../preferences/common/settingsEditorColorRegistry.js';
import { ACCESS_MODE_OPTIONS, accessModeOption } from '../../../services/voltRuntime/common/access/accessModes.js';
import { IPermissionRule } from '../../../services/voltRuntime/common/access/accessTypes.js';
import { VOLT_MODES, VoltMode, modePolicy } from '../../../services/voltRuntime/common/modes.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { IPredictionSettings, IVoltPredictionService } from '../../../services/voltRuntime/common/prediction.js';
import { IWorkbenchThemeService, ThemeSettings } from '../../../services/themes/common/workbenchThemeService.js';
import { AGENT_DEFAULT_MODEL_SETTING, AGENT_NEW_CHAT_DRAFT_SETTING, AGENT_PROMPT_HISTORY_SETTING, AGENT_VOICE_DEFAULT_REALTIME_MODEL, AGENT_VOICE_ENDPOINT_SETTING, AGENT_VOICE_ENGINE_SETTING, AGENT_VOICE_MODEL_SETTING, AGENT_VOICE_REALTIME_MODEL_SETTING, AGENT_VOICE_REALTIME_MODELS, AgentVoiceEngine } from '../../voltAgent/common/agentComposerSettings.js';
import { AGENT_AUTO_RESUME_AFTER_LIMIT_SETTING, AGENT_COMPACT_OLD_THREADS_SETTING, AGENT_KEEP_WORKING_SETTING, AGENT_RESUME_AFTER_RESTART_SETTING } from '../../voltAgent/common/agentWorkflowSettings.js';
import { AGENT_HOME_AUTO_SETTLE_DAYS_SETTING, AGENT_HOME_WORKING_SECTION_SETTING } from '../../voltAgent/common/agentHomeSettings.js';
import '../../voltAgent/common/agentAwakeSettings.js';

/** Settings on the Composer page whose rows redraw when they change. */
/** Settings on the Appearance page whose controls redraw when they change. */
const APPEARANCE_PAGE_SETTINGS = [ThemeSettings.DETECT_COLOR_SCHEME, ThemeSettings.PREFERRED_DARK_THEME, ThemeSettings.PREFERRED_LIGHT_THEME, ThemeSettings.FILE_ICON_THEME, 'editor.fontSize', 'editor.fontFamily', 'window.zoomLevel'];
const COMPOSER_PAGE_SETTINGS = [AGENT_PROMPT_HISTORY_SETTING, AGENT_NEW_CHAT_DRAFT_SETTING, AGENT_KEEP_WORKING_SETTING, AGENT_RESUME_AFTER_RESTART_SETTING, AGENT_AUTO_RESUME_AFTER_LIMIT_SETTING, AGENT_COMPACT_OLD_THREADS_SETTING, AGENT_HOME_WORKING_SECTION_SETTING, AGENT_HOME_AUTO_SETTLE_DAYS_SETTING];
import { AgentModelPicker, type IModelOption, type IProviderGroup } from '../../voltAgent/browser/picker/agentModelPicker.js';
import { appendSettingsBlock, SettingsStickyHeads } from './settingsStickyHeads.js';
import { VoltSettingsEditorInput } from './voltSettingsEditorInput.js';
import { renderProjectsSection, renderStorageSection } from '../../voltSetup/browser/settingsSections.js';
import { clampWorktreeMaxCount, clampWorktreeMaxSizeGB, WORKTREE_MAX_COUNT_SETTING, WORKTREE_MAX_SIZE_GB_SETTING } from '../../voltSetup/common/worktreeLimits.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { AppearancePage, ISettingsPageKit } from './appearancePage.js';
import { CodeIntelligencePage } from './codeIntelligencePage.js';
import { GitPage } from './gitPage.js';
import { ProvidersPage } from './providersPage.js';
import { ConnectedAgentsPage } from './connectedAgentsPage.js';
import { createSettingsIcon } from './settingsIcons.js';
import { AgentUsagePage } from '../../voltAgent/browser/usage/agentUsagePage.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { createAccessIcon } from '../../voltAgent/browser/chrome/accessIcons.js';
import { createVoltDropdown, IVoltDropdownOption } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { createAgentHeaderSeparatorIcon } from '../../voltAgent/browser/chrome/agentTitlebarHeader.js';
import { AgentFooterAction, appendAgentFooterActions } from '../../voltAgent/browser/home/agentHomeFooterActions.js';
import { AgentCustomizeEditor, AgentCustomizeEditorInput } from '../../voltAgent/browser/customize/agentCustomizeEditor.js';

/** The Tab page's on/off settings. */
type TabToggle = 'enabled' | 'partialAccepts' | 'inComments' | 'whitespaceOnly' | 'autoImport' | 'autoImportPython';

type SettingsSection = 'general' | 'appearance' | 'usage' | 'providers' | 'modes' | 'composer' | 'tab' | 'codeIntelligence' | 'beta' | 'security' | 'connected' | 'projects' | 'git' | 'worktrees' | 'storage' | 'customize';

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
	{ id: 'codeIntelligence', label: localize('voltSettings.codeIntelligence', "Code Intelligence"), icon: Codicon.database, group: 1 },
	{ id: 'beta', label: localize('voltSettings.betaPage', "Beta"), icon: Codicon.beaker, group: 1 },
	{ id: 'security', label: localize('voltSettings.security', "Security"), icon: Codicon.shield, group: 2 },
	{ id: 'connected', label: localize('voltSettings.connectedAgents', "Connected agents"), icon: Codicon.link, group: 2 },
	{ id: 'projects', label: localize('voltSettings.projects', "Projects"), icon: Codicon.repo, group: 2 },
	{ id: 'git', label: localize('voltSettings.git', "Git & PRs"), icon: Codicon.gitPullRequest, group: 2 },
	{ id: 'worktrees', label: localize('voltSettings.worktrees', "Worktrees"), icon: Codicon.repoForked, group: 2 },
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
	pullRequests: 'git',
	integrations: 'git',
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
	/**
	 * Skills & Plugins: the agent's Customize page, hosted in place of the settings pages so the
	 * nav stays. Made on first visit and kept, like Usage.
	 */
	private customizeHost!: HTMLElement;
	private customizePane: AgentCustomizeEditor | undefined;
	private sidebar!: HTMLElement;
	private crumb!: HTMLElement;
	private footerActions!: Record<AgentFooterAction, HTMLButtonElement>;
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
		const commandService = this.instantiationService.invokeFunction(accessor => accessor.get(ICommandService));

		// Back to the chat, above the search.
		const head = append(sidebar, $('.volt-settings-sidebar-head'));
		const back = append(head, $('button.volt-settings-back')) as HTMLButtonElement;
		back.type = 'button';
		back.appendChild(renderIcon(Codicon.arrowLeft));
		append(back, $('span')).textContent = localize('voltSettings.back', "Back");
		back.setAttribute('aria-label', localize('voltSettings.backToChat', "Close settings"));
		this._register(addDisposableListener(back, 'click', () => this.close()));

		const searchHost = append(sidebar, $('.volt-settings-search'));
		append(searchHost, $('span.volt-settings-search-icon')).appendChild(createSettingsIcon('search') ?? renderIcon(Codicon.search));
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
		// Skills, subagents, rules, MCP servers and plugins: the agent's Customize page, shown here with
		// the nav beside it. Same glyph as the Customize button in the agent list's footer.
		append(this.toc, $('.volt-settings-toc-gap'));
		const customize = append(this.toc, $('button.volt-settings-toc-item')) as HTMLButtonElement;
		customize.type = 'button';
		customize.dataset.section = 'customize';
		append(customize, $('span.volt-settings-toc-icon')).appendChild(renderIcon(Codicon.extensions));
		append(customize, $('span.volt-settings-toc-text')).textContent = localize('voltSettings.skillsPlugins', "Skills & Plugins");
		if (this.section === 'customize') {
			customize.classList.add('active');
		}
		this._register(addDisposableListener(customize, 'click', () => this.setSection('customize')));

		// The agent list's footer row, so Usage, Automations and Customize are a click away here too.
		const footer = append(sidebar, $('.volt-settings-footer'));
		this.footerActions = appendAgentFooterActions(footer, commandService, this._store);
		// Customize opens Skills & Plugins here instead of leaving Settings. A capture listener runs
		// before the footer's own click handler on the button, and stops it.
		this._register(addDisposableListener(this.footerActions.customize, 'click', e => {
			e.preventDefault();
			e.stopImmediatePropagation();
			this.footerActions.customize.blur();
			this.setSection('customize');
		}, true));

		// Where the page is, as the title bar puts it over a chat ("Settings / Usage"); the overlay covers that bar.
		const main = append(this.container, $('.volt-settings-main'));
		const topbar = append(main, $('.volt-settings-topbar'));
		append(topbar, $('span.volt-settings-crumb.root')).textContent = localize('voltSettings.title', "Settings");
		createAgentHeaderSeparatorIcon(append(topbar, $('span.volt-settings-crumb-sep')));
		this.crumb = append(topbar, $('span.volt-settings-crumb'));

		const scroll = $('.volt-settings-content');
		this.content = append(scroll, $('.volt-settings-content-inner'));
		this.contentScroll = this._register(new DomScrollableElement(scroll, {
			className: 'volt-settings-content-scroll',
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Auto,
			useShadows: false,
		}));
		append(main, this.contentScroll.getDomNode());
		this.customizeHost = append(main, $('.volt-settings-customize'));
		const customizeResize = new (getWindow(parent).ResizeObserver)(() => this.layoutCustomize());
		customizeResize.observe(this.customizeHost);
		this._register(toDisposable(() => customizeResize.disconnect()));
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
			store: this.renderStore,
			search: () => this.search,
			rerender: () => this.renderContent(),
			revealWorkbench: () => this.close(),
			switch: (parent, on, label, onClick) => this.switch(parent, on, label, onClick),
			inputBoxStyles: () => this.inputBoxStyles(),
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
		this.syncCrumb();
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
			if (this.section === 'customize') {
				this.showCustomize();
			}
			this.scheduleScrollSync();
			return;
		}
		this.usage?.setVisible(false);
		this.customizePane?.setVisible(false);
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
		if (id === 'customize') {
			this.setSection('customize');
			return;
		}
		const known = SECTIONS.find(candidate => candidate.id === id);
		if (known) {
			this.setSection(known.id);
		}
	}

	/** The top bar's section name, and which footer icon is lit (Usage on Usage, else Settings). */
	private syncCrumb(): void {
		this.crumb.textContent = this.section === 'customize'
			? localize('voltSettings.skillsPlugins', "Skills & Plugins")
			: SECTIONS.find(entry => entry.id === this.section)?.label ?? '';
		this.footerActions.settings.classList.toggle('active', this.section !== 'usage' && this.section !== 'customize');
		this.footerActions.usage.classList.toggle('active', this.section === 'usage');
		this.footerActions.customize.classList.toggle('active', this.section === 'customize');
	}

	private setSection(section: SettingsSection): void {
		this.section = section;
		if (section === 'providers') {
			void this.providers.checkSetup(true);
		}
		for (const child of this.toc.querySelectorAll('.volt-settings-toc-item')) {
			child.classList.toggle('active', (child as HTMLElement).dataset.section === section);
		}
		this.syncCrumb();
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
		// Providers & Models is two panes side by side and Usage draws wide charts; they take the room
		// the other pages leave. Every other page is one centered column.
		this.content.classList.toggle('volt-settings-content-wide', this.section === 'providers');
		this.content.classList.toggle('volt-settings-content-narrow', this.section !== 'providers' && this.section !== 'usage');
		this.block = undefined;
		this.renderGeneration++;
		const generation = this.renderGeneration;
		let pending: Promise<unknown> | undefined;
		if (this.section !== 'usage') {
			this.usage?.setVisible(false);
		}
		// Skills & Plugins has its own search, header and scrolling: it takes the page area itself.
		this.container.classList.toggle('volt-settings-customize-open', this.section === 'customize');
		if (this.section !== 'customize') {
			this.customizePane?.setVisible(false);
		}
		switch (this.section) {
			case 'customize':
				this.showCustomize();
				break;
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
			case 'codeIntelligence':
				this.renderCodeIntelligence();
				break;
			case 'beta':
				this.renderBeta();
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
			case 'git':
				this.renderGit();
				break;
			case 'worktrees':
				this.renderWorktrees();
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

	/** Shows the hosted Customize page, making it on first visit. */
	private showCustomize(): void {
		if (!this.isVisible()) {
			return;
		}
		let pane = this.customizePane;
		if (!pane) {
			pane = this.customizePane = this._register(this.instantiationService.createInstance(AgentCustomizeEditor, this.group));
			pane.create(this.customizeHost);
			pane.setVisible(true);
			const input = this._register(new AgentCustomizeEditorInput());
			void pane.setInput(input, undefined, {}, CancellationToken.None).then(() => this.layoutCustomize());
		} else {
			pane.setVisible(true);
		}
		this.layoutCustomize();
	}

	private layoutCustomize(): void {
		const host = this.customizeHost;
		if (this.customizePane && this.section === 'customize' && host.isConnected && host.clientWidth && host.clientHeight) {
			this.customizePane.layout(new Dimension(host.clientWidth, host.clientHeight));
		}
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
		if (unit) {
			append(parent, $('.volt-settings-stepper-unit')).textContent = unit;
		}
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

		this.sectionLabel(localize('voltSettings.predictionAndVoice', "Prediction and voice"));
		const assist = this.settingsGroup();
		this.predictionModelRow(assist);
		this.voiceModelRow(assist);
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
			prefs.maxHours > 0
				? localize('voltSettings.lidClosedModeDesc', "Agents keep working when you close the laptop lid. The computer can sleep again once they finish, below {0}% battery, if it gets too hot, or after {1} hours. Use it on a hard, ventilated surface, never in a bag.", prefs.batteryFloorPercent, prefs.maxHours)
				: localize('voltSettings.lidClosedModeNoCapDesc', "Agents keep working when you close the laptop lid, for as long as their work takes. The computer can sleep again once they finish, below {0}% battery, or if it gets too hot. Use it on a hard, ventilated surface, never in a bag.", prefs.batteryFloorPercent),
		);
		if (prefs.lidClosedMode) {
			const state = this.awakeState;
			this.settingRow(group, localize('voltSettings.lidClosedModeStatus', "Status"), describeLidClosedMode(state), host => {
				const action = (label: string, secondary: boolean, run: () => Promise<unknown>) => {
					const button = this.renderStore.add(createVoltButton(host, secondary ? 'secondary' : 'primary'));
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

	/** Full access · Auto · Accept edits · Supervised, picked like the composer's access menu. */
	private accessModeControl(host: HTMLElement): void {
		this.dropdown(host, ACCESS_MODE_OPTIONS.map(option => ({
			id: option.id,
			label: option.label,
			description: option.description,
			icon: () => createAccessIcon(option.id),
			danger: option.id === 'full-access',
		})), this.runtime.getAccessMode(), localize('voltSettings.accessMode', "Default access"), mode => void this.runtime.setAccessMode(mode), 340);
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

		const kit = this.settingsKit();
		this.appearance.renderAgentConversations(kit);
		this.appearance.renderColors(kit);
		this.appearance.renderTypography(kit);
		this.appearance.renderHighContrast(kit);
		this.appearance.renderMotion(kit);

		this.sectionLabel(localize('voltSettings.icons', "Icons"));
		this.settingRow(
			this.settingsGroup(),
			localize('voltSettings.fileIcons', "File icons"),
			localize('voltSettings.fileIconsDesc', "Icons next to files in the explorer, changes and tabs."),
			host => {
				void this.workbenchThemeService.getFileIconThemes().then(themes => {
					if (generation !== this.renderGeneration) {
						return;
					}
					// '' is None: setFileIconTheme takes undefined for it.
					const options = [{ id: '', label: localize('voltSettings.noFileIcons', "None") }, ...themes.map(theme => ({ id: theme.settingsId ?? '', label: theme.label }))];
					const current = this.workbenchThemeService.getFileIconTheme().settingsId ?? '';
					this.dropdown(host, options, current, localize('voltSettings.fileIcons', "File icons"), id => void this.workbenchThemeService.setFileIconTheme(id || undefined, 'auto'));
				});
			},
		);
		return galleryReady;
	}

	/** The row helpers the Appearance page's sections draw with. */
	private settingsKit(): ISettingsPageKit {
		return {
			sectionLabel: label => this.sectionLabel(label),
			settingsGroup: () => this.settingsGroup(),
			settingRow: (parent, title, desc, renderControl) => this.settingRow(parent, title, desc, renderControl),
			stepper: (parent, valueText, unit, onCommit, step) => this.stepper(parent, valueText, unit, onCommit, step),
		};
	}

	/** Version and a manual update check. The release channel lives on the Beta page. */
	private renderUpdates(): void {
		const { product, updates } = this.instantiationService.invokeFunction(accessor => ({ product: accessor.get(IProductService), updates: accessor.get(IUpdateService) }));
		this.sectionLabel(localize('voltSettings.updates', "Updates"));
		const group = this.settingsGroup();

		const version = product.voltVersion ?? product.version;
		const build = [product.quality, product.commit?.slice(0, 8)].filter(Boolean).join(' · ');
		this.settingRow(
			group,
			localize('voltSettings.version', "{0} {1}", product.nameLong, version),
			build || localize('voltSettings.devBuild', "Development build"),
			host => {
				host.classList.add('volt-settings-update-control');
				const status = append(host, $('span.volt-settings-update-status'));
				const check = this.renderStore.add(createVoltButton(host));
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

	/** Pre-release access: which release channel's updates this app offers. */
	private renderBeta(): void {
		this.pageHead(localize('voltSettings.betaPage', "Beta"));
		const group = this.settingsGroup();
		const channels = [
			{ id: 'default', label: localize('voltSettings.channelDefault', "Default") },
			{ id: 'stable', label: localize('voltSettings.channelStable', "Stable") },
			{ id: 'beta', label: localize('voltSettings.channelBeta', "Beta") },
			{ id: 'nightly', label: localize('voltSettings.channelNightly', "Nightly") },
		];
		this.settingRow(
			group,
			localize('voltSettings.updateAccess', "Update Access"),
			localize('voltSettings.updateAccessDesc2', "By default, this app keeps itself up to date. Another channel installs from the update button as its own app beside this one, with its own settings, and updates itself. Beta and Nightly are pre-release builds that may be unstable for production work."),
			host => {
				const current = this.configurationService.getValue<string>(VOLT_RELEASE_CHANNEL_SETTING);
				const value = channels.find(c => c.id === current)?.id ?? channels[0].id;
				this.dropdown(host, channels, value, localize('voltSettings.updateAccess', "Update Access"), id => void this.configurationService.updateValue(VOLT_RELEASE_CHANNEL_SETTING, id));
			},
		);
	}

	/** Ghost text's model, chosen like the text generation model. Auto takes the composer's fastest. */
	private predictionModelRow(group: HTMLElement): void {
		this.settingRow(
			group,
			localize('voltSettings.predictionModel', "Prediction model"),
			localize('voltSettings.predictionModelDesc2', "Writes the ghost text in editors and in the agent composer, and cleans up dictation. Auto uses the fastest model of the composer's provider (Opus -> Haiku on the same Claude login). An agent answers through one session that starts with Volt; API and local models (Ollama) answer faster still."),
			host => this.textGenerationPicker(host, 'tab', localize('voltSettings.predictionModel', "Prediction model"), localize('voltSettings.predictionAuto', "Auto"), localize('voltSettings.predictionAutoDesc', "The fastest model of the composer's provider")),
		);
	}

	/** Where dictation is transcribed, and with which model. Picked like the prediction model. */
	private voiceModelRow(group: HTMLElement): void {
		const label = localize('voltSettings.voiceModel', "Voice model");
		this.settingRow(
			group,
			label,
			localize('voltSettings.voiceModelDesc', "Transcribes dictation in the agent composer. Auto streams to OpenAI when an OpenAI key is set, otherwise uses the Mac's recognizer. A custom endpoint is any OpenAI-compatible speech-to-text server, such as a local Whisper."),
			host => this.modelPicker(host, {
				get: () => {
					const engine = (this.configurationService.getValue<string>(AGENT_VOICE_ENGINE_SETTING) || 'auto') as AgentVoiceEngine;
					if (engine === 'auto') {
						return undefined;
					}
					return engine === 'openai' ? `openai:${this.configurationService.getValue<string>(AGENT_VOICE_REALTIME_MODEL_SETTING) || AGENT_VOICE_DEFAULT_REALTIME_MODEL}` : engine;
				},
				set: ref => {
					if (ref?.startsWith('openai:')) {
						void this.configurationService.updateValue(AGENT_VOICE_REALTIME_MODEL_SETTING, ref.slice('openai:'.length));
					}
					const engine: AgentVoiceEngine = !ref ? 'auto' : ref.startsWith('openai:') ? 'openai' : ref as AgentVoiceEngine;
					void this.configurationService.updateValue(AGENT_VOICE_ENGINE_SETTING, engine);
				},
			}, label, localize('voltSettings.voiceAuto', "Auto"), localize('voltSettings.voiceAutoDesc2', "OpenAI with a key, else the Mac"), () => this.voiceModelGroups()),
		);
	}

	/** The voice picker's tabs: OpenAI realtime models, the Mac's recognizer, a custom endpoint. Auto sits under Favorites. */
	private voiceModelGroups(): IProviderGroup[] {
		const realtime = this.configurationService.getValue<string>(AGENT_VOICE_REALTIME_MODEL_SETTING) || AGENT_VOICE_DEFAULT_REALTIME_MODEL;
		const endpointModel = this.configurationService.getValue<string>(AGENT_VOICE_MODEL_SETTING) || 'whisper-1';
		const realtimeModels = AGENT_VOICE_REALTIME_MODELS.includes(realtime) ? AGENT_VOICE_REALTIME_MODELS : [...AGENT_VOICE_REALTIME_MODELS, realtime];
		const option = (ref: string, name: string, family: string, qualifier: string, description: string): IModelOption => ({
			ref, name, qualifier, providerId: family, family, description, optionDescriptors: [], contextWindow: 0,
		});
		const openAi = localize('voltSettings.voiceOpenAiGroup', "OpenAI");
		const mac = localize('voltSettings.voiceMacGroup', "Mac");
		const endpoint = localize('voltSettings.voiceEndpointGroup', "Custom endpoint");
		return [
			{
				family: 'codex', label: openAi, models: realtimeModels.map(model => option(`openai:${model}`, model, 'codex', openAi,
					localize('voltSettings.voiceOpenAiDesc', "Streams to OpenAI's realtime transcription. Needs an OpenAI key."))),
			},
			{
				family: 'local', label: mac, models: [option('system', localize('voltSettings.voiceSystem', "Mac speech recognizer"), 'local', mac,
					localize('voltSettings.voiceSystemDesc', "Apple's on-device speech recognition. No key needed."))],
			},
			{
				// A server glyph: the generic brand's sparkle reads as Auto.
				family: 'generic', label: endpoint, icon: () => renderIcon(Codicon.server), models: [option('endpoint', endpointModel, 'generic', endpoint,
					localize('voltSettings.voiceEndpointOptionDesc2', "The OpenAI-compatible speech-to-text server set under Tab & Prediction > Voice, such as a local Whisper."))],
			},
		];
	}

	/** The composer's model picker, bound to a generated-text slot instead of the composer's model. */
	private textGenerationPicker(host: HTMLElement, slot: 'title' | 'git' | 'tab', ariaLabel: string, autoLabel: string, autoDescription: string): void {
		this.modelPicker(host, {
			get: () => this.runtime.getTaskModels()[slot],
			set: ref => void this.runtime.setTaskModel(slot, ref),
		}, ariaLabel, autoLabel, autoDescription);
	}

	/** The composer's model picker, bound to a setting instead of the composer's model. */
	private modelPicker(host: HTMLElement, binding: { get(): string | undefined; set(ref: string | undefined): void }, ariaLabel: string, autoLabel: string, autoDescription: string, models?: () => IProviderGroup[]): void {
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
			models,
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
		this.settingSwitch(
			workflow,
			AGENT_KEEP_WORKING_SETTING,
			localize('voltSettings.keepWorking', "Keep working until done"),
			localize('voltSettings.keepWorkingDesc', "When a chat's work stops part way (an error, a crashed or silent agent, Volt restarting), Volt restarts it on its own, waiting longer each time (at most 30 minutes), for as long as it takes. A turn that ends with its plan unfinished keeps going. Stop the chat to end it."),
		);
		const resumeOptions: IVoltDropdownOption<string>[] = [
			{ id: 'subagents', label: localize('voltSettings.resumeSubagents', "Delegated tasks"), description: localize('voltSettings.resumeSubagentsDesc', "Only subagents and delegated tasks"), icon: Codicon.typeHierarchySub },
			{ id: 'all', label: localize('voltSettings.resumeAll', "Every chat"), description: localize('voltSettings.resumeAllDesc', "Every interrupted run carries on"), icon: Codicon.commentDiscussion },
			{ id: 'off', label: localize('voltSettings.resumeOff', "Nothing"), description: localize('voltSettings.resumeOffDesc', "Every interrupted run waits for Resume"), icon: Codicon.circleSlash },
		];
		const resume = this.configurationService.getValue<string>(AGENT_RESUME_AFTER_RESTART_SETTING);
		this.settingRow(
			workflow,
			localize('voltSettings.resumeAfterRestart', "Continue after a restart"),
			localize('voltSettings.resumeAfterRestartDesc', "What keeps working on its own when Volt restarts in the middle of a run. Everything else shows Resume."),
			host => {
				this.dropdown(host, resumeOptions, resume, localize('voltSettings.resumeAfterRestart', "Continue after a restart"), id => void this.configurationService.updateValue(AGENT_RESUME_AFTER_RESTART_SETTING, id), 280);
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
		const settleOptions: IVoltDropdownOption<string>[] = [0, 1, 3, 7, 14].map(days => ({
			id: String(days),
			label: days === 0 ? localize('voltSettings.settleNever', "Never") : days === 1 ? localize('voltSettings.settleDay', "After 1 day") : localize('voltSettings.settleDays', "After {0} days", days),
		}));
		const settleDays = String(this.configurationService.getValue<number>(AGENT_HOME_AUTO_SETTLE_DAYS_SETTING) ?? 3);
		this.settingRow(
			workflow,
			localize('voltSettings.autoSettle', "Settle idle chats"),
			localize('voltSettings.autoSettleDesc', "Move a chat to Settled after it goes this long without a message from you. Each chat's Auto-settle switch can keep it out."),
			host => {
				this.dropdown(host, settleOptions, settleDays, localize('voltSettings.autoSettle', "Settle idle chats"), days => void this.configurationService.updateValue(AGENT_HOME_AUTO_SETTLE_DAYS_SETTING, Number(days)));
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

	/** Instant grep's code index and the language servers agents use (codeIntelligencePage.ts). */
	private renderCodeIntelligence(): void {
		this.instantiationService.createInstance(CodeIntelligencePage, {
			store: this.renderStore,
			pageHead: (title, lead) => void this.pageHead(title, lead),
			sectionLabel: label => this.sectionLabel(label),
			settingsGroup: () => this.settingsGroup(),
			settingRow: (parent, title, desc, renderControl) => this.settingRow(parent, title, desc, renderControl),
			toggle: (parent, on, label, onClick) => void this.switch(parent, on, label, onClick),
			stepper: (parent, valueText, unit, onCommit, step) => this.stepper(parent, valueText, unit, onCommit, step),
			rerender: () => this.renderContent(),
			isCurrent: () => this.section === 'codeIntelligence',
		}).render();
	}

	/** Pull request links and reviews, attribution, branch names and code hosts (gitPage.ts). */
	private renderGit(): void {
		this.instantiationService.createInstance(GitPage, {
			store: this.renderStore,
			pageHead: (title, lead) => void this.pageHead(title, lead),
			sectionLabel: label => this.sectionLabel(label),
			sectionHint: text => void (append(this.target, $('.volt-settings-section-hint')).textContent = text),
			settingsGroup: () => this.settingsGroup(),
			settingRow: (parent, title, desc, renderControl) => this.settingRow(parent, title, desc, renderControl),
			toggle: (parent, on, label, onClick) => void this.switch(parent, on, label, onClick),
			stepper: (parent, valueText, unit, onCommit, step) => this.stepper(parent, valueText, unit, onCommit, step),
			select: (parent, options, selected, label, onSelect) => {
				const choices = options.map((text, index) => ({ id: String(index), label: text }));
				this.dropdown(parent, choices, String(Math.max(0, selected)), label, id => onSelect(Number(id)));
			},
			input: (parent, value, placeholder, label, onCommit) => {
				const box = this.renderStore.add(new InputBox(append(parent, $('.volt-settings-input')), this.contextViewService, {
					placeholder,
					ariaLabel: label,
					inputBoxStyles: this.inputBoxStyles(),
				}));
				box.value = value;
				this.renderStore.add(addDisposableListener(box.inputElement, 'change', () => onCommit(box.value)));
			},
			rerender: () => this.renderContent(),
			isCurrent: () => this.section === 'git',
		}).render();
	}

	/** An (i) after a row's title with more about it on hover. */
	private titleInfo(row: HTMLElement, text: string): void {
		const label = row.querySelector('label');
		if (label) {
			const info = append(label, $('span.volt-settings-title-info'));
			info.appendChild(renderIcon(Codicon.info));
			setAgentTooltip(info, text);
		}
	}

	/** A small tag after a row's title, such as BETA. */
	private titleBadge(row: HTMLElement, text: string): void {
		const label = row.querySelector('label');
		if (label) {
			append(label, $('span.volt-settings-title-badge')).textContent = text;
		}
	}

	private renderTab(): void {
		this.pageHead(
			localize('voltSettings.tab', "Tab & Prediction"),
			localize('voltSettings.tabLead2', "Ghost text wherever you type: code in any editor, the next words in the agent composer. Tab accepts."),
		);
		const settings = this.prediction.getSettings();

		// Cursor's Tab page: one switch per behavior, then the files Tab stays out of.
		const tab = this.settingsGroup();
		const toggle = (key: TabToggle, title: string, desc: string) => this.settingRow(tab, title, desc, host => this.switch(host, settings[key], title, () => {
			const update: Partial<IPredictionSettings> = {};
			update[key] = !settings[key];
			this.prediction.updateSettings(update);
			this.renderContent();
		}));
		toggle('enabled', localize('voltSettings.voltTab', "Volt Tab"), localize('voltSettings.voltTabDesc', "Context-aware, multi-line suggestions around your cursor based on recent edits"));
		const partial = toggle('partialAccepts', localize('voltSettings.partialAccepts', "Partial Accepts"), localize('voltSettings.partialAcceptsDesc', "Accept the next word of a suggestion via {0}", isMacintosh ? '\u2318\u2192' : 'Ctrl+\u2192'));
		this.titleInfo(partial, localize('voltSettings.partialAcceptsInfo', "Each press takes one more word of the suggestion; Tab still takes all of it. Off, the key moves the cursor as usual."));
		toggle('inComments', localize('voltSettings.tabInComments', "Suggestions While Commenting"), localize('voltSettings.tabInCommentsDesc', "Allow Tab to trigger while in a comment region"));
		toggle('whitespaceOnly', localize('voltSettings.tabWhitespace', "Whitespace-Only Suggestions"), localize('voltSettings.tabWhitespaceDesc', "Suggest edits like new lines and indentation that modify whitespace only"));
		toggle('autoImport', localize('voltSettings.tabImports', "Imports"), localize('voltSettings.tabImportsDesc', "Automatically import necessary modules for TypeScript"));
		const python = toggle('autoImportPython', localize('voltSettings.tabPythonImports', "Auto Import for Python"), localize('voltSettings.tabPythonImportsDesc', "Enable auto import for Python. This is a beta feature."));
		this.titleBadge(python, localize('voltSettings.beta', "BETA"));
		this.settingRow(
			tab,
			localize('voltSettings.tabIgnoredFiles', "Ignored Files"),
			localize('voltSettings.tabIgnoredFilesDesc', "Glob patterns for files where Volt Tab will not suggest"),
			host => {
				const globInput = this.renderStore.add(new InputBox(append(host, $('.volt-settings-input.wide')), this.contextViewService, {
					placeholder: localize('voltSettings.tabIgnoredFilesPlaceholder', "e.g., *.md, **/generated/**"),
					ariaLabel: localize('voltSettings.tabIgnoredFiles', "Ignored Files"),
					inputBoxStyles: this.inputBoxStyles(),
				}));
				globInput.value = settings.disabledGlobs.join(', ');
				this.renderStore.add(addDisposableListener(globInput.inputElement, 'change', () => {
					this.prediction.updateSettings({ disabledGlobs: globInput.value.split(',').map(glob => glob.trim()).filter(Boolean) });
				}));
			},
		);

		this.sectionLabel(localize('voltSettings.editorPrediction', "Editors"));
		const editors = this.settingsGroup();
		this.predictionModelRow(editors);
		const modeOptions: IVoltDropdownOption<'eager' | 'subtle'>[] = [
			{ id: 'eager', label: localize('voltSettings.tabEager', "Eager") },
			{ id: 'subtle', label: localize('voltSettings.tabSubtle', "Subtle") },
		];
		this.settingRow(
			editors,
			localize('voltSettings.tabMode', "Prediction mode"),
			localize('voltSettings.tabModeDesc', "Eager predicts while you type. Subtle only predicts on the explicit trigger (Alt+\\)."),
			host => this.dropdown(host, modeOptions, settings.mode === 'subtle' ? 'subtle' : 'eager', localize('voltSettings.tabMode', "Prediction mode"), mode => this.prediction.updateSettings({ mode })),
		);
		this.settingRow(
			editors,
			localize('voltSettings.tabDebounce', "Debounce"),
			localize('voltSettings.tabDebounceDesc', "Extra wait before a model request is sent. Lower is snappier; higher saves tokens while typing fast."),
			host => this.stepper(host, String(settings.debounceMs), localize('voltSettings.ms', "ms"), ms => {
				const clamped = Math.max(0, Math.min(2000, Math.round(ms)));
				this.prediction.updateSettings({ debounceMs: clamped });
				return clamped;
			}, 25),
		);

		this.sectionLabel(localize('voltSettings.composerPrediction', "Agent composer"));
		const composer = this.settingsGroup();
		this.settingRow(
			composer,
			localize('voltSettings.composerGhost', "Predict the message"),
			localize('voltSettings.composerGhostDesc', "While you type to the agent: the rest of the word and the next words from your own prompts at once, then the rest of the sentence from the prediction model, which reads the chat and the clipboard."),
			host => this.switch(host, settings.composer, localize('voltSettings.composerGhost', "Predict the message"), () => {
				this.prediction.updateSettings({ composer: !settings.composer });
				this.renderContent();
			}),
		);
		this.settingRow(
			composer,
			localize('voltSettings.composerPause', "Pause before the model"),
			localize('voltSettings.composerPauseDesc', "How long the typing stops before the prediction model is asked to finish the sentence. Suggestions from your prompts never wait."),
			host => this.stepper(host, String(settings.composerDelayMs), localize('voltSettings.ms', "ms"), ms => {
				const clamped = Math.max(0, Math.min(5000, Math.round(ms)));
				this.prediction.updateSettings({ composerDelayMs: clamped });
				return clamped;
			}, 100),
		);

		this.sectionLabel(localize('voltSettings.voice', "Voice"));
		const voice = this.settingsGroup();
		this.voiceModelRow(voice);
		this.settingRow(
			voice,
			localize('voltSettings.voiceCleanup', "Clean up dictation"),
			localize('voltSettings.voiceCleanupDesc', "The prediction model fixes punctuation, misheard names and spoken code ('agent editor dot ts' -> agentEditor.ts) and drops filler words before the text goes in. When it takes more than a few seconds, the text goes in as heard."),
			host => this.switch(host, settings.voice, localize('voltSettings.voiceCleanup', "Clean up dictation"), () => {
				this.prediction.updateSettings({ voice: !settings.voice });
				this.renderContent();
			}),
		);
		this.textSettingRow(voice, AGENT_VOICE_ENDPOINT_SETTING, localize('voltSettings.voiceEndpoint', "Transcription endpoint"), localize('voltSettings.voiceEndpointDesc', "Base URL of an OpenAI-compatible speech-to-text server for the custom endpoint, such as http://localhost:8000/v1."));
		this.textSettingRow(voice, AGENT_VOICE_MODEL_SETTING, localize('voltSettings.voiceEndpointModel', "Endpoint model"), localize('voltSettings.voiceEndpointModelDesc', "The model name the custom endpoint takes, such as whisper-1."));
	}

	/** A text input bound to a string setting, saved when it changes. */
	private textSettingRow(group: HTMLElement, key: string, title: string, desc: string): void {
		this.settingRow(group, title, desc, host => {
			const input = this.renderStore.add(new InputBox(append(host, $('.volt-settings-input.wide')), this.contextViewService, {
				ariaLabel: title,
				inputBoxStyles: this.inputBoxStyles(),
			}));
			input.value = this.configurationService.getValue<string>(key) ?? '';
			this.renderStore.add(addDisposableListener(input.inputElement, 'change', () => {
				void this.configurationService.updateValue(key, input.value.trim());
			}));
		});
	}

	/** Cleanup limits for the checkouts in ~/.volt/worktrees, as Cursor's Worktrees settings. */
	private renderWorktrees(): void {
		this.pageHead(
			localize('voltSettings.worktrees', "Worktrees"),
			localize('voltSettings.worktreesLead', "Checkouts Volt makes in ~/.volt/worktrees for chats that run in a new worktree."),
		);
		this.sectionLabel(localize('voltSettings.worktreesCleanup', "Cleanup"));
		append(this.target, $('.volt-settings-section-hint')).textContent = localize('voltSettings.worktreesCleanupHint', "Volt periodically removes old worktrees to free disk space. Tune how aggressively cleanup runs. Worktrees with uncommitted changes or a running agent are never removed, and a chat gets its worktree back from its branch on the next message.");
		const cleanup = this.settingsGroup();
		this.settingRow(
			cleanup,
			localize('voltSettings.maxWorktrees', "Max Worktrees"),
			localize('voltSettings.maxWorktreesDesc', "Maximum number of Volt-managed worktrees to retain across all projects. Older worktrees are removed first."),
			host => this.stepper(host, String(clampWorktreeMaxCount(this.configurationService.getValue(WORKTREE_MAX_COUNT_SETTING))), '', count => {
				const next = clampWorktreeMaxCount(count);
				void this.configurationService.updateValue(WORKTREE_MAX_COUNT_SETTING, next);
				return next;
			}, 1),
		);
		this.settingRow(
			cleanup,
			localize('voltSettings.maxWorktreeSize', "Max Total Size (GB)"),
			localize('voltSettings.maxWorktreeSizeDesc', "Maximum total size in GB across all Volt-managed worktrees. Set to 0 to disable the size limit."),
			host => this.stepper(host, String(clampWorktreeMaxSizeGB(this.configurationService.getValue(WORKTREE_MAX_SIZE_GB_SETTING))), '', gb => {
				const next = clampWorktreeMaxSizeGB(gb);
				void this.configurationService.updateValue(WORKTREE_MAX_SIZE_GB_SETTING, next);
				return next;
			}, 5),
		);

		this.sectionLabel(localize('voltSettings.managedWorktrees', "Volt-Managed Worktrees"));
		this.settingRow(
			this.settingsGroup(),
			localize('voltSettings.worktreeStorage', "Disk use"),
			localize('voltSettings.worktreeStorageDesc', "See each worktree's size, which chat it belongs to, and clean up now."),
			host => {
				const open = this.renderStore.add(createVoltButton(host, 'secondary'));
				open.label = localize('voltSettings.openStorage', "Open Storage");
				this.renderStore.add(open.onDidClick(() => this.setSection('storage')));
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
				const revoke = this.renderStore.add(createVoltButton(row, 'danger'));
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
		this.dropdown(append(effectHost, $('.volt-settings-control')), [
			{ id: 'deny', label: localize('voltSettings.ruleDeny', "Deny"), icon: Codicon.circleSlash },
			{ id: 'ask', label: localize('voltSettings.ruleAsk', "Ask"), icon: Codicon.question },
			{ id: 'allow', label: localize('voltSettings.ruleAllow', "Allow"), icon: Codicon.check },
		], effect, localize('voltSettings.ruleEffect', "Effect"), next => { effect = next; });
		const actions = append(form, $('.volt-settings-actions'));
		const add = this.renderStore.add(createVoltButton(actions, 'primary'));
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
				const remove = this.renderStore.add(createVoltButton(row, 'danger'));
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

	/** Volt's dropdown pill, bound to the page: it goes away with the next render. */
	private dropdown<T extends string>(host: HTMLElement, options: readonly IVoltDropdownOption<T>[], value: T, ariaLabel: string, onChange: (value: T) => void, width?: number): void {
		createVoltDropdown(host, this.contextViewService, { options, value, ariaLabel, onChange, width }, this.renderStore);
	}

	private inputBoxStyles() {
		return getInputBoxStyle({
			inputBackground: settingsTextInputBackground,
			inputForeground: settingsTextInputForeground,
			inputBorder: settingsTextInputBorder,
		});
	}

	override async setInput(input: VoltSettingsEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.renderContent();
	}

	override layout(_dimension: Dimension): void {
		this.scheduleScrollSync();
		this.layoutCustomize();
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
