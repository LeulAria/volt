/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { Sequencer } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltUsageLimitGroup } from '../../voltUsage/common/voltUsage.js';
import { claudeCredentialsOf, claudePlan, fetchClaudeLimitsFor } from '../../voltUsage/node/usageAccounts.js';
import { CLAUDE_AUTO_SWITCH_DEFAULT_THRESHOLD, IVoltAccountSwitchEvent, IVoltClaudeAccount, IVoltClaudeAccountsState, IVoltClaudeLogin, VoltAccountSwitching, VoltClaudeLoginResult } from '../common/voltAccounts.js';
import { accountCredentials, asObject, asString, claudeLiveLocation, fetchOauthAccount, IAccountSecrets, IClaudeLiveLocation, JsonObject, keychainDelete, readJsonFile, readLiveLogin, refreshAccountCredentials, spliceCredentials, withClaudeLocks, writeFileAtomic, writeLiveCredentials, writeLiveOauthAccount } from './claudeLogin.js';

/** The active account's limits are read at most this often; Claude Code and the Usage page ask too. */
const ACTIVE_LIMITS_MS = 2 * 60_000;
/** Accounts not in use change only when used elsewhere, so they are read less often. */
const IDLE_LIMITS_MS = 10 * 60_000;
/** After a 429 from the usage endpoint, an account is left alone this long. */
const LIMITS_BACKOFF_MS = 5 * 60_000;
/** A stored access token this close to expiry is refreshed before use. */
const EXPIRY_MARGIN_MS = 5 * 60_000;
/** Automatic switching waits this long after any switch, so two accounts near the line never ping-pong. */
export const AUTO_SWITCH_COOLDOWN_MS = 5 * 60_000;
/** A switch target must be this many points under the threshold. */
export const AUTO_SWITCH_MARGIN = 5;
/** Terminal sign-ins left unfinished are cleaned up after this long. */
const LOGIN_TTL_MS = 30 * 60_000;

interface IStoredAccount {
	readonly id: string;
	oauthAccount: JsonObject;
	plan?: string;
	readonly addedAt: number;
	activatedAt?: number;
	needsSignIn?: boolean;
	limits?: IVoltUsageLimitGroup;
	limitsBackoffUntil?: number;
}

interface IStoreFile {
	readonly version: 1;
	accounts: IStoredAccount[];
	lastSwitch?: IVoltAccountSwitchEvent;
}

interface IPendingLogin {
	readonly id: string;
	readonly dir: string;
	readonly startedAt: number;
}

export interface IClaudeAccountsOptions {
	readonly home: string;
	/** `~/.volt/accounts/claude`. */
	readonly storeDir: string;
	readonly secrets: IAccountSecrets;
	readonly env: () => Promise<NodeJS.ProcessEnv>;
	readonly logService: ILogService;
	readonly platform?: NodeJS.Platform;
	/** Overrides the live location (tests). */
	readonly location?: (env: NodeJS.ProcessEnv) => IClaudeLiveLocation;
	readonly readLimits?: (oauth: JsonObject) => Promise<{ group?: IVoltUsageLimitGroup; retryAfterMs?: number }>;
	readonly refresh?: typeof refreshAccountCredentials;
}

/** Who an `oauthAccount` is: the same person in two organizations is two accounts. */
export function accountKey(oauthAccount: JsonObject | undefined): string | undefined {
	const user = asString(oauthAccount?.accountUuid) ?? asString(oauthAccount?.emailAddress)?.toLowerCase();
	return user ? `${user}/${asString(oauthAccount?.organizationUuid) ?? ''}` : undefined;
}

function planOf(credentials: JsonObject | undefined, oauthAccount: JsonObject | undefined): string | undefined {
	const parsed = claudeCredentialsOf(asObject(credentials?.claudeAiOauth));
	const tier = parsed ? claudePlan(parsed) : undefined;
	if (tier) {
		return tier;
	}
	const fallback = asString(oauthAccount?.userRateLimitTier) ?? asString(oauthAccount?.organizationRateLimitTier);
	return fallback ? claudePlan({ accessToken: '', rateLimitTier: fallback }) : undefined;
}

