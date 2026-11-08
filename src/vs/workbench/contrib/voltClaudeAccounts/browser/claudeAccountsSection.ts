/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CLAUDE_ACCOUNT_SWITCHING_SETTING, CLAUDE_AUTO_SWITCH_THRESHOLD_SETTING, IVoltAccountsService, IVoltClaudeAccount, IVoltClaudeAccountsState } from '../../../../platform/voltAccounts/common/voltAccounts.js';
import { IVoltUsageLimitWindow } from '../../../../platform/voltUsage/common/voltUsage.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { IClaudeAccountsSection, IClaudeAccountsSectionHost } from '../common/voltClaudeAccounts.js';

/** While a sign-in runs in the terminal, how often and how long the broker is asked again. */
const SIGN_IN_POLL_MS = 3000;
const SIGN_IN_POLL_LIMIT_MS = 5 * 60_000;

/**
 * Providers & Models > Claude > Accounts: saved Claude logins with their limits, the one in use
 * marked. Switch makes another one Claude Code's login without a browser sign-in; Add account
 * signs in once, in a terminal, in a folder of its own. Under the list: manual or automatic
 * switching. Every change goes through the accounts broker (`IVoltAccountsService`).
 */
export class ClaudeAccountsSection implements IClaudeAccountsSection {

	private accountsState: IVoltClaudeAccountsState | undefined;
	private accountsLoading = false;
	private limitsRequestedAt = 0;
	/** A terminal sign-in adding a Claude account, polled until it lands. */
	private accountLogin: { readonly id: string; readonly email?: string } | undefined;
	/** The account a switch is running for, and the last thing that went wrong. */
	private accountBusy: string | undefined;
	private accountError: string | undefined;
	private disposed = false;
	private readonly store = new DisposableStore();

	constructor(
		private readonly host: IClaudeAccountsSectionHost,
		private readonly accounts: IVoltAccountsService,
		private readonly configurationService: IConfigurationService,
	) {
		this.store.add(accounts.onDidChangeClaudeAccounts(() => void this.loadAccounts(false)));
	}

	dispose(): void {
		this.disposed = true;
		this.store.dispose();
		this.loginWatch?.dispose();
	}

