/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { dirname, join } from '../../../base/common/path.js';
import { IVoltUsageAccount, IVoltUsageLimitGroup, IVoltUsageLimitWindow, VoltResetCreditOutcome } from '../common/voltUsage.js';
import { ICodexRateLimitSample, IUsageRecord } from './usageTranscripts.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): number | undefined {
	const n = typeof value === 'string' && value.trim() ? Number(value) : value;
	return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function isoMs(value: unknown): number | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/** Reads a generic password the way the CLIs store them. `security` is on each item's access list, so no prompt. */
function readKeychain(service: string, account?: string): Promise<string | undefined> {
	if (process.platform !== 'darwin') {
		return Promise.resolve(undefined);
	}
	const args = ['find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w'];
	return new Promise(resolve => {
		execFile('/usr/bin/security', args, { timeout: 10_000 }, (error, stdout) => {
			const value = stdout?.trim();
			resolve(error || !value ? undefined : value);
		});
	});
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		return record(JSON.parse(await fs.readFile(path, 'utf8')));
	} catch {
		return undefined;
	}
}

//#region Claude

/** One Claude Code login: the default `~/.claude`, or a `CLAUDE_CONFIG_DIR`. */
export interface IClaudeHome {
	readonly configDir: string;
	/** Claude Code's own default directory; its keychain item and account file have no suffix. */
	readonly isDefault: boolean;
}

/** The default login plus every extra config directory, each once. */
export function claudeHomes(home: string, extraDirs: readonly string[]): IClaudeHome[] {
	const defaultDir = join(home, '.claude');
	const homes: IClaudeHome[] = [{ configDir: defaultDir, isDefault: true }];
	const seen = new Set([defaultDir]);
	for (const raw of extraDirs) {
		const dir = expandHome(raw.trim(), home);
		if (dir && !seen.has(dir)) {
			seen.add(dir);
			homes.push({ configDir: dir, isDefault: false });
		}
	}
	return homes;
}

