/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { userInfo } from 'os';
import { basename, dirname, join } from '../../../base/common/path.js';

/**
 * Claude Code's sign-in, as Claude Code itself keeps it:
 *
 * - The credential is a JSON blob. On macOS it lives in the login keychain (generic password,
 *   service `Claude Code-credentials`, account `$USER`); elsewhere in `<config home>/.credentials.json`.
 *   `claudeAiOauth` (and `trustedDeviceToken`) belong to the account; the rest of the blob
 *   (MCP server logins, plugin secrets) belongs to the machine and is never swapped.
 * - Who is signed in is `oauthAccount` in the global config (`~/.claude.json`).
 * - With `CLAUDE_CONFIG_DIR` set, both move: the keychain service gets the first 8 hex digits of
 *   the folder's SHA-256 as a suffix, and the config is `<dir>/.claude.json`.
 * - Token refreshes hold two `proper-lockfile` directory locks, `<config home>/.oauth_refresh.lock`
 *   then `<config home>.lock`; config writes hold `<config>.lock`. Volt takes the same locks, in the
 *   same order, so a switch never lands inside a refresh.
 */

const SECURITY = '/usr/bin/security';
/** `security -i` reads 4096-byte lines; longer commands go through argv instead. */
const SECURITY_STDIN_LIMIT = 4096 - 64;
const KEYCHAIN_NOT_FOUND = 44;

export const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
/** Credential keys that move with the account; every other key in the blob stays put. */
export const ACCOUNT_CREDENTIAL_KEYS = ['claudeAiOauth', 'trustedDeviceToken'] as const;

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

export function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

//#region Keychain and files

export class KeychainError extends Error { }

export function keychainAccountName(env: NodeJS.ProcessEnv): string {
	if (env.USER) {
		return env.USER;
	}
	try {
		return userInfo().username;
	} catch {
		return 'claude-code-user';
	}
}

/** The keychain service Claude Code derives for a `CLAUDE_CONFIG_DIR` value (hashed as given, not resolved). */
export function claudeKeychainService(configDir: string | undefined): string {
	if (!configDir) {
		return 'Claude Code-credentials';
	}
	const digest = createHash('sha256').update(configDir.normalize('NFC'), 'utf8').digest('hex').slice(0, 8);
	return `Claude Code-credentials-${digest}`;
}

export function keychainGet(service: string, account: string): Promise<string | undefined> {
	return new Promise((resolve, reject) => {
		execFile(SECURITY, ['find-generic-password', '-a', account, '-w', '-s', service], { timeout: 10_000 }, (error, stdout, stderr) => {
			if (!error) {
				resolve(stdout.replace(/\n$/, ''));
			} else if ((error as { code?: unknown }).code === KEYCHAIN_NOT_FOUND) {
				resolve(undefined);
			} else {
				reject(new KeychainError(`security find-generic-password failed: ${String(stderr || error.message).trim()}`));
			}
		});
	});
}

function quote(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Writes the way Claude Code does: hex through `security -i`, so the secret is not in argv. */
export function keychainSet(service: string, account: string, value: string): Promise<void> {
	const hex = Buffer.from(value, 'utf8').toString('hex');
	const line = `add-generic-password -U -a ${quote(account)} -s ${quote(service)} -X ${hex}\n`;
	return new Promise((resolve, reject) => {
		const viaStdin = line.length <= SECURITY_STDIN_LIMIT;
		const child = viaStdin
			? spawn(SECURITY, ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] })
			: spawn(SECURITY, ['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex], { stdio: ['ignore', 'ignore', 'pipe'] });
		let stderr = '';
		const timer = setTimeout(() => child.kill(), 10_000);
		child.stderr?.setEncoding('utf8').on('data', chunk => stderr += chunk);
		child.on('error', error => {
			clearTimeout(timer);
			reject(new KeychainError(error.message));
		});
		child.on('exit', code => {
			clearTimeout(timer);
			// `security -i` exits 0 even when a command failed; it says so on stderr.
			if (code === 0 && !/error|fail/i.test(stderr)) {
				resolve();
			} else {
				reject(new KeychainError(`security add-generic-password failed: ${stderr.trim() || `exit ${code}`}`));
			}
		});
		if (viaStdin) {
			child.stdin!.end(line);
		}
	});
}

export function keychainDelete(service: string, account: string): Promise<void> {
	return new Promise(resolve => {
		execFile(SECURITY, ['delete-generic-password', '-a', account, '-s', service], { timeout: 10_000 }, () => resolve());
	});
}

export async function readText(path: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path, 'utf8');
	} catch {
		return undefined;
	}
}

