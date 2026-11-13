/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { X509Certificate, createPrivateKey } from 'crypto';
import { promises as fs } from 'fs';
import type * as http from 'http';
import { request as httpRequest } from 'http';
import { get as httpsGet } from 'https';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createAuthenticatedServer, createTlsListenerServer, hostAllowed, ListenerAuth, listenOn, loadOrCreateSecretFile, loopbackHostNames, originAllowed, secretsEqual, SourceRateLimiter } from '../../node/listenerAuth.js';
import { certificateFingerprint, fingerprintMatches, loadOrCreateListenerIdentity, PinMismatchError, pinnedRequest } from '../../node/listenerTls.js';

function fakeRequest(headers: http.IncomingHttpHeaders, method = 'GET', remoteAddress = '127.0.0.1', encrypted = false): http.IncomingMessage {
	return { headers, method, url: '/', socket: { remoteAddress, encrypted } } as unknown as http.IncomingMessage;
}

/** Node's HTTP client: unlike a page's fetch, it sends exactly the Host and Origin given (or none). */
function call(url: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(url, { method: init.method ?? 'GET', headers: init.headers }, res => {
			res.resume();
			res.on('end', () => resolve(res.statusCode ?? 0));
		});
		req.on('error', reject);
		req.end();
	});
}

