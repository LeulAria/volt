/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentUsageHoverCard.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IVoltAccountsService, IVoltClaudeAccountsState } from '../../../../../platform/voltAccounts/common/voltAccounts.js';
import { IVoltUsageLimitGroup, IVoltUsageLimitWindow, IVoltUsageService, VoltUsageProvider } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { createBrandIcon } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { createVoltButton, voltButtonClasses } from '../chrome/voltButton.js';
import { OPEN_AGENT_USAGE_COMMAND_ID } from './agentUsageEditor.js';
import { formatResetTime } from './agentUsageFormat.js';

/** The pointer rests on the button this long before the card opens. */
const SHOW_DELAY_MS = 250;
/** Time to cross the gap from the button to the card (and back) before it closes. */
const HIDE_DELAY_MS = 160;
/** Whether account names (emails) show in the clear; they are blurred until the user shows them. */
const STORAGE_SHOW_NAMES = 'volt.usage.showAccountNames';

const ACCOUNT_NAMES: Record<VoltUsageProvider, string> = {
	claude: 'Claude',
	codex: 'Codex',
	cursor: 'Cursor',
	opencode: 'OpenCode Go',
	grok: 'Grok',
};

/** Time until a reset, as short as it gets: "45m", "5h", "3d", "2w". */
function shortIn(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) {
		return localize('voltUsageHover.minutes', "{0}m", minutes);
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return localize('voltUsageHover.hours', "{0}h", hours);
	}
	const days = Math.round(hours / 24);
	return days < 14 ? localize('voltUsageHover.days', "{0}d", days) : localize('voltUsageHover.weeks', "{0}w", Math.round(days / 7));
}

export interface IUsageAccountRow {
	readonly provider: VoltUsageProvider;
	readonly name: string;
	readonly plan?: string;
	readonly active: boolean;
	readonly limits?: IVoltUsageLimitGroup;
	readonly expired?: boolean;
}

/** Claude's saved accounts (the one in use reads its live limits), then every other account a limit was read for. */
export function usageAccountRows(groups: readonly IVoltUsageLimitGroup[] | undefined, accountsState: IVoltClaudeAccountsState | undefined): IUsageAccountRow[] {
	const read = groups ?? [];
	const claude = accountsState?.accounts ?? [];
	const rows: IUsageAccountRow[] = [];
	for (const account of [...claude].sort((a, b) => Number(b.active) - Number(a.active))) {
		const live = account.active ? read.find(group => group.provider === 'claude' && (group.account?.id === account.id || group.account?.label === account.email)) : undefined;
		rows.push({
			provider: 'claude',
			name: account.email,
			plan: account.plan,
			active: account.active,
			limits: live ?? account.limits,
			expired: account.needsSignIn && !account.limits,
		});
	}
	for (const group of read) {
		if (group.provider === 'claude' && claude.length) {
			continue;
		}
		rows.push({ provider: group.provider, name: group.account?.label ?? ACCOUNT_NAMES[group.provider], plan: group.plan, active: false, limits: group });
	}
	return rows;
}

/** Where the card opens: above its button (the home footer), or beside it toward the window (the side toolbar). */
export type UsageHoverPlacement = 'above' | 'start';

/**
 * Every account's limits at a glance over the Usage button: each account (Claude's saved ones
 * first, the one in use on top), its current session and weekly windows, how much of each is used
 * and when it resets. Shows the last reading at once and refreshes it while open. Opaque, like the
 * menus (see volt-transparent-window).
 */
export class AgentUsageHoverCard extends Disposable {

	private readonly card: HTMLElement;
	private readonly visibleStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly renderStore = this._register(new DisposableStore());
	private showHandle: number | undefined;
	private hideHandle: number | undefined;
	private readonly accounts: IVoltAccountsService | undefined;
	private readonly usage: IVoltUsageService | undefined;
	private groups: readonly IVoltUsageLimitGroup[] | undefined;
	private accountsState: IVoltClaudeAccountsState | undefined;
	private loading = false;

	constructor(
		private readonly anchor: HTMLElement,
		private readonly placement: UsageHoverPlacement,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		// Absent where the services are not (another machine's browser, tests).
		this.accounts = instantiationService.invokeFunction(accessor => accessor.getIfExists(IVoltAccountsService));
		this.usage = instantiationService.invokeFunction(accessor => accessor.getIfExists(IVoltUsageService));
		this.card = $('.volt-usage-hover-card');
		this.card.setAttribute('role', 'dialog');
		this.card.setAttribute('aria-label', localize('voltUsageHover.aria', "Usage limits"));
		this._register(toDisposable(() => {
			this.clearTimers();
			this.card.remove();
		}));
		this._register(addDisposableListener(anchor, 'mouseenter', () => this.scheduleShow()));
		this._register(addDisposableListener(anchor, 'mouseleave', () => this.scheduleHide()));
		// Clicking opens the Usage page: the card would cover it.
		this._register(addDisposableListener(anchor, 'mousedown', () => this.hide()));
		this._register(addDisposableListener(this.card, 'mouseenter', () => this.cancelHide()));
		this._register(addDisposableListener(this.card, 'mouseleave', () => this.scheduleHide()));
	}

