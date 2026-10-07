/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IInputBoxStyles, InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { ISelectBoxStyles, ISelectOptionItem, SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { CLI_AGENT_DEFINITIONS } from '../../../services/voltRuntime/browser/agents/cliAgents.js';
import { createBrandIcon } from '../../../services/voltRuntime/browser/providers/providerBrands.js';
import { MODEL_OPTION_CONTEXT, MODEL_OPTION_FAST, MODEL_OPTION_REASONING } from '../../../services/voltRuntime/common/models/modelOptions.js';
import { IProviderProfileDraft, VoltApiStyle, VoltAuthKind } from '../../../services/voltRuntime/common/profiles.js';
import { IVoltCatalogItem, IVoltProviderStatus } from '../../../services/voltRuntime/common/providers.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { createRefreshSpinner } from '../../voltAgent/browser/usage/agentUsageIcons.js';
import { AgentSetupService, IAgentSetupState } from '../../voltSetup/browser/agentSetupService.js';

/** How long a background install may run before it is called failed. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** While a sign-in runs in the terminal, how often and how long its CLI is asked again. */
const SIGN_IN_POLL_MS = 3000;
const SIGN_IN_POLL_LIMIT_MS = 5 * 60_000;

/** API providers anyone can add with a key or an endpoint. */
const API_PROVIDERS: readonly { id: string; label: string; keyHint?: string; baseUrl?: string; docs?: string }[] = [
	{ id: 'anthropic', label: 'Anthropic', keyHint: 'sk-ant-…', docs: 'https://console.anthropic.com/settings/keys' },
	{ id: 'openai', label: 'OpenAI', keyHint: 'sk-…', docs: 'https://platform.openai.com/api-keys' },
	{ id: 'openrouter', label: 'OpenRouter', keyHint: 'sk-or-…', docs: 'https://openrouter.ai/keys' },
	{ id: 'gemini', label: 'Gemini', keyHint: 'AIza…', docs: 'https://aistudio.google.com/apikey' },
	{ id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434' },
	{ id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
	{ id: 'openai-compat', label: 'OpenAI compatible', keyHint: 'Optional' },
];

/** Where to get the apps behind local model runtimes. */
const LOCAL_DOWNLOADS: Record<string, string> = {
	ollama: 'https://ollama.com/download',
	lmstudio: 'https://lmstudio.ai/download',
};

type RunningAction = { readonly action: 'install' | 'login'; readonly command: string } | { readonly action: 'failed'; readonly command: string; readonly output: string };

export interface IProvidersPageHost {
	/** Where the next block goes (the body of the current section). */
	target(): HTMLElement;
	sectionLabel(label: string): void;
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
 * Volt Settings > Providers: every coding agent CLI and model API in one list. Each card says
 * whether it is ready and offers the next step (Install, Sign In, Add Key, Download), and opens
 * into its models with what each one can do. Replaces the old Models, Agents and ACP pages.
 */
export class ProvidersPage {

	private readonly runtime: IAgentRuntimeService;
	private readonly stdio: IVoltStdioService;
	private readonly opener: IOpenerService;
	private readonly contextViewService: IContextViewService;
	private readonly setup: AgentSetupService;

	/** Install and sign-in state per CLI id, from asking each CLI directly. */
	private readonly setupStates = new Map<string, IAgentSetupState>();
	private setupChecking: Promise<void> | undefined;
	private readonly running = new Map<string, RunningAction>();
	private readonly expanded = new Set<string>();
	private readonly keyEditor = new Set<string>();
	private adding: 'api' | 'agent' | undefined;
	private disposed = false;
	/** While Refresh runs; the button shows the Usage page's spinner, also across re-renders. */
	private refreshing = false;

	constructor(instantiationService: IInstantiationService, private readonly host: IProvidersPageHost) {
		({ runtime: this.runtime, stdio: this.stdio, opener: this.opener, contextViewService: this.contextViewService } = instantiationService.invokeFunction(accessor => ({
			runtime: accessor.get(IAgentRuntimeService),
			stdio: accessor.get(IVoltStdioService),
			opener: accessor.get(IOpenerService),
			contextViewService: accessor.get(IContextViewService),
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
		const needle = this.host.search().trim().toLowerCase();
		const matches = (status: IVoltProviderStatus) => !needle
			|| status.label.toLowerCase().includes(needle)
			|| status.providerId.includes(needle)
			|| status.models.some(model => model.label.toLowerCase().includes(needle));
		const statuses = this.runtime.listProviderStatuses().filter(matches);
		const agents = statuses.filter(status => status.kind === 'agent');
		const models = statuses.filter(status => status.kind === 'model');

		this.renderSummary(agents, models);

		this.host.sectionLabel(localize('voltSettings.codingAgents', "Coding agents"));
		append(this.host.target(), $('.volt-settings-section-hint')).textContent = localize('voltSettings.codingAgentsHint', "Agent CLIs Volt drives over ACP, with your own sign-in and plan.");
		this.renderCards(agents);
		this.renderAddAgent();

		this.host.sectionLabel(localize('voltSettings.apiProviders', "API & local models"));
		append(this.host.target(), $('.volt-settings-section-hint')).textContent = localize('voltSettings.apiProvidersHint', "Models Volt calls directly with an API key, or that run on this machine. Keys stay in the OS keychain.");
		this.renderCards(models);
		this.renderAddApi();

		this.host.sectionLabel(localize('voltSettings.healthSection', "Health checks"));
		const group = append(this.host.target(), $('.volt-settings-group'));
		const row = append(group, $('.volt-settings-row'));
		const copy = append(row, $('.volt-settings-row-copy'));
		append(copy, $('label')).textContent = localize('voltSettings.healthInterval', "Health check interval");
		append(copy, $('.desc')).textContent = localize('voltSettings.healthIntervalDesc2', "How often Volt re-checks versions, sign-in and model lists in the background.");
		const control = append(row, $('.volt-settings-row-control'));
		const select = this.host.store.add(new SelectBox([0, 60, 300, 900, 3600].map(seconds => ({ text: seconds === 0 ? localize('voltSettings.manual', "Manual only") : seconds < 3600 ? localize('voltSettings.everyMin', "Every {0} min", seconds / 60) : localize('voltSettings.everyHour', "Every hour") })), 0, this.contextViewService, this.host.selectBoxStyles(), { useCustomDrawn: true, ariaLabel: localize('voltSettings.healthInterval', "Health check interval") }));
		const choices = [0, 60, 300, 900, 3600];
		const current = this.runtime.getHealthCheckInterval();
		const nearest = choices.reduce((best, value, index) => Math.abs(value - current) < Math.abs(choices[best] - current) ? index : best, 0);
		select.select(nearest);
		select.render(append(control, $('.volt-settings-select')));
		this.host.store.add(select.onDidSelect(e => void this.runtime.setHealthCheckInterval(choices[e.index])));
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

	/** Three counts across the top: ready, needs attention, models on. */
	private renderSummary(agents: IVoltProviderStatus[], models: IVoltProviderStatus[]): void {
		const all = [...agents, ...models];
		const ready = all.filter(status => status.enabled && (status.state === 'authenticated' || status.state === 'available')).length;
		const attention = all.filter(status => this.needsAction(status)).length;
		const enabledModels = all.reduce((sum, status) => sum + status.models.filter(model => model.enabled).length, 0);
		const totalModels = all.reduce((sum, status) => sum + status.models.length, 0);
		const strip = append(this.host.target(), $('.volt-settings-stats'));
		const stat = (value: string, label: string, tone?: string) => {
			const cell = append(strip, $('.volt-settings-stat'));
			if (tone) {
				cell.classList.add(tone);
			}
			append(cell, $('.value')).textContent = value;
			append(cell, $('.label')).textContent = label;
		};
		stat(String(ready), localize('voltSettings.statReady', "Ready"), ready ? 'good' : undefined);
		stat(String(attention), localize('voltSettings.statAttention', "Need setup"), attention ? 'warn' : undefined);
		stat(`${enabledModels}/${totalModels}`, localize('voltSettings.statModels', "Models in picker"));
	}

	/** Not installed, signed out, or an API provider missing its key. */
	private needsAction(status: IVoltProviderStatus): boolean {
		if (status.kind === 'agent') {
			const setup = this.setupStates.get(status.providerId);
			return !!setup && (!setup.installed || setup.signIn.kind === 'signedOut');
		}
		return status.enabled && status.state === 'missing';
	}

	private renderCards(statuses: IVoltProviderStatus[]): void {
		if (!statuses.length) {
			append(this.host.target(), $('.volt-settings-empty')).textContent = this.host.search()
				? localize('voltSettings.noProviderMatch', "Nothing matches your search.")
				: localize('voltSettings.noProviders', "No providers yet.");
			return;
		}
		// Ready first, then the ones that need a step, then the rest; by name within each.
		const rank = (status: IVoltProviderStatus) => {
			if (status.kind === 'agent') {
				const setup = this.setupStates.get(status.providerId);
				if (setup && !setup.installed) {
					return 2;
				}
			}
			return status.state === 'authenticated' || status.state === 'available' ? 0 : status.state === 'missing' ? 2 : 1;
		};
		const sorted = [...statuses].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
		const list = append(this.host.target(), $('.volt-settings-list.volt-settings-providers'));
		for (const status of sorted) {
			this.providerCard(list, status);
		}
	}

	private providerCard(list: HTMLElement, status: IVoltProviderStatus): void {
		const setup = status.kind === 'agent' ? this.setupStates.get(status.providerId) : undefined;
		const running = this.running.get(status.profileId);
		const installed = status.kind !== 'agent' || !setup || setup.installed;
		const expanded = this.expanded.has(status.profileId);

		const card = append(list, $('.volt-settings-provider'));
		card.classList.toggle('expanded', expanded);
		card.classList.toggle('not-installed', !installed);
		const row = append(card, $('.volt-settings-provider-row'));
		const icon = append(row, $('.volt-settings-provider-icon'));
		icon.appendChild(createBrandIcon(status.providerId, 20));

		const text = append(row, $('.text'));
		const title = append(text, $('.title'));
		append(title, $('span.name')).textContent = status.label;
		const version = setup?.version ?? status.version;
		if (version && installed) {
			append(title, $('span.version')).textContent = version.startsWith('v') ? version : `v${version}`;
		}
		if (status.earlyAccess) {
			append(title, $('span.badge')).textContent = localize('voltSettings.earlyAccess', "Early Access");
		}
		const detail = append(text, $('.detail'));
		const { tone, label } = this.statusLine(status, setup, running);
		append(detail, $(`span.volt-settings-dot.${tone}`));
		append(detail, $('span.detail-text')).textContent = label;

		const actions = append(row, $('.volt-settings-provider-actions'));
		this.renderActions(actions, status, setup, running);

		if (installed) {
			this.host.switch(row, status.enabled, status.label, () => void this.runtime.setProfileEnabled(status.profileId, !status.enabled));
		}

		const chevron = append(row, $('button.volt-settings-chevron')) as HTMLButtonElement;
		chevron.type = 'button';
		chevron.appendChild(renderIcon(Codicon.chevronRight));
		chevron.setAttribute('aria-expanded', String(expanded));
		chevron.setAttribute('aria-label', localize('voltSettings.providerDetails', "Show models and connection details"));
		const toggle = () => {
			if (this.expanded.has(status.profileId)) {
				this.expanded.delete(status.profileId);
			} else {
				this.expanded.add(status.profileId);
			}
			this.host.rerender();
		};
		this.host.store.add(addDisposableListener(chevron, 'click', toggle));
		// The whole row opens the card, except its buttons and switch.
		this.host.store.add(addDisposableListener(row, 'click', e => {
			if (!(e.target as HTMLElement).closest('button, input, .monaco-inputbox')) {
				toggle();
			}
		}));

		if (running?.action === 'failed') {
			const failure = append(card, $('.volt-settings-provider-failure'));
			append(failure, $('.title')).textContent = localize('voltSettings.installFailed', "The install did not finish.");
			append(failure, $('pre')).textContent = running.output.trim().split('\n').slice(-8).join('\n') || running.command;
		}
		if (this.keyEditor.has(status.profileId)) {
			this.renderKeyEditor(card, status);
		}
		if (expanded) {
			this.providerBody(card, status, setup);
		}
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

	private renderActions(actions: HTMLElement, status: IVoltProviderStatus, setup: IAgentSetupState | undefined, running: RunningAction | undefined): void {
		if (running && running.action !== 'failed') {
			append(actions, $('span.volt-settings-spinner')).appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
			return;
		}
		if (status.kind === 'agent' && setup) {
			const install = this.setup.installCommand(setup);
			if (!setup.installed) {
				if (install) {
					this.button(actions, running?.action === 'failed' ? localize('voltSettings.retryInTerminal', "Install in Terminal") : localize('voltSettings.install', "Install"), true, localize('voltSettings.installHint', "Runs {0}", install), () => running?.action === 'failed' ? void this.signInOrInstallInTerminal(status, setup, 'install') : void this.install(status, setup));
				}
				if (setup.info) {
					this.button(actions, install ? '' : localize('voltSettings.installGuide', "Install Guide"), !install, localize('voltSettings.docs', "Open {0}", setup.info.docsUrl), () => void this.opener.open(URI.parse(setup.info!.docsUrl), { openExternal: true }), Codicon.linkExternal);
				}
				return;
			}
			const login = this.setup.loginCommand(setup);
			if (login && setup.signIn.kind !== 'signedIn') {
				const signedOut = setup.signIn.kind === 'signedOut';
				const hint = setup.info?.loginHint
					? localize('voltSettings.signInHintType', "Opens {0} in a terminal; type {1} there", login, setup.info.loginHint)
					: localize('voltSettings.signInHint', "Runs {0} in a terminal", login);
				this.button(actions, localize('voltSettings.signIn', "Sign In"), signedOut, hint, () => void this.signInOrInstallInTerminal(status, setup, 'login'));
			}
			return;
		}
		if (status.kind === 'model') {
			const download = LOCAL_DOWNLOADS[status.providerId];
			if (download && status.state === 'missing') {
				this.button(actions, localize('voltSettings.download', "Download"), true, download, () => void this.opener.open(URI.parse(download), { openExternal: true }), Codicon.cloudDownload);
				return;
			}
			const profile = this.runtime.listProfiles().find(candidate => candidate.id === status.profileId);
			if (profile?.authKind === 'apikey' && (!profile.hasSecret || status.state === 'missing')) {
				this.button(actions, profile.hasSecret ? localize('voltSettings.replaceKey', "Replace Key") : localize('voltSettings.addKey', "Add Key"), true, localize('voltSettings.addKeyHint', "Saved in the OS keychain"), () => {
					this.keyEditor.add(status.profileId);
					this.host.rerender();
				});
			}
		}
	}

	private button(parent: HTMLElement, label: string, primary: boolean, tooltip: string, run: () => void, icon?: ThemeIcon): void {
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
	}

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

	private renderKeyEditor(card: HTMLElement, status: IVoltProviderStatus): void {
		const editor = append(card, $('.volt-settings-provider-key'));
		const profile = this.runtime.listProfiles().find(candidate => candidate.id === status.profileId);
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
			const draft: IProviderProfileDraft = {
				id: profile.id, label: profile.label, kind: profile.kind, providerId: profile.providerId, modelId: profile.modelId, enabled: true,
				transport: profile.transport, apiStyle: profile.apiStyle, endpoint: profile.endpoint, authKind: profile.authKind,
			};
			void this.runtime.upsertProfile(draft, key).then(() => this.runtime.refreshProviders());
		};
		this.button(editor, localize('voltSettings.save', "Save"), true, localize('voltSettings.addKeyHint', "Saved in the OS keychain"), save);
		this.button(editor, localize('voltSettings.cancel', "Cancel"), false, localize('voltSettings.cancel', "Cancel"), () => {
			this.keyEditor.delete(status.profileId);
			this.host.rerender();
		});
		if (meta?.docs) {
			this.button(editor, '', false, localize('voltSettings.getKey', "Get a key: {0}", meta.docs), () => void this.opener.open(URI.parse(meta.docs!), { openExternal: true }), Codicon.linkExternal);
		}
		this.host.store.add(addDisposableListener(input.inputElement, 'keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				save();
			}
		}));
		mainWindow.setTimeout(() => input.focus());
	}

	private providerBody(card: HTMLElement, status: IVoltProviderStatus, setup: IAgentSetupState | undefined): void {
		const body = append(card, $('.volt-settings-provider-body'));
		const profile = this.runtime.listProfiles().find(candidate => candidate.id === status.profileId);

		const facts = append(body, $('.volt-settings-facts'));
		const fact = (label: string, value: string | undefined, mono = false) => {
			if (!value) {
				return;
			}
			const cell = append(facts, $('.fact'));
			append(cell, $('.label')).textContent = label;
			const text = append(cell, $(mono ? 'code.value' : '.value'));
			text.textContent = value;
			setAgentTooltip(text, value);
		};
		if (status.kind === 'agent') {
			fact(localize('voltSettings.factPath', "Executable"), setup?.path ?? profile?.command, true);
			fact(localize('voltSettings.factLaunch', "Launch"), [profile?.command, ...(profile?.args ?? [])].filter(Boolean).join(' '), true);
		} else {
			fact(localize('voltSettings.factEndpoint', "Endpoint"), profile?.endpoint?.baseURL ?? localize('voltSettings.defaultEndpoint', "Default"), !!profile?.endpoint?.baseURL);
			fact(localize('voltSettings.factKey', "API key"), profile?.authKind === 'apikey' ? (profile.hasSecret ? localize('voltSettings.keySaved', "Saved in keychain") : localize('voltSettings.keyMissing', "Not set")) : undefined);
		}
		const account = status.account ?? (setup?.signIn.kind === 'signedIn' ? setup.signIn.account : undefined);
		const plan = status.plan ?? (setup?.signIn.kind === 'signedIn' ? setup.signIn.plan : undefined);
		fact(localize('voltSettings.factAccount', "Account"), account);
		fact(localize('voltSettings.factPlan', "Plan"), plan);
		fact(localize('voltSettings.factChecked', "Checked"), status.checkedAt ? fromNow(status.checkedAt, true, true) : undefined);

		const footer = append(body, $('.volt-settings-provider-links'));
		if (setup?.info?.docsUrl) {
			this.link(footer, localize('voltSettings.docsLink', "Docs"), Codicon.book, () => void this.opener.open(URI.parse(setup.info!.docsUrl), { openExternal: true }));
		}
		if (setup?.installed && this.setup.loginCommand(setup) && setup.signIn.kind === 'signedIn') {
			this.link(footer, localize('voltSettings.signInAgain', "Sign in again"), Codicon.account, () => void this.signInOrInstallInTerminal(status, setup, 'login'));
		}
		if (profile?.authKind === 'apikey') {
			this.link(footer, profile.hasSecret ? localize('voltSettings.replaceKey', "Replace Key") : localize('voltSettings.addKey', "Add Key"), Codicon.key, () => {
				this.keyEditor.add(status.profileId);
				this.host.rerender();
			});
		}
		if (profile && !profile.id.startsWith('seed-')) {
			this.link(footer, localize('voltSettings.remove', "Remove"), Codicon.trash, () => void this.runtime.deleteProfile(profile.id), 'danger');
		}

		this.renderModels(body, status);
	}

	private link(parent: HTMLElement, label: string, icon: ThemeIcon, run: () => void, tone?: string): void {
		const link = append(parent, $('button.volt-settings-link')) as HTMLButtonElement;
		link.type = 'button';
		if (tone) {
			link.classList.add(tone);
		}
		link.appendChild(renderIcon(icon));
		append(link, $('span')).textContent = label;
		this.host.store.add(addDisposableListener(link, 'click', run));
	}

	/**
	 * The provider's models as a dense list, like T3 Code's: name, model id, what it can do and its
	 * context on one line, and a switch. Models off the picker sink to the end and fade. A filter
	 * narrows the list in place, so typing never loses focus to a re-render.
	 */
	private renderModels(body: HTMLElement, status: IVoltProviderStatus): void {
		const models = [...status.models].sort((a, b) => Number(b.enabled) - Number(a.enabled));
		const head = append(body, $('.volt-settings-models-head'));
		append(head, $('span.title')).textContent = localize('voltSettings.modelsTitle', "Models");
		if (!models.length) {
			append(body, $('.volt-settings-provider-empty')).textContent = status.kind === 'agent'
				? localize('voltSettings.agentNoModels', "No model list yet. It shows up once the agent is installed and signed in, or the agent picks its own model.")
				: localize('voltSettings.providerNoModels', "No models reported yet. Add a key or start the app, then refresh.");
			return;
		}
		const on = models.filter(model => model.enabled).length;
		const toolbar = append(body, $('.volt-settings-models-toolbar'));
		const filter = this.host.store.add(new InputBox(append(toolbar, $('.volt-settings-input.filter')), this.contextViewService, {
			placeholder: localize('voltSettings.filterModels', "Filter models"),
			ariaLabel: localize('voltSettings.filterModels', "Filter models"),
			inputBoxStyles: this.host.inputBoxStyles(),
		}));
		const hidden = models.length - on;
		append(toolbar, $('span.count')).textContent = hidden
			? localize('voltSettings.modelCountHidden', "{0} models · {1} hidden", models.length, hidden)
			: localize('voltSettings.modelCountAll', "{0} models", models.length);
		if (models.length > 1) {
			const enable = on < models.length;
			const bulk = append(toolbar, $('button.volt-settings-link')) as HTMLButtonElement;
			bulk.type = 'button';
			bulk.textContent = enable ? localize('voltSettings.enableAll', "Enable all") : localize('voltSettings.disableAll', "Disable all");
			this.host.store.add(addDisposableListener(bulk, 'click', async () => {
				for (const model of models) {
					if (model.enabled !== enable) {
						await this.runtime.setModelEnabled(model.ref, enable);
					}
				}
			}));
		}

		const list = append(body, $('.volt-settings-models'));
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
		this.host.store.add(filter.onDidChange(value => {
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
		const name = append(row, $('.name'));
		append(name, $('span.label')).textContent = model.label;
		if (model.qualifier && model.qualifier.toLowerCase() !== providerLabel.toLowerCase()) {
			append(name, $('span.qualifier')).textContent = model.qualifier;
		}
		if (model.id && model.id.toLowerCase() !== model.label.toLowerCase()) {
			append(name, $('code.slug')).textContent = model.id;
		}
		const traits = this.modelTraits(model);
		append(row, $('span.traits')).textContent = traits.join(' · ');
		// Everything the model says about itself, on hover: its blurb, every effort level, fixed settings.
		const reasoning = model.optionDescriptors?.find(descriptor => descriptor.id === MODEL_OPTION_REASONING)?.options;
		const hover = [
			model.description,
			reasoning && reasoning.length > 2 ? localize('voltSettings.hoverEffort', "Effort: {0}", reasoning.map(option => option.label).join(', ')) : undefined,
			model.detail,
		].filter(Boolean).join(' · ');
		if (hover) {
			setAgentTooltip(name, hover);
		}
		this.host.switch(row, model.enabled, localize('voltSettings.showInPicker', "Show {0} in the model picker", model.label), () => void this.runtime.setModelEnabled(model.ref, !model.enabled)).classList.add('small');
		return row;
	}

	private renderAddApi(): void {
		const target = this.host.target();
		if (this.adding !== 'api') {
			this.addButton(target, localize('voltSettings.addApiProvider', "Add API provider"), () => {
				this.adding = 'api';
				this.host.rerender();
			});
			return;
		}
		const form = append(target, $('.volt-settings-form'));
		append(form, $('label.volt-settings-form-title')).textContent = localize('voltSettings.addApiProvider', "Add API provider");
		let provider = API_PROVIDERS[0];
		const grid = append(form, $('.volt-settings-form-grid'));
		const providerBox = this.field(grid, localize('voltSettings.provider', "Provider"), host => {
			const box = this.host.store.add(new SelectBox(API_PROVIDERS.map(item => ({ text: item.label }) satisfies ISelectOptionItem), 0, this.contextViewService, this.host.selectBoxStyles(), { useCustomDrawn: true, ariaLabel: localize('voltSettings.provider', "Provider") }));
			box.render(host);
			return box;
		});
		const name = this.input(grid, localize('voltSettings.label', "Name"), localize('voltSettings.label.placeholder', "Display name (optional)"));
		const key = this.input(grid, localize('voltSettings.apiKey', "API key"), provider.keyHint ?? '', 'password');
		const baseUrl = this.input(grid, localize('voltSettings.baseUrl', "Base URL"), localize('voltSettings.baseUrl.placeholder', "Optional"));
		const model = this.input(grid, localize('voltSettings.modelId', "Model id"), localize('voltSettings.modelId.placeholder', "Optional, e.g. gpt-4.1"));
		this.host.store.add(providerBox.onDidSelect(e => {
			provider = API_PROVIDERS[e.index];
			key.setPlaceHolder(provider.keyHint ?? localize('voltSettings.noKeyNeeded', "Not needed"));
			baseUrl.setPlaceHolder(provider.baseUrl ?? localize('voltSettings.baseUrl.placeholder', "Optional"));
		}));
		const actions = append(form, $('.volt-settings-actions'));
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
			this.adding = undefined;
			void this.runtime.upsertProfile(draft, key.value.trim() || undefined).then(() => this.runtime.refreshProviders());
		});
		this.button(actions, localize('voltSettings.cancel', "Cancel"), false, localize('voltSettings.cancel', "Cancel"), () => {
			this.adding = undefined;
			this.host.rerender();
		});
	}

	private renderAddAgent(): void {
		const target = this.host.target();
		if (this.adding !== 'agent') {
			this.addButton(target, localize('voltSettings.addCustomAgent', "Add custom ACP agent"), () => {
				this.adding = 'agent';
				this.host.rerender();
			});
			return;
		}
		const form = append(target, $('.volt-settings-form'));
		append(form, $('label.volt-settings-form-title')).textContent = localize('voltSettings.addCustomAgent', "Add custom ACP agent");
		append(form, $('.volt-settings-section-hint')).textContent = localize('voltSettings.addCustomAgentHint', "Any command that speaks the Agent Client Protocol over stdio.");
		const grid = append(form, $('.volt-settings-form-grid'));
		const name = this.input(grid, localize('voltSettings.label', "Name"), localize('voltSettings.agentName.placeholder', "My agent"));
		const command = this.input(grid, localize('voltSettings.command', "Command"), 'my-agent');
		const args = this.input(grid, localize('voltSettings.args', "Args"), 'acp');
		const cwd = this.input(grid, localize('voltSettings.cwd', "Working directory"), localize('voltSettings.cwd.placeholder', "Optional"));
		const actions = append(form, $('.volt-settings-actions'));
		this.button(actions, localize('voltSettings.connect', "Connect"), true, localize('voltSettings.connectAgentHint', "Adds the agent to the composer"), () => {
			if (!command.value.trim()) {
				command.focus();
				return;
			}
			this.adding = undefined;
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
			}).then(() => this.runtime.refreshProviders());
		});
		this.button(actions, localize('voltSettings.cancel', "Cancel"), false, localize('voltSettings.cancel', "Cancel"), () => {
			this.adding = undefined;
			this.host.rerender();
		});
	}

	private addButton(parent: HTMLElement, label: string, run: () => void): void {
		const button = append(parent, $('button.volt-settings-add')) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(renderIcon(Codicon.add));
		append(button, $('span')).textContent = label;
		this.host.store.add(addDisposableListener(button, 'click', run));
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
}