suite('Volt listener library (INV-07)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('secrets compare in constant time and never match empty or missing values', () => {
		assert.ok(secretsEqual('abc', 'abc'));
		assert.ok(!secretsEqual('abd', 'abc'));
		assert.ok(!secretsEqual('abc', 'abcd'));
		assert.ok(!secretsEqual(undefined, 'abc'));
		assert.ok(!secretsEqual('', ''));
		assert.ok(!secretsEqual('x'.repeat(5000), 'x'.repeat(5000)), 'oversized input is refused');
	});

	test('the bearer file is created 0600 and narrowed to 0600 when looser', async function () {
		const dir = await fs.mkdtemp(join(tmpdir(), 'volt-listener-'));
		try {
			const file = join(dir, 'nested', 'token');
			const secret = await loadOrCreateSecretFile(file);
			assert.ok(secret.length >= 43);
			assert.strictEqual(await loadOrCreateSecretFile(file), secret, 'kept across launches');
			if (process.platform !== 'win32') {
				assert.strictEqual((await fs.stat(file)).mode & 0o777, 0o600);
				await fs.chmod(file, 0o644);
				await loadOrCreateSecretFile(file);
				assert.strictEqual((await fs.stat(file)).mode & 0o777, 0o600);
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('the Host allow list refuses rebound names and accepts listed names and (when asked) IP literals', () => {
		const loopback = { names: loopbackHostNames(4000) };
		assert.ok(hostAllowed('127.0.0.1:4000', loopback));
		assert.ok(hostAllowed('localhost:4000', loopback));
		assert.ok(hostAllowed('[::1]:4000', loopback));
		assert.ok(!hostAllowed('127.0.0.1:4001', loopback), 'another port');
		assert.ok(!hostAllowed('evil.example:4000', loopback), 'a DNS-rebound name');
		assert.ok(!hostAllowed('127.0.0.1.nip.io:4000', loopback));
		assert.ok(!hostAllowed(undefined, loopback));
		assert.ok(!hostAllowed('a@127.0.0.1:4000', loopback));
		const network = { names: ['my-mac.local'], anyIpLiteral: true, suffixes: ['.ts.net'] };
		assert.ok(hostAllowed('192.168.1.20:4002', network));
		assert.ok(hostAllowed('[fe80::1]:4002', network));
		assert.ok(hostAllowed('my-mac.local:4002', network));
		assert.ok(hostAllowed('box.tail1234.ts.net', network));
		assert.ok(!hostAllowed('ts.net', network));
		assert.ok(!hostAllowed('attacker.example', network));
	});

	test('a missing Origin is never taken for the listener\'s own origin', () => {
		assert.ok(!originAllowed(fakeRequest({ host: '127.0.0.1:4000' }), ['self']));
		assert.ok(!originAllowed(fakeRequest({ host: '127.0.0.1:4000', origin: 'null' }), ['self']));
		assert.ok(originAllowed(fakeRequest({ host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000' }), ['self']));
		assert.ok(!originAllowed(fakeRequest({ host: '127.0.0.1:4000', origin: 'https://127.0.0.1:4000' }), ['self']), 'scheme counts');
		assert.ok(originAllowed(fakeRequest({ host: '10.0.0.2:4002', origin: 'https://10.0.0.2:4002' }, 'POST', '10.0.0.3', true), ['self']));
		assert.ok(!originAllowed(fakeRequest({ host: '127.0.0.1:4000', origin: 'http://evil.example' }), ['self']));
		assert.ok(originAllowed(fakeRequest({ origin: 'vscode-file://vscode-app' }), ['vscode-file://vscode-app']));
	});

	test('failures are limited per source: one source over its limit leaves the others alone', () => {
		let now = 1_000_000;
		const limiter = new SourceRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
		limiter.fail('10.0.0.5');
		limiter.fail('10.0.0.5');
		assert.ok(!limiter.blocked('10.0.0.5'));
		assert.ok(limiter.fail('10.0.0.5'));
		assert.ok(limiter.blocked('10.0.0.5'));
		assert.ok(!limiter.blocked('10.0.0.6'));
		assert.ok(limiter.retryAfter('10.0.0.5') > 0);
		now += 60_001;
		assert.ok(!limiter.blocked('10.0.0.5'), 'the window passes');
		const bounded = new SourceRateLimiter({ limit: 1, windowMs: 60_000, maxSources: 2, now: () => now });
		bounded.fail('a');
		bounded.fail('b');
		bounded.fail('c');
		assert.ok(!bounded.blocked('a'), 'the oldest source is forgotten past the bound');
		assert.ok(bounded.blocked('c'));
	});

	test('an authenticated server answers only with the secret, an allowed Host and (for writes by URL secret) the Origin', async () => {
		let port = 0;
		const auth = new ListenerAuth<true>({
			hosts: () => ({ names: loopbackHostNames(port) }),
			extract: req => {
				const secret = new URL(req.url ?? '/', 'http://x').searchParams.get('s');
				return secret ? { secret, via: 'query' } : undefined;
			},
			verify: secret => secretsEqual(secret, 'the-secret') || undefined,
			browserOrigins: ['self'],
		});
		const server = createAuthenticatedServer(auth, (_req, res) => res.end('ok'));
		port = await listenOn(server, 0);
		const base = `http://127.0.0.1:${port}`;
		try {
			assert.strictEqual(await call(`${base}/`), 401, 'no secret');
			assert.strictEqual(await call(`${base}/`, { headers: { Authorization: 'Bearer forged' } }), 401, 'forged secret');
			assert.strictEqual(await call(`${base}/`, { headers: { Authorization: 'Bearer the-secret' } }), 200);
			assert.strictEqual(await call(`${base}/`, { headers: { Authorization: 'Bearer the-secret', Host: `evil.example:${port}` } }), 403, 'forged Host');
			assert.strictEqual(await call(`${base}/?s=the-secret`), 200);
			assert.strictEqual(await call(`${base}/?s=the-secret`, { method: 'POST' }), 403, 'a URL secret writes only with the Origin');
			assert.strictEqual(await call(`${base}/?s=the-secret`, { method: 'POST', headers: { Origin: 'http://evil.example' } }), 403);
			assert.strictEqual(await call(`${base}/?s=the-secret`, { method: 'POST', headers: { Origin: base } }), 200);
			assert.strictEqual(await call(`${base}/`, { method: 'POST', headers: { Authorization: 'Bearer the-secret' } }), 200, 'a bearer header can\'t be forged cross-site');
		} finally {
			await new Promise(resolve => server.close(resolve));
		}
	});

	test('the TLS identity is a valid self-signed certificate, kept 0600, pinned by its SHA-256', async function () {
		this.timeout(20_000);
		const dir = await fs.mkdtemp(join(tmpdir(), 'volt-tls-'));
		try {
			const identity = await loadOrCreateListenerIdentity(dir, 'Volt test');
			const x509 = new X509Certificate(identity.cert);
			assert.ok(x509.checkPrivateKey(createPrivateKey(identity.key)));
			assert.ok(x509.verify(x509.publicKey), 'self-signed');
			assert.match(x509.subject, /CN=Volt test/);
			assert.ok(Date.parse(x509.validTo) > Date.now() + 365 * 24 * 60 * 60 * 1000);
			assert.strictEqual(identity.fingerprint, certificateFingerprint(x509.raw));
			assert.match(identity.fingerprint, /^[A-Za-z0-9_-]{43}$/);
			assert.ok(fingerprintMatches(x509.raw, identity.fingerprint));
			assert.ok(!fingerprintMatches(x509.raw, 'A'.repeat(43)));
			assert.strictEqual((await loadOrCreateListenerIdentity(dir)).fingerprint, identity.fingerprint, 'the same certificate next launch');
			if (process.platform !== 'win32') {
				assert.strictEqual((await fs.stat(join(dir, 'tls-key.pem'))).mode & 0o777, 0o600);
			}

			const server = createTlsListenerServer(identity, (req, res) => res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`pinned ${req.headers.host}`));
			const port = await listenOn(server, 0);
			try {
				const response = await pinnedRequest(`https://127.0.0.1:${port}/x`, identity.fingerprint);
				assert.strictEqual(response.status, 200);
				assert.strictEqual(response.body, `pinned 127.0.0.1:${port}`, 'the Host is the URL\'s own');
				await assert.rejects(pinnedRequest(`https://127.0.0.1:${port}/x`, 'B'.repeat(43)), PinMismatchError, 'another certificate is refused before anything is sent');
				// A client with only the system's trust store refuses the self-signed certificate.
				await assert.rejects(new Promise((resolve, reject) => httpsGet(`https://127.0.0.1:${port}/x`, resolve).on('error', reject)));
			} finally {
				await new Promise(resolve => server.close(resolve));
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
