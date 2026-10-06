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
import { fromNow } from '../../../../base/common/date.js';
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
import { DisablementReason, IUpdateService, State as UpdateState, StateType } from '../../../../platform/update/common/update.js';
import { VOLT_RELEASE_CHANNEL_SETTING } from '../../../../platform/update/common/voltUpdateFeed.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles, getInputBoxStyle, getSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { settingsSelectBackground, settingsSelectBorder, settingsSelectForeground, settingsSelectListBorder, settingsTextInputBackground, settingsTextInputBorder, settingsTextInputForeground } from '../../preferences/common/settingsEditorColorRegistry.js';
import { ACCESS_MODE_OPTIONS, VoltAccessMode } from '../../../services/voltRuntime/common/access/accessModes.js';
import { IPermissionRule } from '../../../services/voltRuntime/common/access/accessTypes.js';
import { VOLT_MODES, VoltMode, modePolicy } from '../../../services/voltRuntime/common/modes.js';
import { IProviderProfileDraft, VoltApiStyle, VoltAuthKind, VoltProviderKind, VoltTransportKind } from '../../../services/voltRuntime/common/profiles.js';
import { IVoltCatalogItem, IVoltProviderStatus } from '../../../services/voltRuntime/common/providers.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { IVoltPredictionService } from '../../../services/voltRuntime/common/prediction.js';
import { createBrandIcon } from '../../../services/voltRuntime/browser/providers/providerBrands.js';
import { AGENT_NEW_CHAT_DRAFT_SETTING, AGENT_PROMPT_HISTORY_SETTING } from '../../voltAgent/common/agentComposerSettings.js';
import { AgentModelPicker } from '../../voltAgent/browser/picker/agentModelPicker.js';
import { appendSettingsBlock, SettingsStickyHeads } from './settingsStickyHeads.js';
import { VoltSettingsEditorInput } from './voltSettingsEditorInput.js';

type SettingsSection = 'general' | 'common' | 'providers' | 'models' | 'agents' | 'acp' | 'modes' | 'composer' | 'tab' | 'security';

const SECTIONS: { id: SettingsSection; label: string; icon: ThemeIcon }[] = [
	{ id: 'general', label: localize('voltSettings.general', "General"), icon: Codicon.settingsGear },
	{ id: 'common', label: localize('voltSettings.common', "Commonly Used"), icon: Codicon.starEmpty },
	{ id: 'providers', label: localize('voltSettings.providers', "Providers"), icon: Codicon.plug },
	{ id: 'models', label: localize('voltSettings.models', "Models"), icon: Codicon.symbolClass },
	{ id: 'agents', label: localize('voltSettings.agents', "Agents"), icon: Codicon.robot },
	{ id: 'acp', label: localize('voltSettings.acp', "ACP"), icon: Codicon.server },
	{ id: 'modes', label: localize('voltSettings.modes', "Modes"), icon: Codicon.sparkle },
	{ id: 'composer', label: localize('voltSettings.composer', "Composer"), icon: Codicon.commentDiscussion },
	{ id: 'tab', label: localize('voltSettings.tab', "Tab & Prediction"), icon: Codicon.keyboard },
	{ id: 'security', label: localize('voltSettings.security', "Security"), icon: Codicon.shield },
];

const MODEL_PROVIDERS: ISelectOptionItem[] = [
	{ text: 'OpenAI', detail: 'openai' },
	{ text: 'Anthropic', detail: 'anthropic' },
	{ text: 'OpenRouter', detail: 'openrouter' },
	{ text: 'Gemini', detail: 'gemini' },
	{ text: 'Ollama', detail: 'ollama' },
	{ text: 'OpenAI Compatible', detail: 'openai-compat' },
	{ text: 'LM Studio', detail: 'lmstudio' },
];

const AGENT_PROVIDERS: ISelectOptionItem[] = [
	{ text: 'Cursor', detail: 'cursor-acp' },
	{ text: 'Custom command', detail: 'acp-generic' },
];

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

const HEALTH_INTERVAL_STEP = 30;