export async function readJsonFile(path: string): Promise<JsonObject | undefined> {
	const text = await readText(path);
	if (!text) {
		return undefined;
	}
	try {
		return asObject(JSON.parse(text));
	} catch {
		return undefined;
	}
}

/** Temp file and rename, so a reader never sees half a file. Keeps an existing file's mode. */
export async function writeFileAtomic(path: string, text: string, mode = 0o600): Promise<void> {
	await fs.mkdir(dirname(path), { recursive: true });
	let fileMode = mode;
	try {
		fileMode = (await fs.stat(path)).mode & 0o777;
	} catch {
		// New file.
	}
	const temp = join(dirname(path), `.${basename(path)}.volt-${process.pid}-${Date.now().toString(36)}`);
	await fs.writeFile(temp, text, { mode: fileMode });
	await fs.rename(temp, path);
}

/** Where Volt keeps each saved account's credential: the keychain on macOS, 0600 files elsewhere. */
export interface IAccountSecrets {
	get(id: string): Promise<string | undefined>;
	set(id: string, value: string): Promise<void>;
	delete(id: string): Promise<void>;
}

export class KeychainAccountSecrets implements IAccountSecrets {
	constructor(private readonly service: string) { }
	get(id: string) { return keychainGet(this.service, id); }
	set(id: string, value: string) { return keychainSet(this.service, id, value); }
	delete(id: string) { return keychainDelete(this.service, id); }
}

export class FileAccountSecrets implements IAccountSecrets {
	constructor(private readonly dir: string) { }
	private path(id: string) { return join(this.dir, `${id.replace(/[^a-z0-9-]/gi, '')}.json`); }
	get(id: string) { return readText(this.path(id)); }
	async set(id: string, value: string) {
		await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
		await writeFileAtomic(this.path(id), value, 0o600);
	}
	async delete(id: string) { await fs.rm(this.path(id), { force: true }); }
}

//#endregion

//#region The live login

export interface IClaudeLiveLocation {
	/** `~/.claude`, or `CLAUDE_CONFIG_DIR`. */
	readonly configHome: string;
	/** `~/.claude.json`, or `<CLAUDE_CONFIG_DIR>/.claude.json`. */
	readonly globalConfig: string;
	/** Keychain item on macOS; undefined elsewhere. */
	readonly keychain?: { readonly service: string; readonly account: string };
	readonly credentialsFile: string;
}

export function claudeLiveLocation(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, configDir = env.CLAUDE_CONFIG_DIR?.trim() || undefined): IClaudeLiveLocation {
	const configHome = configDir ?? join(home, '.claude');
	return {
		configHome,
		globalConfig: configDir ? join(configDir, '.claude.json') : join(home, '.claude.json'),
		keychain: platform === 'darwin' ? { service: claudeKeychainService(configDir), account: keychainAccountName(env) } : undefined,
		credentialsFile: join(configHome, '.credentials.json'),
	};
}

export interface IClaudeLiveLogin {
	/** The whole credential blob; undefined when Claude Code is signed out. */
	readonly credentials?: JsonObject;
	/** Where the blob was read from, so it is written back there. */
	readonly source: 'keychain' | 'file';
	readonly oauthAccount?: JsonObject;
}