export function expandHome(path: string, home: string): string {
	return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

/** Claude Code names a non-default directory's keychain item after a hash of the directory. */
export function claudeKeychainService(claudeHome: IClaudeHome): string {
	return claudeHome.isDefault ? 'Claude Code-credentials' : `Claude Code-credentials-${sha256(claudeHome.configDir).slice(0, 8)}`;
}

/** The account record Claude Code keeps beside its settings, or in the home directory by default. */
function claudeAccountPath(home: string, claudeHome: IClaudeHome): string {
	return claudeHome.isDefault ? join(home, '.claude.json') : join(claudeHome.configDir, '.claude.json');
}

interface IClaudeCredentials {
	readonly accessToken: string;
	readonly expiresAt?: number;
	readonly subscriptionType?: string;
	readonly rateLimitTier?: string;
}

async function readClaudeCredentials(claudeHome: IClaudeHome): Promise<IClaudeCredentials | undefined> {
	const fromKeychain = await readKeychain(claudeKeychainService(claudeHome));
	let parsed: Record<string, unknown> | undefined;
	if (fromKeychain) {
		try {
			parsed = record(JSON.parse(fromKeychain));
		} catch {
			parsed = undefined;
		}
	}
	parsed ??= await readJson(join(claudeHome.configDir, '.credentials.json'));
	const oauth = record(parsed?.claudeAiOauth);
	const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken : undefined;
	if (!accessToken) {
		return undefined;
	}
	return {
		accessToken,
		expiresAt: finite(oauth?.expiresAt),
		subscriptionType: typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
		rateLimitTier: typeof oauth?.rateLimitTier === 'string' ? oauth.rateLimitTier : undefined,
	};
}

interface IClaudeAccountRecord {
	readonly account: IVoltUsageAccount;
	readonly organizationUuid?: string;
}

async function readClaudeAccount(home: string, claudeHome: IClaudeHome): Promise<IClaudeAccountRecord> {
	const oauth = record((await readJson(claudeAccountPath(home, claudeHome)))?.oauthAccount);
	const uuid = typeof oauth?.accountUuid === 'string' && oauth.accountUuid ? oauth.accountUuid : undefined;
	const email = typeof oauth?.emailAddress === 'string' && oauth.emailAddress ? oauth.emailAddress : undefined;
	const organizationUuid = typeof oauth?.organizationUuid === 'string' && oauth.organizationUuid.trim() ? oauth.organizationUuid.trim() : undefined;
	return {
		// Without an account id the login can't be matched across machines; it counts per directory.
		account: { id: uuid ? `claude:${uuid}` : `claude:dir:${sha256(claudeHome.configDir).slice(0, 16)}`, ...(email ? { label: email } : {}) },
		...(organizationUuid ? { organizationUuid } : {}),
	};
}

/** "default_claude_max_5x" → "Max 5x"; falls back to the subscription type. */
function claudePlan(credentials: IClaudeCredentials): string | undefined {
	const tier = credentials.rateLimitTier?.match(/(max|pro|team|enterprise)_?(\d+x)?$/i);
	if (tier) {
		return [tier[1][0].toUpperCase() + tier[1].slice(1).toLowerCase(), tier[2]].filter(Boolean).join(' ');
	}
	const type = credentials.subscriptionType;
	return type ? type[0].toUpperCase() + type.slice(1) : undefined;
}

/** Sent as Claude Code's user agent when its version can't be read. */
const CLAUDE_FALLBACK_VERSION = '2.1.289';
let claudeVersion: Promise<string> | undefined;

/**
 * The installed Claude Code's version. Its banked resets are offered only to Claude Code, so
 * these calls go out under its user agent.
 */
export function claudeCliVersion(env: NodeJS.ProcessEnv): Promise<string> {
	claudeVersion ??= new Promise(resolve => {
		execFile('claude', ['--version'], { env, timeout: 5_000 }, (error, stdout) => {
			const version = !error && typeof stdout === 'string' ? stdout.match(/\d+\.\d+\.\d+/)?.[0] : undefined;
			resolve(version ?? CLAUDE_FALLBACK_VERSION);
		});
	});
	return claudeVersion;
}

function claudeHeaders(token: string, version: string): Record<string, string> {
	return {
		'Authorization': `Bearer ${token}`,
		'anthropic-beta': 'oauth-2025-04-20',
		'Content-Type': 'application/json',
		'User-Agent': `claude-cli/${version} (external, cli)`,
	};
}

/** Claude's banked resets (its `cedar_ember` program): how many are left and the grant to spend next. */
export interface IClaudeResetCredits {
	readonly count: number;
	readonly nextGrantId?: string;
	readonly expiresAt?: number;
}

const CLAUDE_GRANT_ID = /^[a-z0-9_-]{1,64}$/i;

/** Grants that are paused, past `ends_at` or not usable now cannot be claimed and do not count. */
export function claudeResetCredits(block: unknown, now = Date.now()): IClaudeResetCredits | undefined {
	const data = record(block);
	if (!data || data.eligible !== true) {
		return undefined;
	}
	const live = (Array.isArray(data.grants) ? data.grants : []).map(record).filter((grant): grant is Record<string, unknown> => {
		if (!grant || typeof grant.id !== 'string' || !CLAUDE_GRANT_ID.test(grant.id) || grant.paused === true || grant.usable_now !== true) {
			return false;
		}
		const left = finite(grant.resets_left);
		const endsAt = isoMs(grant.ends_at);
		return left !== undefined && left > 0 && (grant.ends_at === null || grant.ends_at === undefined || (endsAt !== undefined && endsAt > now));
	});
	const next = live.find(grant => grant.id === data.next_grant_id) ?? live[0];
	if (!next) {
		return { count: 0 };
	}
	const expiresAt = isoMs(next.ends_at);
	return {
		count: live.reduce((sum, grant) => sum + Math.trunc(finite(grant.resets_left) ?? 0), 0),
		nextGrantId: String(next.id),
		...(expiresAt ? { expiresAt } : {}),
	};
}

interface IClaudeFetch {
	readonly group?: IVoltUsageLimitGroup;
	readonly credits?: IClaudeResetCredits;
	/** The endpoint said 429; wait this long before asking again. */
	readonly retryAfterMs?: number;
	/** A network or server failure worth papering over with the last good reading. */
	readonly transient?: boolean;
}

async function fetchClaudeLimits(home: string, claudeHome: IClaudeHome, env: NodeJS.ProcessEnv): Promise<IClaudeFetch> {
	const checkedAt = Date.now();
	const credentials = await readClaudeCredentials(claudeHome);
	if (!credentials) {
		return {};
	}
	const { account } = await readClaudeAccount(home, claudeHome);
	const plan = claudePlan(credentials);
	const failed = (error: string): IVoltUsageLimitGroup => ({ provider: 'claude', account, plan, windows: [], checkedAt, error });
	if (credentials.expiresAt && credentials.expiresAt < checkedAt) {
		return { group: failed('Claude Code’s sign-in has expired. Send any Claude message to renew it, then refresh.') };
	}
	try {
		// One call answers both the windows and the banked resets.
		const response = await fetch('https://api.anthropic.com/api/oauth/usage?cedar_ember=1', {
			headers: claudeHeaders(credentials.accessToken, await claudeCliVersion(env)),
			signal: AbortSignal.timeout(10_000),
		});
		if (response.status === 429) {
			const seconds = Number(response.headers.get('retry-after'));
			return { retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0, transient: true };
		}
		if (response.status === 401 || response.status === 403) {
			return { group: failed('Sign in to Claude Code again to read your limits.') };
		}
		if (!response.ok) {
			return { group: failed('Claude limits could not be read. Refresh to try again.'), transient: true };
		}
		const body = record(await response.json());
		const credits = claudeResetCredits(body?.cedar_ember);
		return {
			group: {
				provider: 'claude', account, plan, windows: claudeWindows(body), checkedAt,
				...(credits?.count ? { resetCredits: credits.count } : {}),
				...(credits?.count && credits.expiresAt ? { resetCreditsExpireAt: credits.expiresAt } : {}),
			},
			credits,
		};
	} catch {
		return { group: failed('Claude limits could not be read. Check your connection and refresh.'), transient: true };
	}
}

/** Claude's usage endpoint is asked at most this often, refresh button included. */
const CLAUDE_MIN_INTERVAL_MS = 60_000;
/** After a 429, wait at least this long. */
const CLAUDE_BACKOFF_MS = 3 * 60_000;

/**
 * Reads one Claude login's limits without tripping its rate limit. Claude Code, T3 Code and Volt
 * all poll the same endpoint with the same sign-in, and it answers 429 when they add up. The last
 * good reading is kept (on disk too, so a restart has numbers at once) and shown with its age
 * while the endpoint cools down, instead of an error.
 */
export class ClaudeLimitsReader {

	private last: IVoltUsageLimitGroup | undefined;
	private credits: IClaudeResetCredits | undefined;
	private backoffUntil = 0;
	private loaded = false;

	constructor(private readonly home: string, readonly claudeHome: IClaudeHome, private readonly cachePath: string) { }

	/** The grant a redemption spends: from the last reading, so it is the one the user saw. */
	get nextGrantId(): string | undefined {
		return this.credits?.nextGrantId;
	}

	/** Forgets the reading, so the next read asks the endpoint (after a redemption). */
	invalidate(): void {
		if (this.last) {
			this.last = { ...this.last, checkedAt: 0 };
		}
	}

	async read(env: NodeJS.ProcessEnv): Promise<IVoltUsageLimitGroup | undefined> {
		await this.load();
		const now = Date.now();
		if (this.last && (now < this.backoffUntil || now - this.last.checkedAt < CLAUDE_MIN_INTERVAL_MS)) {
			return this.last;
		}
		if (now < this.backoffUntil) {
			return this.coolingDown(now);
		}
		const result = await fetchClaudeLimits(this.home, this.claudeHome, env);
		if (result.retryAfterMs !== undefined) {
			this.backoffUntil = now + Math.max(result.retryAfterMs, CLAUDE_BACKOFF_MS);
			return this.last ?? this.coolingDown(now);
		}
		if (result.group && !result.group.error) {
			this.last = result.group;
			this.credits = result.credits;
			void this.save(result.group);
			return result.group;
		}
		return result.transient && this.last ? this.last : result.group;
	}

	private coolingDown(now: number): IVoltUsageLimitGroup {
		return { provider: 'claude', windows: [], checkedAt: now, error: 'Claude is limiting how often usage can be checked. Volt will try again in a few minutes.' };
	}

	private async load(): Promise<void> {
		if (this.loaded) {
			return;
		}
		this.loaded = true;
		const cached = await readJson(this.cachePath);
		if (cached?.provider === 'claude' && Array.isArray(cached.windows) && typeof cached.checkedAt === 'number') {
			// The grant id isn't cached, so a warm start shows the count but redeems after the next read.
			this.last = cached as unknown as IVoltUsageLimitGroup;
		}
	}

	private async save(group: IVoltUsageLimitGroup): Promise<void> {
		try {
			await fs.mkdir(dirname(this.cachePath), { recursive: true });
			await fs.writeFile(this.cachePath, JSON.stringify(group));
		} catch {
			// Only a warm start is lost.
		}
	}
}

/** Where a Claude login's last reading is kept between runs. */
export function claudeCachePath(cacheDir: string, claudeHome: IClaudeHome): string {
	return join(cacheDir, claudeHome.isDefault ? 'claude-limits.json' : `claude-limits-${sha256(claudeHome.configDir).slice(0, 8)}.json`);
}

/** Prefers the `limits` list (session, weekly, per-model weekly); older payloads only had the named windows. */
export function claudeWindows(body: unknown): IVoltUsageLimitWindow[] {
	const data = record(body);
	const windows: IVoltUsageLimitWindow[] = [];
	const limits = Array.isArray(data?.limits) ? data.limits : [];
	for (const raw of limits) {
		const limit = record(raw);
		const percent = finite(limit?.percent);
		if (!limit || percent === undefined) {
			continue;
		}
		const kind = String(limit.kind ?? '');
		const resetsAt = isoMs(limit.resets_at);
		const scopeName = record(record(limit.scope)?.model)?.display_name;
		const session = limit.group === 'session' || kind === 'session';
		// Claude Code's /usage wording: "Current session", "Current week (all models)", "Current week (Fable)".
		const label = session ? 'Current session' : 'Current week';
		const scope = session ? undefined : kind === 'weekly_all' || !scopeName ? 'All models' : String(scopeName);
		windows.push({
			id: `${kind}:${typeof scopeName === 'string' ? scopeName : ''}`,
			label,
			...(scope ? { scope } : {}),
			usedPercent: clampPercent(percent),
			windowMs: session ? 5 * HOUR_MS : 7 * DAY_MS,
			...(resetsAt ? { resetsAt } : {}),
		});
	}
	if (windows.length) {
		return windows;
	}
	const named: [string, string, string | undefined, number][] = [['five_hour', 'Current session', undefined, 5 * HOUR_MS], ['seven_day', 'Current week', 'All models', 7 * DAY_MS], ['seven_day_opus', 'Current week', 'Opus', 7 * DAY_MS], ['seven_day_sonnet', 'Current week', 'Sonnet', 7 * DAY_MS]];
	for (const [key, label, scope, windowMs] of named) {
		const window = record(data?.[key]);
		const utilization = finite(window?.utilization);
		if (utilization === undefined) {
			continue;
		}
		const resetsAt = isoMs(window?.resets_at);
		windows.push({ id: key, label, ...(scope ? { scope } : {}), usedPercent: clampPercent(utilization), windowMs, ...(resetsAt ? { resetsAt } : {}) });
	}
	return windows;
}

const CLAUDE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Thrown when a redemption failed. `settled`: Claude answered, so a retry is a new attempt. */
export class ResetCreditError extends Error {
	constructor(message: string, readonly settled: boolean) {
		super(message);
		this.name = 'ResetCreditError';
	}
}

/**
 * Claims one of Claude's banked resets for the organization, as Claude Code does. `requestId` is
 * the idempotency key: a retry with the same id is the same claim.
 */
export async function redeemClaudeResetCredit(home: string, claudeHome: IClaudeHome, env: NodeJS.ProcessEnv, grantId: string, requestId: string): Promise<VoltResetCreditOutcome> {
	if (!CLAUDE_GRANT_ID.test(grantId) || !CLAUDE_REQUEST_ID.test(requestId)) {
		throw new ResetCreditError('Claude returned a malformed reset credit.', true);
	}
	const credentials = await readClaudeCredentials(claudeHome);
	const { organizationUuid } = await readClaudeAccount(home, claudeHome);
	if (!credentials || !organizationUuid) {
		throw new ResetCreditError('Sign in to Claude Code again to redeem resets.', true);
	}
	let response: Response;
	try {
		response = await fetch(`https://api.anthropic.com/api/organizations/${encodeURIComponent(organizationUuid)}/reset_rate_limits`, {
			method: 'POST',
			headers: claudeHeaders(credentials.accessToken, await claudeCliVersion(env)),
			body: JSON.stringify({ program: 'cedar_ember', grant_id: grantId, request_id: requestId }),
			signal: AbortSignal.timeout(25_000),
		});
	} catch {
		throw new ResetCreditError('Claude could not redeem the reset. Check your connection and try again.', false);
	}
	if (response.status === 429) {
		throw new ResetCreditError('Claude is rate limiting resets. Try again soon.', true);
	}
	if (response.status === 401 || response.status === 403) {
		throw new ResetCreditError('Sign in to Claude Code again to redeem resets.', true);
	}
	let result: unknown;
	try {
		result = response.ok ? record(await response.json())?.result : undefined;
	} catch {
		result = undefined;
	}
	switch (result) {
		case 'reset': return 'reset';
		case 'not_limited': return 'nothingToReset';
		case 'already_used': return 'alreadyRedeemed';
		case 'ineligible': return 'noCredit';
		case 'cooldown': throw new ResetCreditError('Claude resets are cooling down. Try again later.', true);
		// Claude could not say whether the claim landed; the retry asks about the same claim.
		case 'unavailable': throw new ResetCreditError('Claude could not confirm the reset. If you are still limited in a moment, try again.', false);
		default: throw new ResetCreditError('Claude could not redeem the reset.', false);
	}
}

//#endregion

//#region Codex

const CODEX_COMMANDS = (home: string) => [
	join(home, '.codex', 'plugins', '.plugin-appserver', 'codex-cli', 'bin', 'codex'),
	'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
	'/Applications/Conductor.app/Contents/Resources/bin/codex',
	'codex',
];

/** The default Codex home (`CODEX_HOME` or `~/.codex`) plus every extra one, each once. */
export function codexHomes(home: string, env: NodeJS.ProcessEnv, extraDirs: readonly string[]): string[] {
	const homes = [env.CODEX_HOME?.trim() ? expandHome(env.CODEX_HOME.trim(), home) : join(home, '.codex')];
	for (const raw of extraDirs) {
		const dir = expandHome(raw.trim(), home);
		if (dir && !homes.includes(dir)) {
			homes.push(dir);
		}
	}
	return homes;
}

function jwtPayload(token: unknown): Record<string, unknown> | undefined {
	if (typeof token !== 'string') {
		return undefined;
	}
	try {
		return record(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')));
	} catch {
		return undefined;
	}
}

/** The ChatGPT account a Codex home is signed in to, from its `auth.json`. */
export async function readCodexAccount(codexHome: string): Promise<IVoltUsageAccount | undefined> {
	const tokens = record((await readJson(join(codexHome, 'auth.json')))?.tokens);
	const accountId = typeof tokens?.account_id === 'string' && tokens.account_id ? tokens.account_id : undefined;
	if (!accountId) {
		return undefined;
	}
	const email = jwtPayload(tokens?.id_token)?.email;
	return { id: `codex:${accountId}`, ...(typeof email === 'string' && email ? { label: email } : {}) };
}

/** Codex's /status wording: "5h limit", "Weekly limit". */
function codexWindowLabel(minutes: number | undefined): string {
	if (minutes === 10080) {
		return 'Weekly limit';
	}
	if (!minutes) {
		return 'Limit';
	}
	return minutes % 1440 === 0 ? `${minutes / 1440}-day limit` : `${Math.round(minutes / 60)}-hour limit`;
}

function codexPlan(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value[0].toUpperCase() + value.slice(1) : undefined;
}

/** Normalizes both the app-server (camelCase) and rollout (snake_case) shapes. */
export function codexGroup(raw: Record<string, unknown>, checkedAt: number, resetCredits?: number, resetCreditsExpireAt?: number): IVoltUsageLimitGroup {
	const windows: IVoltUsageLimitWindow[] = [];
	for (const key of ['primary', 'secondary']) {
		const window = record(raw[key]);
		const used = finite(window?.usedPercent ?? window?.used_percent);
		if (!window || used === undefined) {
			continue;
		}
		const minutes = finite(window.windowDurationMins ?? window.window_minutes);
		const resetsAtSeconds = finite(window.resetsAt ?? window.resets_at);
		const resetsAt = resetsAtSeconds ? resetsAtSeconds * 1000 : undefined;
		// A window that already reset is back to zero, even if the sample predates the reset.
		const expired = resetsAt !== undefined && resetsAt <= Date.now();
		windows.push({
			id: key,
			label: codexWindowLabel(minutes),
			usedPercent: expired ? 0 : clampPercent(used),
			...(minutes ? { windowMs: minutes * 60_000 } : {}),
			...(resetsAt && !expired ? { resetsAt } : {}),
		});
	}
	return {
		provider: 'codex',
		plan: codexPlan(raw.planType ?? raw.plan_type),
		windows,
		checkedAt,
		...(resetCredits ? { resetCredits } : {}),
		...(resetCredits && resetCreditsExpireAt ? { resetCreditsExpireAt } : {}),
	};
}

/** Soonest expiry among the credits still available, epoch ms. */
export function codexCreditsExpireAt(summary: unknown): number | undefined {
	const credits = record(summary)?.credits;
	const expiries = (Array.isArray(credits) ? credits : [])
		.map(record)
		.filter(credit => credit?.status === 'available')
		.map(credit => finite(credit?.expiresAt))
		.filter((value): value is number => value !== undefined && value > 0);
	return expiries.length ? Math.min(...expiries) * 1000 : undefined;
}

/**
 * Sends one request to `codex app-server` for the login in `codexHome`; the answer comes from the
 * account, not from a transcript. Undefined when no Codex binary answered.
 */
async function codexAppServerRequest(home: string, codexHome: string, env: NodeJS.ProcessEnv, method: string, params: object, timeoutMs: number): Promise<{ result?: Record<string, unknown>; error?: string } | undefined> {
	for (const command of CODEX_COMMANDS(home)) {
		if (command.startsWith('/')) {
			try {
				await fs.access(command);
			} catch {
				continue;
			}
		}
		const answer = await new Promise<{ result?: Record<string, unknown>; error?: string } | undefined>(resolve => {
			let settled = false;
			let buffer = '';
			const child = spawn(command, ['app-server', '--stdio'], { env: { ...env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'ignore'] });
			const finish = (value: { result?: Record<string, unknown>; error?: string } | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				child.kill();
				resolve(value);
			};
			const timer = setTimeout(() => finish(undefined), timeoutMs);
			child.on('error', () => finish(undefined));
			child.on('exit', () => finish(undefined));
			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => {
				buffer += chunk;
				let newline: number;
				while ((newline = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					try {
						const message = record(JSON.parse(line));
						if (message?.id === 2) {
							const error = record(message.error);
							finish(error ? { error: typeof error.message === 'string' ? error.message : 'Codex refused the request.' } : { result: record(message.result) });
						} else if (message?.id !== undefined && message.method) {
							// The server can ask us things (approvals); answer with nothing.
							child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n');
						}
					} catch {
						// Not JSON-RPC; ignore.
					}
				}
			});
			child.stdin.on('error', () => finish(undefined));
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'volt', title: 'Volt', version: '0.1.0' } } }) + '\n');
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) + '\n');
		});
		if (answer) {
			return answer;
		}
	}
	return undefined;
}

