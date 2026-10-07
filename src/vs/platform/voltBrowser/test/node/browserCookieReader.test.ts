/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import type { Database } from '@vscode/sqlite3';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { chromiumPosixKey, decryptChromiumPosix, decryptChromiumWindows, ICookieReaderEnv, listCookieSources, readCookies } from '../../node/browserCookieReader.js';

function encryptPosix(value: string, host: string, password: string, iterations: number, dbVersion: number): Buffer {
	const cipher = createCipheriv('aes-128-cbc', chromiumPosixKey(password, iterations), Buffer.alloc(16, 0x20));
	const plain = dbVersion >= 24 ? Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)]) : Buffer.from(value);
	return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
}

async function createDb(file: string, statements: readonly [string, unknown[]][]): Promise<void> {
	const sqlite3 = (await import('@vscode/sqlite3')).default;
	const db = await new Promise<Database>((resolve, reject) => {
		const opened: Database = new sqlite3.Database(file, sqlite3.OPEN_CREATE | sqlite3.OPEN_READWRITE, error => error ? reject(error) : resolve(opened));
	});
	for (const [sql, params] of statements) {
		await new Promise<void>((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
	}
	await new Promise<void>(resolve => db.close(() => resolve()));
}

const CHROMIUM_SCHEMA = 'CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, samesite INTEGER NOT NULL)';
const CHROMIUM_INSERT = 'INSERT INTO cookies VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

suite('Volt browser: cookie reader', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let home: string;

	setup(async () => {
		home = join(tmpdir(), `volt-cookie-test-${randomBytes(6).toString('hex')}`);
		await fs.mkdir(home, { recursive: true });
	});

	teardown(async () => {
		await fs.rm(home, { recursive: true, force: true });
	});

	test('Chromium v10 values decrypt and drop the host hash from database version 24', () => {
		const key = chromiumPosixKey('peanuts', 1);
		assert.strictEqual(decryptChromiumPosix(encryptPosix('token=abc', '.github.com', 'peanuts', 1, 24), key, 24), 'token=abc');
		assert.strictEqual(decryptChromiumPosix(encryptPosix('old', 'x.com', 'peanuts', 1, 18), key, 18), 'old');
		// macOS: the Keychain password with 1003 rounds.
		const mac = chromiumPosixKey('s3cr3t==', 1003);
		assert.strictEqual(decryptChromiumPosix(encryptPosix('v', 'a.dev', 's3cr3t==', 1003, 24), mac, 24), 'v');
		assert.throws(() => decryptChromiumPosix(encryptPosix('v', 'a.dev', 'other', 1003, 24), mac, 24));
	});

	test('Windows v10 values decrypt with AES-256-GCM', () => {
		const key = randomBytes(32);
		const nonce = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', key, nonce);
		const plain = Buffer.concat([createHash('sha256').update('.example.com').digest(), Buffer.from('hello')]);
		const encrypted = Buffer.concat([Buffer.from('v10'), nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
		assert.strictEqual(decryptChromiumWindows(encrypted, key, 24), 'hello');
	});

	test('finds Chrome and Firefox profiles and reads their cookies (Linux layout)', async () => {
		const env: ICookieReaderEnv = { platform: 'linux', home, env: {} };
		const chrome = join(home, '.config', 'google-chrome');
		await fs.mkdir(join(chrome, 'Default', 'Network'), { recursive: true });
		await fs.mkdir(join(chrome, 'Profile 2'), { recursive: true });
		await fs.writeFile(join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' } } } }));
		const expires = String((2_000_000_000 + 11_644_473_600) * 1_000_000);
		await createDb(join(chrome, 'Default', 'Network', 'Cookies'), [
			[CHROMIUM_SCHEMA, []],
			['CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)', []],
			[`INSERT INTO meta VALUES ('version', '24')`, []],
			[CHROMIUM_INSERT, ['.github.com', '', 'user_session', '', encryptPosix('s-123', '.github.com', 'peanuts', 1, 24), '/', expires, 1, 1, 1]],
			[CHROMIUM_INSERT, ['localhost', '', 'plain', 'unencrypted', Buffer.alloc(0), '/', '0', 0, 0, -1]],
			[CHROMIUM_INSERT, ['embed.example', 'https://top.example', 'chips', '', encryptPosix('p', 'embed.example', 'peanuts', 1, 24), '/', expires, 1, 0, 0]],
			[CHROMIUM_INSERT, ['broken.example', '', 'bad', '', Buffer.from('v10garbage-garbage'), '/', expires, 1, 0, 0]],
		]);
		const firefox = join(home, '.mozilla', 'firefox');
		await fs.mkdir(join(firefox, 'abc.default-release'), { recursive: true });
		await fs.writeFile(join(firefox, 'profiles.ini'), '[Profile0]\nName=default-release\nIsRelative=1\nPath=abc.default-release\nDefault=1\n');
		await createDb(join(firefox, 'abc.default-release', 'cookies.sqlite'), [
			['CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT \'\', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)', []],
			['INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ['', 'ff', '1', '.mozilla.org', '/', 1_900_000_000_000, 1, 0, 1]],
			['INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ['^userContextId=2', 'container', '1', '.mozilla.org', '/', 1_900_000_000, 1, 0, 1]],
		]);

		const sources = await listCookieSources(env);
		assert.deepStrictEqual(sources.map(source => [source.id, source.browserLabel, source.profileLabel, source.encrypted]), [
			['chrome:Default', 'Google Chrome', 'Personal', true],
			['firefox:abc.default-release', 'Firefox', 'default-release', false],
		]);

		const chromeCookies = await readCookies(sources[0], env);
		assert.deepStrictEqual(chromeCookies.cookies, [
			{ host: '.github.com', name: 'user_session', value: 's-123', path: '/', secure: true, httpOnly: true, expires: 2_000_000_000, sameSite: 'lax' },
			{ host: 'localhost', name: 'plain', value: 'unencrypted', path: '/', secure: false, httpOnly: false, expires: undefined, sameSite: 'unspecified' },
		]);
		assert.strictEqual(chromeCookies.partitioned, 1);
		assert.strictEqual(chromeCookies.undecryptable, 1);

		const firefoxCookies = await readCookies(sources[1], env);
		assert.deepStrictEqual(firefoxCookies.cookies, [{ host: '.mozilla.org', name: 'ff', value: '1', path: '/', secure: true, httpOnly: false, expires: 1_900_000_000, sameSite: 'lax' }]);
		assert.strictEqual(firefoxCookies.partitioned, 1);

		// The source database is untouched: the reader works on a copy.
		const after = await fs.readdir(join(chrome, 'Default', 'Network'));
		assert.deepStrictEqual(after, ['Cookies']);
	});
});