/** The fullest window that counts for switching: the session and the all-models week. A window that already reset is 0. */
export function limitPressure(group: IVoltUsageLimitGroup | undefined, now = Date.now()): number | undefined {
	if (!group || group.error || !group.windows.length) {
		return undefined;
	}
	let worst = 0;
	for (const window of group.windows) {
		// Per-model weeks (Fable, Opus) only close that model; the session and the all-models week close Claude.
		if (window.label !== 'Current session' && window.scope !== 'All models') {
			continue;
		}
		const used = window.resetsAt !== undefined && window.resetsAt <= now ? 0 : window.usedPercent;
		worst = Math.max(worst, used);
	}
	return worst;
}

function describePressure(group: IVoltUsageLimitGroup | undefined): string | undefined {
	const window = group?.windows
		.filter(candidate => candidate.label === 'Current session' || candidate.scope === 'All models')
		.sort((a, b) => b.usedPercent - a.usedPercent)[0];
	if (!window) {
		return undefined;
	}
	const name = window.label === 'Current session' ? 'Session limit' : 'Weekly limit';
	return `${name} at ${Math.round(window.usedPercent)}%`;
}

export interface IAutoSwitchCandidate {
	readonly id: string;
	readonly pressure: number | undefined;
	readonly usable: boolean;
}

/**
 * Whether to leave the active account, and for which. Moves only when the active account is at
 * or over the threshold, and only to a usable account at least {@link AUTO_SWITCH_MARGIN} points
 * under it; picks the one with the most left. When every account is near its limit, stays.
 */
export function pickAutoSwitchTarget(active: IAutoSwitchCandidate, others: readonly IAutoSwitchCandidate[], threshold: number): string | undefined {
	if (active.pressure === undefined || active.pressure < threshold) {
		return undefined;
	}
	let best: IAutoSwitchCandidate | undefined;
	for (const candidate of others) {
		if (!candidate.usable || candidate.pressure === undefined || candidate.pressure > threshold - AUTO_SWITCH_MARGIN) {
			continue;
		}
		if (!best || candidate.pressure < best.pressure!) {
			best = candidate;
		}
	}
	return best?.id;
}

/**
 * Several Claude logins, one of which is Claude Code's at a time. Each saved account keeps its
 * account-scoped credential (Volt's keychain item, or a 0600 file); switching writes it into
 * Claude Code's own store under Claude Code's locks, after saving the outgoing account's latest
 * tokens (they rotate on refresh). Adding an account signs in once, in a terminal, in a config
 * folder of its own, so the live login is not touched until the user switches.
 */