/** `fallback` supplies the newest sample from the rollouts, used only when app-server cannot be reached. */
export async function readCodexLimits(home: string, codexHome: string, env: NodeJS.ProcessEnv, fallback?: () => Promise<ICodexRateLimitSample | undefined>): Promise<IVoltUsageLimitGroup | undefined> {
	const account = await readCodexAccount(codexHome);
	const live = await codexAppServerRequest(home, codexHome, env, 'account/rateLimits/read', {}, 12_000);
	const limits = record(live?.result?.rateLimits);
	if (limits) {
		const summary = live?.result?.rateLimitResetCredits;
		const group = codexGroup(limits, Date.now(), finite(record(summary)?.availableCount), codexCreditsExpireAt(summary));
		return account ? { ...group, account } : group;
	}
	const sample = await fallback?.();
	if (!sample) {
		return undefined;
	}
	const group = codexGroup(sample.raw, sample.timestampMs);
	return account ? { ...group, account } : group;
}

/** Spends one of the Codex account's reset credits. `idempotencyKey` names the attempt; a retry reuses it. */
export async function redeemCodexResetCredit(home: string, codexHome: string, env: NodeJS.ProcessEnv, idempotencyKey: string): Promise<VoltResetCreditOutcome> {
	const answer = await codexAppServerRequest(home, codexHome, env, 'account/rateLimitResetCredit/consume', { idempotencyKey }, 20_000);
	if (!answer) {
		throw new ResetCreditError('Codex could not be reached to redeem the reset. Try again.', false);
	}
	if (answer.error) {
		throw new ResetCreditError(answer.error, true);
	}
	const outcome = answer.result?.outcome;
	if (outcome === 'reset' || outcome === 'nothingToReset' || outcome === 'noCredit' || outcome === 'alreadyRedeemed') {
		return outcome;
	}
	throw new ResetCreditError('Codex could not redeem the reset.', false);
}

