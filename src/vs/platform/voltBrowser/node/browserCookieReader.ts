/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { createDecipheriv, pbkdf2Sync } from 'crypto';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import type { Database } from '@vscode/sqlite3';
import { generateUuid } from '../../../base/common/uuid.js';
import { chromiumSameSite, chromiumTimeToUnix, firefoxExpiryToUnix, firefoxSameSite, IReadCookie, IVoltCookieSource, parseBinaryCookies, parseChromiumProfileNames, parseFirefoxProfilesIni, VoltCookieBrowser } from '../common/browserCookies.js';

interface IChromiumBrowser {
	readonly browser: VoltCookieBrowser;
	readonly label: string;
	/** User data folders per platform, relative to the platform's base folder. */
	readonly darwin?: string;
	readonly linux?: string;
	readonly win32?: string;
	/** macOS Keychain item: service and account. */
	readonly keychain: readonly [string, string];
	/** Linux Secret Service `application` attribute. */
	readonly secretApp: string;
	/** Opera keeps the profile in the user data folder itself. */
	readonly flat?: boolean;
}

const CHROMIUM_BROWSERS: readonly IChromiumBrowser[] = [
	{ browser: 'chrome', label: 'Google Chrome', darwin: 'Google/Chrome', linux: 'google-chrome', win32: 'Google/Chrome/User Data', keychain: ['Chrome Safe Storage', 'Chrome'], secretApp: 'chrome' },
	{ browser: 'arc', label: 'Arc', darwin: 'Arc/User Data', win32: 'Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4/LocalCache/Local/Arc/User Data', keychain: ['Arc Safe Storage', 'Arc'], secretApp: 'arc' },
	{ browser: 'brave', label: 'Brave', darwin: 'BraveSoftware/Brave-Browser', linux: 'BraveSoftware/Brave-Browser', win32: 'BraveSoftware/Brave-Browser/User Data', keychain: ['Brave Safe Storage', 'Brave'], secretApp: 'brave' },
	{ browser: 'edge', label: 'Microsoft Edge', darwin: 'Microsoft Edge', linux: 'microsoft-edge', win32: 'Microsoft/Edge/User Data', keychain: ['Microsoft Edge Safe Storage', 'Microsoft Edge'], secretApp: 'chromium' },
	{ browser: 'chromium', label: 'Chromium', darwin: 'Chromium', linux: 'chromium', win32: 'Chromium/User Data', keychain: ['Chromium Safe Storage', 'Chromium'], secretApp: 'chromium' },
	{ browser: 'vivaldi', label: 'Vivaldi', darwin: 'Vivaldi', linux: 'vivaldi', win32: 'Vivaldi/User Data', keychain: ['Vivaldi Safe Storage', 'Vivaldi'], secretApp: 'chromium' },
	{ browser: 'opera', label: 'Opera', darwin: 'com.operasoftware.Opera', linux: 'opera', win32: 'Opera Software/Opera Stable', keychain: ['Opera Safe Storage', 'Opera'], secretApp: 'chromium', flat: true },
	{ browser: 'operaGx', label: 'Opera GX', darwin: 'com.operasoftware.OperaGX', win32: 'Opera Software/Opera GX Stable', keychain: ['Opera Safe Storage', 'Opera'], secretApp: 'chromium', flat: true },
];

interface IFirefoxFamily {
	readonly browser: VoltCookieBrowser;
	readonly label: string;
	readonly darwin: string;
	readonly linux: string;
	readonly win32: string;
}

const FIREFOX_BROWSERS: readonly IFirefoxFamily[] = [
	{ browser: 'firefox', label: 'Firefox', darwin: 'Firefox', linux: '.mozilla/firefox', win32: 'Mozilla/Firefox' },
	{ browser: 'zen', label: 'Zen', darwin: 'zen', linux: '.zen', win32: 'zen' },
];

export interface ICookieReaderEnv {
	readonly platform: NodeJS.Platform;
	readonly home: string;
	readonly env: NodeJS.ProcessEnv;
}