function providerDetailText(status: IVoltProviderStatus): string {
	if (!status.enabled) {
		return localize('voltSettings.providerDisabled', "Disabled - turn this on to use {0} in the composer.", status.label);
	}
	if (status.state === 'checking') {
		return localize('voltSettings.providerChecking', "Checking availability...");
	}
	return status.detail ?? localize('voltSettings.providerUnknown', "No status reported yet.");
}

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
	private readonly expandedProviders = new Set<string>();
	private readonly renderStore = this._register(new DisposableStore());
	private readonly scrollSync = this._register(new MutableDisposable());

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
	) {
		super(VoltSettingsEditor.ID, group, telemetryService, themeService, storageService);
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (this.section === 'composer' && (e.affectsConfiguration(AGENT_PROMPT_HISTORY_SETTING) || e.affectsConfiguration(AGENT_NEW_CHAT_DRAFT_SETTING))) {
				this.renderContent();
			}
		}));
		this._register(this.runtime.onDidChangeCatalog(() => this.renderContent()));
		this._register(this.runtime.onDidChangeProfiles(() => this.renderContent()));
		this._register(this.runtime.onDidChangeProviderStatus(() => this.renderContent()));
		this._register(this.runtime.onDidChangeAccess(() => this.renderContent()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.volt-settings'));
		this._register(toDisposable(() => {
			this.container.remove();
			this.layoutService.mainContainer.classList.remove('volt-settings-open');
		}));

		const sidebar = append(this.container, $('.volt-settings-sidebar'));
		const back = append(sidebar, $('button.volt-settings-back')) as HTMLButtonElement;
		back.type = 'button';
		back.appendChild(renderIcon(Codicon.arrowLeft));
		append(back, $('span')).textContent = localize('voltSettings.back', "Back");
		this._register(addDisposableListener(back, 'click', () => this.close()));

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
		for (const section of SECTIONS) {
			const item = append(this.toc, $('button.volt-settings-toc-item')) as HTMLButtonElement;
			item.type = 'button';
			append(item, $('span.volt-settings-toc-icon')).appendChild(renderIcon(section.icon));
			append(item, $('span.volt-settings-toc-text')).textContent = section.label;
			item.dataset.section = section.id;
			if (section.id === this.section) {
				item.classList.add('active');
			}
			this._register(addDisposableListener(item, 'click', () => this.setSection(section.id)));
		}

		const scroll = $('.volt-settings-content');
		this.content = append(scroll, $('.volt-settings-content-inner'));
		this.contentScroll = this._register(new DomScrollableElement(scroll, {
			className: 'volt-settings-content-scroll',
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Auto,
			useShadows: false,
		}));
		append(this.container, this.contentScroll.getDomNode());
		this.stickyHeads = this._register(new SettingsStickyHeads(scroll, this.content));
		this._register(this.contentScroll.onScroll(() => this.stickyHeads.sync()));
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
			this.scheduleScrollSync();
			return;
		}
		this.container.classList.remove('volt-settings-overlay');
		this.layoutService.mainContainer.classList.remove('volt-settings-open');
		this.container.remove();
	}

	private applyNavFilter(): void {
		const needle = this.search.trim().toLowerCase();
		for (const child of this.toc.querySelectorAll<HTMLElement>('.volt-settings-toc-item')) {
			const label = child.querySelector('.volt-settings-toc-text')?.textContent?.toLowerCase() ?? '';
			child.hidden = needle.length > 0 && !label.includes(needle);
		}
	}

	private setSection(section: SettingsSection): void {
		this.section = section;
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
		this.renderStore.clear();
		this.content.replaceChildren();
		this.block = undefined;
		this.renderGeneration++;
		switch (this.section) {
			case 'general':
				this.renderGeneral();
				break;
			case 'providers':
				this.renderProviders();
				break;
			case 'models':
				this.renderModels();
				break;
			case 'agents':
			case 'acp':
				this.renderAgents();
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
			default:
				this.renderCommon();
		}
		this.scheduleScrollSync();
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
		this.sectionLabel(localize('voltSettings.textGeneration', "Text generation"));
		this.settingRow(
			this.settingsGroup(),
			localize('voltSettings.textGenerationModel', "Text generation model"),
			localize('voltSettings.textGenerationModelDesc', "Used for chat titles and other generated text. Follow chat runs each one on the model the chat uses."),
			host => this.textGenerationPicker(host),
		);
		this.renderUpdates();
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

	/** The composer's model picker, bound to the text generation slot instead of the composer's model. */
	private textGenerationPicker(host: HTMLElement): void {
		const button = append(host, $('button.volt-agent-model.volt-settings-model')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-haspopup', 'dialog');
		button.setAttribute('aria-label', localize('voltSettings.textGenerationModel', "Text generation model"));
		const picker = this.renderStore.add(this.instantiationService.createInstance(AgentModelPicker, {
			binding: {
				get: () => this.runtime.getTaskModels().title,
				set: ref => void this.runtime.setTaskModel('title', ref),
				autoLabel: localize('voltSettings.followChat', "Follow chat"),
				autoDescription: localize('voltSettings.followChatDesc', "Use the model the chat runs on"),
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

	private renderCommon(): void {
		this.pageHead(
			localize('voltSettings.common', "Commonly Used"),
			localize('voltSettings.commonLead', "The connections and choices you reach for most."),
		);
		this.renderProfileList(undefined);
	}

	private renderProviders(): void {
		const head = this.pageHead(
			localize('voltSettings.providers', "Providers"),
			localize('voltSettings.providersLead', "Installed connections and whether each one is ready."),
		);
		const actions = append(head, $('.volt-settings-page-actions'));
		const lastCheck = this.runtime.getLastProviderCheck();
		append(actions, $('span.volt-settings-checked')).textContent = lastCheck
			? localize('voltSettings.checkedAt', "Checked {0}", fromNow(lastCheck, true))
			: localize('voltSettings.checking', "Checking...");
		const add = append(actions, $('button.volt-settings-icon-btn')) as HTMLButtonElement;
		add.appendChild(renderIcon(Codicon.add));
		add.title = localize('voltSettings.addConnection', "Add a connection");
		this.renderStore.add(addDisposableListener(add, 'click', () => this.setSection('models')));
		const refresh = append(actions, $('button.volt-settings-icon-btn')) as HTMLButtonElement;
		refresh.appendChild(renderIcon(Codicon.refresh));
		refresh.title = localize('voltSettings.refreshProviders', "Check providers now");
		this.renderStore.add(addDisposableListener(refresh, 'click', () => void this.runtime.refreshProviders()));

		this.settingRow(
			this.settingsGroup(),
			localize('voltSettings.healthInterval', "Health check interval"),
			localize('voltSettings.healthIntervalDesc', "Refresh provider availability, versions, auth state, and model metadata in the background. Set this to 0 seconds to rely on manual refreshes."),
			host => this.stepper(host, String(this.runtime.getHealthCheckInterval()), localize('voltSettings.seconds', "seconds"), seconds => {
				const clamped = Math.max(0, Math.round(seconds));
				void this.runtime.setHealthCheckInterval(clamped);
				return clamped;
			}, HEALTH_INTERVAL_STEP),
		);

		const needle = this.search.trim().toLowerCase();
		const statuses = this.runtime.listProviderStatuses()
			.filter(status => !needle || status.label.toLowerCase().includes(needle) || status.providerId.includes(needle));
		if (!statuses.length) {
			this.empty(localize('voltSettings.noProviders', "No providers yet. Add a model or ACP agent connection to get started."));
			return;
		}
		const list = append(this.target, $('.volt-settings-list'));
		for (const status of statuses) {
			this.providerRow(list, status);
		}
	}

	private providerRow(parent: HTMLElement, status: IVoltProviderStatus): void {
		const expanded = this.expandedProviders.has(status.profileId);
		const card = append(parent, $('.volt-settings-provider'));
		const row = append(card, $('.volt-settings-provider-row'));
		append(row, $(`span.volt-settings-dot.${status.state}`));
		append(row, $('.volt-settings-provider-icon')).appendChild(createBrandIcon(status.providerId, 18));

		const text = append(row, $('.text'));
		const title = append(text, $('.title'));
		append(title, $('span.name')).textContent = status.label;
		if (status.version) {
			append(title, $('span.version')).textContent = status.version;
		}
		if (status.earlyAccess) {
			append(title, $('span.badge')).textContent = localize('voltSettings.earlyAccess', "Early Access");
		}
		append(text, $('.detail')).textContent = providerDetailText(status);

		const chevron = append(row, $('button.volt-settings-chevron')) as HTMLButtonElement;
		chevron.appendChild(renderIcon(expanded ? Codicon.chevronUp : Codicon.chevronDown));
		chevron.title = localize('voltSettings.providerDetails', "Show models and connection details");
		this.renderStore.add(addDisposableListener(chevron, 'click', () => {
			if (expanded) {
				this.expandedProviders.delete(status.profileId);
			} else {
				this.expandedProviders.add(status.profileId);
			}
			this.renderContent();
		}));

		const toggle = append(row, $('button.volt-settings-toggle')) as HTMLButtonElement;
		toggle.classList.toggle('on', status.enabled);
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-checked', String(status.enabled));
		toggle.setAttribute('aria-label', status.label);
		this.renderStore.add(addDisposableListener(toggle, 'click', () => {
			void this.runtime.setProfileEnabled(status.profileId, !status.enabled);
		}));

		if (expanded) {
			this.providerDetails(card, status);
		}
	}

	private providerDetails(card: HTMLElement, status: IVoltProviderStatus): void {
		const body = append(card, $('.volt-settings-provider-body'));
		const profile = this.runtime.listProfiles().find(p => p.id === status.profileId);
		const connection = profile?.kind === 'agent'
			? [profile.command, ...(profile.args ?? [])].filter(Boolean).join(' ')
			: profile?.endpoint?.baseURL;
		if (connection) {
			append(body, $('.volt-settings-provider-connection')).textContent = connection;
		}
		if (!status.models.length) {
			append(body, $('.volt-settings-provider-empty')).textContent = status.kind === 'agent'
				? localize('voltSettings.agentNoModels', "This agent chooses its own model.")
				: localize('voltSettings.providerNoModels', "No models reported yet. Refresh once the connection is authenticated.");
			return;
		}
		for (const model of status.models) {
			const item = append(body, $('.volt-settings-provider-model'));
			append(item, $('span.label')).textContent = model.label;
			const toggle = append(item, $('button.volt-settings-toggle.small')) as HTMLButtonElement;
			toggle.classList.toggle('on', model.enabled);
			toggle.setAttribute('role', 'switch');
			toggle.setAttribute('aria-checked', String(model.enabled));
			toggle.setAttribute('aria-label', model.label);
			this.renderStore.add(addDisposableListener(toggle, 'click', () => {
				void this.runtime.setModelEnabled(model.ref, !model.enabled);
			}));
		}
	}

	private renderModels(): void {
		this.pageHead(
			localize('voltSettings.models', "Models"),
			localize('voltSettings.modelsLead', "Choose which models appear in the model picker."),
		);
		this.renderConnectionForm('model');
		this.sectionLabel(localize('voltSettings.modelList', "Enabled models"));
		const needle = this.search.trim().toLowerCase();
		const models = this.runtime.listCatalog().filter(item => item.kind === 'model' && (!needle || item.label.toLowerCase().includes(needle) || item.qualifier?.toLowerCase().includes(needle)));
		if (!models.length) {
			this.empty(localize('voltSettings.noModels', "Add an OpenAI, Anthropic, OpenRouter, Gemini, or Ollama connection to list models."));
			return;
		}
		const list = append(this.target, $('.volt-settings-list'));
		for (const model of models) {
			this.modelRow(list, model);
		}
	}

	private renderAgents(): void {
		this.pageHead(
			this.section === 'acp' ? localize('voltSettings.acp', "ACP") : localize('voltSettings.agents', "Agents"),
			this.section === 'acp'
				? localize('voltSettings.acpIntro', "Agent Client Protocol connections you can pick from the composer.")
				: localize('voltSettings.agentsLead', "Connect an agent and pick it from the composer."),
		);
		this.renderConnectionForm('agent');
		const generation = this.renderGeneration;
		void this.runtime.detectAgents().then(results => {
			if (generation !== this.renderGeneration) {
				return;
			}
			if (!results.length) {
				return;
			}
			this.sectionLabel(localize('voltSettings.detectedAgents', "Detected agents"));
			const list = append(this.target, $('.volt-settings-list'));
			for (const result of results) {
				const card = append(list, $('.volt-settings-card'));
				const meta = append(card, $('.volt-settings-card-copy'));
				append(meta, $('div.title')).textContent = result.label;
				append(meta, $('.meta')).textContent = result.available
					? localize('voltSettings.acpReady', "Ready - {0}", result.detail ?? result.version ?? 'detected')
					: localize('voltSettings.acpMissing', "Not found - {0}", result.detail ?? 'install the CLI and reconnect');
				append(card, $(`span.volt-settings-status.${result.available ? 'ready' : 'missing'}`)).textContent = result.available
					? localize('voltSettings.ready', "Ready")
					: localize('voltSettings.missing', "Missing");
			}
		});
		const agents = this.runtime.listCatalog().filter(i => i.kind === 'agent');
		if (agents.length) {
			this.sectionLabel(localize('voltSettings.connectedAgents', "Connected"));
			const list = append(this.target, $('.volt-settings-list'));
			for (const item of agents) {
				this.modelRow(list, item);
			}
		}
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
			localize('voltSettings.composerLead', "How the agent prompt box behaves."),
		);
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
			localize('voltSettings.accessMode', "Default access mode"),
			localize('voltSettings.accessModeDesc', "The starting permission preset for new agent sessions."),
			host => {
				const selected = ACCESS_MODE_OPTIONS.findIndex(option => option.id === this.runtime.getAccessMode());
				const box = this.selectBox(
					append(host, $('.volt-settings-select')),
					ACCESS_MODE_OPTIONS.map(option => ({ text: option.label, detail: option.description })),
					Math.max(0, selected),
					localize('voltSettings.accessMode', "Default access mode"),
				);
				this.renderStore.add(box.onDidSelect(e => {
					const mode = ACCESS_MODE_OPTIONS[e.index]?.id as VoltAccessMode | undefined;
					if (mode) {
						void this.runtime.setAccessMode(mode);
					}
				}));
			},
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

	private renderProfileList(kind: VoltProviderKind | undefined): void {
		const items = this.runtime.listCatalog().filter(item => !kind || item.kind === kind);
		if (!items.length) {
			this.empty(localize('voltSettings.noConnections', "No connections yet. Add one under Models or Agents."));
			return;
		}
		this.sectionLabel(localize('voltSettings.connections', "Connections"));
		const list = append(this.target, $('.volt-settings-list'));
		for (const item of items) {
			this.modelRow(list, item);
		}
	}

	private renderConnectionForm(kind: VoltProviderKind): void {
		const form = append(this.target, $('.volt-settings-form'));
		append(form, $('label.volt-settings-form-title')).textContent = kind === 'model'
			? localize('voltSettings.addModel', "Add model connection")
			: localize('voltSettings.addAgent', "Add ACP agent");

		const providers = kind === 'model' ? MODEL_PROVIDERS : AGENT_PROVIDERS;
		let providerId = providers[0].detail ?? providers[0].text;
		this.field(form, localize('voltSettings.provider', "Provider"), host => {
			const box = this.selectBox(host, providers, 0, localize('voltSettings.provider', "Provider"));
			this.renderStore.add(box.onDidSelect(e => {
				providerId = providers[e.index]?.detail ?? e.selected;
			}));
		});

		const label = this.labeledInput(form, localize('voltSettings.label', "Name"), localize('voltSettings.label.placeholder', "Display name"));
		const model = this.labeledInput(
			form,
			kind === 'model' ? localize('voltSettings.modelId', "Model id") : localize('voltSettings.command', "Command"),
			kind === 'model' ? localize('voltSettings.modelId.placeholder', "Optional, e.g. gpt-4.1") : localize('voltSettings.command.placeholder', "agent"),
		);
		const extra = this.labeledInput(
			form,
			kind === 'model' ? localize('voltSettings.baseUrl', "Base URL") : localize('voltSettings.args', "Args"),
			kind === 'model' ? localize('voltSettings.baseUrl.placeholder', "Optional") : localize('voltSettings.args.placeholder', "acp"),
		);
		const secret = this.labeledInput(
			form,
			kind === 'model' ? localize('voltSettings.apiKey', "API key") : localize('voltSettings.cwd', "Working directory"),
			kind === 'model' ? localize('voltSettings.apiKey.placeholder', "Stored in OS secret storage") : localize('voltSettings.cwd.placeholder', "Optional"),
			kind === 'model' ? 'password' : 'text',
		);

		const actions = append(form, $('.volt-settings-actions'));
		const save = this.renderStore.add(new Button(actions, defaultButtonStyles));
		save.label = localize('voltSettings.connect', "Connect");
		this.renderStore.add(save.onDidClick(() => {
			void this.saveConnection(kind, providerId, label.value, model.value, extra.value, secret.value);
		}));
	}

	private async saveConnection(kind: VoltProviderKind, providerId: string, label: string, modelOrCommand: string, extra: string, secretOrCwd: string): Promise<void> {
		const transport: VoltTransportKind = kind === 'agent' ? 'stdio' : 'http';
		const apiStyle = this.apiStyle(providerId);
		const draft: IProviderProfileDraft = {
			label: label || (kind === 'agent' ? (providerId === 'cursor-acp' ? 'Cursor' : 'Agent') : providerId),
			kind,
			providerId,
			transport,
			apiStyle,
			authKind: this.authKind(providerId),
			enabled: true,
		};
		if (kind === 'model') {
			draft.modelId = modelOrCommand || undefined;
			if (extra) {
				draft.endpoint = { baseURL: extra };
			}
			await this.runtime.upsertProfile(draft, secretOrCwd || undefined);
		} else {
			draft.command = modelOrCommand || 'agent';
			draft.args = extra ? extra.split(/\s+/).filter(Boolean) : ['acp'];
			draft.cwd = secretOrCwd || undefined;
			await this.runtime.upsertProfile(draft);
		}
	}

	private modelRow(parent: HTMLElement, item: IVoltCatalogItem): void {
		const card = append(parent, $('.volt-settings-card'));
		const meta = append(card, $('.volt-settings-card-copy'));
		append(meta, $('div.title')).textContent = item.label;
		const detail = [item.qualifier, item.kind === 'agent' ? undefined : item.providerId].filter(Boolean).join(' - ');
		if (detail) {
			append(meta, $('.meta')).textContent = detail;
		}
		this.switch(card, item.enabled, item.label, () => {
			void this.runtime.setModelEnabled(item.ref, !item.enabled);
		});
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

	private apiStyle(providerId: string): VoltApiStyle | undefined {
		if (providerId === 'anthropic') {
			return 'anthropic';
		}
		if (providerId === 'gemini') {
			return 'gemini';
		}
		if (providerId === 'ollama') {
			return 'ollama';
		}
		if (providerId === 'openai' || providerId === 'openrouter' || providerId === 'openai-compat' || providerId === 'lmstudio') {
			return 'openai-compat';
		}
		return undefined;
	}

	private authKind(providerId: string): VoltAuthKind {
		if (providerId === 'ollama' || providerId === 'lmstudio' || providerId === 'cursor-acp' || providerId === 'acp-generic') {
			return providerId.startsWith('acp') || providerId === 'cursor-acp' ? 'cli' : 'none';
		}
		return 'apikey';
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
