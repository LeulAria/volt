/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { chromiumSameSite, chromiumTimeToUnix, firefoxExpiryToUnix, IReadCookie, isPreviewPartition, macTimeToUnix, matchesDomainFilter, parseBinaryCookies, parseChromiumProfileNames, parseDomainFilter, parseFirefoxProfilesIni, siteOf, toElectronCookie } from '../../common/browserCookies.js';

interface ISafariCookie {
	readonly domain: string;
	readonly name: string;
	readonly path: string;
	readonly value: string;
	readonly flags: number;
	/** Unix seconds. */
	readonly expires: number;
}

/** Writes Safari's Cookies.binarycookies layout, the way Safari does, to test the reader. */
export function encodeBinaryCookies(pages: readonly (readonly ISafariCookie[])[]): Uint8Array {
	const encoder = new TextEncoder();
	const pageBytes = pages.map(cookies => {
		const records = cookies.map(cookie => {
			const strings = [cookie.domain, cookie.name, cookie.path, cookie.value].map(value => [...encoder.encode(value), 0]);
			const size = 56 + strings.reduce((sum, bytes) => sum + bytes.length, 0);
			const record = new Uint8Array(size);
			const view = new DataView(record.buffer);
			view.setUint32(0, size, true);
			view.setUint32(8, cookie.flags, true);
			let offset = 56;
			strings.forEach((bytes, index) => {
				view.setUint32(16 + index * 4, offset, true);
				record.set(bytes, offset);
				offset += bytes.length;
			});
			view.setFloat64(40, cookie.expires - 978_307_200, true);
			view.setFloat64(48, 0, true);
			return record;
		});
		const header = 8 + records.length * 4 + 4;
		const size = header + records.reduce((sum, record) => sum + record.length, 0);
		const page = new Uint8Array(size);
		const view = new DataView(page.buffer);
		view.setUint32(0, 0x00000100);
		view.setUint32(4, records.length, true);
		let offset = header;
		records.forEach((record, index) => {
			view.setUint32(8 + index * 4, offset, true);
			page.set(record, offset);
			offset += record.length;
		});
		return page;
	});
	const total = 8 + pageBytes.length * 4 + pageBytes.reduce((sum, page) => sum + page.length, 0) + 8;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	out.set(encoder.encode('cook'), 0);
	view.setUint32(4, pageBytes.length);
	pageBytes.forEach((page, index) => view.setUint32(8 + index * 4, page.length));
	let offset = 8 + pageBytes.length * 4;
	for (const page of pageBytes) {
		out.set(page, offset);
		offset += page.length;
	}
	return out;
}

function cookie(overrides: Partial<IReadCookie>): IReadCookie {
	return { host: '.example.com', name: 'sid', value: 'v', path: '/', secure: true, httpOnly: false, expires: 2_000_000_000, sameSite: 'lax', ...overrides };
}

