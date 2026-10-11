/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { localize } from '../../../nls.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { Registry } from '../../registry/common/platform.js';
import { IVoltUsageLimitGroup } from '../../voltUsage/common/voltUsage.js';

export const IVoltAccountsService = createDecorator<IVoltAccountsService>('voltAccountsService');
export const VOLT_ACCOUNTS_CHANNEL_NAME = 'voltAccounts';

/** `manual`: the user picks the account. `auto`: Volt moves to the account with the most left near a limit. */
export const CLAUDE_ACCOUNT_SWITCHING_SETTING = 'volt.claude.accountSwitching';
/** Percent of the session or weekly limit at which automatic switching moves on. */
export const CLAUDE_AUTO_SWITCH_THRESHOLD_SETTING = 'volt.claude.autoSwitchThreshold';

export type VoltAccountSwitching = 'manual' | 'auto';
export const CLAUDE_AUTO_SWITCH_DEFAULT_THRESHOLD = 90;

// Registered here, not in the workbench, so the main process (which runs the switching) has the defaults.
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.claude.accounts',
	title: localize('voltAccounts.configTitle', "Claude Accounts"),
	type: 'object',
	properties: {
		[CLAUDE_ACCOUNT_SWITCHING_SETTING]: {
			type: 'string',
			enum: ['manual', 'auto'],
			enumDescriptions: [
				localize('voltAccounts.switching.manual', "Claude stays on the account you pick in Settings > Providers & Models > Claude."),
				localize('voltAccounts.switching.auto', "When the active account nears its session or weekly limit, Volt moves Claude to the saved account with the most left."),
			],
			default: 'manual',
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltAccounts.switching', "How Volt picks which saved Claude account Claude Code is signed in to."),
		},
		[CLAUDE_AUTO_SWITCH_THRESHOLD_SETTING]: {
			type: 'number',
			default: CLAUDE_AUTO_SWITCH_DEFAULT_THRESHOLD,
			minimum: 50,
			maximum: 99,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltAccounts.threshold', "With automatic switching on, the percent of the session or weekly limit at which Volt moves to another account."),
		},
	},
});

/** A Claude login Volt keeps, so switching to it needs no browser sign-in. */
export interface IVoltClaudeAccount {
	readonly id: string;
	readonly email: string;
	readonly displayName?: string;
	readonly organizationName?: string;
	/** "Max 20x", "Pro", from the stored sign-in. */
	readonly plan?: string;
	/** Claude Code is signed in to this account right now. */
	readonly active: boolean;
	readonly addedAt: number;
	/** Last time it became the active account. */
	readonly activatedAt?: number;
	/** The stored sign-in was rejected; sign in to this account again. */
	readonly needsSignIn?: boolean;
	/** Its session and weekly limits, as last read (also for accounts not in use). */
	readonly limits?: IVoltUsageLimitGroup;
}

export interface IVoltAccountSwitchEvent {
	readonly fromEmail?: string;
	readonly toEmail: string;
	readonly reason: 'manual' | 'auto';
	/** Why an automatic switch happened, in words: "Session limit at 92%". */
	readonly detail?: string;
	readonly at: number;
}

export interface IVoltClaudeAccountsState {
	readonly accounts: readonly IVoltClaudeAccount[];
	readonly switching: VoltAccountSwitching;
	readonly threshold: number;
	readonly lastSwitch?: IVoltAccountSwitchEvent;
	/** Claude Code has no sign-in on this machine. */
	readonly signedOut?: boolean;
	/** The sign-in could not be read (a locked keychain); nothing was changed. */
	readonly error?: string;
}

/** A sign-in started in a terminal, in a config folder of its own, so the current login is untouched. */
export interface IVoltClaudeLogin {
	readonly id: string;
	/** What to run in a terminal. */
	readonly command: string;
}

export type VoltClaudeLoginResult =
	| { readonly status: 'pending' }
	| { readonly status: 'added'; readonly email: string; readonly updated: boolean }
	| { readonly status: 'failed'; readonly error: string };

export interface IVoltAccountsService {
	readonly _serviceBrand: undefined;
	/** Accounts were added, removed, switched, or their limits were read again. */
	readonly onDidChangeClaudeAccounts: Event<void>;
	/** Volt switched accounts on its own, near a limit. */
	readonly onDidAutoSwitchClaudeAccount: Event<IVoltAccountSwitchEvent>;

	/**
	 * The saved accounts. The live login is saved on sight (so it can always be switched back
	 * to) and its stored copy is kept current. `refreshLimits` reads limits that are stale.
	 */
	getClaudeAccounts(refreshLimits?: boolean): Promise<IVoltClaudeAccountsState>;
	beginClaudeLogin(email?: string): Promise<IVoltClaudeLogin>;
	/** Polled while the terminal sign-in runs; saves the account once it finished. */
	completeClaudeLogin(id: string): Promise<VoltClaudeLoginResult>;
	cancelClaudeLogin(id: string): Promise<void>;
	/** Makes the account Claude Code's login. Running chats pick it up within about 30 seconds. */
	switchClaudeAccount(id: string): Promise<IVoltClaudeAccountsState>;
	/** Forgets a saved account. The active one stays signed in to Claude Code. */
	removeClaudeAccount(id: string): Promise<IVoltClaudeAccountsState>;
}
