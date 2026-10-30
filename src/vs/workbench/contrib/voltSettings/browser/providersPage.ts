/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, isHTMLElement, isHTMLInputElement } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IInputBoxStyles, InputBox, MessageType } from '../../../../base/browser/ui/inputbox/inputBox.js';
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
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { CLAUDE_ACCOUNT_SWITCHING_SETTING, CLAUDE_AUTO_SWITCH_THRESHOLD_SETTING, IVoltAccountsService, IVoltClaudeAccount, IVoltClaudeAccountsState } from '../../../../platform/voltAccounts/common/voltAccounts.js';
import { IVoltUsageLimitWindow } from '../../../../platform/voltUsage/common/voltUsage.js';
import { CLI_AGENT_DEFINITIONS } from '../../../services/voltRuntime/browser/agents/cliAgents.js';
import { createBrandIcon } from '../../../services/voltRuntime/browser/providers/providerBrands.js';
import { IModelOptionDescriptor, IModelParamSpec, isSelectableDescriptor, MODEL_GENERATION_PARAMS, MODEL_OPTION_CONTEXT, MODEL_OPTION_FAST, MODEL_OPTION_REASONING, MODEL_OPTION_SERVICE_TIER, MODEL_OPTION_THINKING, MODEL_PARAM_MAX_OUTPUT, MODEL_PARAM_TEMPERATURE, MODEL_PARAM_TOP_P, optionValue, parseModelParam, traitDescriptors } from '../../../services/voltRuntime/common/models/modelOptions.js';
import { IProviderProfile, IProviderProfileDraft, VoltApiStyle, VoltAuthKind } from '../../../services/voltRuntime/common/profiles.js';
import { IVoltCatalogItem, IVoltProviderStatus } from '../../../services/voltRuntime/common/providers.js';
import { IAgentRuntimeService, IVoltTaskModels } from '../../../services/voltRuntime/common/runtime.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { createRefreshSpinner, setRefreshSpinnerRunning } from '../../voltAgent/browser/usage/agentUsageIcons.js';
import { AGENT_DEFAULT_MODEL_SETTING } from '../../voltAgent/common/agentComposerSettings.js';
import { AgentSetupService, IAgentSetupState } from '../../voltSetup/browser/agentSetupService.js';
import { agentSetupInfo } from '../../voltSetup/common/agentSetup.js';
import { IVoltQuery, IVoltQueryCache, IVoltQueryHandle } from '../../../services/voltRuntime/browser/queryCache.js';
import { createVoltButton, VoltButtonKind } from '../../voltAgent/browser/chrome/voltButton.js';
import { createVoltDropdown, IVoltDropdownOption } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { createMessageCopyIcon } from '../../voltAgent/browser/blocks/agentCodeBlock.js';
import './media/providersPage.css';

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

/** A row of the left list. */
type ListRow =
	| { readonly kind: 'overview'; readonly attention: number }
	| { readonly kind: 'group'; readonly label: string }
	| { readonly kind: 'provider'; readonly status: IVoltProviderStatus }
	| { readonly kind: 'add'; readonly what: 'api' | 'agent'; readonly label: string }
	| { readonly kind: 'none' };

function listRowId(row: ListRow): string {
	switch (row.kind) {
		case 'provider': return `provider:${row.status.profileId}`;
		case 'add': return `add:${row.what}`;
		case 'group': return `group:${row.label}`;
		default: return row.kind;
	}
}

/** Group titles and the no-match line: in the list for layout, never focused or picked. */
function isStaticRow(row: ListRow | undefined): boolean {
	return row?.kind === 'group' || row?.kind === 'none';
}

/** An email address, up to an apostrophe ("x@y.com's Organization") or a separator. */
const EMAIL_PATTERN = /[^\s\u00b7@()]+@[^\s\u00b7@()'\u2019]+\.[^\s\u00b7@()'\u2019]+/g;

/**
 * Writes `text` with every email address in a span the CSS blurs until hovered, so a shared screen
 * does not show which accounts are signed in.
 */
function appendPrivateText(parent: HTMLElement, text: string): void {
	let last = 0;
	for (const match of text.matchAll(EMAIL_PATTERN)) {
		const at = match.index ?? 0;
		if (at > last) {
			parent.append(text.slice(last, at));
		}
		append(parent, $('span.volt-pm-private')).textContent = match[0];
		last = at + match[0].length;
	}
	if (last < text.length) {
		parent.append(text.slice(last));
	}
}

function listRowLabel(row: ListRow): string {
	switch (row.kind) {
		case 'overview': return localize('voltSettings.overview', "Overview");
		case 'provider': return row.status.label;
		case 'none': return localize('voltSettings.noProviderMatch', "Nothing matches your search.");
		default: return row.label;
	}
}

class ProviderRowDelegate implements IListVirtualDelegate<ListRow> {
	getHeight(row: ListRow): number {
		return row.kind === 'group' ? 34 : row.kind === 'none' ? 44 : 32;
	}
	getTemplateId(): string {
		return 'row';
	}
}

class ProviderRowRenderer implements IListRenderer<ListRow, HTMLElement> {
	readonly templateId = 'row';
	constructor(private readonly page: ProvidersPage) { }
	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.volt-pm-item'));
	}
	renderElement(row: ListRow, _index: number, element: HTMLElement): void {
		this.page.renderListRow(element, row);
	}
	disposeTemplate(): void { }
}

/** A row of a provider's model list: a model, the title over the hidden ones, or the no-match line. */
type ModelListRow =
	| { readonly kind: 'model'; readonly model: IVoltCatalogItem }
	| { readonly kind: 'hidden' }
	| { readonly kind: 'none' };

/** Every model row is one height, so the list sizes itself from its row count. */
const MODEL_ROW_HEIGHT = 32;
const MODEL_NOTE_HEIGHT = 30;
/** The model list grows with its rows up to this, then scrolls inside the card. */
const MODEL_LIST_MAX_HEIGHT = 12 * MODEL_ROW_HEIGHT;

class ModelRowDelegate implements IListVirtualDelegate<ModelListRow> {
	getHeight(row: ModelListRow): number {
		return row.kind === 'model' ? MODEL_ROW_HEIGHT : MODEL_NOTE_HEIGHT;
	}
	getTemplateId(row: ModelListRow): string {
		return row.kind === 'model' ? 'model' : 'note';
	}
}

interface IModelRowTemplate {
	readonly row: HTMLElement;
	readonly label: HTMLElement;
	readonly qualifier: HTMLElement;
	readonly slug: HTMLElement;
	readonly traits: HTMLElement;
	readonly toggle: HTMLButtonElement;
	readonly disposables: DisposableStore;
	model?: IVoltCatalogItem;
}

