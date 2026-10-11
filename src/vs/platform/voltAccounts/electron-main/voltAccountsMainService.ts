/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'os';
import { Disposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ILogService } from '../../log/common/log.js';
import { getResolvedShellEnv } from '../../shell/node/shellEnv.js';
import { CLAUDE_ACCOUNT_SWITCHING_SETTING, CLAUDE_AUTO_SWITCH_DEFAULT_THRESHOLD, CLAUDE_AUTO_SWITCH_THRESHOLD_SETTING, IVoltAccountsService, IVoltClaudeAccountsState, IVoltClaudeLogin, VoltClaudeLoginResult } from '../common/voltAccounts.js';
import { ClaudeAccounts } from '../node/claudeAccounts.js';
import { FileAccountSecrets, KeychainAccountSecrets } from '../node/claudeLogin.js';

/** How often automatic switching looks at the active account's limits. */
const AUTO_SWITCH_INTERVAL_MS = 2 * 60_000;
const FIRST_TICK_DELAY_MS = 30_000;

/**
 * Saved Claude accounts live in the main process: switching writes Claude Code's keychain item and
 * `~/.claude.json`, and automatic switching runs while any window (or none) is open. The store is
 * `~/.volt/accounts/claude`, shared by every Volt build on the machine.
 */
export class VoltAccountsMainService extends Disposable implements IVoltAccountsService {

	declare readonly _serviceBrand: undefined;

	private readonly claude: ClaudeAccounts;
	readonly onDidChangeClaudeAccounts;
	readonly onDidAutoSwitchClaudeAccount;
	private timer: ReturnType<typeof setInterval> | undefined;
	private firstTick: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		super();
		const home = homedir();
		const storeDir = join(home, '.volt', 'accounts', 'claude');
		let env: Promise<NodeJS.ProcessEnv> | undefined;
		this.claude = this._register(new ClaudeAccounts({
			home,
			storeDir,
			secrets: process.platform === 'darwin' ? new KeychainAccountSecrets('Volt Claude Accounts') : new FileAccountSecrets(join(storeDir, 'credentials')),
			// Volt's agents run with the login shell's env, so a CLAUDE_CONFIG_DIR set there is the one to follow.
			env: () => env ??= getResolvedShellEnv(configurationService, logService, { _: [] }, process.env)
				.then(resolved => ({ ...process.env, ...resolved }))
				.catch(() => process.env),
			logService,
		}));
		this.onDidChangeClaudeAccounts = this.claude.onDidChange;
		this.onDidAutoSwitchClaudeAccount = this.claude.onDidAutoSwitch;
		this.applyConfiguration();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CLAUDE_ACCOUNT_SWITCHING_SETTING) || e.affectsConfiguration(CLAUDE_AUTO_SWITCH_THRESHOLD_SETTING)) {
				this.applyConfiguration();
			}
		}));
		this._register({ dispose: () => this.stopTimer() });
	}

	private applyConfiguration(): void {
		const switching = this.configurationService.getValue<string>(CLAUDE_ACCOUNT_SWITCHING_SETTING) === 'auto' ? 'auto' : 'manual';
		const threshold = this.configurationService.getValue<number>(CLAUDE_AUTO_SWITCH_THRESHOLD_SETTING) ?? CLAUDE_AUTO_SWITCH_DEFAULT_THRESHOLD;
		this.claude.configure(switching, threshold);
		if (switching === 'auto') {
			this.startTimer();
		} else {
			this.stopTimer();
		}
	}

	private startTimer(): void {
		if (this.timer) {
			return;
		}
		const tick = () => void this.claude.autoSwitchTick().catch(() => undefined);
		this.firstTick = setTimeout(tick, FIRST_TICK_DELAY_MS);
		this.timer = setInterval(tick, AUTO_SWITCH_INTERVAL_MS);
		// Which timer typing wins depends on the program's file order; Node's timers have unref.
		(this.firstTick as unknown as { unref?(): void }).unref?.();
		(this.timer as unknown as { unref?(): void }).unref?.();
	}

	private stopTimer(): void {
		clearTimeout(this.firstTick);
		clearInterval(this.timer);
		this.firstTick = this.timer = undefined;
	}

	getClaudeAccounts(refreshLimits?: boolean): Promise<IVoltClaudeAccountsState> {
		return this.claude.getState(refreshLimits);
	}

	beginClaudeLogin(email?: string): Promise<IVoltClaudeLogin> {
		return this.claude.beginLogin(email);
	}

	completeClaudeLogin(id: string): Promise<VoltClaudeLoginResult> {
		return this.claude.completeLogin(id);
	}

	cancelClaudeLogin(id: string): Promise<void> {
		return this.claude.cancelLogin(id);
	}

	switchClaudeAccount(id: string): Promise<IVoltClaudeAccountsState> {
		return this.claude.switchTo(id);
	}

	removeClaudeAccount(id: string): Promise<IVoltClaudeAccountsState> {
		return this.claude.remove(id);
	}
}