	/** Reads the saved accounts; `refreshLimits` also reads limits that are stale. Redraws when they arrive. */
	private async loadAccounts(refreshLimits: boolean): Promise<void> {
		if (this.accountsLoading) {
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
		if (!this.disposed && this.host.isShowing()) {
			this.host.rerender();
		}
	}

	/**
	 * Saved Claude logins with their limits, the one in use marked. Switch makes another one
	 * Claude Code's login without a browser sign-in; Add account signs in once, in a terminal, in a
	 * folder of its own. Under the list: manual or automatic switching.
	 */
	render(parent: HTMLElement): void {
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
		this.host.renderStore().add(toDisposable(() => mainWindow.clearTimeout(recheck)));
		const heading = this.host.sectionTitle(parent, localize('voltSettings.claudeAccounts', "Accounts"), localize('voltSettings.claudeAccountsHint', "Sign in to each Claude account once. Switching changes the account Claude Code uses on this computer, in Volt and in the terminal; running chats pick it up within about 30 seconds."));
		const adding = !!this.accountLogin;
		const add = this.host.link(heading, adding ? localize('voltSettings.claudeAddingAccount', "Waiting for sign-in") : localize('voltSettings.claudeAddAccount', "Add account"), adding ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.add, () => {
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
			this.host.privateText(detail, [account.plan ? localize('voltSettings.claudePlanName', "Claude {0}", account.plan) : undefined, account.organizationName].filter(Boolean).join(' · '));
		}
		this.accountLimits(append(row, $('.volt-pm-account-limits')), account);

		const actions = append(row, $('.volt-pm-actions'));
		if (this.accountBusy === account.id) {
			append(actions, $('span.volt-settings-spinner')).appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
			return;
		}
		if (account.needsSignIn) {
			this.host.button(actions, localize('voltSettings.signIn', "Sign In"), 'primary', localize('voltSettings.claudeSignInAgainHint', "Signs in to {0} again in a terminal", account.email), () => void this.addClaudeAccount(account.email));
		} else if (!account.active) {
			this.host.button(actions, localize('voltSettings.claudeSwitch', "Switch"), 'ghost', localize('voltSettings.claudeSwitchHint', "Make {0} Claude Code's account", account.email), () => void this.switchClaudeAccount(account));
		}
		if (!account.active) {
			const remove = this.host.button(actions, '', 'ghost', localize('voltSettings.claudeRemoveAccount', "Forget {0}", account.email), () => void this.removeClaudeAccount(account), Codicon.trash);
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
		this.host.sectionTitle(parent, localize('voltSettings.claudeSwitching', "Switching"));
		const group = append(parent, $('.volt-settings-group'));
		const auto = state.switching === 'auto';
		const autoTitle = localize('voltSettings.claudeAutoSwitch', "Switch automatically");
		const autoDesc = state.accounts.length < 2
			? localize('voltSettings.claudeAutoSwitchNeedsTwo', "Add a second account first. Then, near a limit, Volt moves Claude to the saved account with the most left.")
			: localize('voltSettings.claudeAutoSwitchDesc', "When the account in use reaches {0}% of its session or weekly limit, Volt moves Claude to the saved account with the most left. Off: Claude stays on the account you pick.", state.threshold);
		this.host.switch(this.host.row(group, autoTitle, autoDesc), auto, autoTitle, () => {
			void this.configurationService.updateValue(CLAUDE_ACCOUNT_SWITCHING_SETTING, auto ? 'manual' : 'auto').then(() => this.loadAccounts(false));
		});
		if (auto) {
			const control = this.host.row(group, localize('voltSettings.claudeSwitchAt', "Switch at"), localize('voltSettings.claudeSwitchAtDesc', "How full the session or weekly limit gets before Volt moves on. Volt checks every 2 minutes."));
			const choices = [70, 80, 85, 90, 95];
			const nearest = choices.reduce((best, value) => Math.abs(value - state.threshold) < Math.abs(best - state.threshold) ? value : best, choices[0]);
			this.host.dropdown(control, localize('voltSettings.claudeSwitchAt', "Switch at"), String(nearest), choices.map(value => ({
				id: String(value),
				label: localize('voltSettings.percentUsed', "{0}% used", value),
			})), value => void this.configurationService.updateValue(CLAUDE_AUTO_SWITCH_THRESHOLD_SETTING, Number(value)).then(() => this.loadAccounts(false)));
		}
		const last = state.lastSwitch;
		if (last) {
			const how = last.reason === 'auto' ? localize('voltSettings.claudeSwitchAuto', "automatically") : localize('voltSettings.claudeSwitchManual', "by you");
			const text = [localize('voltSettings.claudeLastSwitchTo', "To {0} {1}, {2}", last.toEmail, how, fromNow(last.at, true, true)), last.detail].filter(Boolean).join(' · ');
			this.host.valueRow(group, localize('voltSettings.claudeLastSwitch', "Last switch"), text);
		}
	}

	private async switchClaudeAccount(account: IVoltClaudeAccount): Promise<void> {
		if (this.accountBusy) {
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
		await this.host.refreshProvider();
		if (!this.disposed) {
			this.host.rerender();
		}
	}

	private async removeClaudeAccount(account: IVoltClaudeAccount): Promise<void> {
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
		if (this.accountLogin) {
			return;
		}
		this.accountError = undefined;
		let login;
		let onClosed;
		try {
			login = await this.accounts.beginClaudeLogin(email);
			onClosed = await this.host.runInTerminal(login.command);
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
			void this.accounts.cancelClaudeLogin(login.id);
		}
		this.host.rerender();
	}
}