//#endregion

//#region Cursor

async function readCursorToken(home: string): Promise<string | undefined> {
	const fromEnv = process.env.CURSOR_AUTH_TOKEN?.trim();
	if (fromEnv) {
		return fromEnv;
	}
	const fromKeychain = await readKeychain('cursor-access-token', 'cursor-user');
	if (fromKeychain) {
		return fromKeychain;
	}
	const file = await readJson(join(home, '.cursor', 'auth.json')) ?? await readJson(join(home, '.config', 'cursor', 'auth.json'));
	return typeof file?.accessToken === 'string' ? file.accessToken : undefined;
}

/** The user id in the token's `sub` (`auth0|user_…`), needed for the dashboard cookie. */
function cursorUserId(token: string): string | undefined {
	const subject = jwtPayload(token)?.sub;
	return typeof subject === 'string' ? subject.split('|').at(-1) || undefined : undefined;
}

/** The Cursor account this machine is signed in to, so its account-wide usage counts once across machines. */
export async function readCursorAccountId(home: string): Promise<string | undefined> {
	const token = await readCursorToken(home);
	const userId = token && cursorUserId(token);
	return userId ? `cursor:${userId}` : undefined;
}

export async function readCursorLimits(home: string): Promise<IVoltUsageLimitGroup | undefined> {
	const checkedAt = Date.now();
	const token = await readCursorToken(home);
	if (!token) {
		return undefined;
	}
	const userId = cursorUserId(token);
	const email = jwtPayload(token)?.email;
	const account: IVoltUsageAccount | undefined = userId ? { id: `cursor:${userId}`, ...(typeof email === 'string' && email ? { label: email } : {}) } : undefined;
	try {
		const response = await fetch('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json',
				'connect-protocol-version': '1',
				'x-cursor-client-type': 'cli',
			},
			body: '{}',
			signal: AbortSignal.timeout(10_000),
		});
		if (response.status === 401 || response.status === 403) {
			return { provider: 'cursor', account, windows: [], checkedAt, error: 'Sign in to Cursor again to read your limits.' };
		}
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		return { provider: 'cursor', account, windows: cursorWindows(await response.json()), checkedAt };
	} catch {
		return { provider: 'cursor', account, windows: [], checkedAt, error: 'Cursor limits could not be read. Check your connection and refresh.' };
	}
}