/** One model: name, qualifier, id and traits on a line, a switch for the picker and a chevron. */
class ModelRowRenderer implements IListRenderer<ModelListRow, IModelRowTemplate> {
	readonly templateId = 'model';
	constructor(
		private readonly providerLabel: string,
		private readonly traits: (model: IVoltCatalogItem) => string[],
		private readonly onToggle: (model: IVoltCatalogItem) => void,
	) { }
	renderTemplate(container: HTMLElement): IModelRowTemplate {
		const row = append(container, $('.volt-settings-model-row'));
		const name = append(row, $('.name'));
		const label = append(name, $('span.label'));
		const qualifier = append(name, $('span.qualifier'));
		const slug = append(name, $('code.slug'));
		const traits = append(row, $('span.traits'));
		const toggle = append(row, $('button.volt-settings-toggle.small')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.tabIndex = -1;
		toggle.setAttribute('role', 'switch');
		append(row, $('span.volt-pm-row-chevron')).appendChild(renderIcon(Codicon.chevronRight));
		const disposables = new DisposableStore();
		const template: IModelRowTemplate = { row, label, qualifier, slug, traits, toggle, disposables };
		// The switch flips visibility; the click stops here so the list does not open the model.
		disposables.add(addDisposableListener(toggle, 'click', e => {
			e.stopPropagation();
			if (template.model) {
				this.onToggle(template.model);
			}
		}));
		return template;
	}
	renderElement(row: ModelListRow, _index: number, template: IModelRowTemplate): void {
		if (row.kind !== 'model') {
			return;
		}
		const model = row.model;
		template.model = model;
		template.row.classList.toggle('off', !model.enabled);
		template.label.textContent = model.label;
		const qualifier = model.qualifier && model.qualifier.toLowerCase() !== this.providerLabel.toLowerCase() ? model.qualifier : '';
		template.qualifier.textContent = qualifier;
		template.qualifier.hidden = !qualifier;
		const slug = model.id && model.id.toLowerCase() !== model.label.toLowerCase() ? model.id : '';
		template.slug.textContent = slug;
		template.slug.hidden = !slug;
		template.traits.textContent = this.traits(model).join(' · ');
		template.toggle.classList.toggle('on', model.enabled);
		template.toggle.setAttribute('aria-checked', String(model.enabled));
		template.toggle.setAttribute('aria-label', localize('voltSettings.showInPicker', "Show {0} in the model picker", model.label));
	}
	disposeElement(_row: ModelListRow, _index: number, template: IModelRowTemplate): void {
		template.model = undefined;
	}
	disposeTemplate(template: IModelRowTemplate): void {
		template.disposables.dispose();
	}
}

/** The title over the models hidden from the picker, and the no-match line. */
class ModelNoteRenderer implements IListRenderer<ModelListRow, HTMLElement> {
	readonly templateId = 'note';
	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.volt-settings-models-note'));
	}
	renderElement(row: ModelListRow, _index: number, element: HTMLElement): void {
		// Not an item: the row paints no hover, focus or selection.
		element.parentElement?.classList.add('volt-pm-row-static');
		element.classList.toggle('none', row.kind === 'none');
		element.textContent = row.kind === 'none'
			? localize('voltSettings.noModelMatch', "No models match.")
			: localize('voltSettings.hiddenModels', "Hidden from picker");
	}
	disposeTemplate(): void { }
}

export interface IProvidersPageHost {
	/** Where the page goes (the body of the page's titled block). */
	target(): HTMLElement;
	readonly store: DisposableStore;
	search(): string;
	rerender(): void;
	/** The next render starts the page at the top (a new provider or model was picked). */
	scrollToTop(): void;
	/** Shows the window under the settings overlay, so a terminal the page opened can be used. */
	revealWorkbench(): void;
	switch(parent: HTMLElement, on: boolean, label: string, onClick: () => void): HTMLButtonElement;
	inputBoxStyles(): IInputBoxStyles;
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
 * Volt Settings > Providers & Models: every coding agent CLI and model API, as a list on the left,
 * and whatever is picked on the right. A provider shows its setup (Install, Sign In, Add Key,
 * Download), connection, accounts (Claude) and models; a model shows what Volt sends
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
	/** Saved Claude accounts (desktop only). */
	private readonly accounts: IVoltAccountsService | undefined;
	private accountsState: IVoltClaudeAccountsState | undefined;
	private accountsLoading = false;
	private limitsRequestedAt = 0;
	/** A terminal sign-in adding a Claude account, polled until it lands. */
	private accountLogin: { readonly id: string; readonly email?: string } | undefined;
	/** The account a switch is running for, and the last thing that went wrong. */
	private accountBusy: string | undefined;
	private accountError: string | undefined;

	/**
	 * Install and sign-in state per CLI id, from asking each CLI directly. The last answers are kept
	 * (across restarts too), so the page draws them at once while the CLIs are asked again.
	 */
	private readonly setupStates = new Map<string, IAgentSetupState>();
	private setupHandles: IVoltQueryHandle<IAgentSetupState>[] | undefined;
	private readonly setupStore = new DisposableStore();
	private readonly cache: IVoltQueryCache;
	/** The head's refresh button, turned while any CLI is asked again behind its last answer. */
	private refreshButton: HTMLElement | undefined;
	private readonly running = new Map<string, RunningAction>();
	private readonly keyEditor = new Set<string>();
	private disposed = false;
	/** While Refresh runs; the button shows the Usage page's spinner, also across re-renders. */
	private refreshing = false;

	private selection: Selection = { kind: 'overview' };
	private listFilter = '';
	/** The model the models list had focus on, given back after a re-render. */
	private modelsFocusRef: string | undefined;
	/** Both panes scroll on their own; a re-render puts them back where they were. */
	private listScrollTop = 0;
	private detailScrollTop = 0;
	/** The field that had focus, so a re-render (a save, a health check) gives it back. */
	private focusKey: string | undefined;
	/** Typed but not saved yet, per field, so a re-render does not throw the text away. */
	private readonly drafts = new Map<string, string>();
	/** A pointer is down on the page; a field it pulled focus from saves once its click has landed. */
	private pointerDown = false;