export async function readLiveLogin(location: IClaudeLiveLocation): Promise<IClaudeLiveLogin> {
	let raw: string | undefined;
	let source: 'keychain' | 'file' = location.keychain ? 'keychain' : 'file';
	if (location.keychain) {
		raw = await keychainGet(location.keychain.service, location.keychain.account);
	}
	if (!raw) {
		const file = await readText(location.credentialsFile);
		if (file) {
			raw = file;
			source = 'file';
		}
	}
	let credentials: JsonObject | undefined;
	if (raw) {
		try {
			credentials = asObject(JSON.parse(raw));
		} catch {
			throw new KeychainError('Claude Code\u2019s sign-in could not be read.');
		}
	}
	const config = await readJsonFile(location.globalConfig);
	return { credentials, source, oauthAccount: asObject(config?.oauthAccount) };
}

export async function writeLiveCredentials(location: IClaudeLiveLocation, source: 'keychain' | 'file', credentials: JsonObject): Promise<void> {
	const text = JSON.stringify(credentials);
	if (source === 'keychain' && location.keychain) {
		await keychainSet(location.keychain.service, location.keychain.account, text);
	} else {
		await writeFileAtomic(location.credentialsFile, text, 0o600);
	}
}

/** Replaces `oauthAccount` in the global config and leaves every other key as it was. */
export async function writeLiveOauthAccount(location: IClaudeLiveLocation, oauthAccount: JsonObject): Promise<void> {
	const text = await readText(location.globalConfig);
	let config: JsonObject = {};
	if (text) {
		try {
			config = asObject(JSON.parse(text)) ?? {};
		} catch {
			throw new Error(`${location.globalConfig} is not valid JSON; Volt left it alone.`);
		}
	}
	config.oauthAccount = oauthAccount;
	await writeFileAtomic(location.globalConfig, JSON.stringify(config, undefined, 2), 0o600);
}

/** The account-scoped part of a credential blob. */
export function accountCredentials(credentials: JsonObject | undefined): JsonObject | undefined {
	if (!asObject(credentials?.claudeAiOauth)) {
		return undefined;
	}
	const picked: JsonObject = {};
	for (const key of ACCOUNT_CREDENTIAL_KEYS) {
		if (credentials![key] !== undefined) {
			picked[key] = credentials![key];
		}
	}
	return picked;
}

/** The live blob with the account-scoped keys of another account in place of its own. */
export function spliceCredentials(live: JsonObject | undefined, account: JsonObject): JsonObject {
	const next: JsonObject = { ...live };
	for (const key of ACCOUNT_CREDENTIAL_KEYS) {
		delete next[key];
		if (account[key] !== undefined) {
			next[key] = account[key];
		}
	}
	return next;
}

//#endregion

//#region Claude Code's locks

const CREDENTIAL_LOCK_STALE_MS = 60_000;
const CONFIG_LOCK_STALE_MS = 10_000;
const LOCK_TOUCH_MS = 3000;
const LOCK_TIMEOUT_MS = 9000;

export class LockTimeoutError extends Error { }

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A `proper-lockfile` compatible lock: the directory is the mutex, its mtime the heartbeat. */
async function withDirLock<T>(lockDir: string, staleMs: number, run: () => Promise<T>): Promise<T> {
	await fs.mkdir(dirname(lockDir), { recursive: true });
	const started = Date.now();
	for (; ;) {
		try {
			await fs.mkdir(lockDir);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
		}
		if (Date.now() - started > LOCK_TIMEOUT_MS) {
			throw new LockTimeoutError('Claude Code is refreshing its sign-in. Try again in a few seconds.');
		}
		try {
			const { mtimeMs } = await fs.stat(lockDir);
			if (Date.now() - mtimeMs > staleMs) {
				await fs.rmdir(lockDir).catch(() => undefined);
				continue;
			}
		} catch {
			continue;
		}
		await sleep(250 + Math.random() * 250);
	}
	const touch = setInterval(() => {
		const now = new Date();
		fs.utimes(lockDir, now, now).catch(() => undefined);
	}, LOCK_TOUCH_MS);
	try {
		return await run();
	} finally {
		clearInterval(touch);
		await fs.rmdir(lockDir).catch(() => undefined);
	}
}