	get visible(): boolean {
		return !!this.visibleStore.value;
	}

	hide(): void {
		this.clearTimers();
		this.visibleStore.clear();
		this.renderStore.clear();
		this.card.remove();
	}

	private scheduleShow(): void {
		this.cancelHide();
		if (this.visible || this.showHandle !== undefined || (!this.usage && !this.accounts)) {
			return;
		}
		this.showHandle = getWindow(this.anchor).setTimeout(() => {
			this.showHandle = undefined;
			void this.show();
		}, SHOW_DELAY_MS);
	}

	private scheduleHide(): void {
		const win = getWindow(this.anchor);
		if (this.showHandle !== undefined) {
			win.clearTimeout(this.showHandle);
			this.showHandle = undefined;
		}
		if (!this.visible || this.hideHandle !== undefined) {
			return;
		}
		this.hideHandle = win.setTimeout(() => {
			this.hideHandle = undefined;
			this.hide();
		}, HIDE_DELAY_MS);
	}

	private cancelHide(): void {
		if (this.hideHandle !== undefined) {
			getWindow(this.anchor).clearTimeout(this.hideHandle);
			this.hideHandle = undefined;
		}
	}

	private clearTimers(): void {
		const win = getWindow(this.anchor);
		if (this.showHandle !== undefined) {
			win.clearTimeout(this.showHandle);
			this.showHandle = undefined;
		}
		this.cancelHide();
	}

	private async show(): Promise<void> {
		if (!this.anchor.isConnected) {
			return;
		}
		const store = new DisposableStore();
		this.visibleStore.value = store;
		const host = this.anchor.closest('.monaco-workbench') ?? getWindow(this.anchor).document.body;
		host.appendChild(this.card);
		store.add(addDisposableListener(getWindow(this.anchor), 'blur', () => this.hide()));
		if (this.accounts) {
			store.add(this.accounts.onDidChangeClaudeAccounts(() => void this.load(false)));
		}
		// The last reading straight away, then a fresh one.
		this.groups ??= await this.usage?.peekLimits();
		if (this.visibleStore.value !== store) {
			return;
		}
		this.render();
		void this.load(true);
	}

	private async load(refresh: boolean): Promise<void> {
		if (this.loading) {
			return;
		}
		this.loading = true;
		try {
			const [groups, accounts] = await Promise.all([
				this.usage?.getLimits(false).catch(() => this.groups),
				this.accounts?.getClaudeAccounts(refresh).catch(() => this.accountsState),
			]);
			this.groups = groups ?? this.groups;
			this.accountsState = accounts ?? this.accountsState;
		} finally {
			this.loading = false;
		}
		if (this.visible) {
			this.render();
		}
	}