	constructor(private readonly instantiationService: IInstantiationService, private readonly host: IProvidersPageHost) {
		({
			runtime: this.runtime,
			stdio: this.stdio,
			opener: this.opener,
			contextViewService: this.contextViewService,
			configurationService: this.configurationService,
			clipboard: this.clipboard,
			cache: this.cache,
		} = instantiationService.invokeFunction(accessor => ({
			runtime: accessor.get(IAgentRuntimeService),
			stdio: accessor.get(IVoltStdioService),
			opener: accessor.get(IOpenerService),
			contextViewService: accessor.get(IContextViewService),
			configurationService: accessor.get(IConfigurationService),
			clipboard: accessor.get(IClipboardService),
			cache: accessor.get(IVoltQueryCache),
		})));
		this.setup = instantiationService.createInstance(AgentSetupService);
		this.accounts = instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(IVoltAccountsService);
			} catch {
				return undefined;
			}
		});
		if (this.accounts) {
			this.setupStore.add(this.accounts.onDidChangeClaudeAccounts(() => void this.loadAccounts(false)));
		}
	}

	/** Reads the saved accounts; `refreshLimits` also reads limits that are stale. Redraws when they arrive. */
	private async loadAccounts(refreshLimits: boolean): Promise<void> {
		if (!this.accounts || this.accountsLoading) {
			return;
		}
		this.accountsLoading = true;
		try {
			this.accountsState = await this.accounts.getClaudeAccounts(refreshLimits);
		} catch (error) {
			this.accountError = error instanceof Error ? error.message : String(error);
		} finally {
			this.accountsLoading = false;
		}
		if (!this.disposed && this.selection.kind === 'provider' && this.profile(this.selection.profileId)?.providerId === 'claude-code') {
			this.host.rerender();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.setupStore.dispose();
		this.loginWatch?.dispose();
	}

	private setupQuery(id: string): IVoltQuery<IAgentSetupState> {
		const def = this.setup.definitions().find(candidate => candidate.id === id);
		return {
			key: `providers.setup:${id}`,
			staleTime: 60_000,
			fetch: () => def ? this.setup.detect(def) : Promise.reject(new Error(`Unknown CLI ${id}`)),
		};
	}

	/**
	 * Asks every CLI whether it is installed and signed in, behind the last known answers. Runs on
	 * each page visit (`force`) and on Refresh; without `force` only stale answers are asked again.
	 */
	checkSetup(force = false): Promise<void> {
		if (!this.setupHandles) {
			this.setupHandles = this.setup.definitions().map(def => {
				const handle = this.setupStore.add(this.cache.watch(this.setupQuery(def.id)));
				this.setupStore.add(handle.onDidChange(() => this.applySetup()));
				return handle;
			});
			this.applySetup();
		}
		if (!force) {
			return Promise.resolve();
		}
		return Promise.all(this.setupHandles.map(handle => handle.refetch())).then(() => undefined);
	}

	/** Takes the cached answers; a new answer redraws the page, a check starting or ending only turns the spinner. */
	private applySetup(): void {
		let changed = false;
		for (const handle of this.setupHandles ?? []) {
			const state = handle.state.data;
			const previous = state && this.setupStates.get(state.id);
			if (state && previous !== state && JSON.stringify(previous) !== JSON.stringify(state)) {
				// Saved answers may predate this build's setup recipes; those come from code.
				this.setupStates.set(state.id, { ...state, info: agentSetupInfo(state.id) });
				changed = true;
			}
		}
		this.syncRefresh();
		if (changed && !this.disposed) {
			this.host.rerender();
		}
	}

	/** An answer the page got itself (after an install or sign-in) replaces the cached one. */
	private storeSetup(state: IAgentSetupState): void {
		this.setupStates.set(state.id, state);
		this.cache.set(this.setupQuery(state.id).key, state);
	}

	private syncRefresh(): void {
		const button = this.refreshButton;
		if (!button) {
			return;
		}
		const spinning = this.refreshing || !!this.setupHandles?.some(handle => handle.state.fetching);
		button.classList.toggle('spinning', spinning);
		if (spinning) {
			button.setAttribute('aria-busy', 'true');
		} else {
			button.removeAttribute('aria-busy');
		}
		const spinner = button.querySelector('svg:last-child');
		if (spinner) {
			setRefreshSpinnerRunning(spinner, spinning);
		}
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

	/**
	 * The providers in `listPane` (the settings' list pane, edge to edge like every settings list,
	 * under a head with the title and Check now) and the selection in `detailPane`, the page.
	 */
	render(listPane: HTMLElement, detailPane: HTMLElement): void {
		const head = append(listPane, $('.volt-settings-side-head'));
		append(head, $('span.volt-settings-side-title')).textContent = localize('voltSettings.providers', "Providers & Models");
		this.renderHeadActions(head);
		const all = this.runtime.listProviderStatuses();
		this.validateSelection(all);
		const needle = this.host.search().trim().toLowerCase();
		const statuses = all.filter(status => !needle
			|| status.label.toLowerCase().includes(needle)
			|| status.providerId.includes(needle)
			|| status.models.some(model => model.label.toLowerCase().includes(needle)));

		const doc = listPane.ownerDocument;
		this.host.store.add(addDisposableListener(doc, 'pointerdown', () => this.pointerDown = true, true));
		this.host.store.add(addDisposableListener(doc, 'pointerup', () => this.pointerDown = false, true));
		this.host.store.add(addDisposableListener(doc, 'pointercancel', () => this.pointerDown = false, true));
		this.renderList(append(listPane, $('.volt-pm-list')), statuses);
		this.renderDetail(append(detailPane, $('.volt-pm-detail')), all);
		this.restoreFocus(listPane);
		this.restoreFocus(detailPane);
	}

	private select(selection: Selection): void {
		this.selection = selection;
		this.detailScrollTop = 0;
		this.host.scrollToTop();
		this.drafts.clear();
		// A pick from the keyboard keeps the list focused, so arrows go on walking it.
		this.focusKey = this.focusKey === 'list' ? 'list' : undefined;
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
		const checked = lastCheck
			? localize('voltSettings.checkedAt', "Checked {0}", fromNow(lastCheck, true))
			: localize('voltSettings.checking', "Checking...");
		append(actions, $('span.volt-settings-checked')).textContent = checked;
		const refresh = append(actions, $('button.volt-settings-icon-btn.volt-settings-refresh')) as HTMLButtonElement;
		refresh.type = 'button';
		refresh.appendChild(renderIcon(Codicon.refresh));
		refresh.appendChild(createRefreshSpinner());
		this.refreshButton = refresh;
		this.syncRefresh();
		const refreshLabel = localize('voltSettings.refreshProviders', "Check providers now");
		refresh.setAttribute('aria-label', refreshLabel);
		setAgentTooltip(refresh, lastCheck ? localize('voltSettings.refreshProvidersWhen', "{0}. {1}", refreshLabel, checked) : refreshLabel);
		this.host.store.add(addDisposableListener(refresh, 'click', () => this.refresh()));
	}

	//#region List

	/**
	 * Overview, then each group's providers and its Add row, in a workbench list. A provider row
	 * opens it on the right, models included, so the list does not repeat them. The filter narrows
	 * the rows in place (by provider or model name), so typing never loses focus to a re-render.
	 */
	private renderList(pane: HTMLElement, statuses: IVoltProviderStatus[]): void {
		const filterHost = append(pane, $('.volt-pm-filter'));
		append(filterHost, $('span.volt-pm-filter-icon')).appendChild(renderIcon(Codicon.search));
		const filter = this.host.store.add(new InputBox(filterHost, this.contextViewService, {
			placeholder: localize('voltSettings.filterProviders', "Filter providers and models"),
			ariaLabel: localize('voltSettings.filterProviders', "Filter providers and models"),
			inputBoxStyles: this.host.inputBoxStyles(),
		}));
		filter.value = this.listFilter;
		this.trackFocus(filter.inputElement, 'list-filter');

		const scroller = append(pane, $('.volt-pm-scroll'));
		const attention = this.runtime.listProviderStatuses().filter(status => this.needsAction(status)).length;
		const agents = this.sorted(statuses.filter(status => status.kind === 'agent'));
		const apis = this.sorted(statuses.filter(status => status.kind === 'model'));
		const rowsFor = (value: string): ListRow[] => {
			const needle = value.trim().toLowerCase();
			const matches = (status: IVoltProviderStatus) => !needle
				|| `${status.label} ${status.providerId}`.toLowerCase().includes(needle)
				|| status.models.some(model => `${model.label} ${model.id} ${model.qualifier ?? ''}`.toLowerCase().includes(needle));
			const rows: ListRow[] = [{ kind: 'overview', attention }];
			const group = (label: string, items: IVoltProviderStatus[], addLabel: string, what: 'api' | 'agent') => {
				const shown = items.filter(matches);
				if (needle && !shown.length) {
					return;
				}
				rows.push({ kind: 'group', label });
				rows.push(...shown.map(status => ({ kind: 'provider' as const, status })));
				if (!needle) {
					rows.push({ kind: 'add', what, label: addLabel });
				}
			};
			group(localize('voltSettings.codingAgents', "Coding agents"), agents, localize('voltSettings.addCustomAgentShort', "Add custom agent"), 'agent');
			group(localize('voltSettings.apiProviders', "API & local models"), apis, localize('voltSettings.addApiProvider', "Add API provider"), 'api');
			if (rows.length === 1 && needle) {
				rows.push({ kind: 'none' });
			}
			return rows;
		};

		const list = this.host.store.add(this.instantiationService.createInstance(WorkbenchList<ListRow>, 'VoltProvidersList', scroller, new ProviderRowDelegate(), [new ProviderRowRenderer(this)], {
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			paddingTop: 4,
			paddingBottom: 10,
			identityProvider: { getId: row => listRowId(row) },
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltSettings.providersAndModels', "Providers and models"),
				getRole: row => isStaticRow(row) ? 'presentation' : 'listitem',
				getAriaLabel: row => listRowLabel(row),
			},
			// Hover, focus and selection come from the theme's list colours (the workbench defaults).
		}));
		// The list keeps keyboard focus across the re-render that opening a row causes.
		this.trackFocus(list.getHTMLElement(), 'list');
		let rows = rowsFor(this.listFilter);
		const selectedIndex = () => rows.findIndex(row => this.isSelectedRow(row));
		const show = (next: ListRow[]) => {
			rows = next;
			list.splice(0, list.length, rows);
			const selected = selectedIndex();
			list.setSelection(selected >= 0 ? [selected] : []);
			list.setFocus(selected >= 0 ? [selected] : []);
		};
		show(rows);
		// Group titles are skipped: focus walks on in the direction it was going, and a click on one
		// leaves the selection where it was.
		let lastFocus = selectedIndex();
		this.host.store.add(list.onDidChangeFocus(e => {
			const index = e.indexes[0];
			if (index === undefined) {
				return;
			}
			if (!isStaticRow(rows[index])) {
				lastFocus = index;
				return;
			}
			const step = index >= lastFocus ? 1 : -1;
			const walk = (from: number, by: number) => {
				let next = from + by;
				while (next >= 0 && next < rows.length && isStaticRow(rows[next])) {
					next += by;
				}
				return next >= 0 && next < rows.length ? next : -1;
			};
			const next = walk(index, step) >= 0 ? walk(index, step) : walk(index, -step);
			list.setFocus(next >= 0 ? [next] : []);
			if (next >= 0) {
				list.reveal(next);
			}
		}));
		this.host.store.add(list.onDidChangeSelection(e => {
			if (e.elements.some(isStaticRow)) {
				const selected = selectedIndex();
				list.setSelection(selected >= 0 ? [selected] : []);
			}
		}));
		this.host.store.add(list.onDidOpen(e => {
			const row = e.element;
			if (row?.kind === 'overview') {
				this.select({ kind: 'overview' });
			} else if (row?.kind === 'provider') {
				this.select({ kind: 'provider', profileId: row.status.profileId });
			} else if (row?.kind === 'add') {
				this.select({ kind: 'add', what: row.what });
			}
		}));
		this.host.store.add(filter.onDidChange(value => {
			this.listFilter = value;
			show(rowsFor(value));
		}));
		// Arrow Down from the filter walks the list.
		this.host.store.add(addDisposableListener(filter.inputElement, 'keydown', e => {
			if (e.key === 'ArrowDown' && list.length) {
				e.preventDefault();
				list.domFocus();
				list.focusFirst();
			}
		}));

		const resize = new ResizeObserver(() => {
			list.layout(scroller.clientHeight, scroller.clientWidth);
			if (this.listScrollTop) {
				list.scrollTop = this.listScrollTop;
			}
		});
		resize.observe(scroller);
		this.host.store.add(toDisposable(() => resize.disconnect()));
		this.host.store.add(list.onDidScroll(e => this.listScrollTop = e.scrollTop));
	}

	private isSelectedRow(row: ListRow): boolean {
		const selection = this.selection;
		switch (row.kind) {
			case 'overview': return selection.kind === 'overview';
			case 'add': return selection.kind === 'add' && selection.what === row.what;
			case 'provider':
				return (selection.kind === 'provider' && selection.profileId === row.status.profileId)
					|| (selection.kind === 'model' && row.status.models.some(model => model.ref === selection.ref));
			default: return false;
		}
	}

	/** Fills one list row. Called by the list's renderer, so the row's look stays here with the page. */
	renderListRow(element: HTMLElement, row: ListRow): void {
		element.replaceChildren();
		element.className = `volt-pm-item ${row.kind}`;
		// Rows are reused across kinds; the row itself says whether it paints hover and focus.
		element.parentElement?.classList.toggle('volt-pm-row-static', isStaticRow(row));
		switch (row.kind) {
			case 'overview': {
				append(element, $('span.volt-pm-glyph')).appendChild(renderIcon(Codicon.dashboard));
				append(element, $('span.volt-pm-name')).textContent = localize('voltSettings.overview', "Overview");
				if (row.attention) {
					const badge = append(element, $('span.volt-pm-count.warn'));
					badge.textContent = String(row.attention);
					setAgentTooltip(badge, localize('voltSettings.needSetupCount', "{0} need setup", row.attention));
				}
				break;
			}
			case 'group':
				element.textContent = row.label;
				break;
			case 'add':
				append(element, $('span.volt-pm-glyph')).appendChild(renderIcon(Codicon.add));
				append(element, $('span.volt-pm-name')).textContent = row.label;
				break;
			case 'none':
				element.textContent = localize('voltSettings.noProviderMatch', "Nothing matches your search.");
				break;
			case 'provider': {
				const status = row.status;
				const setup = status.kind === 'agent' ? this.setupStates.get(status.providerId) : undefined;
				element.classList.toggle('not-installed', status.kind === 'agent' && !!setup && !setup.installed);
				element.classList.toggle('off', !status.enabled);
				append(element, $('span.volt-pm-icon')).appendChild(createBrandIcon(status.providerId, 14));
				append(element, $('span.volt-pm-name')).textContent = status.label;
				if (status.models.length) {
					const count = append(element, $('span.volt-pm-count'));
					count.textContent = String(status.models.length);
					setAgentTooltip(count, localize('voltSettings.modelCount', "{0} models", status.models.length));
				}
				const { tone, label } = this.statusLine(status, setup, this.running.get(status.profileId));
				const dot = append(element, $(`span.volt-settings-dot.${tone}`));
				setAgentTooltip(dot, label);
				break;
			}
		}
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
		this.reachRightEdge(pane, scroller);
		scroller.scrollTop = this.detailScrollTop;
		this.host.store.add(addDisposableListener(scroller, 'scroll', () => this.detailScrollTop = scroller.scrollTop));
	}

	/**
	 * The detail scroller runs out to the page's right edge, so its scrollbar sits at the edge of
	 * the window instead of beside the centered column. Padding of the same width keeps the content
	 * where it was.
	 */
	private reachRightEdge(pane: HTMLElement, scroller: HTMLElement): void {
		const page = pane.closest('.volt-settings-content');
		if (!isHTMLElement(page)) {
			return;
		}
		const fit = () => {
			const edge = Math.max(0, Math.round(page.getBoundingClientRect().right - pane.getBoundingClientRect().right));
			scroller.style.marginRight = `-${edge}px`;
			scroller.style.paddingRight = `${edge}px`;
		};
		fit();
		const resize = new ResizeObserver(fit);
		resize.observe(page);
		this.host.store.add(toDisposable(() => resize.disconnect()));
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
			appendPrivateText(append(line, $('span.text')), status.label);
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

	/**
	 * A read-only value, monospaced for paths and ids, with a copy button for the ones worth pasting.
	 * Email addresses in it are blurred until hovered.
	 */
	private valueRow(group: HTMLElement, title: string, value: string | undefined, options?: { mono?: boolean; copy?: boolean }): void {
		if (!value) {
			return;
		}
		const control = this.row(group, title);
		const text = append(control, $(options?.mono ? 'code.volt-pm-value' : 'span.volt-pm-value'));
		appendPrivateText(text, value);
		setAgentTooltip(text, value);
		if (options?.copy) {
			this.copyButton(control, title, value);
		}
	}

	/** The chat's copy button: its glyph, and the same green check for a moment once copied. */
	private copyButton(parent: HTMLElement, title: string, value: string): void {
		const copyLabel = localize('voltSettings.copy', "Copy");
		const copiedLabel = localize('voltSettings.copied', "Copied");
		const copy = append(parent, $('button.volt-pm-copy')) as HTMLButtonElement;
		copy.type = 'button';
		copy.appendChild(createMessageCopyIcon());
		copy.setAttribute('aria-label', localize('voltSettings.copyValue', "Copy {0}", title));
		setAgentTooltip(copy, copyLabel);
		let timer: number | undefined;
		this.host.store.add(toDisposable(() => mainWindow.clearTimeout(timer)));
		this.host.store.add(addDisposableListener(copy, 'click', () => {
			void this.clipboard.writeText(value).then(() => {
				copy.replaceChildren(renderIcon(Codicon.check));
				copy.classList.add('copied');
				setAgentTooltip(copy, copiedLabel);
				mainWindow.clearTimeout(timer);
				timer = mainWindow.setTimeout(() => {
					copy.replaceChildren(createMessageCopyIcon());
					copy.classList.remove('copied');
					setAgentTooltip(copy, copyLabel);
				}, 1500);
			});
		}));
	}

	/**
	 * One summary line under the title, then the providers that need a step (each with that one
	 * step; the row opens the provider), then the background check interval.
	 */
	private renderOverview(parent: HTMLElement, all: IVoltProviderStatus[]): void {
		const ready = all.filter(status => status.enabled && (status.state === 'authenticated' || status.state === 'available')).length;
		const attention = all.filter(status => this.needsAction(status));
		const enabledModels = all.reduce((sum, status) => sum + status.models.filter(model => model.enabled).length, 0);
		const totalModels = all.reduce((sum, status) => sum + status.models.length, 0);
		const summary = [
			localize('voltSettings.summaryReady', "{0} ready", ready),
			attention.length ? localize('voltSettings.summaryAttention', "{0} need setup", attention.length) : undefined,
			localize('voltSettings.summaryModels', "{0} of {1} models in the picker", enabledModels, totalModels),
		].filter(Boolean).join(' · ');
		this.detailHead(parent, renderIcon(Codicon.dashboard), localize('voltSettings.overview', "Overview"), undefined, {
			tone: attention.length ? 'disabled' : 'authenticated',
			label: summary,
		});
		append(parent, $('.volt-pm-desc')).textContent = localize('voltSettings.overviewLead', "Pick a provider or a model on the left to set it up.");

		this.sectionTitle(parent, localize('voltSettings.needsSetup', "Needs setup"));
		if (!attention.length) {
			append(parent, $('.volt-settings-empty')).textContent = localize('voltSettings.allSetUp', "Every provider is set up.");
		} else {
			const list = append(parent, $('.volt-settings-group.volt-pm-setup-list'));
			for (const status of this.sorted(attention)) {
				const setup = status.kind === 'agent' ? this.setupStates.get(status.providerId) : undefined;
				const running = this.running.get(status.profileId);
				const row = append(list, $('.volt-pm-setup-row'));
				row.tabIndex = 0;
				row.setAttribute('role', 'button');
				row.setAttribute('aria-label', localize('voltSettings.openProvider', "Open {0}", status.label));
				append(row, $('span.volt-pm-icon')).appendChild(createBrandIcon(status.providerId, 16));
				const copy = append(row, $('.copy'));
				append(copy, $('.name')).textContent = status.label;
				const { tone, label } = this.statusLine(status, setup, running);
				const line = append(copy, $('.detail'));
				append(line, $(`span.volt-settings-dot.${tone}`));
				appendPrivateText(append(line, $('span.text')), label);
				this.renderActions(append(row, $('.volt-pm-actions')), status, setup, running, 'secondary');
				this.onActivate(row, () => this.select({ kind: 'provider', profileId: status.profileId }));
			}
		}

		this.sectionTitle(parent, localize('voltSettings.healthSection', "Health checks"));
		const group = append(parent, $('.volt-settings-group'));
		const control = this.row(group, localize('voltSettings.healthInterval', "Health check interval"), localize('voltSettings.healthIntervalDesc2', "How often Volt re-checks versions, sign-in and model lists in the background."));
		const choices = [0, 60, 300, 900, 3600];
		const current = this.runtime.getHealthCheckInterval();
		const nearest = choices.reduce((best, value) => Math.abs(value - current) < Math.abs(best - current) ? value : best, choices[0]);
		this.dropdown(control, localize('voltSettings.healthInterval', "Health check interval"), String(nearest), choices.map(seconds => ({
			id: String(seconds),
			label: seconds === 0 ? localize('voltSettings.manual', "Manual only") : seconds < 3600 ? localize('voltSettings.everyMin', "Every {0} min", seconds / 60) : localize('voltSettings.everyHour', "Every hour"),
		})), value => void this.runtime.setHealthCheckInterval(Number(value)));
	}

	/** A Volt dropdown (the composer's pill and menu) in a row's control. */
	private dropdown(parent: HTMLElement, ariaLabel: string, value: string, options: readonly IVoltDropdownOption<string>[], onChange: (value: string) => void, align: 'left' | 'right' = 'right'): void {
		createVoltDropdown(parent, this.contextViewService, { options, value, ariaLabel, onChange, align }, this.host.store);
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

	/**
	 * The next step for a provider, one button: Install, Sign In, Download or Add Key. All share one
	 * width. `kind` is the button's look (the overview's list keeps them quiet). The docs are a link
	 * at the foot of the provider's page.
	 */
	private renderActions(actions: HTMLElement, status: IVoltProviderStatus, setup: IAgentSetupState | undefined, running: RunningAction | undefined, kind: VoltButtonKind = 'primary'): void {
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
						this.button(actions, localize('voltSettings.installGuide', "Install Guide"), kind, localize('voltSettings.docs', "Open {0}", docs), openDocs);
					}
					return;
				}
				const failed = running?.action === 'failed';
				this.button(actions, failed ? localize('voltSettings.retryInstall', "Retry Install") : localize('voltSettings.install', "Install"), kind,
					failed ? localize('voltSettings.retryInstallHint', "Runs {0} in a terminal", install) : localize('voltSettings.installHint', "Runs {0}", install),
					() => failed ? void this.signInOrInstallInTerminal(status, setup, 'install') : void this.install(status, setup));
				return;
			}
			const login = this.setup.loginCommand(setup);
			if (login && setup.signIn.kind !== 'signedIn') {
				const hint = setup.info?.loginHint
					? localize('voltSettings.signInHintType', "Opens {0} in a terminal; type {1} there", login, setup.info.loginHint)
					: localize('voltSettings.signInHint', "Runs {0} in a terminal", login);
				this.button(actions, localize('voltSettings.signIn', "Sign In"), setup.signIn.kind === 'signedOut' ? kind : 'secondary', hint, () => void this.signInOrInstallInTerminal(status, setup, 'login'));
			}
			return;
		}
		if (status.kind === 'model') {
			const download = LOCAL_DOWNLOADS[status.providerId];
			if (download && status.state === 'missing') {
				this.button(actions, localize('voltSettings.download', "Download"), kind, download, () => void this.opener.open(URI.parse(download), { openExternal: true }));
				return;
			}
			const profile = this.profile(status.profileId);
			if (profile?.authKind === 'apikey' && (!profile.hasSecret || status.state === 'missing')) {
				this.button(actions, profile.hasSecret ? localize('voltSettings.replaceKey', "Replace Key") : localize('voltSettings.addKey', "Add Key"), kind, localize('voltSettings.addKeyHint', "Saved in the OS keychain"), () => this.openKeyEditor(status.profileId));
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

	/** A small Volt button; without a label, a square ghost button around `icon`. */
	private button(parent: HTMLElement, label: string, kind: VoltButtonKind, tooltip: string, run: () => void, icon?: ThemeIcon): HTMLElement {
		const button = this.host.store.add(createVoltButton(parent, label ? kind : 'ghost', { supportIcons: !!icon, ariaLabel: label ? undefined : tooltip }));
		button.element.classList.add('volt-button-small');
		button.element.classList.toggle('volt-pm-icon-button', !label);
		button.label = icon ? `$(${icon.id})${label ? ` ${label}` : ''}` : label;
		setAgentTooltip(button.element, tooltip);
		this.host.store.add(button.onDidClick(e => {
			// A button inside a clickable row (the overview's) does not open the row too.
			e.stopPropagation();
			run();
		}));
		return button.element;
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
			if (status.providerId === 'claude-code' && this.accounts && installed) {
				this.renderClaudeAccounts(parent);
			}
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
			this.button(footer, localize('voltSettings.save', "Save"), 'primary', localize('voltSettings.saveAgentHint', "Restarts the agent with these settings on its next chat"), () => {
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
		this.button(footer, localize('voltSettings.save', "Save"), 'primary', localize('voltSettings.saveProviderHint', "Saves and reloads the model list"), () => {
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
			this.button(actions, profile.hasSecret ? localize('voltSettings.replaceKey', "Replace Key") : localize('voltSettings.addKey', "Add Key"), profile.hasSecret ? 'secondary' : 'primary', localize('voltSettings.addKeyHint', "Saved in the OS keychain"), () => this.openKeyEditor(profile.id));
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
		this.button(actions, localize('voltSettings.save', "Save"), 'primary', localize('voltSettings.addKeyHint', "Saved in the OS keychain"), save);
		this.button(actions, localize('voltSettings.cancel', "Cancel"), 'secondary', localize('voltSettings.cancel', "Cancel"), () => {
			this.keyEditor.delete(status.profileId);
			this.host.rerender();
		});
		if (meta?.docs) {
			const docs = meta.docs;
			this.button(actions, '', 'ghost', localize('voltSettings.getKey', "Get a key: {0}", docs), () => void this.opener.open(URI.parse(docs), { openExternal: true }), Codicon.linkExternal);
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

		// A workbench list: the theme's hover, focus and selection, arrow keys, and only the rows in view
		// are drawn. It is as tall as its rows, up to a cap, and scrolls inside the card past that.
		const listHost = append(append(group, $('.volt-settings-models')), $('.volt-settings-models-list'));
		const searchText = (model: IVoltCatalogItem) => `${model.label} ${model.id} ${model.qualifier ?? ''}`.toLowerCase();
		const rowsFor = (value: string): ModelListRow[] => {
			const needle = value.trim().toLowerCase();
			const shown: ModelListRow[] = [];
			let hiddenHead = false;
			for (const model of models) {
				if (needle && !searchText(model).includes(needle)) {
					continue;
				}
				if (!needle && !model.enabled && !hiddenHead) {
					hiddenHead = true;
					shown.push({ kind: 'hidden' });
				}
				shown.push({ kind: 'model', model });
			}
			if (!shown.length) {
				shown.push({ kind: 'none' });
			}
			return shown;
		};
		const delegate = new ModelRowDelegate();
		const renderer = new ModelRowRenderer(status.label, model => this.modelTraits(model), model => void this.runtime.setModelEnabled(model.ref, !model.enabled));
		const list = this.host.store.add(this.instantiationService.createInstance(WorkbenchList<ModelListRow>, 'VoltProviderModelsList', listHost, delegate, [renderer, new ModelNoteRenderer()], {
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			// Short lists hand the wheel on to the page.
			alwaysConsumeMouseWheel: false,
			identityProvider: { getId: row => row.kind === 'model' ? `model:${row.model.ref}` : row.kind },
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltSettings.modelsOf', "{0} models", status.label),
				getRole: row => row.kind === 'model' ? 'listitem' : 'presentation',
				getAriaLabel: row => row.kind === 'model'
					? [row.model.label, row.model.enabled ? undefined : localize('voltSettings.hiddenFromPicker', "Hidden from the model picker")].filter(Boolean).join(', ')
					: row.kind === 'none' ? localize('voltSettings.noModelMatch', "No models match.") : localize('voltSettings.hiddenModels', "Hidden from picker"),
			},
		}));
		this.trackFocus(list.getHTMLElement(), 'models-list');
		let rows: ModelListRow[] = [];
		let height = 0;
		const layout = () => list.layout(height, listHost.clientWidth);
		const show = (next: ModelListRow[]) => {
			rows = next;
			list.splice(0, list.length, rows);
			height = Math.min(MODEL_LIST_MAX_HEIGHT, rows.reduce((sum, row) => sum + delegate.getHeight(row), 0));
			listHost.style.height = `${height}px`;
			layout();
			// Toggling a model redraws the page; focus comes back to the row it was on.
			const focused = rows.findIndex(row => row.kind === 'model' && row.model.ref === this.modelsFocusRef);
			if (focused >= 0) {
				list.setFocus([focused]);
				list.reveal(focused);
			}
		};
		const draft = this.drafts.get('models-filter') ?? '';
		filter.value = draft;
		show(rowsFor(draft));
		// The hidden-models title and the no-match line are skipped: focus walks on the way it was going.
		this.host.store.add(list.onDidChangeFocus(e => {
			const index = e.indexes[0];
			const row = index === undefined ? undefined : rows[index];
			if (row?.kind === 'model') {
				this.modelsFocusRef = row.model.ref;
				return;
			}
			if (index === undefined) {
				return;
			}
			const last = rows.findIndex(r => r.kind === 'model' && r.model.ref === this.modelsFocusRef);
			const step = index >= last ? 1 : -1;
			const walk = (by: number) => {
				let next = index + by;
				while (next >= 0 && next < rows.length && rows[next].kind !== 'model') {
					next += by;
				}
				return next >= 0 && next < rows.length ? next : -1;
			};
			const next = walk(step) >= 0 ? walk(step) : walk(-step);
			list.setFocus(next >= 0 ? [next] : []);
		}));
		this.host.store.add(list.onDidChangeSelection(e => {
			if (e.elements.some(row => row.kind !== 'model')) {
				list.setSelection([]);
			}
		}));
		this.host.store.add(list.onDidOpen(e => {
			const target = e.browserEvent?.target;
			if (e.element?.kind === 'model' && !(isHTMLElement(target) && target.closest('.volt-settings-toggle'))) {
				this.select({ kind: 'model', ref: e.element.model.ref });
			}
		}));
		// Space flips the focused model's switch; Enter opens it.
		this.host.store.add(addDisposableListener(list.getHTMLElement(), 'keydown', e => {
			if (e.key !== ' ') {
				return;
			}
			const row = list.getFocusedElements()[0];
			if (row?.kind === 'model') {
				e.preventDefault();
				e.stopPropagation();
				void this.runtime.setModelEnabled(row.model.ref, !row.model.enabled);
			}
		}));
		this.host.store.add(filter.onDidChange(value => {
			this.drafts.set('models-filter', value);
			show(rowsFor(value));
		}));
		// Arrow Down from the filter walks the list.
		this.host.store.add(addDisposableListener(filter.inputElement, 'keydown', e => {
			if (e.key === 'ArrowDown' && rows.some(row => row.kind === 'model')) {
				e.preventDefault();
				list.domFocus();
				list.setFocus([rows.findIndex(row => row.kind === 'model')]);
			}
		}));
		const resize = new ResizeObserver(layout);
		resize.observe(listHost);
		this.host.store.add(toDisposable(() => resize.disconnect()));
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

	private renderModel(parent: HTMLElement, model: IVoltCatalogItem, status: IVoltProviderStatus): void {
		const actions = this.detailHead(parent, createBrandIcon(status.providerId, 22), model.label, title => {
			if (model.qualifier && model.qualifier.toLowerCase() !== status.label.toLowerCase()) {
				append(title, $('span.version')).textContent = model.qualifier;
			}
		}, {
			tone: model.enabled ? 'authenticated' : 'off',
			label: [status.label, model.enabled ? localize('voltSettings.inPicker', "In the model picker") : localize('voltSettings.hiddenFromPicker', "Hidden from the model picker")].join(' · '),
		});
		this.button(actions, localize('voltSettings.providerShort', "Provider"), 'ghost', localize('voltSettings.openProvider', "Open {0}", status.label), () => this.select({ kind: 'provider', profileId: status.profileId }), Codicon.arrowLeft);
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
		this.dropdown(host, descriptor.label, String(Math.max(0, choices.findIndex(choice => choice.value === value))), choices.map((choice, index) => ({
			id: String(index),
			label: choice.isDefault ? localize('voltSettings.choiceDefault', "{0} (default)", choice.label) : choice.label,
		})), index => write(choices[Number(index)].value));
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

	//#region Claude accounts

	/**
	 * Saved Claude logins with their limits, the one in use marked. Switch makes another one
	 * Claude Code's login without a browser sign-in; Add account signs in once, in a terminal, in a
	 * folder of its own. Under the list: manual or automatic switching.
	 */
	private renderClaudeAccounts(parent: HTMLElement): void {
		const state = this.accountsState;
		// Limits are read behind what is shown (the answer redraws the page), at most once a minute:
		// the main process keeps each account to its own interval anyway. The one in use moves while
		// Claude works, so it counts as stale after a minute (it shares the Usage page's reading).
		const stale = !state || state.accounts.some(account => !account.needsSignIn && (!account.limits || Date.now() - account.limits.checkedAt > (account.active ? 60_000 : 5 * 60_000)));
		if (stale && Date.now() - this.limitsRequestedAt > 60_000) {
			this.limitsRequestedAt = Date.now();
			mainWindow.setTimeout(() => void this.loadAccounts(true));
		}
		// A page left open keeps up too; every redraw starts this again.
		const recheck = mainWindow.setTimeout(() => void this.loadAccounts(true), 60_000);
		this.host.store.add(toDisposable(() => mainWindow.clearTimeout(recheck)));
		const heading = this.sectionTitle(parent, localize('voltSettings.claudeAccounts', "Accounts"), localize('voltSettings.claudeAccountsHint', "Sign in to each Claude account once. Switching changes the account Claude Code uses on this computer, in Volt and in the terminal; running chats pick it up within about 30 seconds."));
		const adding = !!this.accountLogin;
		const add = this.link(heading, adding ? localize('voltSettings.claudeAddingAccount', "Waiting for sign-in") : localize('voltSettings.claudeAddAccount', "Add account"), adding ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.add, () => {
			if (this.accountLogin) {
				this.cancelAccountLogin();
			} else {
				void this.addClaudeAccount();
			}
		});
		setAgentTooltip(add, adding
			? localize('voltSettings.claudeAddingHint', "Finish the sign-in in the terminal and the browser. Click to cancel.")
			: localize('voltSettings.claudeAddHint', "Opens Claude's sign-in in a terminal. Your current login stays as it is."));

		if (this.accountError) {
			const failure = append(parent, $('.volt-settings-provider-failure'));
			append(failure, $('.title')).textContent = this.accountError;
		}
		const group = append(parent, $('.volt-settings-group.volt-pm-accounts'));
		if (!state) {
			append(group, $('.volt-settings-empty')).textContent = localize('voltSettings.claudeAccountsLoading', "Reading saved accounts…");
			return;
		}
		if (state.error) {
			append(group, $('.volt-settings-empty')).textContent = state.error;
		} else if (!state.accounts.length) {
			append(group, $('.volt-settings-empty')).textContent = state.signedOut
				? localize('voltSettings.claudeNoAccountsSignedOut', "Claude Code is not signed in. Add an account to start.")
				: localize('voltSettings.claudeNoAccounts', "No saved accounts yet.");
		}
		const sorted = [...state.accounts].sort((a, b) => Number(b.active) - Number(a.active) || a.addedAt - b.addedAt);
		for (const account of sorted) {
			this.accountRow(group, account);
		}
		if (state.accounts.length) {
			this.renderAccountSwitching(parent, state);
		}
	}

	private accountRow(group: HTMLElement, account: IVoltClaudeAccount): void {
		const row = append(group, $('.volt-pm-account'));
		row.classList.toggle('active', account.active);
		row.classList.toggle('needs-sign-in', !!account.needsSignIn);
		append(row, $('span.volt-pm-account-avatar')).textContent = (account.displayName ?? account.email).trim().charAt(0).toUpperCase() || '?';
		const copy = append(row, $('.volt-pm-account-copy'));
		const name = append(copy, $('.name'));
		append(name, $('span.email.volt-pm-private')).textContent = account.email;
		if (account.active) {
			append(name, $('span.volt-pm-account-badge')).textContent = localize('voltSettings.claudeAccountActive', "In use");
		}
		const detail = append(copy, $('.detail'));
		if (account.needsSignIn) {
			detail.classList.add('warn');
			detail.textContent = localize('voltSettings.claudeAccountExpired', "The saved sign-in expired. Sign in to this account again.");
		} else {
			appendPrivateText(detail, [account.plan ? localize('voltSettings.claudePlanName', "Claude {0}", account.plan) : undefined, account.organizationName].filter(Boolean).join(' · '));
		}
		this.accountLimits(append(row, $('.volt-pm-account-limits')), account);

		const actions = append(row, $('.volt-pm-actions'));
		if (this.accountBusy === account.id) {
			append(actions, $('span.volt-settings-spinner')).appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
			return;
		}
		if (account.needsSignIn) {
			this.button(actions, localize('voltSettings.signIn', "Sign In"), 'primary', localize('voltSettings.claudeSignInAgainHint', "Signs in to {0} again in a terminal", account.email), () => void this.addClaudeAccount(account.email));
		} else if (!account.active) {
			this.button(actions, localize('voltSettings.claudeSwitch', "Switch"), 'ghost', localize('voltSettings.claudeSwitchHint', "Make {0} Claude Code's account", account.email), () => void this.switchClaudeAccount(account));
		}
		if (!account.active) {
			const remove = this.button(actions, '', 'ghost', localize('voltSettings.claudeRemoveAccount', "Forget {0}", account.email), () => void this.removeClaudeAccount(account), Codicon.trash);
			remove.classList.add('volt-pm-account-remove');
		}
	}

	/** Session and all-models week as small bars, the way Claude Code's /usage words them. */
	private accountLimits(host: HTMLElement, account: IVoltClaudeAccount): void {
		const limits = account.limits;
		const pick = (test: (window: IVoltUsageLimitWindow) => boolean) => limits?.windows.find(test);
		const windows: [string, IVoltUsageLimitWindow | undefined][] = [
			[localize('voltSettings.claudeLimitSession', "Session"), pick(window => window.label === 'Current session')],
			[localize('voltSettings.claudeLimitWeek', "Week"), pick(window => window.scope === 'All models')],
		];
		if (!limits || !windows.some(([, window]) => window)) {
			host.classList.add('empty');
			host.textContent = limits?.error ?? (account.needsSignIn ? '' : localize('voltSettings.claudeLimitsUnknown', "Limits not read yet"));
			if (limits?.error) {
				setAgentTooltip(host, limits.error);
			}
			return;
		}
		const now = Date.now();
		for (const [label, window] of windows) {
			if (!window) {
				continue;
			}
			const reset = window.resetsAt !== undefined && window.resetsAt <= now;
			const used = reset ? 0 : Math.round(window.usedPercent);
			const meter = append(host, $('.volt-pm-meter'));
			meter.classList.toggle('high', used >= 80);
			meter.classList.toggle('full', used >= 100);
			append(meter, $('span.label')).textContent = label;
			const bar = append(meter, $('span.bar'));
			append(bar, $('span.fill')).style.width = `${Math.min(100, used)}%`;
			append(meter, $('span.value')).textContent = `${used}%`;
			const resets = window.resetsAt && !reset ? localize('voltSettings.claudeLimitResets', "resets {0}", fromNow(window.resetsAt, true, true)) : undefined;
			setAgentTooltip(meter, [`${window.label}${window.scope ? ` (${window.scope})` : ''}: ${used}%`, resets, localize('voltSettings.claudeLimitChecked', "checked {0}", fromNow(limits.checkedAt, true, true))].filter(Boolean).join(' · '));
		}
	}

	private renderAccountSwitching(parent: HTMLElement, state: IVoltClaudeAccountsState): void {
		this.sectionTitle(parent, localize('voltSettings.claudeSwitching', "Switching"));
		const group = append(parent, $('.volt-settings-group'));
		const auto = state.switching === 'auto';
		const autoTitle = localize('voltSettings.claudeAutoSwitch', "Switch automatically");
		const autoDesc = state.accounts.length < 2
			? localize('voltSettings.claudeAutoSwitchNeedsTwo', "Add a second account first. Then, near a limit, Volt moves Claude to the saved account with the most left.")
			: localize('voltSettings.claudeAutoSwitchDesc', "When the account in use reaches {0}% of its session or weekly limit, Volt moves Claude to the saved account with the most left. Off: Claude stays on the account you pick.", state.threshold);
		this.host.switch(this.row(group, autoTitle, autoDesc), auto, autoTitle, () => {
			void this.configurationService.updateValue(CLAUDE_ACCOUNT_SWITCHING_SETTING, auto ? 'manual' : 'auto').then(() => this.loadAccounts(false));
		});
		if (auto) {
			const control = this.row(group, localize('voltSettings.claudeSwitchAt', "Switch at"), localize('voltSettings.claudeSwitchAtDesc', "How full the session or weekly limit gets before Volt moves on. Volt checks every 2 minutes."));
			const choices = [70, 80, 85, 90, 95];
			const nearest = choices.reduce((best, value) => Math.abs(value - state.threshold) < Math.abs(best - state.threshold) ? value : best, choices[0]);
			this.dropdown(control, localize('voltSettings.claudeSwitchAt', "Switch at"), String(nearest), choices.map(value => ({
				id: String(value),
				label: localize('voltSettings.percentUsed', "{0}% used", value),
			})), value => void this.configurationService.updateValue(CLAUDE_AUTO_SWITCH_THRESHOLD_SETTING, Number(value)).then(() => this.loadAccounts(false)));
		}
		const last = state.lastSwitch;
		if (last) {
			const how = last.reason === 'auto' ? localize('voltSettings.claudeSwitchAuto', "automatically") : localize('voltSettings.claudeSwitchManual', "by you");
			const text = [localize('voltSettings.claudeLastSwitchTo', "To {0} {1}, {2}", last.toEmail, how, fromNow(last.at, true, true)), last.detail].filter(Boolean).join(' · ');
			this.valueRow(group, localize('voltSettings.claudeLastSwitch', "Last switch"), text);
		}
	}

	private async switchClaudeAccount(account: IVoltClaudeAccount): Promise<void> {
		if (!this.accounts || this.accountBusy) {
			return;
		}
		this.accountBusy = account.id;
		this.accountError = undefined;
		this.host.rerender();
		try {
			this.accountsState = await this.accounts.switchClaudeAccount(account.id);
		} catch (error) {
			this.accountError = error instanceof Error ? error.message : String(error);
		} finally {
			this.accountBusy = undefined;
		}
		// The connection facts (account, plan) come from the provider check.
		await Promise.allSettled([this.runtime.refreshProviders(), this.checkSetup(true)]);
		if (!this.disposed) {
			this.host.rerender();
		}
	}

	private async removeClaudeAccount(account: IVoltClaudeAccount): Promise<void> {
		if (!this.accounts) {
			return;
		}
		this.accountError = undefined;
		try {
			this.accountsState = await this.accounts.removeClaudeAccount(account.id);
		} catch (error) {
			this.accountError = error instanceof Error ? error.message : String(error);
		}
		if (!this.disposed) {
			this.host.rerender();
		}
	}

	/**
	 * Runs `claude auth login` in a terminal with a throwaway `CLAUDE_CONFIG_DIR`, so the browser
	 * sign-in lands there and not on the login in use, then asks the main process until it has
	 * picked the new account up. `email` signs in to a saved account whose sign-in expired.
	 */
	private async addClaudeAccount(email?: string): Promise<void> {
		if (!this.accounts || this.accountLogin) {
			return;
		}
		this.accountError = undefined;
		let login;
		let onClosed;
		try {
			login = await this.accounts.beginClaudeLogin(email);
			onClosed = await this.setup.runInTerminal('login', 'Claude', login.command);
		} catch (error) {
			this.accountError = error instanceof Error ? error.message : String(error);
			this.host.rerender();
			return;
		}
		const id = login.id;
		this.accountLogin = { id, email };
		this.host.rerender();
		this.host.revealWorkbench();

		const accounts = this.accounts;
		const watch = new DisposableStore();
		const started = Date.now();
		let checking = false;
		const finish = (error?: string) => {
			watch.dispose();
			if (this.accountLogin?.id !== id) {
				return;
			}
			this.accountLogin = undefined;
			this.accountError = error;
			void accounts.cancelClaudeLogin(id);
			void this.loadAccounts(true);
			if (!this.disposed) {
				this.host.rerender();
			}
		};
		const check = async (last: boolean) => {
			if (checking || this.accountLogin?.id !== id) {
				return;
			}
			checking = true;
			try {
				const result = await accounts.completeClaudeLogin(id);
				if (result.status === 'added') {
					finish();
				} else if (result.status === 'failed') {
					finish(result.error);
				} else if (last) {
					finish();
				}
			} catch (error) {
				finish(error instanceof Error ? error.message : String(error));
			} finally {
				checking = false;
			}
		};
		const handle = mainWindow.setInterval(() => {
			if (Date.now() - started > SIGN_IN_POLL_LIMIT_MS) {
				finish(localize('voltSettings.claudeSignInTimeout', "The sign-in did not finish in time. Add the account again to retry."));
				return;
			}
			void check(false);
		}, SIGN_IN_POLL_MS);
		watch.add(toDisposable(() => mainWindow.clearInterval(handle)));
		// The terminal can close a moment before the credential is readable; one last look, then stop.
		watch.add(onClosed(() => mainWindow.setTimeout(() => void check(true), 500)));
		this.loginWatch = watch;
	}

	private loginWatch: DisposableStore | undefined;

	private cancelAccountLogin(): void {
		const login = this.accountLogin;
		this.loginWatch?.dispose();
		this.loginWatch = undefined;
		this.accountLogin = undefined;
		if (login) {
			void this.accounts?.cancelClaudeLogin(login.id);
		}
		this.host.rerender();
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
		const field = root.querySelector<HTMLElement>(`[data-focus-key="${this.focusKey}"]`);
		if (field && field.ownerDocument.activeElement !== field) {
			field.focus();
			if (isHTMLInputElement(field)) {
				const end = field.value.length;
				field.setSelectionRange(end, end);
			}
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
			this.storeSetup(next);
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
				this.storeSetup(next);
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
		let onProvider = (_id: string) => { };
		this.field(grid, localize('voltSettings.provider', "Provider"), host => this.dropdown(host, localize('voltSettings.provider', "Provider"), provider.id, API_PROVIDERS.map(item => ({
			id: item.id,
			label: item.label,
			icon: () => createBrandIcon(item.id, 14),
		})), id => onProvider(id), 'left'));
		const name = this.input(grid, localize('voltSettings.label', "Name"), localize('voltSettings.label.placeholder', "Display name (optional)"));
		const key = this.input(grid, localize('voltSettings.apiKey', "API key"), provider.keyHint ?? '', 'password');
		const baseUrl = this.input(grid, localize('voltSettings.baseUrl', "Base URL"), provider.baseUrl ?? localize('voltSettings.baseUrl.placeholder', "Optional"));
		const model = this.input(grid, localize('voltSettings.modelIdField', "Model id"), localize('voltSettings.modelId.placeholder', "Optional, e.g. gpt-4.1"));
		onProvider = id => {
			provider = API_PROVIDERS.find(item => item.id === id) ?? API_PROVIDERS[0];
			key.setPlaceHolder(authKind(provider.id) === 'none' ? localize('voltSettings.noKeyNeeded', "Not needed") : provider.keyHint ?? '');
			baseUrl.setPlaceHolder(provider.baseUrl ?? localize('voltSettings.baseUrl.placeholder', "Optional"));
		};
		const actions = append(form, $('.volt-settings-actions.volt-pm-actions'));
		this.button(actions, localize('voltSettings.connect', "Connect"), 'primary', localize('voltSettings.connectHint', "Adds the provider and lists its models"), () => {
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
		this.button(actions, localize('voltSettings.cancel', "Cancel"), 'secondary', localize('voltSettings.cancel', "Cancel"), () => this.select({ kind: 'overview' }));
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
		this.button(actions, localize('voltSettings.connect', "Connect"), 'primary', localize('voltSettings.connectAgentHint', "Adds the agent to the composer"), () => {
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
		this.button(actions, localize('voltSettings.cancel', "Cancel"), 'secondary', localize('voltSettings.cancel', "Cancel"), () => this.select({ kind: 'overview' }));
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