/** Holds the refresh locks (in Claude Code's order) and the config lock. No network inside. */
export function withClaudeLocks<T>(location: IClaudeLiveLocation, run: () => Promise<T>): Promise<T> {
	const home = location.configHome.replace(/[\\/]+$/, '');
	return withDirLock(join(home, '.oauth_refresh.lock'), CREDENTIAL_LOCK_STALE_MS,
		() => withDirLock(`${home}.lock`, CREDENTIAL_LOCK_STALE_MS,
			() => withDirLock(`${location.globalConfig}.lock`, CONFIG_LOCK_STALE_MS, run)));
}

//#endregion

//#region OAuth

export type RefreshResult =
	| { readonly ok: true; readonly credentials: JsonObject }
	/** `dead`: the refresh token was rejected; only a new sign-in brings the account back. */
	| { readonly ok: false; readonly dead: boolean };

/** Trades an account's refresh token for a fresh access token. Only for accounts not live in Claude Code. */
export async function refreshAccountCredentials(credentials: JsonObject): Promise<RefreshResult> {
	const oauth = asObject(credentials.claudeAiOauth);
	const refreshToken = asString(oauth?.refreshToken);
	if (!oauth || !refreshToken) {
		return { ok: false, dead: true };
	}
	try {
		const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLAUDE_OAUTH_CLIENT_ID }),
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			if (response.status >= 400 && response.status < 500) {
				const body = asObject(await response.json().catch(() => undefined));
				return { ok: false, dead: body?.error === 'invalid_grant' };
			}
			return { ok: false, dead: false };
		}
		const body = asObject(await response.json());
		const accessToken = asString(body?.access_token);
		const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : undefined;
		if (!accessToken || !expiresIn) {
			return { ok: false, dead: false };
		}
		const next: JsonObject = { ...oauth, accessToken, expiresAt: Date.now() + expiresIn * 1000 };
		if (asString(body?.refresh_token)) {
			next.refreshToken = body!.refresh_token;
		}
		if (typeof body?.refresh_token_expires_in === 'number') {
			next.refreshTokenExpiresAt = Date.now() + body.refresh_token_expires_in * 1000;
		}
		if (asString(body?.scope)) {
			next.scopes = String(body!.scope).split(/\s+/);
		}
		return { ok: true, credentials: { ...credentials, claudeAiOauth: next } };
	} catch {
		return { ok: false, dead: false };
	}
}

/** The account behind a token, shaped like Claude Code's `oauthAccount`, for sign-ins that did not write one. */
export async function fetchOauthAccount(accessToken: string): Promise<JsonObject | undefined> {
	try {
		const response = await fetch(CLAUDE_PROFILE_URL, {
			headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			return undefined;
		}
		const body = asObject(await response.json());
		const account = asObject(body?.account);
		const organization = asObject(body?.organization);
		const accountUuid = asString(account?.uuid);
		const emailAddress = asString(account?.email_address) ?? asString(account?.email);
		if (!accountUuid || !emailAddress) {
			return undefined;
		}
		return {
			accountUuid,
			emailAddress,
			organizationUuid: asString(organization?.uuid),
			displayName: asString(account?.display_name),
			fullName: asString(account?.full_name),
			organizationName: asString(organization?.name),
			organizationType: asString(organization?.organization_type),
			organizationRateLimitTier: asString(organization?.rate_limit_tier),
		};
	} catch {
		return undefined;
	}
}

//#endregion