export function cursorWindows(body: unknown): IVoltUsageLimitWindow[] {
	const data = record(body);
	const usage = record(data?.planUsage);
	const start = finite(data?.billingCycleStart);
	const end = finite(data?.billingCycleEnd);
	const windowMs = start && end && end > start ? end - start : undefined;
	const windows: IVoltUsageLimitWindow[] = [];
	// The two pools Cursor's dashboard shows, in its words. Its blended total is not shown there, so not here.
	const rows: [string, string, string | undefined, string][] = [
		['autoPercentUsed', 'Cursor Models', 'Includes Cursor Grok and Composer', 'Additional usage beyond limits consumes Other Models quota or on-demand spend.'],
		['apiPercentUsed', 'Other Models', undefined, 'Additional usage beyond limits consumes on-demand spend.'],
	];
	for (const [key, label, scope, note] of rows) {
		const used = finite(usage?.[key]);
		if (used === undefined) {
			continue;
		}
		windows.push({ id: key, label, ...(scope ? { scope } : {}), note, usedPercent: clampPercent(used), ...(end ? { resetsAt: end } : {}), ...(windowMs ? { windowMs } : {}) });
	}
	return windows;
}

/** `cursor-grok-4.7-high-fast` → `xai/grok-4.7`, so cache savings can be priced from the table. */
export function cursorRateModel(model: string): string {
	const base = model.replace(/^cursor-/, '').replace(/(?:-thinking)?(?:-(?:none|minimal|low|medium|high|xhigh|max))?(?:-fast)?$/, '');
	return base.startsWith('grok-') ? `xai/${base}` : base;
}

