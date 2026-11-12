/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IVoltAccountsService, IVoltClaudeAccountsState } from '../../../../platform/voltAccounts/common/voltAccounts.js';
import { IVoltUsageLimitGroup, IVoltUsageService } from '../../../../platform/voltUsage/common/voltUsage.js';
import { createBrandIcon } from '../../../services/voltRuntime/browser/providers/providerBrands.js';
import { IVoltFeatureDockSection } from '../../voltCustomize/browser/voltFeatureModules.js';
import { DockGroup } from '../../voltAgent/browser/chrome/agentDockSections.js';
import { AgentUsageHoverCard, usageAccountRows } from './agentUsageHoverCard.js';

/** The bars refresh this often while they show (each read asks every provider for its limits). */
const USAGE_REFRESH_MS = 5 * 60_000;

/**
 * Usage in the side toolbar: a thin bar per account (its brand mark, then how much of its current
 * window is used), nothing else. Hovering the bars opens the full Usage limits card beside them.
 */
export class AgentDockUsage extends Disposable implements IVoltFeatureDockSection {

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
		if (!this.shown || this._store.isDisposed) {
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
