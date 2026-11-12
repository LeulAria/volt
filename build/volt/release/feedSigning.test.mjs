/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// node --test build/volt/release/feedSigning.test.mjs

import assert from 'node:assert';
import * as crypto from 'node:crypto';
import { test } from 'node:test';
import { canonicalJson, feedSigningKeyFromEnv, publicKeyBase64, signFeedEntry, signingMessage, verifyFeedEntry } from './feedSigning.mjs';

const entry = {
	version: '0.0.2',
	productVersion: '0.0.2',
	commit: 'bbbbbbb',
	timestamp: 1791417600000,
	url: 'https://github.com/LeulAria/VOLT/releases/download/v0.0.2/volt-stable-0.0.2-darwin-arm64.zip',
	sha256hash: 'abc',
	// allow-any-unicode-next-line
	notes: 'café ✓',
};

test('canonical JSON sorts keys at every depth and drops undefined', () => {
	assert.strictEqual(canonicalJson({ b: 1, a: { d: [1, { z: true, y: null }], c: 'x' }, u: undefined }), '{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":1}');
	assert.throws(() => canonicalJson({ n: NaN }));
});

test('a signed entry verifies with its key and no other', () => {
	const { privateKey } = crypto.generateKeyPairSync('ed25519');
	const other = crypto.generateKeyPairSync('ed25519').privateKey;
	const signed = signFeedEntry(entry, { channel: 'stable', platform: 'darwin-arm64', key: privateKey, now: 1000, expiryDays: 1 });
	assert.deepStrictEqual([signed.channel, signed.platform, signed.feedVersion, signed.expires], ['stable', 'darwin-arm64', 1000, 1000 + 86400000]);
	assert.ok(verifyFeedEntry(signed, publicKeyBase64(privateKey)));
	assert.ok(!verifyFeedEntry(signed, publicKeyBase64(other)));
	assert.ok(!verifyFeedEntry({ ...signed, url: 'https://evil.example/volt.zip' }, publicKeyBase64(privateKey)));
	assert.ok(!verifyFeedEntry(entry, publicKeyBase64(privateKey)));
	// Field order doesn't matter, the signature field isn't signed.
	assert.strictEqual(signingMessage(Object.fromEntries(Object.entries(signed).reverse())), signingMessage(signed));
});

test('the signing key comes from the channel secret or the shared one', () => {
	const { privateKey } = crypto.generateKeyPairSync('ed25519');
	const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
	const der = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
	assert.strictEqual(feedSigningKeyFromEnv('stable', {}), undefined);
	assert.strictEqual(publicKeyBase64(feedSigningKeyFromEnv('beta', { VOLT_FEED_SIGNING_KEY_BETA: pem })), publicKeyBase64(privateKey));
	assert.strictEqual(publicKeyBase64(feedSigningKeyFromEnv('beta', { VOLT_FEED_SIGNING_KEY: der })), publicKeyBase64(privateKey));
	const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
	assert.throws(() => feedSigningKeyFromEnv('stable', { VOLT_FEED_SIGNING_KEY: rsa }), /Ed25519/);
});
