/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, isHTMLElement } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IInputBoxStyles, InputBox, MessageType } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { ISelectBoxStyles, ISelectOptionItem, SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { CLI_AGENT_DEFINITIONS } from '../../../services/voltRuntime/browser/agents/cliAgents.js';
import { createBrandIcon } from '../../../services/voltRuntime/browser/providers/providerBrands.js';
import { IModelOptionDescriptor, IModelParamSpec, isSelectableDescriptor, MODEL_GENERATION_PARAMS, MODEL_OPTION_CONTEXT, MODEL_OPTION_FAST, MODEL_OPTION_REASONING, MODEL_OPTION_SERVICE_TIER, MODEL_OPTION_THINKING, MODEL_PARAM_MAX_OUTPUT, MODEL_PARAM_TEMPERATURE, MODEL_PARAM_TOP_P, optionValue, parseModelParam, traitDescriptors } from '../../../services/voltRuntime/common/models/modelOptions.js';
import { IProviderProfile, IProviderProfileDraft, VoltApiStyle, VoltAuthKind } from '../../../services/voltRuntime/common/profiles.js';
import { IVoltCatalogItem, IVoltProviderStatus } from '../../../services/voltRuntime/common/providers.js';
import { IAgentRuntimeService, IVoltTaskModels } from '../../../services/voltRuntime/common/runtime.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { createRefreshSpinner } from '../../voltAgent/browser/usage/agentUsageIcons.js';
import { AGENT_DEFAULT_MODEL_SETTING } from '../../voltAgent/common/agentComposerSettings.js';
import { AgentSetupService, IAgentSetupState } from '../../voltSetup/browser/agentSetupService.js';

/** How long a background install may run before it is called failed. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** While a sign-in runs in the terminal, how often and how long its CLI is asked again. */
const SIGN_IN_POLL_MS = 3000;
const SIGN_IN_POLL_LIMIT_MS = 5 * 60_000;

/** API providers anyone can add with a key or an endpoint. */
const API_PROVIDERS: readonly { id: string; label: string; keyHint?: string; baseUrl?: string; docs?: string }[] = [
	{ id: 'anthropic', label: 'Anthropic', keyHint: 'sk-ant-…', baseUrl: 'https://api.anthropic.com', docs: 'https://console.anthropic.com/settings/keys' },
	{ id: 'openai', label: 'OpenAI', keyHint: 'sk-…', baseUrl: 'https://api.openai.com/v1', docs: 'https://platform.openai.com/api-keys' },
	{ id: 'openrouter', label: 'OpenRouter', keyHint: 'sk-or-…', baseUrl: 'https://openrouter.ai/api/v1', docs: 'https://openrouter.ai/keys' },
	{ id: 'gemini', label: 'Gemini', keyHint: 'AIza…', baseUrl: 'https://generativelanguage.googleapis.com', docs: 'https://aistudio.google.com/apikey' },
	{ id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434' },
	{ id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
	{ id: 'openai-compat', label: 'OpenAI compatible', keyHint: 'Optional' },
];

/** Where to get the apps behind local model runtimes. */
const LOCAL_DOWNLOADS: Record<string, string> = {
	ollama: 'https://ollama.com/download',
	lmstudio: 'https://lmstudio.ai/download',
};

const API_STYLE_LABELS: Record<VoltApiStyle, string> = {
	'openai-compat': 'OpenAI Chat Completions',
	'anthropic': 'Anthropic Messages',
	'gemini': 'Gemini generateContent',
	'ollama': 'Ollama chat',
};

/** What each option a provider advertises does, for the row under its name. */
const OPTION_HINTS: Record<string, string> = {
	[MODEL_OPTION_REASONING]: localize('voltSettings.optReasoning', "How hard the model thinks before it answers. Auto lets Volt pick per message."),
	[MODEL_OPTION_CONTEXT]: localize('voltSettings.optContext', "How much of the conversation the model can see at once. Larger windows can cost more."),
	[MODEL_OPTION_SERVICE_TIER]: localize('voltSettings.optTier', "The priority and price tier the provider runs requests on."),
	[MODEL_OPTION_FAST]: localize('voltSettings.optFast', "Faster output at a higher price, where the provider offers it."),
	[MODEL_OPTION_THINKING]: localize('voltSettings.optThinking', "Extended thinking before the reply."),
};

type RunningAction = { readonly action: 'install' | 'login'; readonly command: string } | { readonly action: 'failed'; readonly command: string; readonly output: string };

/** What the right pane shows. */
type Selection =
	| { readonly kind: 'overview' }
	| { readonly kind: 'provider'; readonly profileId: string }
	| { readonly kind: 'model'; readonly ref: string }
	| { readonly kind: 'add'; readonly what: 'api' | 'agent' };

/** A provider in the left list, with its model rows, for filtering in place. */
interface IListBlock {
	readonly profileId: string;
	readonly block: HTMLElement;
	readonly row: HTMLElement;
	readonly models: HTMLElement;
	readonly text: string;
	readonly rows: readonly { readonly row: HTMLElement; readonly text: string }[];
}

export interface IProvidersPageHost {
	/** Where the page goes (the body of the page's titled block). */
	target(): HTMLElement;
	readonly store: DisposableStore;
	search(): string;
	rerender(): void;
	/** Shows the window under the settings overlay, so a terminal the page opened can be used. */
	revealWorkbench(): void;
	switch(parent: HTMLElement, on: boolean, label: string, onClick: () => void): HTMLButtonElement;
	inputBoxStyles(): IInputBoxStyles;
	selectBoxStyles(): ISelectBoxStyles;
}

function apiStyle(providerId: string): VoltApiStyle | undefined {
	switch (providerId) {
		case 'anthropic': return 'anthropic';
		case 'gemini': return 'gemini';
		case 'ollama': return 'ollama';
		case 'openai': case 'openrouter': case 'openai-compat': case 'lmstudio': return 'openai-compat';
		default: return undefined;
	}
}

function authKind(providerId: string): VoltAuthKind {
	return providerId === 'ollama' || providerId === 'lmstudio' ? 'none' : 'apikey';
}

/** Context sizes read the same whoever reported them: 200k, 1M. */
function normalizeContext(label: string): string {
	return label.replace(/(\d+(?:\.\d+)?)\s*([km])\b/gi, (_, n: string, unit: string) => `${n}${unit.toLowerCase() === 'm' ? 'M' : 'k'}`);
}

function formatContext(tokens: number): string {
	return tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
}

/**
 * Volt Settings > Providers & Models: every coding agent CLI and model API, as a list on the left
 * with each provider's models under it, and whatever is picked on the right. A provider shows its
 * setup (Install, Sign In, Add Key, Download), connection and models; a model shows what Volt sends
 * with it (option defaults, sampling pins), where else it is used and what it can do.
 */
export class ProvidersPage {

	private readonly runtime: IAgentRuntimeService;
	private readonly stdio: IVoltStdioService;
	private readonly opener: IOpenerService;
	private readonly contextViewService: IContextViewService;
	private readonly configurationService: IConfigurationService;
	private readonly clipboard: IClipboardService;
	private readonly setup: AgentSetupService;

	/** Install and sign-in state per CLI id, from asking each CLI directly. */
	private readonly setupStates = new Map<string, IAgentSetupState>();
	private setupChecking: Promise<void> | undefined;
	private readonly running = new Map<string, RunningAction>();
	private readonly keyEditor = new Set<string>();
	private disposed = false;
	/** While Refresh runs; the button shows the Usage page's spinner, also across re-renders. */
	private refreshing = false;

	private selection: Selection = { kind: 'overview' };
	/** Providers whose models are open in the list. */
	private readonly expanded = new Set<string>();
	private listFilter = '';
	/** Both panes scroll on their own; a re-render puts them back where they were. */
	private listScrollTop = 0;
	private detailScrollTop = 0;
	/** The field that had focus, so a re-render (a save, a health check) gives it back. */
	private focusKey: string | undefined;
	/** Typed but not saved yet, per field, so a re-render does not throw the text away. */
	private readonly drafts = new Map<string, string>();
	/** A pointer is down on the page; a field it pulled focus from saves once its click has landed. */
	private pointerDown = false;

	constructor(instantiationService: IInstantiationService, private readonly host: IProvidersPageHost) {
		({
			runtime: this.runtime,
			stdio: this.stdio,
			opener: this.opener,
			contextViewService: this.contextViewService,
			configurationService: this.configurationService,
			clipboard: this.clipboard,
		} = instantiationService.invokeFunction(accessor => ({
			runtime: accessor.get(IAgentRuntimeService),
			stdio: accessor.get(IVoltStdioService),
			opener: accessor.get(IOpenerService),
			contextViewService: accessor.get(IContextViewService),
			configurationService: accessor.get(IConfigurationService),
			clipboard: accessor.get(IClipboardService),
		})));
		this.setup = instantiationService.createInstance(AgentSetupService);
	}

	dispose(): void {
		this.disposed = true;
	}

	/** Asks every CLI whether it is installed and signed in. Runs once per page visit, and on Refresh. */
	checkSetup(force = false): Promise<void> {
		if (this.setupChecking && !force) {
			return this.setupChecking;
		}
		this.setupChecking = Promise.all(this.setup.definitions().map(async def => {
			const state = await this.setup.detect(def).catch(() => undefined);
			if (state) {
				this.setupStates.set(def.id, state);
			}
		})).then(() => {
			if (!this.disposed) {
				this.host.rerender();
			}
		});
		return this.setupChecking;
	}

	refresh(): void {
		if (this.refreshing) {
			return;
		}
		this.refreshing = true;
		this.host.rerender();
		void Promise.allSettled([this.checkSetup(true), this.runtime.refreshProviders()]).then(() => {
			this.refreshing = false;
			if (!this.disposed) {
				this.host.rerender();
			}
		});
	}

	render(head: HTMLElement): void {
		this.renderHeadActions(head);
		const all = this.runtime.listProviderStatuses();
		this.validateSelection(all);
		const needle = this.host.search().trim().toLowerCase();
		const statuses = all.filter(status => !needle
			|| status.label.toLowerCase().includes(needle)
			|| status.providerId.includes(needle)
			|| status.models.some(model => model.label.toLowerCase().includes(needle)));

		const shell = append(this.host.target(), $('.volt-pm'));
		const doc = shell.ownerDocument;
		this.host.store.add(addDisposableListener(doc, 'pointerdown', () => this.pointerDown = true, true));
		this.host.store.add(addDisposableListener(doc, 'pointerup', () => this.pointerDown = false, true));
		this.host.store.add(addDisposableListener(doc, 'pointercancel', () => this.pointerDown = false, true));
		this.renderList(append(shell, $('.volt-pm-list')), statuses);
		this.renderDetail(append(shell, $('.volt-pm-detail')), all);
		this.restoreFocus(shell);
	}

	private select(selection: Selection): void {
		this.selection = selection;
		this.detailScrollTop = 0;
		this.drafts.clear();
		this.focusKey = undefined;
		if (selection.kind === 'provider') {
			this.expanded.add(selection.profileId);
		} else if (selection.kind === 'model') {
			const owner = this.runtime.listProviderStatuses().find(status => status.models.some(model => model.ref === selection.ref));
			if (owner) {
				this.expanded.add(owner.profileId);
			}
		}
		this.host.rerender();
	}

	/** A provider removed, or a model gone from its catalog, falls back to the overview. */
	private validateSelection(all: IVoltProviderStatus[]): void {
		const selection = this.selection;
		if (selection.kind === 'provider' && !all.some(status => status.profileId === selection.profileId)) {
			this.selection = { kind: 'overview' };
		} else if (selection.kind === 'model' && !all.some(status => status.models.some(model => model.ref === selection.ref))) {
			this.selection = { kind: 'overview' };
		}
	}

	private renderHeadActions(head: HTMLElement): void {
		const actions = append(head, $('.volt-settings-page-actions'));
		const lastCheck = this.runtime.getLastProviderCheck();
		append(actions, $('span.volt-settings-checked')).textContent = lastCheck
			? localize('voltSettings.checkedAt', "Checked {0}", fromNow(lastCheck, true))
			: localize('voltSettings.checking', "Checking...");
		const refresh = append(actions, $('button.volt-settings-icon-btn.volt-settings-refresh')) as HTMLButtonElement;
		refresh.type = 'button';
		refresh.appendChild(renderIcon(Codicon.refresh));
		refresh.appendChild(createRefreshSpinner());
		refresh.classList.toggle('spinning', this.refreshing);
		if (this.refreshing) {
			refresh.setAttribute('aria-busy', 'true');
		}
		refresh.setAttribute('aria-label', localize('voltSettings.refreshProviders', "Check providers now"));
		setAgentTooltip(refresh, localize('voltSettings.refreshProviders', "Check providers now"));
		this.host.store.add(addDisposableListener(refresh, 'click', () => this.refresh()));
	}

	//#region List

	private renderList(pane: HTMLElement, statuses: IVoltProviderStatus[]): void {
		const filter = this.host.store.add(new InputBox(append(pane, $('.volt-pm-filter')), this.contextViewService, {
			placeholder: localize('voltSettings.filterProviders', "Filter providers and models"),
			ariaLabel: localize('voltSettings.filterProviders', "Filter providers and models"),
			inputBoxStyles: this.host.inputBoxStyles(),
		}));
		filter.value = this.listFilter;
		this.trackFocus(filter.inputElement, 'list-filter');

		const scroller = append(pane, $('.volt-pm-scroll'));
		scroller.setAttribute('role', 'tree');
		scroller.setAttribute('aria-label', localize('voltSettings.providersAndModels', "Providers and models"));

		const all = this.runtime.listProviderStatuses();
		const attention = all.filter(status => this.needsAction(status)).length;
		const overview = this.listItem(scroller, 'overview', this.selection.kind === 'overview');
		append(overview, $('span.volt-pm-glyph')).appendChild(renderIcon(Codicon.dashboard));
		append(overview, $('span.volt-pm-name')).textContent = localize('voltSettings.overview', "Overview");
		if (attention) {
			const badge = append(overview, $('span.volt-pm-count.warn'));
			badge.textContent = String(attention);
			setAgentTooltip(badge, localize('voltSettings.needSetupCount', "{0} need setup", attention));
		}
		this.onActivate(overview, () => this.select({ kind: 'overview' }));

		const blocks: IListBlock[] = [];
		const groups: { label: HTMLElement; add: HTMLElement; blocks: IListBlock[] }[] = [];
		const group = (label: string, items: IVoltProviderStatus[], addLabel: string, what: 'api' | 'agent') => {
			const heading = append(scroller, $('.volt-pm-group'));
			heading.textContent = label;
			const own: IListBlock[] = [];
			for (const status of this.sorted(items)) {
				own.push(this.listProvider(scroller, status));
			}
			const add = append(scroller, $('button.volt-pm-add')) as HTMLButtonElement;
			add.type = 'button';
			add.classList.toggle('selected', this.selection.kind === 'add' && this.selection.what === what);
			add.appendChild(renderIcon(Codicon.add));
			append(add, $('span')).textContent = addLabel;
			this.host.store.add(addDisposableListener(add, 'click', () => this.select({ kind: 'add', what })));
			blocks.push(...own);
			groups.push({ label: heading, add, blocks: own });
		};
		group(localize('voltSettings.codingAgents', "Coding agents"), statuses.filter(status => status.kind === 'agent'), localize('voltSettings.addCustomAgentShort', "Add custom agent"), 'agent');
		group(localize('voltSettings.apiProviders', "API & local models"), statuses.filter(status => status.kind === 'model'), localize('voltSettings.addApiProvider', "Add API provider"), 'api');

		const none = append(scroller, $('.volt-pm-none'));
		none.textContent = localize('voltSettings.noProviderMatch', "Nothing matches your search.");

		const apply = () => {
			const needle = this.listFilter.trim().toLowerCase();
			let shown = 0;
			for (const item of blocks) {
				const open = this.expanded.has(item.profileId);
				item.block.classList.toggle('expanded', open);
				item.row.setAttribute('aria-expanded', String(open));
				if (!needle || item.text.includes(needle)) {
					item.block.hidden = false;
					item.models.hidden = !open;
					item.rows.forEach(({ row }) => row.hidden = false);
					shown++;
					continue;
				}
				let hits = 0;
				for (const { row, text } of item.rows) {
					row.hidden = !text.includes(needle);
					hits += row.hidden ? 0 : 1;
				}
				item.block.hidden = hits === 0;
				item.models.hidden = hits === 0;
				item.block.classList.toggle('expanded', hits > 0);
				item.row.setAttribute('aria-expanded', String(hits > 0));
				shown += hits ? 1 : 0;
			}
			for (const { label, add, blocks: own } of groups) {
				label.hidden = !!needle && own.every(item => item.block.hidden);
				add.hidden = !!needle;
			}
			none.hidden = shown > 0 || !needle;
		};
		apply();
		this.host.store.add(filter.onDidChange(value => {
			this.listFilter = value;
			apply();
		}));
		for (const item of blocks) {
			const twistie = item.block.querySelector<HTMLElement>('.volt-pm-twistie');
			if (twistie) {
				this.host.store.add(addDisposableListener(twistie, 'click', e => {
					e.stopPropagation();
					if (this.expanded.has(item.profileId)) {
						this.expanded.delete(item.profileId);
					} else {
						this.expanded.add(item.profileId);
					}
					apply();
				}));
			}
		}

		scroller.scrollTop = this.listScrollTop;
		this.host.store.add(addDisposableListener(scroller, 'scroll', () => this.listScrollTop = scroller.scrollTop));
	}

	/** Ready first, then the ones that need a step, then the rest; by name within each. */
	private sorted(statuses: IVoltProviderStatus[]): IVoltProviderStatus[] {
		const rank = (status: IVoltProviderStatus) => {
			if (status.kind === 'agent') {
				const setup = this.setupStates.get(status.providerId);
				if (setup && !setup.installed) {
					return 2;
				}
			}
			return status.state === 'authenticated' || status.state === 'available' ? 0 : status.state === 'missing' ? 2 : 1;
		};
		return [...statuses].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
	}

	private listItem(parent: HTMLElement, kind: string, selected: boolean): HTMLElement {
		const item = append(parent, $(`.volt-pm-item.${kind}`));
		item.tabIndex = 0;
		item.setAttribute('role', 'treeitem');
		item.setAttribute('aria-selected', String(selected));
		item.classList.toggle('selected', selected);
		return item;
	}

	private onActivate(element: HTMLElement, run: () => void): void {
		this.host.store.add(addDisposableListener(element, 'click', run));
		this.host.store.add(addDisposableListener(element, 'keydown', e => {
			// Keys on a switch inside the row belong to the switch.
			if (e.target === element && (e.key === 'Enter' || e.key === ' ')) {
				e.preventDefault();
				run();
			}
		}));
	}

	private listProvider(parent: HTMLElement, status: IVoltProviderStatus): IListBlock {
		const setup = status.kind === 'agent' ? this.setupStates.get(status.providerId) : undefined;
		const installed = status.kind !== 'agent' || !setup || setup.installed;
		const block = append(parent, $('.volt-pm-block'));
		block.classList.toggle('not-installed', !installed);
		block.classList.toggle('off', !status.enabled);

		const selected = this.selection.kind === 'provider' && this.selection.profileId === status.profileId;
		const row = this.listItem(block, 'provider', selected);
		const twistie = append(row, $('span.volt-pm-twistie'));
		twistie.classList.toggle('empty', !status.models.length);
		twistie.appendChild(renderIcon(Codicon.chevronRight));
		append(row, $('span.volt-pm-icon')).appendChild(createBrandIcon(status.providerId, 14));
		append(row, $('span.volt-pm-name')).textContent = status.label;
		if (status.models.length) {
			append(row, $('span.volt-pm-count')).textContent = String(status.models.length);
		}
		const { tone, label } = this.statusLine(status, setup, this.running.get(status.profileId));
		const dot = append(row, $(`span.volt-settings-dot.${tone}`));
		setAgentTooltip(dot, label);
		this.onActivate(row, () => this.select({ kind: 'provider', profileId: status.profileId }));

		const models = append(block, $('.volt-pm-models'));
		models.setAttribute('role', 'group');
		const rows: { row: HTMLElement; text: string }[] = [];
		for (const model of [...status.models].sort((a, b) => Number(b.enabled) - Number(a.enabled))) {
			const modelSelected = this.selection.kind === 'model' && this.selection.ref === model.ref;
			const item = this.listItem(models, 'model', modelSelected);
			item.classList.toggle('off', !model.enabled);
			append(item, $('span.volt-pm-name')).textContent = model.label;
			if (!model.enabled) {
				const hidden = append(item, $('span.volt-pm-hidden'));
				hidden.appendChild(renderIcon(Codicon.eyeClosed));
				setAgentTooltip(hidden, localize('voltSettings.hiddenFromPicker', "Hidden from the model picker"));
			}
			if (model.qualifier && model.qualifier.toLowerCase() !== status.label.toLowerCase()) {
				setAgentTooltip(item, `${model.label} · ${model.qualifier}`);
			}
			this.onActivate(item, () => this.select({ kind: 'model', ref: model.ref }));
			rows.push({ row: item, text: `${model.label} ${model.id} ${model.qualifier ?? ''}`.toLowerCase() });
		}
		return { profileId: status.profileId, block, row, models, text: `${status.label} ${status.providerId}`.toLowerCase(), rows };
	}

	//#endregion

	//#region Detail

	private renderDetail(pane: HTMLElement, all: IVoltProviderStatus[]): void {
		const scroller = append(pane, $('.volt-pm-detail-scroll'));
		const inner = append(scroller, $('.volt-pm-detail-inner'));
		const selection = this.selection;
		switch (selection.kind) {
			case 'overview':
				this.renderOverview(inner, all);
				break;
			case 'provider': {
				const status = all.find(candidate => candidate.profileId === selection.profileId);
				if (status) {
					this.renderProvider(inner, status);
				}
				break;
			}
			case 'model': {
				const owner = all.find(status => status.models.some(model => model.ref === selection.ref));
				const model = owner?.models.find(candidate => candidate.ref === selection.ref);
				if (owner && model) {
					this.renderModel(inner, model, owner);
				}
				break;
			}
			case 'add':
				if (selection.what === 'api') {
					this.renderAddApi(inner);
				} else {
					this.renderAddAgent(inner);
				}
				break;
		}
		scroller.scrollTop = this.detailScrollTop;
		this.host.store.add(addDisposableListener(scroller, 'scroll', () => this.detailScrollTop = scroller.scrollTop));
	}

	/** Icon, title and status across the top of the right pane. Returns the slot for its actions. */
	private detailHead(parent: HTMLElement, icon: HTMLElement, title: string, decorate?: (title: HTMLElement) => void, status?: { tone: string; label: string }): HTMLElement {
		const head = append(parent, $('.volt-pm-head'));
		append(head, $('.volt-pm-head-icon')).appendChild(icon);
		const copy = append(head, $('.volt-pm-head-copy'));
		const heading = append(copy, $('.volt-pm-head-title'));
		append(heading, $('span.name')).textContent = title;
		decorate?.(heading);
		if (status) {
			const line = append(copy, $('.volt-pm-head-status'));
			append(line, $(`span.volt-settings-dot.${status.tone}`));
			append(line, $('span.text')).textContent = status.label;
		}
		return append(head, $('.volt-pm-actions.volt-pm-head-actions'));
	}

	private sectionTitle(parent: HTMLElement, title: string, hint?: string): HTMLElement {
		const heading = append(parent, $('.volt-pm-section-title'));
		append(heading, $('span')).textContent = title;
		if (hint) {
			append(parent, $('.volt-pm-section-hint')).textContent = hint;
		}
		return heading;
	}

	private row(group: HTMLElement, title: string, desc?: string): HTMLElement {
		const row = append(group, $('.volt-settings-row'));
		const copy = append(row, $('.volt-settings-row-copy'));
		append(copy, $('label')).textContent = title;
		if (desc) {
			append(copy, $('.desc')).textContent = desc;
		}
		return append(row, $('.volt-settings-row-control'));
	}

	/** A read-only value, monospaced for paths and ids, with a copy button for the ones worth pasting. */
	private valueRow(group: HTMLElement, title: string, value: string | undefined, options?: { mono?: boolean; copy?: boolean }): void {
		if (!value) {
			return;
		}
		const control = this.row(group, title);
		const text = append(control, $(options?.mono ? 'code.volt-pm-value' : 'span.volt-pm-value'));
		text.textContent = value;
		setAgentTooltip(text, value);
		if (options?.copy) {
			const copy = append(control, $('button.volt-settings-icon-btn.volt-pm-copy')) as HTMLButtonElement;
			copy.type = 'button';
			copy.appendChild(renderIcon(Codicon.copy));
			copy.setAttribute('aria-label', localize('voltSettings.copyValue', "Copy {0}", title));
			setAgentTooltip(copy, localize('voltSettings.copy', "Copy"));
			this.host.store.add(addDisposableListener(copy, 'click', () => {
				void this.clipboard.writeText(value);
				copy.replaceChildren(renderIcon(Codicon.check));
				mainWindow.setTimeout(() => {
					if (copy.isConnected) {
						copy.replaceChildren(renderIcon(Codicon.copy));
					}
				}, 1200);
			}));
		}
	}

	private renderOverview(parent: HTMLElement, all: IVoltProviderStatus[]): void {
		this.detailHead(parent, renderIcon(Codicon.dashboard), localize('voltSettings.overview', "Overview"), undefined, {
			tone: all.some(status => this.needsAction(status)) ? 'disabled' : 'authenticated',
			label: localize('voltSettings.overviewLead', "Pick a provider or a model on the left to set it up."),
		});

		const ready = all.filter(status => status.enabled && (status.state === 'authenticated' || status.state === 'available')).length;
		const attention = all.filter(status => this.needsAction(status));
		const enabledModels = all.reduce((sum, status) => sum + status.models.filter(model => model.enabled).length, 0);
		const totalModels = all.reduce((sum, status) => sum + status.models.length, 0);
		const strip = append(parent, $('.volt-settings-stats'));
		const stat = (value: string, label: string, tone?: string) => {
			const cell = append(strip, $('.volt-settings-stat'));
			if (tone) {
				cell.classList.add(tone);
			}
			append(cell, $('.value')).textContent = value;
			append(cell, $('.label')).textContent = label;
		};
		stat(String(ready), localize('voltSettings.statReady', "Ready"), ready ? 'good' : undefined);
		stat(String(attention.length), localize('voltSettings.statAttention', "Need setup"), attention.length ? 'warn' : undefined);
		stat(`${enabledModels}/${totalModels}`, localize('voltSettings.statModels', "Models in picker"));

		if (attention.length) {
			this.sectionTitle(parent, localize('voltSettings.needsSetup', "Needs setup"));
			const list = append(parent, $('.volt-settings-group'));
			for (const status of this.sorted(attention)) {
				const setup = status.kind === 'agent' ? this.setupStates.get(status.providerId) : undefined;
				const running = this.running.get(status.profileId);
				const row = append(list, $('.volt-pm-setup-row'));
				append(row, $('span.volt-pm-icon')).appendChild(createBrandIcon(status.providerId, 14));
				const copy = append(row, $('.copy'));
				append(copy, $('.name')).textContent = status.label;
				const { tone, label } = this.statusLine(status, setup, running);
				const line = append(copy, $('.detail'));
				append(line, $(`span.volt-settings-dot.${tone}`));
				append(line, $('span')).textContent = label;
				this.renderActions(append(row, $('.volt-pm-actions')), status, setup, running);
				this.host.store.add(addDisposableListener(row, 'click', e => {
					if (!(e.target as HTMLElement).closest('button')) {
						this.select({ kind: 'provider', profileId: status.profileId });
					}
				}));
			}
		}

		this.sectionTitle(parent, localize('voltSettings.healthSection', "Health checks"));
		const group = append(parent, $('.volt-settings-group'));
		const control = this.row(group, localize('voltSettings.healthInterval', "Health check interval"), localize('voltSettings.healthIntervalDesc2', "How often Volt re-checks versions, sign-in and model lists in the background."));
		const choices = [0, 60, 300, 900, 3600];
		const select = this.host.store.add(new SelectBox(choices.map(seconds => ({ text: seconds === 0 ? localize('voltSettings.manual', "Manual only") : seconds < 3600 ? localize('voltSettings.everyMin', "Every {0} min", seconds / 60) : localize('voltSettings.everyHour', "Every hour") })), 0, this.contextViewService, this.host.selectBoxStyles(), { useCustomDrawn: true, ariaLabel: localize('voltSettings.healthInterval', "Health check interval") }));
		const current = this.runtime.getHealthCheckInterval();
		select.select(choices.reduce((best, value, index) => Math.abs(value - current) < Math.abs(choices[best] - current) ? index : best, 0));
		select.render(append(control, $('.volt-settings-select')));
		this.host.store.add(select.onDidSelect(e => void this.runtime.setHealthCheckInterval(choices[e.index])));
	}

	/** Not installed, signed out, or an API provider missing its key. */
	private needsAction(status: IVoltProviderStatus): boolean {
		if (status.kind === 'agent') {
			const setup = this.setupStates.get(status.providerId);
			return !!setup && (!setup.installed || setup.signIn.kind === 'signedOut');
		}
		return status.enabled && status.state === 'missing';
	}

	private statusLine(status: IVoltProviderStatus, setup: IAgentSetupState | undefined, running: RunningAction | undefined): { tone: string; label: string } {
		if (running?.action === 'install') {
			return { tone: 'checking', label: localize('voltSettings.installing', "Installing…") };
		}
		if (running?.action === 'login') {
			return { tone: 'checking', label: localize('voltSettings.signingIn', "Waiting for sign-in in the terminal…") };
		}
		if (setup && !setup.installed) {
			return { tone: 'missing', label: localize('voltSettings.notInstalled', "Not installed") };
		}
		if (setup?.signIn.kind === 'signedOut') {
			return { tone: 'disabled', label: localize('voltSettings.signedOut', "Installed · not signed in") };
		}
		if (!status.enabled) {
			return { tone: 'off', label: localize('voltSettings.off', "Off · hidden from the model picker") };
		}
		const account = status.account ?? (setup?.signIn.kind === 'signedIn' ? setup.signIn.account : undefined);
		const plan = status.plan ?? (setup?.signIn.kind === 'signedIn' ? setup.signIn.plan : undefined);
		switch (status.state) {
			case 'checking':
				return { tone: 'checking', label: localize('voltSettings.providerChecking', "Checking…") };
			case 'missing':
				if (status.kind === 'model' && LOCAL_DOWNLOADS[status.providerId]) {
					return { tone: 'missing', label: localize('voltSettings.localMissing', "Not running on this machine") };
				}
				return { tone: 'missing', label: status.detail ?? localize('voltSettings.unreachable', "Can't be reached") };
			default: {
				const parts = [account, plan].filter(Boolean);
				const models = status.models.length ? localize('voltSettings.modelCount', "{0} models", status.models.length) : undefined;
				const local = status.kind === 'model' && !!LOCAL_DOWNLOADS[status.providerId];
				const who = parts.length ? parts.join(' · ')
					: local ? localize('voltSettings.running', "Running")
						: status.state === 'authenticated' ? localize('voltSettings.signedIn', "Signed in") : localize('voltSettings.ready', "Ready");
				return { tone: status.state, label: [who, models].filter(Boolean).join(' · ') };
			}
		}
	}

	/** The next step for a provider: Install, Sign In, Download or Add Key. All share one width. */
	private renderActions(actions: HTMLElement, status: IVoltProviderStatus, setup: IAgentSetupState | undefined, running: RunningAction | undefined): void {
		if (running && running.action !== 'failed') {
			append(actions, $('span.volt-settings-spinner')).appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
			return;
		}
		if (status.kind === 'agent' && setup) {
			const install = this.setup.installCommand(setup);
			if (!setup.installed) {
				const docs = setup.info?.docsUrl;
				const openDocs = () => {
					if (docs) {
						void this.opener.open(URI.parse(docs), { openExternal: true });
					}
				};
				if (!install) {
					if (docs) {
						this.button(actions, localize('voltSettings.installGuide', "Install Guide"), true, localize('voltSettings.docs', "Open {0}", docs), openDocs);
					}
					return;
				}
				// The docs icon goes first, so the text buttons share one right edge down a list.
				if (docs) {
					this.button(actions, '', false, localize('voltSettings.docs', "Open {0}", docs), openDocs, Codicon.linkExternal);
				}
				const failed = running?.action === 'failed';
				this.button(actions, failed ? localize('voltSettings.retryInstall', "Retry Install") : localize('voltSettings.install', "Install"), true,
					failed ? localize('voltSettings.retryInstallHint', "Runs {0} in a terminal", install) : localize('voltSettings.installHint', "Runs {0}", install),
					() => failed ? void this.signInOrInstallInTerminal(status, setup, 'install') : void this.install(status, setup));
				return;
			}
			const login = this.setup.loginCommand(setup);
			if (login && setup.signIn.kind !== 'signedIn') {
				const hint = setup.info?.loginHint
					? localize('voltSettings.signInHintType', "Opens {0} in a terminal; type {1} there", login, setup.info.loginHint)
					: localize('voltSettings.signInHint', "Runs {0} in a terminal", login);
				this.button(actions, localize('voltSettings.signIn', "Sign In"), setup.signIn.kind === 'signedOut', hint, () => void this.signInOrInstallInTerminal(status, setup, 'login'));
			}
			return;
		}
		if (status.kind === 'model') {
			const download = LOCAL_DOWNLOADS[status.providerId];
			if (download && status.state === 'missing') {
				this.button(actions, localize('voltSettings.download', "Download"), true, download, () => void this.opener.open(URI.parse(download), { openExternal: true }));
				return;
			}
			const profile = this.profile(status.profileId);
			if (profile?.authKind === 'apikey' && (!profile.hasSecret || status.state === 'missing')) {
				this.button(actions, profile.hasSecret ? localize('voltSettings.replaceKey', "Replace Key") : localize('voltSettings.addKey', "Add Key"), true, localize('voltSettings.addKeyHint', "Saved in the OS keychain"), () => this.openKeyEditor(status.profileId));
			}
		}
	}

	private openKeyEditor(profileId: string): void {
		this.keyEditor.add(profileId);
		if (this.selection.kind !== 'provider' || this.selection.profileId !== profileId) {
			this.select({ kind: 'provider', profileId });
			return;
		}
		this.host.rerender();
	}

	private button(parent: HTMLElement, label: string, primary: boolean, tooltip: string, run: () => void, icon?: ThemeIcon): HTMLButtonElement {
		const button = append(parent, $('button.volt-settings-action')) as HTMLButtonElement;
		button.type = 'button';
		button.classList.toggle('primary', primary);
		button.classList.toggle('icon-only', !label);
		if (icon) {
			button.appendChild(renderIcon(icon));
		}
		if (label) {
			append(button, $('span')).textContent = label;
		} else {
			button.setAttribute('aria-label', tooltip);
		}
		setAgentTooltip(button, tooltip);
		this.host.store.add(addDisposableListener(button, 'click', e => {
			e.stopPropagation();
			run();
		}));
		return button;
	}

	private profile(profileId: string): IProviderProfile | undefined {
		return this.runtime.listProfiles().find(candidate => candidate.id === profileId);
	}

	private renderProvider(parent: HTMLElement, status: IVoltProviderStatus): void {
		const setup = status.kind === 'agent' ? this.setupStates.get(status.providerId) : undefined;
		const running = this.running.get(status.profileId);
		const installed = status.kind !== 'agent' || !setup || setup.installed;
		const profile = this.profile(status.profileId);

		const version = setup?.version ?? status.version;
		const actions = this.detailHead(parent, createBrandIcon(status.providerId, 22), status.label, title => {
			if (version && installed) {
				append(title, $('span.version')).textContent = version.startsWith('v') ? version : `v${version}`;
			}
			if (status.earlyAccess) {
				append(title, $('span.badge')).textContent = localize('voltSettings.earlyAccess', "Early Access");
			}
		}, this.statusLine(status, setup, running));
		this.renderActions(actions, status, setup, running);
		if (installed) {
			const toggle = this.host.switch(actions, status.enabled, localize('voltSettings.providerInPicker', "Show {0} in the model picker", status.label), () => void this.runtime.setProfileEnabled(status.profileId, !status.enabled));
			setAgentTooltip(toggle, status.enabled ? localize('voltSettings.providerOn', "On: its models show in the picker") : localize('voltSettings.providerOff', "Off: hidden from the picker"));
		}

		if (running?.action === 'failed') {
			const failure = append(parent, $('.volt-settings-provider-failure'));
			append(failure, $('.title')).textContent = localize('voltSettings.installFailed', "The install did not finish.");
			append(failure, $('pre')).textContent = running.output.trim().split('\n').slice(-8).join('\n') || running.command;
		}
		if (this.keyEditor.has(status.profileId)) {
			this.renderKeyEditor(parent, status);
		}

		if (status.kind === 'agent') {
			this.renderAgentConnection(parent, status, setup, profile);
		} else if (profile) {
			this.renderApiConnection(parent, status, profile);
		}
		this.renderModels(parent, status);

		const footer = append(parent, $('.volt-settings-provider-links'));
		if (setup?.info?.docsUrl) {
			const docs = setup.info.docsUrl;
			this.link(footer, localize('voltSettings.docsLink', "Docs"), Codicon.book, () => void this.opener.open(URI.parse(docs), { openExternal: true }));
		}
		if (setup?.installed && this.setup.loginCommand(setup) && setup.signIn.kind === 'signedIn') {
			this.link(footer, localize('voltSettings.signInAgain', "Sign in again"), Codicon.account, () => void this.signInOrInstallInTerminal(status, setup, 'login'));
		}
		if (profile && !profile.id.startsWith('seed-')) {
			this.link(footer, localize('voltSettings.removeProvider', "Remove provider"), Codicon.trash, () => {
				this.selection = { kind: 'overview' };
				void this.runtime.deleteProfile(profile.id);
			}, 'danger');
		}
	}

	private renderAgentConnection(parent: HTMLElement, status: IVoltProviderStatus, setup: IAgentSetupState | undefined, profile: IProviderProfile | undefined): void {
		const account = status.account ?? (setup?.signIn.kind === 'signedIn' ? setup.signIn.account : undefined);
		const plan = status.plan ?? (setup?.signIn.kind === 'signedIn' ? setup.signIn.plan : undefined);
		this.sectionTitle(parent, localize('voltSettings.connection', "Connection"));
		if (profile?.providerId === 'acp-generic') {
			// A custom agent is just a command; all of it can change.
			const group = append(parent, $('.volt-settings-group'));
			const nameTitle = localize('voltSettings.label', "Name");
			const commandTitle = localize('voltSettings.command', "Command");
			const argsTitle = localize('voltSettings.args', "Args");
			const cwdTitle = localize('voltSettings.cwd', "Working directory");
			const name = this.draftInput(this.row(group, nameTitle), 'agent-name', profile.label, localize('voltSettings.agentName.placeholder', "My agent"), nameTitle);
			const command = this.draftInput(this.row(group, commandTitle, localize('voltSettings.commandDesc', "An executable on your PATH, or a full path.")), 'agent-command', profile.command ?? '', 'my-agent', commandTitle);
			const args = this.draftInput(this.row(group, argsTitle, localize('voltSettings.argsDesc', "Separated by spaces. Most agents start their ACP server with `acp`.")), 'agent-args', (profile.args ?? []).join(' '), 'acp', argsTitle);
			const cwd = this.draftInput(this.row(group, cwdTitle, localize('voltSettings.cwdDesc', "Where the agent starts. Empty: the chat's project.")), 'agent-cwd', profile.cwd ?? '', localize('voltSettings.cwd.placeholder', "Optional"), cwdTitle);
			const footer = append(group, $('.volt-pm-form-actions.volt-pm-actions'));
			this.button(footer, localize('voltSettings.save', "Save"), true, localize('voltSettings.saveAgentHint', "Restarts the agent with these settings on its next chat"), () => {
				if (!command.value.trim()) {
					command.focus();
					return;
				}
				this.drafts.clear();
				void this.runtime.upsertProfile({
					...this.draftOf(profile),
					label: name.value.trim() || command.value.trim(),
					command: command.value.trim(),
					args: args.value.trim() ? args.value.trim().split(/\s+/) : ['acp'],
					cwd: cwd.value.trim() || undefined,
				}).then(() => this.runtime.refreshProviders());
			});
		}
		const facts = append(parent, $('.volt-settings-group'));
		this.valueRow(facts, localize('voltSettings.factPath', "Executable"), setup?.path ?? profile?.command, { mono: true, copy: true });
		this.valueRow(facts, localize('voltSettings.factLaunch', "Launch command"), [profile?.command, ...(profile?.args ?? [])].filter(Boolean).join(' '), { mono: true, copy: true });
		this.valueRow(facts, localize('voltSettings.factAccount', "Account"), account);
		this.valueRow(facts, localize('voltSettings.factPlan', "Plan"), plan);
		this.valueRow(facts, localize('voltSettings.factProtocol', "Protocol"), localize('voltSettings.acpProtocol', "Agent Client Protocol over stdio"));
		this.valueRow(facts, localize('voltSettings.factChecked', "Last checked"), status.checkedAt ? fromNow(status.checkedAt, true, true) : undefined);
	}

	private renderApiConnection(parent: HTMLElement, status: IVoltProviderStatus, profile: IProviderProfile): void {
		const meta = API_PROVIDERS.find(candidate => candidate.id === status.providerId);
		this.sectionTitle(parent, localize('voltSettings.connection', "Connection"));
		const group = append(parent, $('.volt-settings-group'));
		const nameTitle = localize('voltSettings.label', "Name");
		const urlTitle = localize('voltSettings.baseUrl', "Base URL");
		const name = this.draftInput(this.row(group, nameTitle, localize('voltSettings.nameDesc', "How the provider shows in the list and the model picker.")), 'api-name', profile.label, meta?.label ?? '', nameTitle);
		const baseUrl = this.draftInput(this.row(group, urlTitle, localize('voltSettings.baseUrlDesc', "Point at a proxy, a gateway or another port. Empty: the provider's default.")), 'api-url', profile.endpoint?.baseURL ?? '', meta?.baseUrl ?? localize('voltSettings.defaultEndpoint', "Default"), urlTitle);
		const footer = append(group, $('.volt-pm-form-actions.volt-pm-actions'));
		this.button(footer, localize('voltSettings.save', "Save"), true, localize('voltSettings.saveProviderHint', "Saves and reloads the model list"), () => {
			const url = baseUrl.value.trim();
			this.drafts.clear();
			void this.runtime.upsertProfile({
				...this.draftOf(profile),
				label: name.value.trim() || meta?.label || profile.label,
				endpoint: url ? { baseURL: url } : undefined,
			}).then(() => this.runtime.refreshProviders());
		});

		const facts = append(parent, $('.volt-settings-group.volt-pm-facts'));
		if (profile.authKind === 'apikey') {
			const control = this.row(facts, localize('voltSettings.apiKey', "API key"), profile.hasSecret ? localize('voltSettings.keySaved', "Saved in the OS keychain") : localize('voltSettings.keyMissing', "Not set"));
			const actions = append(control, $('.volt-pm-actions'));
			this.button(actions, profile.hasSecret ? localize('voltSettings.replaceKey', "Replace Key") : localize('voltSettings.addKey', "Add Key"), !profile.hasSecret, localize('voltSettings.addKeyHint', "Saved in the OS keychain"), () => this.openKeyEditor(profile.id));
		}
		this.valueRow(facts, localize('voltSettings.factApiStyle', "API"), profile.apiStyle ? API_STYLE_LABELS[profile.apiStyle] : undefined);
		this.valueRow(facts, localize('voltSettings.factAccount', "Account"), status.account);
		this.valueRow(facts, localize('voltSettings.factPlan', "Plan"), status.plan);
		this.valueRow(facts, localize('voltSettings.factChecked', "Last checked"), status.checkedAt ? fromNow(status.checkedAt, true, true) : undefined);
	}

	/** The profile as a draft, so a save changes only the fields it names. */
	private draftOf(profile: IProviderProfile): IProviderProfileDraft {
		return {
			id: profile.id, label: profile.label, kind: profile.kind, providerId: profile.providerId, modelId: profile.modelId, enabled: profile.enabled,
			transport: profile.transport, apiStyle: profile.apiStyle, endpoint: profile.endpoint, authKind: profile.authKind,
			command: profile.command, args: profile.args, cwd: profile.cwd,
		};
	}

	private renderKeyEditor(parent: HTMLElement, status: IVoltProviderStatus): void {
		const editor = append(parent, $('.volt-settings-provider-key'));
		const profile = this.profile(status.profileId);
		const meta = API_PROVIDERS.find(candidate => candidate.id === status.providerId);
		const input = this.host.store.add(new InputBox(append(editor, $('.volt-settings-input.grow')), this.contextViewService, {
			placeholder: meta?.keyHint ? localize('voltSettings.keyPlaceholder', "API key ({0})", meta.keyHint) : localize('voltSettings.keyPlaceholderPlain', "API key"),
			ariaLabel: localize('voltSettings.apiKey', "API key"),
			type: 'password',
			inputBoxStyles: this.host.inputBoxStyles(),
		}));
		const save = () => {
			const key = input.value.trim();
			if (!key || !profile) {
				return;
			}
			this.keyEditor.delete(status.profileId);
			void this.runtime.upsertProfile({ ...this.draftOf(profile), enabled: true }, key).then(() => this.runtime.refreshProviders());
		};
		const actions = append(editor, $('.volt-pm-actions'));
		this.button(actions, localize('voltSettings.save', "Save"), true, localize('voltSettings.addKeyHint', "Saved in the OS keychain"), save);
		this.button(actions, localize('voltSettings.cancel', "Cancel"), false, localize('voltSettings.cancel', "Cancel"), () => {
			this.keyEditor.delete(status.profileId);
			this.host.rerender();
		});
		if (meta?.docs) {
			const docs = meta.docs;
			this.button(actions, '', false, localize('voltSettings.getKey', "Get a key: {0}", docs), () => void this.opener.open(URI.parse(docs), { openExternal: true }), Codicon.linkExternal);
		}
		this.host.store.add(addDisposableListener(input.inputElement, 'keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				save();
			} else if (e.key === 'Escape') {
				this.keyEditor.delete(status.profileId);
				this.host.rerender();
			}
		}));
		mainWindow.setTimeout(() => input.focus());
	}

	private link(parent: HTMLElement, label: string, icon: ThemeIcon, run: () => void, tone?: string): HTMLButtonElement {
		const link = append(parent, $('button.volt-settings-link')) as HTMLButtonElement;
		link.type = 'button';
		if (tone) {
			link.classList.add(tone);
		}
		link.appendChild(renderIcon(icon));
		append(link, $('span')).textContent = label;
		this.host.store.add(addDisposableListener(link, 'click', run));
		return link;
	}

	/**
	 * The provider's models as a dense list: name, model id, what it can do and its context on one
	 * line, and a switch. A row opens the model. Models off the picker sink to the end and fade. The
	 * filter narrows the list in place, so typing never loses focus to a re-render.
	 */
	private renderModels(parent: HTMLElement, status: IVoltProviderStatus): void {
		const models = [...status.models].sort((a, b) => Number(b.enabled) - Number(a.enabled));
		const heading = this.sectionTitle(parent, localize('voltSettings.modelsTitle', "Models"));
		if (!models.length) {
			append(parent, $('.volt-settings-empty')).textContent = status.kind === 'agent'
				? localize('voltSettings.agentNoModels', "No model list yet. It shows up once the agent is installed and signed in, or the agent picks its own model.")
				: localize('voltSettings.providerNoModels', "No models reported yet. Add a key or start the app, then refresh.");
			return;
		}
		const on = models.filter(model => model.enabled).length;
		if (models.length > 1) {
			const enable = on < models.length;
			this.link(heading, enable ? localize('voltSettings.enableAll', "Enable all") : localize('voltSettings.disableAll', "Disable all"), enable ? Codicon.eye : Codicon.eyeClosed, async () => {
				for (const model of models) {
					if (model.enabled !== enable) {
						await this.runtime.setModelEnabled(model.ref, enable);
					}
				}
			});
		}
		const group = append(parent, $('.volt-settings-group.volt-pm-models-group'));
		const toolbar = append(group, $('.volt-settings-models-toolbar'));
		const filter = this.host.store.add(new InputBox(append(toolbar, $('.volt-settings-input.filter')), this.contextViewService, {
			placeholder: localize('voltSettings.filterModels', "Filter models"),
			ariaLabel: localize('voltSettings.filterModels', "Filter models"),
			inputBoxStyles: this.host.inputBoxStyles(),
		}));
		this.trackFocus(filter.inputElement, 'models-filter');
		const hidden = models.length - on;
		append(toolbar, $('span.count')).textContent = hidden
			? localize('voltSettings.modelCountHidden', "{0} models · {1} hidden", models.length, hidden)
			: localize('voltSettings.modelCountAll', "{0} models", models.length);

		const list = append(group, $('.volt-settings-models'));
		const rows: { row: HTMLElement; text: string }[] = [];
		let hiddenHead: HTMLElement | undefined;
		for (const model of models) {
			if (!model.enabled && !hiddenHead) {
				hiddenHead = append(list, $('.volt-settings-models-group'));
				hiddenHead.textContent = localize('voltSettings.hiddenModels', "Hidden from picker");
			}
			rows.push({ row: this.modelRow(list, model, status.label), text: `${model.label} ${model.id} ${model.qualifier ?? ''}`.toLowerCase() });
		}
		const empty = append(list, $('.volt-settings-models-none'));
		empty.textContent = localize('voltSettings.noModelMatch', "No models match.");
		empty.hidden = true;
		const apply = (value: string) => {
			const needle = value.trim().toLowerCase();
			let shown = 0;
			for (const { row, text } of rows) {
				row.hidden = !!needle && !text.includes(needle);
				shown += row.hidden ? 0 : 1;
			}
			if (hiddenHead) {
				hiddenHead.hidden = !!needle;
			}
			empty.hidden = shown > 0;
		};
		const draft = this.drafts.get('models-filter');
		if (draft) {
			filter.value = draft;
			apply(draft);
		}
		this.host.store.add(filter.onDidChange(value => {
			this.drafts.set('models-filter', value);
			apply(value);
		}));
	}

	/** What the model can do, as short text: context, effort range, fast mode, images, tools. */
	private modelTraits(model: IVoltCatalogItem): string[] {
		const traits: string[] = [];
		const context = (model.contextLabel ? normalizeContext(model.contextLabel) : undefined)
			?? model.optionDescriptors?.find(descriptor => descriptor.id === MODEL_OPTION_CONTEXT)?.options?.map(option => normalizeContext(option.label)).join(' / ')
			?? (model.capabilities.contextWindow ? formatContext(model.capabilities.contextWindow) : undefined);
		if (context) {
			traits.push(context);
		}
		const reasoning = model.optionDescriptors?.find(descriptor => descriptor.id === MODEL_OPTION_REASONING)?.options;
		if (reasoning?.length) {
			traits.push(reasoning.length > 1
				// allow-any-unicode-next-line
				? localize('voltSettings.traitEffortRange', "Effort {0}–{1}", reasoning[0].label, reasoning[reasoning.length - 1].label)
				: localize('voltSettings.traitEffort', "Effort {0}", reasoning[0].label));
		} else if (model.capabilities.reasoning) {
			traits.push(localize('voltSettings.traitReasoning', "Reasoning"));
		}
		if (model.optionDescriptors?.some(descriptor => descriptor.id === MODEL_OPTION_FAST)) {
			traits.push(localize('voltSettings.traitFast', "Fast mode"));
		}
		if (model.capabilities.vision) {
			traits.push(localize('voltSettings.traitImages', "Images"));
		}
		if (model.kind === 'model' && model.capabilities.toolCalling) {
			traits.push(localize('voltSettings.traitTools', "Tools"));
		}
		return traits;
	}

	private modelRow(list: HTMLElement, model: IVoltCatalogItem, providerLabel: string): HTMLElement {
		const row = append(list, $('.volt-settings-model-row'));
		row.classList.toggle('off', !model.enabled);
		row.tabIndex = 0;
		const name = append(row, $('.name'));
		append(name, $('span.label')).textContent = model.label;
		if (model.qualifier && model.qualifier.toLowerCase() !== providerLabel.toLowerCase()) {
			append(name, $('span.qualifier')).textContent = model.qualifier;
		}
		if (model.id && model.id.toLowerCase() !== model.label.toLowerCase()) {
			append(name, $('code.slug')).textContent = model.id;
		}
		append(row, $('span.traits')).textContent = this.modelTraits(model).join(' · ');
		const toggle = this.host.switch(row, model.enabled, localize('voltSettings.showInPicker', "Show {0} in the model picker", model.label), () => void this.runtime.setModelEnabled(model.ref, !model.enabled));
		toggle.classList.add('small');
		// The switch flips visibility; it does not open the model.
		this.host.store.add(addDisposableListener(toggle, 'click', e => e.stopPropagation()));
		append(row, $('span.volt-pm-row-chevron')).appendChild(renderIcon(Codicon.chevronRight));
		this.onActivate(row, () => this.select({ kind: 'model', ref: model.ref }));
		return row;
	}

	private renderModel(parent: HTMLElement, model: IVoltCatalogItem, status: IVoltProviderStatus): void {
		const actions = this.detailHead(parent, createBrandIcon(status.providerId, 22), model.label, title => {
			if (model.qualifier && model.qualifier.toLowerCase() !== status.label.toLowerCase()) {
				append(title, $('span.version')).textContent = model.qualifier;
			}
		}, {
			tone: model.enabled ? 'authenticated' : 'off',
			label: [status.label, model.enabled ? localize('voltSettings.inPicker', "In the model picker") : localize('voltSettings.hiddenFromPicker', "Hidden from the model picker")].join(' · '),
		});
		const back = this.button(actions, localize('voltSettings.providerShort', "Provider"), false, localize('voltSettings.openProvider', "Open {0}", status.label), () => this.select({ kind: 'provider', profileId: status.profileId }), Codicon.arrowLeft);
		back.classList.add('ghost');
		this.host.switch(actions, model.enabled, localize('voltSettings.showInPicker', "Show {0} in the model picker", model.label), () => void this.runtime.setModelEnabled(model.ref, !model.enabled));

		if (model.description || model.detail) {
			append(parent, $('.volt-pm-desc')).textContent = [model.description, model.detail].filter(Boolean).join(' · ');
		}

		this.renderModelOptions(parent, model);
		if (model.kind === 'model') {
			this.renderSampling(parent, model, status);
		}
		this.renderUseFor(parent, model);
		this.renderCapabilities(parent, model);

		this.sectionTitle(parent, localize('voltSettings.identifiers', "Identifiers"));
		const ids = append(parent, $('.volt-settings-group'));
		this.valueRow(ids, localize('voltSettings.modelId', "Model id"), model.id, { mono: true, copy: true });
		this.valueRow(ids, localize('voltSettings.catalogRef', "Catalog ref"), model.ref, { mono: true, copy: true });
		this.valueRow(ids, localize('voltSettings.providerId', "Provider"), `${status.label} (${status.providerId})`);
	}

	/**
	 * The options the provider says this model takes (effort, context, tier, fast, thinking), as the
	 * defaults Volt sends. The composer's model menu reads and writes the same values.
	 */
	private renderModelOptions(parent: HTMLElement, model: IVoltCatalogItem): void {
		const descriptors = model.optionDescriptors ?? [];
		const selectable = traitDescriptors(descriptors);
		const stored = this.runtime.getModelOptions(model.ref);
		// A one-choice option is not a setting, but still says what the model runs with.
		const fixed = descriptors.filter(descriptor => !isSelectableDescriptor(descriptor) && optionValue(descriptor, stored) !== undefined);
		const heading = this.sectionTitle(parent, localize('voltSettings.requestDefaults', "Request defaults"), localize('voltSettings.requestDefaultsHint', "What Volt sends with this model unless you change it in the composer's model menu. Both edit the same values."));
		if (selectable.some(descriptor => stored[descriptor.id] !== undefined)) {
			this.link(heading, localize('voltSettings.resetDefaults', "Reset"), Codicon.discard, () => {
				const next = { ...this.runtime.getModelOptions(model.ref) };
				for (const descriptor of descriptors) {
					delete next[descriptor.id];
				}
				void this.runtime.setModelOptions(model.ref, next);
			});
		}
		if (!selectable.length && !fixed.length) {
			append(parent, $('.volt-settings-empty')).textContent = model.kind === 'agent'
				? localize('voltSettings.agentNoOptions', "The agent chooses its own settings for this model.")
				: localize('voltSettings.noOptions', "This model takes no options.");
			return;
		}
		const group = append(parent, $('.volt-settings-group'));
		for (const descriptor of selectable) {
			const control = this.row(group, descriptor.label, OPTION_HINTS[descriptor.id]);
			this.optionControl(control, model, descriptor);
		}
		for (const descriptor of fixed) {
			const value = optionValue(descriptor, stored);
			const choice = descriptor.options?.find(option => option.value === value);
			this.valueRow(group, descriptor.label, choice?.label ?? (value === undefined ? undefined : String(value)));
		}
	}

	private optionControl(host: HTMLElement, model: IVoltCatalogItem, descriptor: IModelOptionDescriptor): void {
		const stored = this.runtime.getModelOptions(model.ref);
		const value = optionValue(descriptor, stored);
		const write = (next: string | boolean) => void this.runtime.setModelOptions(model.ref, { ...this.runtime.getModelOptions(model.ref), [descriptor.id]: next });
		if (descriptor.type === 'boolean') {
			this.host.switch(host, value === true, descriptor.label, () => write(value !== true));
			return;
		}
		const choices = descriptor.options ?? [];
		const items: ISelectOptionItem[] = choices.map(choice => ({ text: choice.isDefault ? localize('voltSettings.choiceDefault', "{0} (default)", choice.label) : choice.label }));
		const select = this.host.store.add(new SelectBox(items, Math.max(0, choices.findIndex(choice => choice.value === value)), this.contextViewService, this.host.selectBoxStyles(), { useCustomDrawn: true, ariaLabel: descriptor.label }));
		select.render(append(host, $('.volt-settings-select')));
		this.host.store.add(select.onDidSelect(e => write(choices[e.index].value)));
	}

	/** Temperature, top P and the output cap, sent with every request to this API model when set. */
	private renderSampling(parent: HTMLElement, model: IVoltCatalogItem, status: IVoltProviderStatus): void {
		const stored = this.runtime.getModelOptions(model.ref);
		const notes: string[] = [localize('voltSettings.samplingHint', "Sent with every request to this model. Leave a field empty for the provider's default.")];
		if (status.providerId === 'anthropic') {
			notes.push(localize('voltSettings.samplingClaude', "Claude takes one of temperature and top P, up to 1, and neither while extended thinking is on. Its output cap is at least 1,024 tokens."));
		} else if (status.providerId === 'openai' && model.capabilities.reasoning) {
			notes.push(localize('voltSettings.samplingOpenAiReasoning', "OpenAI's reasoning models do not take temperature or top P, so Volt leaves them out."));
		}
		const heading = this.sectionTitle(parent, localize('voltSettings.sampling', "Sampling"), notes.join(' '));
		if (MODEL_GENERATION_PARAMS.some(spec => stored[spec.id] !== undefined)) {
			this.link(heading, localize('voltSettings.resetDefaults', "Reset"), Codicon.discard, () => {
				const next = { ...this.runtime.getModelOptions(model.ref) };
				for (const spec of MODEL_GENERATION_PARAMS) {
					delete next[spec.id];
				}
				void this.runtime.setModelOptions(model.ref, next);
			});
		}
		const group = append(parent, $('.volt-settings-group'));
		const copy: Record<string, { title: string; desc: string; placeholder: string }> = {
			[MODEL_PARAM_TEMPERATURE]: {
				title: localize('voltSettings.temperature', "Temperature"),
				desc: localize('voltSettings.temperatureDesc', "0 to 2. Lower is steadier and more literal, higher is more varied."),
				placeholder: localize('voltSettings.paramDefault', "Default"),
			},
			[MODEL_PARAM_TOP_P]: {
				title: localize('voltSettings.topP', "Top P"),
				desc: localize('voltSettings.topPDesc', "0 to 1. Samples only from the likeliest tokens that add up to this share."),
				placeholder: localize('voltSettings.paramDefault', "Default"),
			},
			[MODEL_PARAM_MAX_OUTPUT]: {
				title: localize('voltSettings.maxOutput', "Max output tokens"),
				desc: localize('voltSettings.maxOutputDesc', "Caps how long one reply can be. The model's own limit still applies."),
				placeholder: localize('voltSettings.paramDefault', "Default"),
			},
		};
		for (const spec of MODEL_GENERATION_PARAMS) {
			const text = copy[spec.id];
			this.paramInput(this.row(group, text.title, text.desc), model, spec, text.title, text.placeholder);
		}
	}

	private paramInput(host: HTMLElement, model: IVoltCatalogItem, spec: IModelParamSpec, title: string, placeholder: string): void {
		const key = `param-${spec.id}`;
		const range = spec.integer
			? localize('voltSettings.paramRangeInt', "A whole number from {0} to {1}.", spec.min, spec.max.toLocaleString())
			: localize('voltSettings.paramRange', "A number from {0} to {1}.", spec.min, spec.max);
		const input = this.host.store.add(new InputBox(append(host, $('.volt-settings-input.param')), this.contextViewService, {
			placeholder,
			ariaLabel: title,
			inputBoxStyles: this.host.inputBoxStyles(),
			validationOptions: { validation: value => !value.trim() || parseModelParam(spec.id, value) !== undefined ? null : { type: MessageType.ERROR, content: range } },
		}));
		const stored = this.runtime.getModelOptions(model.ref)[spec.id];
		input.value = this.drafts.get(key) ?? (typeof stored === 'string' ? stored : '');
		this.trackFocus(input.inputElement, key);
		this.host.store.add(input.onDidChange(value => this.drafts.set(key, value)));
		const commit = () => {
			const raw = input.value.trim();
			const parsed = parseModelParam(spec.id, raw);
			if (raw && parsed === undefined) {
				return;
			}
			this.drafts.delete(key);
			const current = this.runtime.getModelOptions(model.ref);
			const next = { ...current };
			if (parsed === undefined) {
				delete next[spec.id];
			} else {
				next[spec.id] = String(parsed);
			}
			if (next[spec.id] !== current[spec.id]) {
				void this.runtime.setModelOptions(model.ref, next);
			}
		};
		this.host.store.add(addDisposableListener(input.inputElement, 'blur', () => {
			// Saving re-renders the page. Under a pointer that pulled focus away (a row, a switch),
			// that would swap the element out before its click lands, so the save waits for it.
			if (!this.pointerDown) {
				commit();
				return;
			}
			const win = input.inputElement.ownerDocument.defaultView ?? mainWindow;
			const release = () => {
				win.removeEventListener('pointerup', release, true);
				win.removeEventListener('pointercancel', release, true);
				win.setTimeout(commit);
			};
			win.addEventListener('pointerup', release, true);
			win.addEventListener('pointercancel', release, true);
		}));
		this.host.store.add(addDisposableListener(input.inputElement, 'keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				commit();
			}
		}));
	}

	/** The other places Volt can run this model: new chats, generated text, commits, Tab. */
	private renderUseFor(parent: HTMLElement, model: IVoltCatalogItem): void {
		this.sectionTitle(parent, localize('voltSettings.useFor', "Use for"), localize('voltSettings.useForHint', "Where Volt runs this model besides the chats you start on it."));
		const group = append(parent, $('.volt-settings-group'));
		const isDefault = (this.configurationService.getValue<string>(AGENT_DEFAULT_MODEL_SETTING) || undefined) === model.ref;
		this.host.switch(this.row(group, localize('voltSettings.useDefault', "Default for new chats"), localize('voltSettings.useDefaultDesc', "New chats start on this model. A project's own default still wins.")), isDefault, localize('voltSettings.useDefault', "Default for new chats"), () => {
			void this.configurationService.updateValue(AGENT_DEFAULT_MODEL_SETTING, isDefault ? '' : model.ref).then(() => this.host.rerender());
		});
		const tasks = this.runtime.getTaskModels();
		const slot = (key: keyof IVoltTaskModels, title: string, desc: string) => {
			const on = tasks[key] === model.ref;
			this.host.switch(this.row(group, title, desc), on, title, () => void this.runtime.setTaskModel(key, on ? undefined : model.ref));
		};
		slot('title', localize('voltSettings.useTitles', "Chat titles and generated text"), localize('voltSettings.useTitlesDesc', "Off: each chat names itself with its own model."));
		slot('git', localize('voltSettings.useGit', "Commit messages and pull requests"), localize('voltSettings.useGitDesc', "Off: the text generation model writes them."));
		slot('tab', localize('voltSettings.useTab', "Tab predictions"), localize('voltSettings.useTabDesc', "Off: predictions follow the composer's model."));
	}

	private renderCapabilities(parent: HTMLElement, model: IVoltCatalogItem): void {
		const caps = model.capabilities;
		this.sectionTitle(parent, localize('voltSettings.capabilities', "Capabilities"));
		const group = append(parent, $('.volt-settings-group'));
		const context = (model.contextLabel ? normalizeContext(model.contextLabel) : undefined) ?? (caps.contextWindow ? formatContext(caps.contextWindow) : undefined);
		this.valueRow(group, localize('voltSettings.contextWindow', "Context window"), context ? localize('voltSettings.contextTokens', "{0} tokens", context) : undefined);
		const reasoning = model.optionDescriptors?.find(descriptor => descriptor.id === MODEL_OPTION_REASONING)?.options;
		this.valueRow(group, localize('voltSettings.effortLevels', "Effort levels"), reasoning?.length ? reasoning.map(option => option.label).join(', ') : undefined);
		const chips = append(group, $('.volt-pm-caps'));
		const items: [string, boolean][] = [
			[localize('voltSettings.capStreaming', "Streaming"), caps.streaming],
			[localize('voltSettings.capReasoning', "Reasoning"), caps.reasoning],
			[localize('voltSettings.capTools', "Tool calling"), caps.toolCalling],
			[localize('voltSettings.capParallel', "Parallel tool calls"), caps.parallelToolCalls],
			[localize('voltSettings.capVision', "Images"), caps.vision],
			[localize('voltSettings.capAttachments', "File attachments"), caps.attachments],
			[localize('voltSettings.capCaching', "Prompt caching"), caps.promptCaching],
			[localize('voltSettings.capStructured', "Structured output"), caps.structuredOutput],
			[localize('voltSettings.capMcp', "MCP servers"), caps.mcp],
			[localize('voltSettings.capAgent', "Own agent loop"), caps.nativeAgent],
		];
		for (const [label, on] of items) {
			const chip = append(chips, $('span.volt-pm-cap'));
			chip.classList.toggle('on', on);
			chip.appendChild(renderIcon(on ? Codicon.check : Codicon.dash));
			append(chip, $('span')).textContent = label;
		}
	}

	//#endregion

	//#region Focus and drafts

	/** Remembers the field so the next render can focus it again. */
	private trackFocus(element: HTMLElement, key: string): void {
		element.dataset.focusKey = key;
		this.host.store.add(addDisposableListener(element, 'focus', () => this.focusKey = key));
		this.host.store.add(addDisposableListener(element, 'blur', e => {
			const next = e.relatedTarget;
			if (next) {
				// Focus moved on: to another field (given back after a re-render) or to anything else.
				this.focusKey = isHTMLElement(next) ? next.dataset.focusKey : undefined;
				return;
			}
			// No target: a re-render removed the field and focuses its replacement in the same task,
			// or the window lost focus with the field still active. Neither clears the key.
			mainWindow.setTimeout(() => {
				const active = element.ownerDocument.activeElement as HTMLElement | null;
				if (this.focusKey === key && !active?.dataset.focusKey) {
					this.focusKey = undefined;
				}
			});
		}));
	}

	private restoreFocus(root: HTMLElement): void {
		if (!this.focusKey) {
			return;
		}
		const field = root.querySelector<HTMLInputElement>(`[data-focus-key="${this.focusKey}"]`);
		if (field && field.ownerDocument.activeElement !== field) {
			field.focus();
			const end = field.value.length;
			field.setSelectionRange?.(end, end);
		}
	}

	/** An input that keeps unsaved text across re-renders of the same selection. */
	private draftInput(host: HTMLElement, key: string, value: string, placeholder: string, ariaLabel: string): InputBox {
		const input = this.host.store.add(new InputBox(append(host, $('.volt-settings-input.wide')), this.contextViewService, {
			placeholder,
			ariaLabel,
			inputBoxStyles: this.host.inputBoxStyles(),
		}));
		input.value = this.drafts.get(key) ?? value;
		this.trackFocus(input.inputElement, key);
		this.host.store.add(input.onDidChange(next => this.drafts.set(key, next)));
		return input;
	}

	//#endregion

	//#region Install and sign-in

	/** Runs the vendor's install script in the background and shows progress on the card. */
	private async install(status: IVoltProviderStatus, setup: IAgentSetupState): Promise<void> {
		const command = this.setup.installCommand(setup);
		if (!command) {
			return;
		}
		this.running.set(status.profileId, { action: 'install', command });
		this.host.rerender();
		let output = '';
		let ok = false;
		try {
			const result = await this.stdio.exec({ id: `volt-install-${generateUuid().slice(0, 8)}`, command, timeoutMs: INSTALL_TIMEOUT_MS, inlineChars: 16_000, env: { NO_COLOR: '1', CI: '1' } });
			output = result.combined;
			ok = result.exitCode === 0 && !result.timedOut;
		} catch (error) {
			output = String(error);
		}
		const def = CLI_AGENT_DEFINITIONS.find(candidate => candidate.id === status.providerId);
		const next = def ? await this.setup.detect(def).catch(() => undefined) : undefined;
		if (next) {
			this.setupStates.set(next.id, next);
		}
		if (ok || next?.installed) {
			this.running.delete(status.profileId);
			if (!status.enabled) {
				await this.runtime.setProfileEnabled(status.profileId, true);
			}
			await this.runtime.refreshProviders();
		} else {
			this.running.set(status.profileId, { action: 'failed', command, output });
		}
		if (!this.disposed) {
			this.host.rerender();
		}
	}

	/**
	 * Sign-ins (and installs that failed in the background) need a real terminal: they open a
	 * browser, ask questions or want a password. The settings overlay steps aside so the terminal
	 * shows, and the CLI is asked again until it reports success or the terminal closes.
	 */
	private async signInOrInstallInTerminal(status: IVoltProviderStatus, setup: IAgentSetupState, action: 'install' | 'login'): Promise<void> {
		const command = action === 'install' ? this.setup.installCommand(setup) : this.setup.loginCommand(setup);
		const def = CLI_AGENT_DEFINITIONS.find(candidate => candidate.id === status.providerId);
		if (!command || !def) {
			return;
		}
		let onClosed;
		try {
			onClosed = await this.setup.runInTerminal(action, setup.label, command);
		} catch {
			return;
		}
		this.running.set(status.profileId, { action, command });
		this.host.rerender();
		this.host.revealWorkbench();

		const watch = new DisposableStore();
		const started = Date.now();
		const finish = () => {
			watch.dispose();
			this.running.delete(status.profileId);
			void this.runtime.refreshProviders();
			if (!this.disposed) {
				this.host.rerender();
			}
		};
		const check = async () => {
			const next = await this.setup.detect(def).catch(() => undefined);
			if (next) {
				this.setupStates.set(next.id, next);
			}
			return next && (action === 'install' ? next.installed : next.signIn.kind === 'signedIn');
		};
		const handle = mainWindow.setInterval(() => {
			if (Date.now() - started > SIGN_IN_POLL_LIMIT_MS) {
				finish();
				return;
			}
			void check().then(done => done && finish());
		}, SIGN_IN_POLL_MS);
		watch.add(toDisposable(() => mainWindow.clearInterval(handle)));
		watch.add(onClosed(() => void check().then(finish)));
	}

	//#endregion

	//#region Add

	private renderAddApi(parent: HTMLElement): void {
		this.detailHead(parent, renderIcon(Codicon.add), localize('voltSettings.addApiProvider', "Add API provider"), undefined, {
			tone: 'off',
			label: localize('voltSettings.addApiLead', "A model API Volt calls directly. The key stays in the OS keychain."),
		});
		const form = append(parent, $('.volt-settings-form'));
		let provider = API_PROVIDERS[0];
		const grid = append(form, $('.volt-settings-form-grid'));
		const providerBox = this.field(grid, localize('voltSettings.provider', "Provider"), host => {
			const box = this.host.store.add(new SelectBox(API_PROVIDERS.map(item => ({ text: item.label }) satisfies ISelectOptionItem), 0, this.contextViewService, this.host.selectBoxStyles(), { useCustomDrawn: true, ariaLabel: localize('voltSettings.provider', "Provider") }));
			box.render(host);
			return box;
		});
		const name = this.input(grid, localize('voltSettings.label', "Name"), localize('voltSettings.label.placeholder', "Display name (optional)"));
		const key = this.input(grid, localize('voltSettings.apiKey', "API key"), provider.keyHint ?? '', 'password');
		const baseUrl = this.input(grid, localize('voltSettings.baseUrl', "Base URL"), provider.baseUrl ?? localize('voltSettings.baseUrl.placeholder', "Optional"));
		const model = this.input(grid, localize('voltSettings.modelIdField', "Model id"), localize('voltSettings.modelId.placeholder', "Optional, e.g. gpt-4.1"));
		this.host.store.add(providerBox.onDidSelect(e => {
			provider = API_PROVIDERS[e.index];
			key.setPlaceHolder(authKind(provider.id) === 'none' ? localize('voltSettings.noKeyNeeded', "Not needed") : provider.keyHint ?? '');
			baseUrl.setPlaceHolder(provider.baseUrl ?? localize('voltSettings.baseUrl.placeholder', "Optional"));
		}));
		const actions = append(form, $('.volt-settings-actions.volt-pm-actions'));
		this.button(actions, localize('voltSettings.connect', "Connect"), true, localize('voltSettings.connectHint', "Adds the provider and lists its models"), () => {
			const draft: IProviderProfileDraft = {
				label: name.value.trim() || provider.label,
				kind: 'model',
				providerId: provider.id,
				transport: 'http',
				apiStyle: apiStyle(provider.id),
				authKind: authKind(provider.id),
				enabled: true,
				modelId: model.value.trim() || undefined,
			};
			const url = baseUrl.value.trim() || provider.baseUrl;
			if (url) {
				draft.endpoint = { baseURL: url };
			}
			void this.runtime.upsertProfile(draft, key.value.trim() || undefined).then(profile => {
				this.select({ kind: 'provider', profileId: profile.id });
				return this.runtime.refreshProviders();
			});
		});
		this.button(actions, localize('voltSettings.cancel', "Cancel"), false, localize('voltSettings.cancel', "Cancel"), () => this.select({ kind: 'overview' }));
	}

	private renderAddAgent(parent: HTMLElement): void {
		this.detailHead(parent, renderIcon(Codicon.add), localize('voltSettings.addCustomAgent', "Add custom ACP agent"), undefined, {
			tone: 'off',
			label: localize('voltSettings.addCustomAgentHint', "Any command that speaks the Agent Client Protocol over stdio."),
		});
		const form = append(parent, $('.volt-settings-form'));
		const grid = append(form, $('.volt-settings-form-grid'));
		const name = this.input(grid, localize('voltSettings.label', "Name"), localize('voltSettings.agentName.placeholder', "My agent"));
		const command = this.input(grid, localize('voltSettings.command', "Command"), 'my-agent');
		const args = this.input(grid, localize('voltSettings.args', "Args"), 'acp');
		const cwd = this.input(grid, localize('voltSettings.cwd', "Working directory"), localize('voltSettings.cwd.placeholder', "Optional"));
		const actions = append(form, $('.volt-settings-actions.volt-pm-actions'));
		this.button(actions, localize('voltSettings.connect', "Connect"), true, localize('voltSettings.connectAgentHint', "Adds the agent to the composer"), () => {
			if (!command.value.trim()) {
				command.focus();
				return;
			}
			void this.runtime.upsertProfile({
				label: name.value.trim() || command.value.trim(),
				kind: 'agent',
				providerId: 'acp-generic',
				transport: 'stdio',
				authKind: 'cli',
				enabled: true,
				command: command.value.trim(),
				args: args.value.trim() ? args.value.trim().split(/\s+/) : ['acp'],
				cwd: cwd.value.trim() || undefined,
			}).then(profile => {
				this.select({ kind: 'provider', profileId: profile.id });
				return this.runtime.refreshProviders();
			});
		});
		this.button(actions, localize('voltSettings.cancel', "Cancel"), false, localize('voltSettings.cancel', "Cancel"), () => this.select({ kind: 'overview' }));
	}

	private field<T>(parent: HTMLElement, title: string, render: (host: HTMLElement) => T): T {
		const field = append(parent, $('.volt-settings-field'));
		append(field, $('label')).textContent = title;
		return render(append(field, $('.volt-settings-control')));
	}

	private input(parent: HTMLElement, title: string, placeholder: string, type: 'text' | 'password' = 'text'): InputBox {
		return this.field(parent, title, host => this.host.store.add(new InputBox(host, this.contextViewService, {
			placeholder,
			ariaLabel: title,
			type,
			inputBoxStyles: this.host.inputBoxStyles(),
		})));
	}

	//#endregion
}