export interface ICursorUsage {
	readonly records: IUsageRecord[];
	readonly error?: string;
}

/**
 * Account usage events from Cursor's dashboard API. They cover every Cursor surface (the
 * IDE, `cursor-agent`, Volt's Cursor runs) and carry the cost Cursor charged.
 */
export async function readCursorUsage(home: string, sinceMs: number): Promise<ICursorUsage | undefined> {
	const token = await readCursorToken(home);
	const userId = token && cursorUserId(token);
	if (!token || !userId) {
		return undefined;
	}
	const until = Date.now();
	const pageSize = 1000;
	const seen = new Set<string>();
	const records: IUsageRecord[] = [];
	try {
		for (let page = 1; page <= 200; page++) {
			const response = await fetch('https://cursor.com/api/dashboard/get-filtered-usage-events', {
				method: 'POST',
				redirect: 'error',
				headers: {
					'Content-Type': 'application/json',
					'Origin': 'https://cursor.com',
					'Cookie': `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`,
				},
				body: JSON.stringify({ page, pageSize, startDate: String(sinceMs), endDate: String(until) }),
				signal: AbortSignal.timeout(15_000),
			});
			if (response.status === 401 || response.status === 403) {
				return { records: [], error: 'Sign in to Cursor again to read its usage.' };
			}
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const body = record(await response.json());
			const events = Array.isArray(body?.usageEventsDisplay) ? body.usageEventsDisplay : [];
			for (const raw of events) {
				const event = record(raw);
				const usage = record(event?.tokenUsage);
				const timestampMs = finite(event?.timestamp);
				const model = typeof event?.model === 'string' ? event.model : '';
				if (!event || !usage || timestampMs === undefined || !model || timestampMs < sinceMs) {
					continue;
				}
				const conversation = typeof event.conversationId === 'string' ? event.conversationId : '';
				const key = JSON.stringify([timestampMs, model, conversation, usage]);
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				const cents = finite(usage.totalCents);
				records.push({
					provider: 'cursor',
					timestampMs,
					model,
					sessionId: conversation,
					uncached: Math.max(0, Math.trunc(finite(usage.inputTokens) ?? 0)),
					cached: Math.max(0, Math.trunc(finite(usage.cacheReadTokens) ?? 0)),
					cacheWrite: Math.max(0, Math.trunc(finite(usage.cacheWriteTokens) ?? 0)),
					output: Math.max(0, Math.trunc(finite(usage.outputTokens) ?? 0)),
					speed: 'standard',
					...(cents !== undefined ? { reportedCostUsd: cents / 100 } : {}),
				});
			}
			if (events.length < pageSize) {
				return { records };
			}
		}
		return { records };
	} catch {
		return { records, error: 'Cursor usage could not be read. Check your connection and refresh.' };
	}
}

//#endregion
