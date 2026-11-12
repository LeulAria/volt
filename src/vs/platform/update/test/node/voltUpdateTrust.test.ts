/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as crypto from 'crypto';
import { verifyEd25519 } from '../../../../base/node/voltEd25519.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { checkVoltFeedTrust, decideVoltUpdate, IVoltFeedEntry, IVoltFeedTrust, IVoltSignedFeedFields, VoltReleaseChannel, voltFeedSigningMessage } from '../../common/voltUpdateFeed.js';

/** INV-28: the signed update feed (SUP-1..3), and unchanged behaviour when product.json pins no keys. */
suite('Volt update feed signature', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const now = Date.parse('2026-11-08T00:00:00Z');
	const day = 24 * 60 * 60 * 1000;

	const keys = {
		stable: crypto.generateKeyPairSync('ed25519'),
		beta: crypto.generateKeyPairSync('ed25519'),
		nightly: crypto.generateKeyPairSync('ed25519'),
	};
	const publicKey = (channel: VoltReleaseChannel) => keys[channel].publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
	const publicKeys = { stable: publicKey('stable'), beta: publicKey('beta'), nightly: publicKey('nightly') };

	const entry: IVoltFeedEntry = {
		version: '0.0.3',
		productVersion: '0.0.3',
		commit: 'ccccccc',
		timestamp: Date.parse('2026-11-07T00:00:00Z'),
		url: 'https://github.com/LeulAria/VOLT/releases/download/v0.0.3/volt-stable-0.0.3-darwin-arm64.zip',
		sha256hash: 'abc',
		downloadUrl: 'https://github.com/LeulAria/VOLT/releases/download/v0.0.3/volt-stable-0.0.3-darwin-arm64.dmg',
		releaseUrl: 'https://github.com/LeulAria/VOLT/releases/tag/v0.0.3',
	};

	function sign(value: object, signer: VoltReleaseChannel, fields: IVoltSignedFeedFields = {}): IVoltFeedEntry & IVoltSignedFeedFields {
		const unsigned = { ...value, channel: signer, platform: 'darwin-arm64', feedVersion: now - day, expires: now + 30 * day, ...fields };
		const signature = crypto.sign(null, Buffer.from(voltFeedSigningMessage(unsigned), 'utf8'), keys[signer].privateKey).toString('base64');
		return { ...unsigned, signature } as IVoltFeedEntry & IVoltSignedFeedFields;
	}

	function trust(overrides: Partial<IVoltFeedTrust> = {}): IVoltFeedTrust {
		return {
			publicKeys,
			verify: (message, signature, key) => verifyEd25519(message, Buffer.from(signature, 'base64'), key),
			now,
			installed: { version: '0.0.2', channel: 'stable' },
			...overrides,
		};
	}

	function refusal(value: unknown, channel: VoltReleaseChannel, overrides: Partial<IVoltFeedTrust> = {}): string {
		const result = checkVoltFeedTrust(value, channel, trust(overrides));
		assert.strictEqual(result.trusted, false, 'expected the feed to be refused');
		return result.trusted ? '' : result.reason;
	}

	test('accepts an entry signed by the channel key, as written by build/volt/release/feedSigning.mjs', () => {
		// Written by feedSigning.mjs signFeedEntry (expires in 2126), so the two canonical forms must agree.
		const fixtureKey = 'MCowBQYDK2VwAyEAhBwiuZYvUG3IhtQMbaaskUfOaaW+ktyfg0jQtA5gd40=';
		const fixture = {
			version: '0.0.3',
			productVersion: '0.0.3',
			commit: 'ccccccc',
			timestamp: 1791417600000,
			url: 'https://github.com/LeulAria/VOLT/releases/download/v0.0.3/volt-stable-0.0.3-darwin-arm64.zip',
			sha256hash: 'abc',
			size: 123,
			downloadUrl: 'https://github.com/LeulAria/VOLT/releases/download/v0.0.3/volt-stable-0.0.3-darwin-arm64.dmg',
			releaseUrl: 'https://github.com/LeulAria/VOLT/releases/tag/v0.0.3',
			// allow-any-unicode-next-line
			notes: 'café ✓ "quoted"',
			channel: 'stable',
			platform: 'darwin-arm64',
			feedVersion: 1791417600000,
			expires: 4945017600000,
			signature: 'l5jjH7kUYMXGKXF6fo4S/xGUyh0R4vuzXrPkgAjXGCaNc8PSBJyMXajQ72ZX418YgjogqJy0OssDITrKpjQVCQ==',
		};
		assert.deepStrictEqual(checkVoltFeedTrust(fixture, 'stable', trust({ publicKeys: { stable: fixtureKey } })), { trusted: true, verified: true, feedVersion: 1791417600000 });
		assert.strictEqual(checkVoltFeedTrust({ ...fixture, notes: 'changed' }, 'stable', trust({ publicKeys: { stable: fixtureKey } })).trusted, false);
		assert.deepStrictEqual(checkVoltFeedTrust(sign(entry, 'stable'), 'stable', trust()), { trusted: true, verified: true, feedVersion: now - day });
	});

	test('SUP-1: an unsigned or tampered feed is refused when keys are pinned', () => {
		assert.match(refusal(entry, 'stable'), /not signed/);
		assert.match(refusal({ ...entry, signature: '' }, 'stable'), /not signed/);
		const signed = sign(entry, 'stable');
		assert.match(refusal({ ...signed, url: 'https://evil.example/volt.zip' }, 'stable'), /signature is not valid/);
		assert.match(refusal({ ...signed, sha256hash: 'def' }, 'stable'), /signature is not valid/);
		assert.match(refusal({ ...signed, signature: Buffer.alloc(64).toString('base64') }, 'stable'), /signature is not valid/);
		assert.match(refusal(signed, 'stable', { publicKeys: { beta: publicKeys.beta } }), /No update feed key is pinned for the stable channel/);
		assert.match(refusal('nope', 'stable'), /not an object/);
	});

	test('SUP-2: a signature by another channel\'s key, or an entry published for another channel, is refused', () => {
		const nightlyOnStable = sign({ ...entry, version: '0.0.4-nightly.202611080300' }, 'nightly');
		assert.match(refusal(nightlyOnStable, 'stable'), /signed with the nightly channel's key/);
		// The stable key signing an entry that says nightly (a misused key) is refused too.
		const relabelled = sign(entry, 'stable', { channel: 'nightly' });
		assert.match(refusal(relabelled, 'stable'), /published for nightly/);
		// The same entry is fine on its own channel.
		assert.strictEqual(checkVoltFeedTrust(nightlyOnStable, 'nightly', trust()).trusted, true);
	});

	test('SUP-3: rollback below the installed version, an older feed and an expired feed are refused', () => {
		assert.match(refusal(sign({ ...entry, version: '0.0.1' }, 'stable'), 'stable', { installed: { version: '0.0.2', channel: 'stable' } }), /below the installed 0\.0\.2/);
		assert.match(refusal(sign({ ...entry, version: '0.0.2-nightly.202611010300' }, 'nightly'), 'nightly', { installed: { version: '0.0.2-nightly.202611050300', channel: 'nightly' } }), /below the installed/);
		// The same version (a re-published build) is not a rollback.
		assert.strictEqual(checkVoltFeedTrust(sign({ ...entry, version: '0.0.2' }, 'stable'), 'stable', trust()).trusted, true);
		// Another channel is a separate app: its version isn't compared with this build's.
		assert.strictEqual(checkVoltFeedTrust(sign({ ...entry, version: '0.0.1-beta.1' }, 'beta'), 'beta', trust()).trusted, true);
		assert.match(refusal(sign(entry, 'stable', { feedVersion: now - 2 * day }), 'stable', { lastFeedVersion: now - day }), /older than one already seen/);
		assert.match(refusal(sign(entry, 'stable', { expires: now - 1 }), 'stable'), /expired/);
		assert.match(refusal(sign(entry, 'stable', { expires: undefined }), 'stable'), /no expiry/);
		assert.match(refusal(sign(entry, 'stable', { feedVersion: undefined }), 'stable'), /no version/);
	});

	test('without pinned keys the feed is read as before', () => {
		const current = { commit: 'aaaaaaa', date: '2026-11-06T00:00:00Z', quality: 'stable' };
		for (const publicKeys of [undefined, {}, { stable: '' }, { stable: [] }]) {
			const unpinned = trust({ publicKeys, verify: () => assert.fail('nothing is verified without pinned keys') });
			assert.deepStrictEqual(checkVoltFeedTrust(entry, 'stable', unpinned), { trusted: true, verified: false });
			assert.deepStrictEqual(checkVoltFeedTrust(sign({ ...entry, version: '0.0.1' }, 'nightly'), 'stable', unpinned), { trusted: true, verified: false });
		}
		assert.deepStrictEqual(decideVoltUpdate(entry, current, 'stable', undefined), {
			version: 'ccccccc',
			productVersion: '0.0.3',
			timestamp: entry.timestamp,
			url: entry.url,
			sha256hash: 'abc',
			voltChannel: undefined,
			releaseUrl: entry.releaseUrl,
			downloadUrl: entry.downloadUrl,
			notes: undefined,
			size: undefined
		});
		// Signed entries still work for builds that don't pin keys (old clients ignore the new fields).
		assert.strictEqual(decideVoltUpdate(sign(entry, 'stable'), current, 'stable', undefined)?.url, entry.url);
	});

	test('downloadUrl and releaseUrl must be https', () => {
		const current = { commit: 'aaaaaaa', date: '2026-11-06T00:00:00Z', quality: 'stable' };
		assert.strictEqual(decideVoltUpdate({ ...entry, downloadUrl: 'http://example.com/volt.dmg' }, current, 'stable', undefined), undefined);
		assert.strictEqual(decideVoltUpdate({ ...entry, releaseUrl: 'javascript:alert(1)' }, current, 'stable', undefined), undefined);
		assert.ok(decideVoltUpdate({ ...entry, downloadUrl: undefined, releaseUrl: undefined }, current, 'stable', undefined));
	});
});
