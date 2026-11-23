/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IVoltAccountsService, IVoltClaudeAccountsState } from '../../../../platform/voltAccounts/common/voltAccounts.js';
import { IVoltUsageLimitGroup, IVoltUsageService, VOLT_USAGE_PROVIDERS, VoltUsageProvider } from '../../../../platform/voltUsage/common/voltUsage.js';
import { createBrandIcon } from '../../../services/voltRuntime/browser/providers/providerBrands.js';
import { providerFamily } from '../../../services/voltRuntime/browser/providers/providerFamily.js';
import { IAgentOrchestratorService } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { IVoltFeatureDockSection } from '../../voltCustomize/browser/voltFeatureModules.js';
import { DockGroup } from '../../voltAgent/browser/chrome/agentDockSections.js';
import { onDidChangeShownAgentChat, shownAgentChat } from '../../voltAgent/browser/editor/agentShownChat.js';
import { ACCOUNT_NAMES, AgentUsageHoverCard, IUsageAccountRow, shortIn, usageAccountRows } from './agentUsageHoverCard.js';

/** The bars refresh this often while they show (each read asks every provider for its limits). */
const USAGE_REFRESH_MS = 5 * 60_000;

/** API-key connections bill per token, not against a subscription's limits. */
const API_KEY_PROVIDERS = new Set(['anthropic', 'openai', 'xai']);

/** The subscription a model draws on, by its provider's family (Claude, Codex, Cursor, OpenCode, Grok); API keys and local models have none. */
function usageProviderOf(providerId: string | undefined): VoltUsageProvider | undefined {
	const family = providerId && !API_KEY_PROVIDERS.has(providerId) ? providerFamily(providerId) : undefined;
	return VOLT_USAGE_PROVIDERS.find(provider => provider === family);
}

/**
 * Usage in the side toolbar: the account the chat in front runs on (its brand mark and name, the
 * provider and plan, never the email), how much of its current window is used and when that
 * resets, over a thin bar. Hovering opens the full Usage limits card with every account.
 */
export class AgentDockUsage extends Disposable implements IVoltFeatureDockSection {

	readonly section: HTMLElement;
	private readonly bars: HTMLElement;
	private readonly usage: IVoltUsageService | undefined;
	private readonly accounts: IVoltAccountsService | undefined;
	private readonly runtime: IAgentRuntimeService | undefined;
	private readonly orchestrator: IAgentOrchestratorService | undefined;
	/** The provider last drawn for the chat in front (`null` before the first draw). */
	private drawnProvider: VoltUsageProvider | undefined | null = null;
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
		this.runtime = instantiationService.invokeFunction(accessor => accessor.getIfExists(IAgentRuntimeService));
		this.orchestrator = instantiationService.invokeFunction(accessor => accessor.getIfExists(IAgentOrchestratorService));
		this.section = append(parent, $('.volt-agent-dock-section.volt-agent-dock-usage'));
		this._register(toDisposable(() => this.section.remove()));
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
		// Another chat in front, or this chat's model changed: draw that model's account.
		const follow = () => {
			if (this.chatProvider() !== this.drawnProvider) {
				this.render();
			}
		};
		this.visibleStore.add(onDidChangeShownAgentChat(follow));
		if (this.orchestrator) {
			this.visibleStore.add(this.orchestrator.onDidChange(change => {
				const chat = shownAgentChat();
				if (chat && change.threads.includes(chat)) {
					follow();
				}
			}));
		}
		if (this.runtime) {
			this.visibleStore.add(this.runtime.onDidChangeActiveCatalog(follow));
			// The catalog loads after the window: until then no model resolves.
			this.visibleStore.add(this.runtime.onDidChangeCatalog(follow));
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

	/** The subscription of the model selected in the composer (what the next send runs on), else the chat's own model. */
	private chatProvider(): VoltUsageProvider | undefined {
		if (!this.runtime) {
			return undefined;
		}
		const chat = shownAgentChat();
		const item = [this.runtime.getActiveCatalogRef(), chat ? this.orchestrator?.getThread(chat)?.modelRef : undefined]
			.map(ref => ref ? this.runtime!.resolveCatalogItem(ref) : undefined)
			.find(found => !!found);
		return usageProviderOf(item?.providerId);
	}

	/** Only the account the chat runs on: for Claude the account in use, for the others their one reading. */
	private chatRows(provider: VoltUsageProvider | undefined): IUsageAccountRow[] {
		const rows = usageAccountRows(this.groups, this.accountsState).filter(row => row.provider === provider);
		const row = rows.find(item => item.active) ?? rows[0];
		return row ? [row] : [];
	}

	private render(): void {
		if (!this.shown || this._store.isDisposed) {
			return;
		}
		const now = Date.now();
		const provider = this.chatProvider();
		this.drawnProvider = provider;
		const rows = this.chatRows(provider);
		this.bars.replaceChildren();
		const labels: string[] = [];
		// Names, not emails (the card shows emails only when asked); two accounts of one plan are told apart by number.
		const names = rows.map(row => [ACCOUNT_NAMES[row.provider], row.plan].filter(Boolean).join(' '));
		const seen = new Map<string, number>();
		for (const [index, row] of rows.entries()) {
			// The account's first window is its current one (Claude's session, Codex's 30 days, Grok's week).
			const window = row.limits?.windows[0];
			const passed = window?.resetsAt !== undefined && window.resetsAt <= now;
			const used = window ? (passed ? 0 : Math.max(0, Math.round(window.usedPercent))) : undefined;
			const count = (seen.get(names[index]) ?? 0) + 1;
			seen.set(names[index], count);
			const name = names.filter(item => item === names[index]).length > 1 ? `${names[index]} ${count}` : names[index];
			const line = append(this.bars, $('.volt-agent-dock-usage-line'));
			line.classList.toggle('active', row.active);
			line.classList.toggle('high', used !== undefined && used >= 80 && used < 100);
			line.classList.toggle('full', used !== undefined && used >= 100);
			line.classList.toggle('unknown', used === undefined);
			const head = append(line, $('.volt-agent-dock-usage-head'));
			head.appendChild(createBrandIcon(row.provider, 14));
			append(head, $('span.volt-agent-dock-usage-name')).textContent = name;
			const value = append(head, $('span.volt-agent-dock-usage-value'));
			if (used === undefined) {
				value.textContent = row.expired ? localize('voltAgent.dock.usageSignIn', "Sign in") : '\u2014';
			} else {
				append(value, $('span.volt-agent-dock-usage-percent')).textContent = `${used}%`;
				if (window?.resetsAt !== undefined && !passed) {
					append(value, $('span.volt-agent-dock-usage-reset')).textContent = shortIn(window.resetsAt - now);
				}
			}
			const bar = append(line, $('span.volt-agent-dock-usage-bar'));
			append(bar, $('span.volt-agent-dock-usage-fill')).style.width = `${Math.min(100, used ?? 0)}%`;
			labels.push(used === undefined ? name : `${name}: ${used}%`);
		}
		if (!rows.length) {
			append(this.bars, $('.volt-agent-dock-usage-empty')).textContent = !provider
				? localize('voltAgent.dock.usageNoPlan', "This chat's model has no subscription limits")
				: this.groups === undefined && !this.accountsState
					? localize('voltAgent.dock.usageLoading', "Reading your limits...")
					: localize('voltAgent.dock.usageNone', "No subscription limits found");
		}
		this.bars.setAttribute('aria-label', labels.length ? localize('voltAgent.dock.usageAria', "Usage: {0}", labels.join(', ')) : localize('voltAgent.dock.usage', "Usage"));
	}
}