	private render(): void {
		const card = this.card;
		this.renderStore.clear();
		card.replaceChildren();
		const now = Date.now();

		const rows = usageAccountRows(this.groups, this.accountsState);
		const head = append(card, $('.volt-usage-hover-head'));
		append(head, $('span.volt-usage-hover-title')).textContent = localize('voltUsageHover.title', "Usage limits");
		const checked = Math.max(0, ...rows.map(row => row.limits?.checkedAt ?? 0));
		append(head, $('span.volt-usage-hover-checked')).textContent = this.loading
			? localize('voltUsageHover.refreshing', "Refreshing...")
			: checked ? (now - checked < 60_000 ? localize('voltUsageHover.justNow', "just now") : fromNow(checked, true)) : '';
		// Emails stay blurred (a screen share, a screenshot) until the eye shows them.
		const showNames = this.storage.getBoolean(STORAGE_SHOW_NAMES, StorageScope.PROFILE, false);
		card.classList.toggle('names-hidden', !showNames);
		const eye = append(head, $('button.volt-usage-hover-eye', { type: 'button' })) as HTMLButtonElement;
		eye.classList.add(...voltButtonClasses('ghost'));
		eye.appendChild(renderIcon(showNames ? Codicon.eye : Codicon.eyeClosed));
		const eyeLabel = showNames ? localize('voltUsageHover.hideNames', "Blur account names") : localize('voltUsageHover.showNames', "Show account names");
		eye.title = eyeLabel;
		eye.setAttribute('aria-label', eyeLabel);
		eye.setAttribute('aria-pressed', String(showNames));
		this.renderStore.add(addDisposableListener(eye, 'click', () => {
			this.storage.store(STORAGE_SHOW_NAMES, !showNames, StorageScope.PROFILE, StorageTarget.USER);
			this.render();
		}));
		const open = this.renderStore.add(createVoltButton(head, 'ghost', { ariaLabel: localize('voltUsageHover.openAria', "Open the Usage page") }));
		open.label = localize('voltUsageHover.open', "Open Usage");
		this.renderStore.add(open.onDidClick(() => {
			this.hide();
			void this.commandService.executeCommand(OPEN_AGENT_USAGE_COMMAND_ID);
		}));

		if (!rows.length) {
			append(card, $('.volt-usage-hover-empty')).textContent = this.groups === undefined && !this.accountsState
				? localize('voltUsageHover.loading', "Reading your limits...")
				: localize('voltUsageHover.none', "No subscription limits found. Sign in to Claude, Codex or Cursor to see them here.");
			this.place();
			return;
		}

		const list = append(card, $('.volt-usage-hover-accounts'));
		for (const row of rows) {
			const item = append(list, $('.volt-usage-hover-account'));
			item.classList.toggle('active', row.active);
			const top = append(item, $('.volt-usage-hover-who'));
			top.appendChild(createBrandIcon(row.provider, 12));
			const name = append(top, $('span.volt-usage-hover-name'));
			name.textContent = row.name;
			// An account's own name (an email) blurs; a provider's ("Cursor") does not. Nor does it show in the hover.
			const own = row.name !== ACCOUNT_NAMES[row.provider];
			name.classList.toggle('private', own);
			name.title = showNames || !own ? row.name : '';
			const plan = row.plan ? `${ACCOUNT_NAMES[row.provider]} ${row.plan}` : ACCOUNT_NAMES[row.provider];
			append(top, $('span.volt-usage-hover-plan')).textContent = plan;
			if (row.active) {
				append(top, $('span.volt-usage-hover-badge')).textContent = localize('voltUsageHover.inUse', "In use");
			}
			if (row.expired) {
				append(item, $('.volt-usage-hover-note.warn')).textContent = localize('voltUsageHover.expired', "Sign-in expired. Sign in again in Settings.");
				continue;
			}
			const windows = row.limits?.windows ?? [];
			if (!windows.length) {
				append(item, $('.volt-usage-hover-note')).textContent = row.limits?.error ?? localize('voltUsageHover.unknown', "Limits not read yet");
				continue;
			}
			for (const window of windows) {
				this.renderWindow(item, window, now);
			}
		}
		this.place();
	}

	/** One line: "Current week · Opus  [bar]  47%  3d"; the full reset time is in its hover. */
	private renderWindow(parent: HTMLElement, window: IVoltUsageLimitWindow, now: number): void {
		const passed = window.resetsAt !== undefined && window.resetsAt <= now;
		const used = passed ? 0 : Math.max(0, Math.round(window.usedPercent));
		const label = window.scope && window.scope !== window.label ? `${window.label} · ${window.scope}` : window.label;
		const meter = append(parent, $('.volt-usage-hover-window'));
		meter.classList.toggle('high', used >= 80);
		meter.classList.toggle('full', used >= 100);
		append(meter, $('span.volt-usage-hover-label')).textContent = label;
		const bar = append(meter, $('span.volt-usage-hover-bar'));
		append(bar, $('span.volt-usage-hover-fill')).style.width = `${Math.min(100, used)}%`;
		append(meter, $('span.volt-usage-hover-value')).textContent = `${used}%`;
		const reset = append(meter, $('span.volt-usage-hover-reset'));
		reset.textContent = window.resetsAt && !passed ? shortIn(window.resetsAt - now) : '-';
		meter.title = `${label}: ${used}%. ${window.resetsAt && !passed
			? localize('voltUsageHover.resets', "Resets {0} · {1}", fromNow(window.resetsAt, true, true), formatResetTime(window.resetsAt))
			: passed ? localize('voltUsageHover.reset', "Reset just now") : localize('voltUsageHover.notStarted', "Starts with your next message")}`;
	}

	/**
	 * Above the button, its left edge on the button's, inside the window; below when there is no
	 * room above. 'start': to the left of the anchor, top edges level, inside the window.
	 */
	private place(): void {
		const win = getWindow(this.anchor);
		const rect = this.anchor.getBoundingClientRect();
		const width = this.card.offsetWidth;
		const height = this.card.offsetHeight;
		const gap = 6;
		if (this.placement === 'start') {
			this.card.style.left = `${Math.max(8, rect.left - width - gap)}px`;
			this.card.style.top = `${Math.max(8, Math.min(rect.top - 8, win.innerHeight - height - 8))}px`;
			return;
		}
		const left = Math.max(8, Math.min(rect.left, win.innerWidth - width - 8));
		const above = rect.top - height - gap;
		this.card.style.left = `${left}px`;
		this.card.style.top = `${above >= 8 ? above : Math.min(rect.bottom + gap, win.innerHeight - height - 8)}px`;
	}
}