export class ClaudeAccounts extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidAutoSwitch = this._register(new Emitter<IVoltAccountSwitchEvent>());
	readonly onDidAutoSwitch = this._onDidAutoSwitch.event;

	private readonly sequencer = new Sequencer();
	private store: IStoreFile | undefined;
	private readonly logins = new Map<string, IPendingLogin>();
	private switching: VoltAccountSwitching = 'manual';
	private threshold = CLAUDE_AUTO_SWITCH_DEFAULT_THRESHOLD;
	private lastError: string | undefined;

	constructor(private readonly options: IClaudeAccountsOptions) {
		super();
	}

	private get storePath(): string {
		return join(this.options.storeDir, 'accounts.json');
	}

	configure(switching: VoltAccountSwitching, threshold: number): void {
		this.switching = switching;
		this.threshold = Math.min(99, Math.max(50, Math.round(threshold) || CLAUDE_AUTO_SWITCH_DEFAULT_THRESHOLD));
	}

	get autoSwitching(): boolean {
		return this.switching === 'auto';
	}

	private async location(): Promise<IClaudeLiveLocation> {
		const env = await this.options.env();
		return this.options.location?.(env) ?? claudeLiveLocation(this.options.home, env, this.options.platform);
	}

	private async load(): Promise<IStoreFile> {
		if (!this.store) {
			const file = await readJsonFile(this.storePath);
			const accounts = Array.isArray(file?.accounts) ? (file.accounts as unknown[]).map(asObject).filter((value): value is JsonObject => !!value && typeof value.id === 'string' && !!asObject(value.oauthAccount)) : [];
			this.store = { version: 1, accounts: accounts as unknown as IStoredAccount[], lastSwitch: asObject(file?.lastSwitch) as IVoltAccountSwitchEvent | undefined };
		}
		return this.store;
	}

	private async save(): Promise<void> {
		if (this.store) {
			await fs.mkdir(this.options.storeDir, { recursive: true, mode: 0o700 });
			await writeFileAtomic(this.storePath, JSON.stringify(this.store, undefined, 2), 0o600);
		}
	}

	private async secret(id: string): Promise<JsonObject | undefined> {
		const raw = await this.options.secrets.get(id);
		try {
			return raw ? asObject(JSON.parse(raw)) : undefined;
		} catch {
			return undefined;
		}
	}

	private async setSecret(id: string, credentials: JsonObject): Promise<void> {
		await this.options.secrets.set(id, JSON.stringify(credentials));
	}

	//#region State

	getState(refreshLimits = false): Promise<IVoltClaudeAccountsState> {
		return this.sequencer.queue(async () => {
			const live = await this.syncLive();
			if (refreshLimits) {
				await this.readStaleLimits(live?.id);
			}
			return this.snapshot(live?.id, live === undefined && !this.lastError);
		});
	}

	private async snapshot(activeId: string | undefined, signedOut = false): Promise<IVoltClaudeAccountsState> {
		const store = await this.load();
		const accounts: IVoltClaudeAccount[] = store.accounts.map(account => ({
			id: account.id,
			email: asString(account.oauthAccount.emailAddress) ?? 'Claude account',
			displayName: asString(account.oauthAccount.displayName) ?? asString(account.oauthAccount.fullName),
			organizationName: asString(account.oauthAccount.organizationName),
			plan: account.plan,
			active: account.id === activeId,
			addedAt: account.addedAt,
			activatedAt: account.activatedAt,
			needsSignIn: account.needsSignIn || undefined,
			limits: account.limits,
		}));
		return { accounts, switching: this.switching, threshold: this.threshold, lastSwitch: store.lastSwitch, signedOut: signedOut || undefined, error: this.lastError };
	}

	/**
	 * Reads the live login, saves it if it is new, and copies its latest tokens over the stored ones
	 * (Claude Code rotates them on refresh, which makes the stored copy useless). Returns the saved
	 * account that is live, or undefined when Claude Code is signed out or could not be read.
	 */
	private async syncLive(): Promise<IStoredAccount | undefined> {
		const store = await this.load();
		let live;
		try {
			live = await readLiveLogin(await this.location());
			this.lastError = undefined;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			return undefined;
		}
		const credentials = accountCredentials(live.credentials);
		const key = accountKey(live.oauthAccount);
		if (!credentials || !key || !live.oauthAccount) {
			return undefined;
		}
		let account = store.accounts.find(candidate => accountKey(candidate.oauthAccount) === key);
		if (!account) {
			account = { id: generateUuid(), oauthAccount: live.oauthAccount, plan: planOf(credentials, live.oauthAccount), addedAt: Date.now(), activatedAt: Date.now() };
			store.accounts.push(account);
			this.options.logService.info(`[volt-accounts] saved the Claude login ${asString(live.oauthAccount.emailAddress)}`);
		} else {
			account.oauthAccount = live.oauthAccount;
			account.plan = planOf(credentials, live.oauthAccount) ?? account.plan;
			account.needsSignIn = undefined;
		}
		const stored = await this.secret(account.id);
		if (JSON.stringify(stored) !== JSON.stringify(credentials)) {
			await this.setSecret(account.id, credentials);
		}
		await this.save();
		return account;
	}

	//#endregion

	//#region Limits

	private async readLimits(oauth: JsonObject): Promise<{ group?: IVoltUsageLimitGroup; retryAfterMs?: number }> {
		if (this.options.readLimits) {
			return this.options.readLimits(oauth);
		}
		const credentials = claudeCredentialsOf(oauth);
		return credentials ? fetchClaudeLimitsFor(credentials) : {};
	}

	/** Reads limits that are older than their interval; refreshes idle accounts' tokens to do so. */
	private async readStaleLimits(activeId: string | undefined, force = false): Promise<void> {
		const store = await this.load();
		const now = Date.now();
		let changed = false;
		await Promise.all(store.accounts.map(async account => {
			const interval = account.id === activeId ? ACTIVE_LIMITS_MS : IDLE_LIMITS_MS;
			if (account.needsSignIn || (account.limitsBackoffUntil ?? 0) > now || (!force && account.limits && now - account.limits.checkedAt < interval)) {
				return;
			}
			const credentials = account.id === activeId ? await this.secret(account.id) : await this.usableCredentials(account);
			const oauth = asObject(credentials?.claudeAiOauth);
			changed = true;
			if (!oauth) {
				return;
			}
			const result = await this.readLimits(oauth);
			if (result.retryAfterMs !== undefined) {
				account.limitsBackoffUntil = now + Math.max(result.retryAfterMs, LIMITS_BACKOFF_MS);
			} else if (result.group && (!result.group.error || !account.limits)) {
				account.limits = result.group;
			}
		}));
		if (changed) {
			await this.save();
			this._onDidChange.fire();
		}
	}

	/**
	 * A stored credential with a live access token. Only for accounts Claude Code is not using:
	 * the live one is refreshed by Claude Code, and refreshing it here too would burn its token.
	 */
	private async usableCredentials(account: IStoredAccount): Promise<JsonObject | undefined> {
		const credentials = await this.secret(account.id);
		const oauth = asObject(credentials?.claudeAiOauth);
		if (!credentials || !oauth) {
			account.needsSignIn = true;
			return undefined;
		}
		const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0;
		if (expiresAt - Date.now() > EXPIRY_MARGIN_MS) {
			return credentials;
		}
		const result = await (this.options.refresh ?? refreshAccountCredentials)(credentials);
		if (!result.ok) {
			if (result.dead) {
				account.needsSignIn = true;
				this.options.logService.warn(`[volt-accounts] the saved sign-in for ${asString(account.oauthAccount.emailAddress)} was rejected`);
			}
			return undefined;
		}
		// The old refresh token is spent now; the new one must be kept before anything else.
		await this.setSecret(account.id, result.credentials);
		account.plan = planOf(result.credentials, account.oauthAccount) ?? account.plan;
		return result.credentials;
	}

	//#endregion

	//#region Switching

	switchTo(id: string, reason: 'manual' | 'auto' = 'manual', detail?: string): Promise<IVoltClaudeAccountsState> {
		return this.sequencer.queue(async () => {
			const event = await this.doSwitch(id, reason, detail);
			const state = await this.snapshot(id);
			if (event && reason === 'auto') {
				this._onDidAutoSwitch.fire(event);
			}
			this._onDidChange.fire();
			return state;
		});
	}

	private async doSwitch(id: string, reason: 'manual' | 'auto', detail?: string): Promise<IVoltAccountSwitchEvent | undefined> {
		const store = await this.load();
		const target = store.accounts.find(account => account.id === id);
		if (!target) {
			throw new Error('That account is no longer saved.');
		}
		const outgoing = await this.syncLive();
		if (outgoing?.id === target.id) {
			return undefined;
		}
		if (this.lastError) {
			throw new Error(this.lastError);
		}
		// Network first: nothing talks to the network while Claude Code's locks are held.
		const credentials = await this.usableCredentials(target);
		await this.save();
		if (!credentials) {
			throw new Error(target.needsSignIn
				? `The saved sign-in for ${asString(target.oauthAccount.emailAddress)} has expired. Sign in to it again.`
				: 'Claude could not be reached to renew that account\u2019s sign-in. Try again in a moment.');
		}
		const location = await this.location();
		await withClaudeLocks(location, async () => {
			// Read again under the lock: a refresh may have finished since the sync above.
			const live = await readLiveLogin(location);
			const liveAccount = accountCredentials(live.credentials);
			const liveKey = accountKey(live.oauthAccount);
			const owner = liveKey ? store.accounts.find(account => accountKey(account.oauthAccount) === liveKey) : undefined;
			if (liveAccount && owner) {
				await this.setSecret(owner.id, liveAccount);
			}
			await writeLiveCredentials(location, live.source, spliceCredentials(live.credentials, credentials));
			await writeLiveOauthAccount(location, target.oauthAccount);
		});
		const now = Date.now();
		target.activatedAt = now;
		target.limitsBackoffUntil = undefined;
		const event: IVoltAccountSwitchEvent = {
			fromEmail: asString(outgoing?.oauthAccount.emailAddress),
			toEmail: asString(target.oauthAccount.emailAddress) ?? 'Claude account',
			reason,
			...(detail ? { detail } : {}),
			at: now,
		};
		store.lastSwitch = event;
		await this.save();
		this.options.logService.info(`[volt-accounts] switched Claude to ${event.toEmail} (${reason}${detail ? `: ${detail}` : ''})`);
		return event;
	}

	/** One automatic-switching pass: read limits, and move when the active account is near its limit. */
	autoSwitchTick(): Promise<void> {
		if (!this.autoSwitching) {
			return Promise.resolve();
		}
		return this.sequencer.queue(async () => {
			const store = await this.load();
			if (store.accounts.length < 2) {
				return;
			}
			const active = await this.syncLive();
			if (!active) {
				return;
			}
			await this.readStaleLimits(active.id);
			if (store.lastSwitch && Date.now() - store.lastSwitch.at < AUTO_SWITCH_COOLDOWN_MS) {
				return;
			}
			const candidate = (account: IStoredAccount): IAutoSwitchCandidate => ({ id: account.id, pressure: limitPressure(account.limits), usable: !account.needsSignIn });
			const pick = pickAutoSwitchTarget(candidate(active), store.accounts.filter(account => account.id !== active.id).map(candidate), this.threshold);
			if (!pick) {
				return;
			}
			const detail = describePressure(active.limits);
			try {
				const event = await this.doSwitch(pick, 'auto', detail);
				if (event) {
					this._onDidAutoSwitch.fire(event);
				}
			} catch (error) {
				this.options.logService.warn('[volt-accounts] automatic switch failed', error);
			}
			this._onDidChange.fire();
		});
	}

	remove(id: string): Promise<IVoltClaudeAccountsState> {
		return this.sequencer.queue(async () => {
			const store = await this.load();
			const active = await this.syncLive();
			if (active?.id === id) {
				// It would be saved again on sight; sign out of Claude Code or switch away first.
				throw new Error('Claude Code is signed in to this account. Switch to another account first.');
			}
			store.accounts = store.accounts.filter(account => account.id !== id);
			await this.options.secrets.delete(id);
			await this.save();
			this._onDidChange.fire();
			return this.snapshot(active?.id);
		});
	}

	//#endregion

	//#region Adding an account

	async beginLogin(email?: string): Promise<IVoltClaudeLogin> {
		await this.sweepLogins();
		const id = generateUuid().slice(0, 8);
		const dir = join(this.options.storeDir, 'logins', id);
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		// Skips Claude Code's first-run questions in the throwaway folder.
		await writeFileAtomic(join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }), 0o600);
		this.logins.set(id, { id, dir, startedAt: Date.now() });
		const platform = this.options.platform ?? process.platform;
		const login = `claude auth login --claudeai${email ? ` --email ${shellQuote(email, platform)}` : ''}`;
		const command = platform === 'win32'
			? `$env:CLAUDE_CONFIG_DIR=${shellQuote(dir, platform)}; ${login}`
			: `CLAUDE_CONFIG_DIR=${shellQuote(dir, platform)} ${login}`;
		return { id, command };
	}

	completeLogin(id: string): Promise<VoltClaudeLoginResult> {
		return this.sequencer.queue(async () => {
			const pending = this.logins.get(id);
			if (!pending) {
				return { status: 'failed', error: 'That sign-in is no longer running. Start it again.' };
			}
			const env = await this.options.env();
			const location = this.options.location?.({ ...env, CLAUDE_CONFIG_DIR: pending.dir }) ?? claudeLiveLocation(this.options.home, env, this.options.platform, pending.dir);
			let staged;
			try {
				staged = await readLiveLogin(location);
			} catch {
				return { status: 'pending' };
			}
			const credentials = accountCredentials(staged.credentials);
			const accessToken = asString(asObject(credentials?.claudeAiOauth)?.accessToken);
			if (!credentials || !accessToken) {
				return { status: 'pending' };
			}
			const oauthAccount = staged.oauthAccount && accountKey(staged.oauthAccount) ? staged.oauthAccount : await fetchOauthAccount(accessToken);
			const key = accountKey(oauthAccount);
			if (!oauthAccount || !key) {
				return { status: 'pending' };
			}
			// The login in use is saved first, so the list keeps the order accounts were met in.
			const live = await this.syncLive();
			const isLive = accountKey(live?.oauthAccount) === key;
			const store = await this.load();
			let account = store.accounts.find(candidate => accountKey(candidate.oauthAccount) === key);
			const updated = !!account;
			if (account) {
				account.oauthAccount = { ...account.oauthAccount, ...oauthAccount };
				account.needsSignIn = undefined;
				account.limits = undefined;
			} else {
				account = { id: generateUuid(), oauthAccount, addedAt: Date.now() };
				store.accounts.push(account);
			}
			account.plan = planOf(credentials, oauthAccount) ?? account.plan;
			// A fresh sign-in is a new token family. The live account keeps Claude Code's own family
			// (synced above); the staged one is dropped with its folder.
			if (!isLive) {
				await this.setSecret(account.id, credentials);
			}
			await this.save();
			await this.dropLogin(pending, location);
			this.options.logService.info(`[volt-accounts] added the Claude account ${asString(oauthAccount.emailAddress)}${isLive ? ' (already live)' : ''}`);
			this._onDidChange.fire();
			return { status: 'added', email: asString(oauthAccount.emailAddress) ?? 'Claude account', updated };
		});
	}

	cancelLogin(id: string): Promise<void> {
		return this.sequencer.queue(async () => {
			const pending = this.logins.get(id);
			if (pending) {
				const env = await this.options.env();
				await this.dropLogin(pending, this.options.location?.({ ...env, CLAUDE_CONFIG_DIR: pending.dir }) ?? claudeLiveLocation(this.options.home, env, this.options.platform, pending.dir));
			}
		});
	}

	private async dropLogin(pending: IPendingLogin, location: IClaudeLiveLocation): Promise<void> {
		this.logins.delete(pending.id);
		if (location.keychain) {
			await keychainDelete(location.keychain.service, location.keychain.account);
		}
		await fs.rm(pending.dir, { recursive: true, force: true }).catch(() => undefined);
	}

	/** Throwaway folders from sign-ins that never finished (or from an earlier run). */
	private async sweepLogins(): Promise<void> {
		const root = join(this.options.storeDir, 'logins');
		let names: string[] = [];
		try {
			names = await fs.readdir(root);
		} catch {
			return;
		}
		const env = await this.options.env();
		for (const name of names) {
			const pending = this.logins.get(name);
			if (pending && Date.now() - pending.startedAt < LOGIN_TTL_MS) {
				continue;
			}
			const dir = join(root, name);
			const stat = await fs.stat(dir).catch(() => undefined);
			if (!pending && stat && Date.now() - stat.mtimeMs < LOGIN_TTL_MS) {
				continue;
			}
			await this.dropLogin(pending ?? { id: name, dir, startedAt: 0 }, this.options.location?.({ ...env, CLAUDE_CONFIG_DIR: dir }) ?? claudeLiveLocation(this.options.home, env, this.options.platform, dir));
		}
	}

	//#endregion
}

function shellQuote(value: string, platform: NodeJS.Platform): string {
	return platform === 'win32' ? `'${value.replace(/'/g, `''`)}'` : `'${value.replace(/'/g, `'\\''`)}'`;
}