export function defaultReaderEnv(): ICookieReaderEnv {
	return { platform: process.platform, home: homedir(), env: process.env };
}

/** Where a platform keeps per-user app data for Chromium browsers. */
function chromiumBase(env: ICookieReaderEnv, browser: IChromiumBrowser): string | undefined {
	switch (env.platform) {
		case 'darwin':
			return browser.darwin && join(env.home, 'Library', 'Application Support', browser.darwin);
		case 'linux':
			return browser.linux && join(env.env.XDG_CONFIG_HOME || join(env.home, '.config'), browser.linux);
		case 'win32': {
			const roaming = browser.flat || browser.browser === 'arc' ? (browser.browser === 'arc' ? env.env.LOCALAPPDATA : env.env.APPDATA) : env.env.LOCALAPPDATA;
			return browser.win32 && roaming ? join(roaming, ...browser.win32.split('/')) : undefined;
		}
		default:
			return undefined;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

/** Newer Chromium keeps cookies in `Network/Cookies`, older in `Cookies`. */
async function chromiumCookieFile(profileDir: string): Promise<string | undefined> {
	for (const candidate of [join(profileDir, 'Network', 'Cookies'), join(profileDir, 'Cookies')]) {
		if (await exists(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/** Every browser profile with a cookie store on this machine. */
export async function listCookieSources(env: ICookieReaderEnv = defaultReaderEnv()): Promise<IVoltCookieSource[]> {
	const sources: IVoltCookieSource[] = [];
	for (const browser of CHROMIUM_BROWSERS) {
		const base = chromiumBase(env, browser);
		if (!base || !await exists(base)) {
			continue;
		}
		const names = parseChromiumProfileNames(await fs.readFile(join(base, 'Local State'), 'utf8').catch(() => ''));
		const folders = browser.flat ? [''] : (await fs.readdir(base).catch(() => [] as string[])).filter(name => name === 'Default' || /^Profile \d+$/.test(name) || names.has(name));
		for (const folder of folders.sort((a, b) => Number(b === 'Default') - Number(a === 'Default') || a.localeCompare(b, undefined, { numeric: true }))) {
			const file = await chromiumCookieFile(folder ? join(base, folder) : base);
			if (!file) {
				continue;
			}
			const profile = folder || 'Default';
			sources.push({ id: `${browser.browser}:${profile}`, browser: browser.browser, browserLabel: browser.label, profile, profileLabel: names.get(folder) ?? profile, path: file, encrypted: true });
		}
	}
	if (env.platform === 'darwin') {
		for (const file of [join(env.home, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Cookies', 'Cookies.binarycookies'), join(env.home, 'Library', 'Cookies', 'Cookies.binarycookies')]) {
			// Exists but unreadable without Full Disk Access: listed, so the import can say so.
			if (await exists(file)) {
				sources.push({ id: 'safari:Default', browser: 'safari', browserLabel: 'Safari', profile: 'Default', profileLabel: 'Default', path: file, encrypted: false });
				break;
			}
		}
	}
	for (const family of FIREFOX_BROWSERS) {
		const base = env.platform === 'darwin' ? join(env.home, 'Library', 'Application Support', family.darwin)
			: env.platform === 'win32' ? (env.env.APPDATA ? join(env.env.APPDATA, ...family.win32.split('/')) : undefined)
				: join(env.home, family.linux);
		if (!base) {
			continue;
		}
		const ini = await fs.readFile(join(base, 'profiles.ini'), 'utf8').catch(() => undefined);
		if (!ini) {
			continue;
		}
		for (const profile of parseFirefoxProfilesIni(ini)) {
			const dir = profile.relative ? join(base, ...profile.path.split('/')) : profile.path;
			const file = join(dir, 'cookies.sqlite');
			if (await exists(file)) {
				sources.push({ id: `${family.browser}:${profile.path}`, browser: family.browser, browserLabel: family.label, profile: profile.path, profileLabel: profile.name, path: file, encrypted: false });
			}
		}
	}
	return sources;
}

//#region SQLite

/** A copy of the database (with its WAL), so the running browser's lock and pending writes do not get in the way. */
async function withDatabaseCopy<T>(file: string, read: (db: Database) => Promise<T>): Promise<T> {
	const dir = join(tmpdir(), `volt-cookies-${generateUuid()}`);
	await fs.mkdir(dir, { recursive: true });
	const copy = join(dir, 'cookies.db');
	try {
		try {
			await fs.copyFile(file, copy);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'EPERM' || (err as NodeJS.ErrnoException).code === 'EACCES') {
				throw new Error(`Volt is not allowed to read ${file}. On macOS, give Volt Full Disk Access in System Settings > Privacy & Security.`);
			}
			throw err;
		}
		for (const suffix of ['-wal', '-shm']) {
			await fs.copyFile(file + suffix, copy + suffix).catch(() => undefined);
		}
		const sqlite3 = (await import('@vscode/sqlite3')).default;
		const db = await new Promise<Database>((resolve, reject) => {
			const opened: Database = new sqlite3.Database(copy, sqlite3.OPEN_READWRITE, error => error ? reject(error) : resolve(opened));
		});
		try {
			return await read(db);
		} finally {
			await new Promise<void>(resolve => db.close(() => resolve()));
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function all<T>(db: Database, sql: string): Promise<T[]> {
	return new Promise((resolve, reject) => db.all(sql, (error: Error | null, rows: T[]) => error ? reject(error) : resolve(rows)));
}

//#endregion

//#region Chromium decryption

/** The AES key Chromium on macOS and Linux derives from its stored password. */
export function chromiumPosixKey(password: string, iterations: number): Buffer {
	return pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
}

/**
 * Decrypts a `v10`/`v11` value (AES-128-CBC, IV of 16 spaces). From database version 24 the
 * plaintext starts with SHA-256 of the host, which is dropped.
 */
export function decryptChromiumPosix(encrypted: Uint8Array, key: Buffer, dbVersion: number): string {
	const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
	const plain = Buffer.concat([decipher.update(Buffer.from(encrypted).subarray(3)), decipher.final()]);
	return (dbVersion >= 24 ? plain.subarray(32) : plain).toString('utf8');
}

/** Windows `v10`: AES-256-GCM with a 12-byte nonce after the prefix and the 16-byte tag at the end. */
export function decryptChromiumWindows(encrypted: Uint8Array, key: Buffer, dbVersion: number): string {
	const data = Buffer.from(encrypted);
	const nonce = data.subarray(3, 15);
	const tag = data.subarray(data.length - 16);
	const decipher = createDecipheriv('aes-256-gcm', key, nonce);
	decipher.setAuthTag(tag);
	const plain = Buffer.concat([decipher.update(data.subarray(15, data.length - 16)), decipher.final()]);
	return (dbVersion >= 24 ? plain.subarray(32) : plain).toString('utf8');
}

function run(file: string, args: readonly string[], timeout = 60_000): Promise<string> {
	return new Promise((resolve, reject) => execFile(file, args as string[], { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout))));
}

interface IChromiumKeys {
	/** Keys to try per version prefix. */
	readonly v10: readonly Buffer[];
	readonly v11: readonly Buffer[];
	readonly windows?: Buffer;
}

async function chromiumKeys(browser: IChromiumBrowser, source: IVoltCookieSource, env: ICookieReaderEnv): Promise<IChromiumKeys> {
	if (env.platform === 'darwin') {
		let password: string;
		try {
			// macOS asks the user to allow this once per browser ("Always Allow" skips it next time).
			password = (await run('security', ['find-generic-password', '-w', '-s', browser.keychain[0], '-a', browser.keychain[1]])).trim();
		} catch (err) {
			throw new Error(`Could not read ${browser.label}'s key from the Keychain (${err instanceof Error ? err.message : String(err)}). Allow Volt when macOS asks, then try again.`);
		}
		const key = chromiumPosixKey(password, 1003);
		return { v10: [key], v11: [key] };
	}
	if (env.platform === 'linux') {
		const v10 = [chromiumPosixKey('peanuts', 1)];
		const secret = await run('secret-tool', ['lookup', 'application', browser.secretApp], 10_000).then(value => value.trim()).catch(() => '');
		return { v10, v11: secret ? [chromiumPosixKey(secret, 1), chromiumPosixKey('', 1)] : [chromiumPosixKey('', 1)] };
	}
	if (env.platform === 'win32') {
		const base = source.path.replace(/[\\/](Network[\\/])?Cookies$/, '').replace(/[\\/][^\\/]+$/, '');
		const localState = JSON.parse(await fs.readFile(join(base, 'Local State'), 'utf8')) as { os_crypt?: { encrypted_key?: string } };
		const wrapped = localState.os_crypt?.encrypted_key;
		if (!wrapped) {
			throw new Error(`${browser.label} has no encryption key in Local State.`);
		}
		const blob = Buffer.from(wrapped, 'base64').subarray(5).toString('base64');
		const script = `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${blob}'), $null, 'CurrentUser'))`;
		const key = Buffer.from((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).trim(), 'base64');
		return { v10: [], v11: [], windows: key };
	}
	throw new Error('Reading Chromium cookies is not supported on this platform.');
}

interface IChromiumRow {
	readonly host_key: string;
	readonly name: string;
	readonly value: string;
	readonly encrypted_value: Uint8Array | null;
	readonly path: string;
	readonly expires_utc: number | string;
	readonly is_secure: number;
	readonly is_httponly: number;
	readonly samesite?: number;
	readonly top_frame_site_key?: string;
}

export interface IReadResult {
	readonly cookies: IReadCookie[];
	/** Rows that could not be decrypted (or are partitioned, which the session cannot store). */
	readonly undecryptable: number;
	readonly partitioned: number;
	readonly warnings: string[];
}

function decryptRow(row: IChromiumRow, keys: IChromiumKeys, dbVersion: number): string | undefined {
	const data = row.encrypted_value;
	if (!data || data.length === 0) {
		return row.value;
	}
	const prefix = String.fromCharCode(data[0], data[1], data[2]);
	if (keys.windows) {
		return prefix === 'v10' ? decryptChromiumWindows(data, keys.windows, dbVersion) : undefined;
	}
	for (const key of prefix === 'v11' ? keys.v11 : prefix === 'v10' ? keys.v10 : []) {
		try {
			return decryptChromiumPosix(data, key, dbVersion);
		} catch {
			// try the next key
		}
	}
	return undefined;
}

async function readChromium(source: IVoltCookieSource, env: ICookieReaderEnv): Promise<IReadResult> {
	const browser = CHROMIUM_BROWSERS.find(candidate => candidate.browser === source.browser);
	if (!browser) {
		throw new Error(`Unknown browser ${source.browser}`);
	}
	return withDatabaseCopy(source.path, async db => {
		const columns = new Set((await all<{ name: string }>(db, 'PRAGMA table_info(cookies)')).map(column => column.name));
		const version = Number((await all<{ value: string }>(db, `SELECT value FROM meta WHERE key = 'version'`).catch(() => []))[0]?.value ?? 0);
		const select = ['host_key', 'name', 'value', 'encrypted_value', 'path', 'CAST(expires_utc AS TEXT) AS expires_utc', 'is_secure', 'is_httponly'];
		if (columns.has('samesite')) {
			select.push('samesite');
		}
		if (columns.has('top_frame_site_key')) {
			select.push('top_frame_site_key');
		}
		const rows = await all<IChromiumRow>(db, `SELECT ${select.join(', ')} FROM cookies`);
		const needsKey = rows.some(row => row.encrypted_value && row.encrypted_value.length > 0);
		const keys = needsKey ? await chromiumKeys(browser, source, env) : { v10: [], v11: [] };
		const warnings: string[] = [];
		const cookies: IReadCookie[] = [];
		let undecryptable = 0;
		let partitioned = 0;
		let appBound = 0;
		for (const row of rows) {
			if (row.top_frame_site_key) {
				partitioned++;
				continue;
			}
			let value: string | undefined;
			try {
				value = decryptRow(row, keys, version);
			} catch {
				value = undefined;
			}
			if (value === undefined) {
				undecryptable++;
				if (row.encrypted_value && String.fromCharCode(row.encrypted_value[0], row.encrypted_value[1], row.encrypted_value[2]) === 'v20') {
					appBound++;
				}
				continue;
			}
			cookies.push({
				host: row.host_key,
				name: row.name,
				value,
				path: row.path || '/',
				secure: !!row.is_secure,
				httpOnly: !!row.is_httponly,
				expires: chromiumTimeToUnix(row.expires_utc),
				sameSite: chromiumSameSite(row.samesite ?? -1),
			});
		}
		if (appBound) {
			warnings.push(`${appBound} cookies use ${browser.label}'s app-bound encryption, which only ${browser.label} itself can read.`);
		} else if (undecryptable && undecryptable === rows.length) {
			warnings.push(`None of ${browser.label}'s cookies could be decrypted with the key from the system keychain.`);
		}
		return { cookies, undecryptable, partitioned, warnings };
	});
}

interface IFirefoxRow {
	readonly host: string;
	readonly name: string;
	readonly value: string;
	readonly path: string;
	readonly expiry: number;
	readonly isSecure: number;
	readonly isHttpOnly: number;
	readonly sameSite?: number;
	readonly originAttributes?: string;
}

async function readFirefox(source: IVoltCookieSource): Promise<IReadResult> {
	return withDatabaseCopy(source.path, async db => {
		const columns = new Set((await all<{ name: string }>(db, 'PRAGMA table_info(moz_cookies)')).map(column => column.name));
		const select = ['host', 'name', 'value', 'path', 'expiry', 'isSecure', 'isHttpOnly'];
		if (columns.has('sameSite')) {
			select.push('sameSite');
		}
		if (columns.has('originAttributes')) {
			select.push('originAttributes');
		}
		const rows = await all<IFirefoxRow>(db, `SELECT ${select.join(', ')} FROM moz_cookies`);
		const cookies: IReadCookie[] = [];
		let partitioned = 0;
		for (const row of rows) {
			// Containers and partitioned (third-party) cookies live under origin attributes; the session has no place for them.
			if (row.originAttributes) {
				partitioned++;
				continue;
			}
			cookies.push({
				host: row.host,
				name: row.name,
				value: row.value,
				path: row.path || '/',
				secure: !!row.isSecure,
				httpOnly: !!row.isHttpOnly,
				expires: firefoxExpiryToUnix(row.expiry),
				sameSite: firefoxSameSite(row.sameSite ?? 256),
			});
		}
		return { cookies, undecryptable: 0, partitioned, warnings: [] };
	});
}

async function readSafari(source: IVoltCookieSource): Promise<IReadResult> {
	let bytes: Buffer;
	try {
		bytes = await fs.readFile(source.path);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'EPERM' || code === 'EACCES') {
			throw new Error('macOS keeps Safari\'s cookies private: give Volt Full Disk Access in System Settings > Privacy & Security > Full Disk Access, restart Volt, and try again.');
		}
		throw err;
	}
	return { cookies: parseBinaryCookies(bytes), undecryptable: 0, partitioned: 0, warnings: [] };
}

export async function readCookies(source: IVoltCookieSource, env: ICookieReaderEnv = defaultReaderEnv()): Promise<IReadResult> {
	switch (source.browser) {
		case 'safari':
			return readSafari(source);
		case 'firefox':
		case 'zen':
			return readFirefox(source);
		default:
			return readChromium(source, env);
	}
}