suite('Volt browser: cookie import', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Safari binarycookies: pages, flags, strings and expiry', () => {
		const bytes = encodeBinaryCookies([
			[
				{ domain: '.github.com', name: 'logged_in', path: '/', value: 'yes', flags: 1 | 4, expires: 1_900_000_000 },
				{ domain: 'app.example.com', name: 'pref', path: '/settings', value: 'dark mode', flags: 0, expires: 1_800_000_000 },
			],
			[{ domain: '.apple.com', name: 'geo', path: '/', value: 'US', flags: 1, expires: 1_700_000_000 }],
		]);
		const cookies = parseBinaryCookies(bytes);
		assert.deepStrictEqual(cookies, [
			{ host: '.github.com', name: 'logged_in', value: 'yes', path: '/', secure: true, httpOnly: true, expires: 1_900_000_000, sameSite: 'unspecified' },
			{ host: 'app.example.com', name: 'pref', value: 'dark mode', path: '/settings', secure: false, httpOnly: false, expires: 1_800_000_000, sameSite: 'unspecified' },
			{ host: '.apple.com', name: 'geo', value: 'US', path: '/', secure: true, httpOnly: false, expires: 1_700_000_000, sameSite: 'unspecified' },
		]);
		assert.throws(() => parseBinaryCookies(new TextEncoder().encode('SQLite format 3')), /Not a Safari cookie file/);
	});

	test('time conversions: Chromium 1601 microseconds, Safari 2001 seconds, Firefox seconds or ms', () => {
		assert.strictEqual(chromiumTimeToUnix('13390000000000000'), 1_745_526_400);
		assert.strictEqual(chromiumTimeToUnix(0), undefined);
		assert.strictEqual(macTimeToUnix(0), undefined);
		assert.strictEqual(macTimeToUnix(700_000_000), 1_678_307_200);
		assert.strictEqual(firefoxExpiryToUnix(1_900_000_000), 1_900_000_000);
		assert.strictEqual(firefoxExpiryToUnix(1_900_000_000_123), 1_900_000_000);
		assert.strictEqual(chromiumSameSite(-1), 'unspecified');
		assert.strictEqual(chromiumSameSite(0), 'no_restriction');
		assert.strictEqual(chromiumSameSite(2), 'strict');
	});

	test('domain filter: parses loose input and matches subdomains and parent domain cookies', () => {
		assert.deepStrictEqual(parseDomainFilter(' https://GitHub.com/login, vercel.app;*.example.org  localhost:3000 bad_host! '), ['github.com', 'vercel.app', 'example.org', 'localhost']);
		assert.deepStrictEqual(parseDomainFilter(''), []);
		const filter = ['github.com', 'mail.google.com'];
		assert.ok(matchesDomainFilter('.github.com', filter));
		assert.ok(matchesDomainFilter('api.github.com', filter));
		assert.ok(!matchesDomainFilter('notgithub.com', filter));
		// A cookie set for all of google.com is sent to mail.google.com, so it belongs to that site.
		assert.ok(matchesDomainFilter('.google.com', filter));
		assert.ok(!matchesDomainFilter('docs.google.com', filter));
		assert.ok(matchesDomainFilter('anything.dev', []));
	});

	test('Electron cookie details: host-only vs domain, prefixes, SameSite=None needs Secure, expired skipped', () => {
		assert.deepStrictEqual(toElectronCookie(cookie({}), 1_000), { url: 'https://example.com/', name: 'sid', value: 'v', domain: '.example.com', path: '/', secure: true, httpOnly: false, expirationDate: 2_000_000_000, sameSite: 'lax' });
		const hostOnly = toElectronCookie(cookie({ host: 'app.example.com', secure: false, path: '/x' }), 1_000);
		assert.ok(!('skip' in hostOnly));
		assert.strictEqual(hostOnly.domain, undefined);
		assert.strictEqual(hostOnly.url, 'http://app.example.com/x');
		assert.deepStrictEqual(toElectronCookie(cookie({ expires: 500 }), 1_000), { skip: 'expired' });
		assert.deepStrictEqual(toElectronCookie(cookie({ name: '__Host-id', host: '.example.com' }), 1_000), { skip: 'invalid __Host- cookie' });
		const hostPrefixed = toElectronCookie(cookie({ name: '__Host-id', host: 'example.com' }), 1_000);
		assert.ok(!('skip' in hostPrefixed) && hostPrefixed.domain === undefined);
		const none = toElectronCookie(cookie({ sameSite: 'no_restriction', secure: false }), 1_000);
		assert.ok(!('skip' in none) && none.sameSite === 'unspecified');
		const securePrefix = toElectronCookie(cookie({ name: '__Secure-x', secure: false }), 1_000);
		assert.ok(!('skip' in securePrefix) && securePrefix.secure && securePrefix.url.startsWith('https://'));
		const session = toElectronCookie(cookie({ expires: undefined }), 1_000);
		assert.ok(!('skip' in session) && session.expirationDate === undefined);
	});

	test('profiles: Chromium Local State names and Firefox profiles.ini', () => {
		const names = parseChromiumProfileNames(JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } } } }));
		assert.deepStrictEqual([...names], [['Default', 'Personal'], ['Profile 1', 'Work']]);
		assert.strictEqual(parseChromiumProfileNames('{').size, 0);
		const ini = '[Install4F96D1932A9F858E]\nDefault=Profiles/abc.default-release\n\n[Profile1]\nName=default\nIsRelative=1\nPath=Profiles/xyz.default\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\nDefault=1\n\n[Profile2]\nName=Elsewhere\nIsRelative=0\nPath=/data/ff\n';
		assert.deepStrictEqual(parseFirefoxProfilesIni(ini), [
			{ name: 'default-release', path: 'Profiles/abc.default-release', relative: true, isDefault: true },
			{ name: 'default', path: 'Profiles/xyz.default', relative: true, isDefault: false },
			{ name: 'Elsewhere', path: '/data/ff', relative: false, isDefault: false },
		]);
	});

	test('only preview browser partitions take imported cookies', () => {
		assert.ok(isPreviewPartition('persist:volt-browser'));
		assert.ok(isPreviewPartition('persist:volt-browser-work'));
		assert.ok(!isPreviewPartition(''));
		assert.ok(!isPreviewPartition('persist:vscode-webview'));
		assert.ok(!isPreviewPartition('persist:volt-browser-../../x'));
		assert.strictEqual(siteOf('.mail.google.com'), 'google.com');
	});
});
