/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { VOLT_LOCAL_SESSION_PATH, VOLT_PAIR_PATH, VOLT_REFRESH_PATH } from '../../../platform/voltAgentServer/common/protocol.js';
import { DEVICE_TOKEN_TTL_MS, IPairingHttpContext, LOCAL_NONCE_TTL_MS, REFRESH_GRACE_MS, ServerPairing } from '../../node/voltAgent/serverPairing.js';

interface IResponse {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

/** Node's HTTP client: unlike a page's fetch, it sends exactly the Host and Origin given (or none). */
function call(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<IResponse> {
	return new Promise((resolve, reject) => {
		const body = init.body === undefined ? undefined : JSON.stringify(init.body);
		const req = http.request(url, { method: init.method ?? 'GET', headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {}), ...init.headers } }, res => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', chunk => text += chunk);
			res.on('end', () => {
				let parsed: Record<string, unknown> = {};
				try {
					parsed = JSON.parse(text);
				} catch {
					// not JSON
				}
				resolve({ status: res.statusCode ?? 0, body: parsed });
			});
		});
		req.on('error', reject);
		req.end(body);
	});
}

suite('Agent server pairing: local nonce, expiring tokens, per-source limits', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let dir: string;
	let now: number;
	let pairing: ServerPairing;
	const servers: http.Server[] = [];

	setup(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'volt-pairing-'));
		now = 1_800_000_000_000;
		pairing = store.add(await ServerPairing.load(dir, new NullLogService(), () => now));
	});

	teardown(async () => {
		await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
		await fs.rm(dir, { recursive: true, force: true });
	});

	/** Serves the pairing routes on loopback like the agent server's own listener. */
	async function serve(extra: Partial<IPairingHttpContext> = {}): Promise<{ base: string; port: number }> {
		let ctx: IPairingHttpContext = { port: 0, network: false, serverVersion: 'test', ...extra };
		const server = http.createServer((req, res) => void pairing.handleHttp(req, res, ctx));
		servers.push(server);
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as AddressInfo).port;
		ctx = { ...ctx, port };
		return { base: `http://127.0.0.1:${port}`, port };
	}

	test('the local sign-in nonce is single use and expires after 60 s', () => {
		const first = pairing.createLocalNonce();
		assert.match(first.nonce, /^[A-Za-z0-9_-]{43}$/);
		assert.strictEqual(first.expiresAt, now + LOCAL_NONCE_TTL_MS);
		assert.ok(pairing.consumeLocalNonce(first.nonce), 'spent once');
		assert.ok(!pairing.consumeLocalNonce(first.nonce), 'never twice');

		const late = pairing.createLocalNonce();
		now += LOCAL_NONCE_TTL_MS;
		assert.ok(!pairing.consumeLocalNonce(late.nonce), 'not after its minute');

		const almost = pairing.createLocalNonce();
		now += LOCAL_NONCE_TTL_MS - 1;
		assert.ok(pairing.consumeLocalNonce(almost.nonce), 'within its minute');

		assert.ok(!pairing.consumeLocalNonce('A'.repeat(43)), 'a forged nonce');
		assert.ok(!pairing.consumeLocalNonce(undefined));
		assert.ok(!pairing.consumeLocalNonce({ nonce: 'x' }));
	});

	test('LST-1: the CVE-2026-82533 replay (POST /api/auth/local from a local process, no Origin, no nonce) gets 403', async () => {
		const { base, port } = await serve();
		const replay = await call(`${base}${VOLT_LOCAL_SESSION_PATH}`, { method: 'POST', headers: { Host: `127.0.0.1:${port}` } });
		assert.strictEqual(replay.status, 403);
		assert.strictEqual(replay.body.token, undefined);
		// Same with a page's Origin but no nonce, and with an empty body.
		assert.strictEqual((await call(`${base}${VOLT_LOCAL_SESSION_PATH}`, { method: 'POST', headers: { Origin: base }, body: {} })).status, 403);
		assert.strictEqual(pairing.list(new Set(), undefined).length, 0, 'no device was issued');
	});

	test('LST-2: a forged or replayed nonce gets 403; the real one signs the page in once', async () => {
		const { base } = await serve();
		const page = { method: 'POST', headers: { Origin: base } };
		assert.strictEqual((await call(`${base}${VOLT_LOCAL_SESSION_PATH}`, { ...page, body: { nonce: 'A'.repeat(43) } })).status, 403, 'forged');
		const { nonce } = pairing.createLocalNonce();
		const signedIn = await call(`${base}${VOLT_LOCAL_SESSION_PATH}`, { ...page, body: { nonce } });
		assert.strictEqual(signedIn.status, 200);
		assert.strictEqual(signedIn.body.role, 'owner');
		assert.ok(typeof signedIn.body.token === 'string' && pairing.authorize(signedIn.body.token as string, 'agent'));
		assert.strictEqual((await call(`${base}${VOLT_LOCAL_SESSION_PATH}`, { ...page, body: { nonce } })).status, 403, 'replayed');
	});

	test('LST-3/LST-4: with a valid nonce, a forged Host, a missing Origin, a foreign Origin or a tunnel still get 403', async () => {
		const { base, port } = await serve();
		const post = (headers: Record<string, string>) => call(`${base}${VOLT_LOCAL_SESSION_PATH}`, { method: 'POST', headers, body: { nonce: pairing.createLocalNonce().nonce } });
		assert.strictEqual((await post({ Host: `rebound.example:${port}`, Origin: `http://rebound.example:${port}` })).status, 403, 'DNS-rebound Host');
		assert.strictEqual((await post({})).status, 403, 'no Origin');
		assert.strictEqual((await post({ Origin: 'http://evil.example' })).status, 403, 'another site');
		assert.strictEqual((await post({ Origin: base })).status, 200, 'this server\'s own page');
		const tunnel = await serve({ viaTunnel: true });
		assert.strictEqual((await call(`${tunnel.base}${VOLT_LOCAL_SESSION_PATH}`, { method: 'POST', headers: { Origin: tunnel.base }, body: { nonce: pairing.createLocalNonce().nonce } })).status, 403, 'through a tunnel');
		const network = await serve({ viaNetwork: true });
		assert.strictEqual((await call(`${network.base}${VOLT_LOCAL_SESSION_PATH}`, { method: 'POST', headers: { Origin: network.base }, body: { nonce: pairing.createLocalNonce().nonce } })).status, 403, 'on the network listener');
	});

	test('REM-4: wrong pairing codes lock out only the address that sent them', async () => {
		const ctx: IPairingHttpContext = { port: 1, network: true, serverVersion: 'test' };
		const { code } = pairing.createCode(ctx);
		for (let i = 0; i < 12; i++) {
			await assert.rejects(pairing.pair({ code: 'WRONG123', client: { label: 'x', kind: 'mobile' } }, '192.168.1.66'), (err: { status?: number }) => err.status === 401);
		}
		await assert.rejects(pairing.pair({ code, client: { label: 'x', kind: 'mobile' } }, '192.168.1.66'), (err: { status?: number }) => err.status === 429, 'the attacker is locked out, even with the right code');
		const paired = await pairing.pair({ code, client: { label: 'Phone', kind: 'mobile' } }, '192.168.1.20');
		assert.ok(paired.token, 'another device on the network still pairs');
		now += 60_001;
		await assert.rejects(pairing.pair({ code: 'WRONG123', client: { label: 'x', kind: 'mobile' } }, '192.168.1.66'), (err: { status?: number }) => err.status === 401, 'the lockout lasts a minute');
	});

	test('REM-4 over HTTP: the pair route counts failures by the caller\'s address', async () => {
		const { base } = await serve();
		for (let i = 0; i < 12; i++) {
			assert.strictEqual((await call(`${base}${VOLT_PAIR_PATH}`, { method: 'POST', body: { code: 'WRONG123', client: { label: 'x', kind: 'mobile' } } })).status, 401);
		}
		assert.strictEqual((await call(`${base}${VOLT_PAIR_PATH}`, { method: 'POST', body: { code: 'WRONG123', client: { label: 'x', kind: 'mobile' } } })).status, 429);
	});

	test('REM-1: a device token expires, refreshes into a new one, and the old one stops after the grace minute', async () => {
		const { code } = pairing.createCode({ port: 1, network: false, serverVersion: 'test' });
		const paired = await pairing.pair({ code, client: { label: 'Phone', kind: 'mobile' } }, '10.0.0.2');
		assert.strictEqual(paired.expiresAt, now + DEVICE_TOKEN_TTL_MS);
		assert.ok(pairing.authorize(paired.token, 'agent'));

		now += DEVICE_TOKEN_TTL_MS - 1000;
		const refreshed = await pairing.refresh(paired.token);
		assert.ok(refreshed);
		assert.notStrictEqual(refreshed.token, paired.token);
		assert.strictEqual(refreshed.expiresAt, now + DEVICE_TOKEN_TTL_MS);
		assert.ok(pairing.authorize(paired.token), 'the old token works for the grace minute');
		assert.strictEqual(await pairing.refresh(paired.token), undefined, 'a superseded token can\'t refresh');
		now += REFRESH_GRACE_MS;
		assert.strictEqual(pairing.authorize(paired.token), undefined, 'then stops');
		assert.ok(pairing.authorize(refreshed.token, 'agent'));

		now += DEVICE_TOKEN_TTL_MS;
		assert.strictEqual(pairing.authorize(refreshed.token), undefined, 'an expired token is refused');
		assert.strictEqual(await pairing.refresh(refreshed.token), undefined, 'and can\'t be refreshed');
		assert.ok(!pairing.isActive(paired.deviceId), 'its connections are closed by the sweep');
	});

	test('REM-1 over HTTP: refresh needs a valid bearer', async () => {
		const { base } = await serve();
		const { code } = pairing.createCode({ port: 1, network: false, serverVersion: 'test' });
		const paired = await pairing.pair({ code, client: { label: 'Phone', kind: 'mobile' } });
		assert.strictEqual((await call(`${base}${VOLT_REFRESH_PATH}`, { method: 'POST' })).status, 401, 'no token');
		assert.strictEqual((await call(`${base}${VOLT_REFRESH_PATH}`, { method: 'POST', headers: { Authorization: 'Bearer forged' } })).status, 401, 'forged token');
		const refreshed = await call(`${base}${VOLT_REFRESH_PATH}`, { method: 'POST', headers: { Authorization: `Bearer ${paired.token}` } });
		assert.strictEqual(refreshed.status, 200);
		assert.ok(pairing.authorize(refreshed.body.token as string));
	});

	test('REM-2: a revoked device\'s token stops at once', async () => {
		const { code } = pairing.createCode({ port: 1, network: false, serverVersion: 'test' });
		const paired = await pairing.pair({ code, client: { label: 'Phone', kind: 'mobile' } });
		assert.ok(pairing.isActive(paired.deviceId));
		assert.ok(await pairing.revoke(paired.deviceId));
		assert.strictEqual(pairing.authorize(paired.token), undefined);
		assert.ok(!pairing.isActive(paired.deviceId));
		assert.strictEqual(await pairing.refresh(paired.token), undefined);
	});

	test('tokens are scoped: a usage-only token can\'t open the agent', async () => {
		const { code } = pairing.createCode({ port: 1, network: false, serverVersion: 'test' });
		const usage = await pairing.pair({ code, client: { label: 'Volt usage', kind: 'web' }, scope: 'usage' });
		assert.ok(pairing.authorize(usage.token, 'usage'));
		assert.strictEqual(pairing.authorize(usage.token, 'agent'), undefined);
	});

	test('tokens from before expiry keep working with a full term, and the file is migrated', async () => {
		const legacyDir = await fs.mkdtemp(join(tmpdir(), 'volt-pairing-legacy-'));
		try {
			const token = 'legacy-token-from-an-older-volt';
			await fs.writeFile(join(legacyDir, 'devices.json'), JSON.stringify({
				version: 1,
				environmentId: 'env-legacy',
				devices: [{ id: 'd1', label: 'Old phone', kind: 'mobile', role: 'device', createdAt: 1, tokenHash: createHash('sha256').update(token).digest('hex') }],
			}));
			const legacy = await ServerPairing.load(legacyDir, new NullLogService(), () => now);
			try {
				const auth = legacy.authorize(token, 'agent');
				assert.ok(auth, 'not signed out by the upgrade');
				assert.strictEqual(auth.expiresAt, now + DEVICE_TOKEN_TTL_MS);
				assert.strictEqual(legacy.environmentId, 'env-legacy');
				const saved = JSON.parse(await fs.readFile(join(legacyDir, 'devices.json'), 'utf8'));
				assert.strictEqual(saved.version, 2);
				assert.strictEqual(saved.devices[0].expiresAt, now + DEVICE_TOKEN_TTL_MS);
				assert.deepStrictEqual(saved.devices[0].scopes, ['agent', 'usage']);
				const refreshed = await legacy.refresh(token);
				assert.ok(refreshed, 'and refresh into an expiring token');
			} finally {
				legacy.dispose();
			}
		} finally {
			await fs.rm(legacyDir, { recursive: true, force: true });
		}
	});

	test('pairing links to the network listener are https and carry the certificate pin', () => {
		const pin = 'P'.repeat(43);
		const code = pairing.createCode({ port: 4000, network: true, serverVersion: 'test', tls: { port: 4002, fingerprint: pin, fingerprintHex: 'AB:CD' } });
		for (const link of code.urls.filter(url => url.kind !== 'loopback')) {
			assert.match(link.url, new RegExp(`^https://[^/]+:4002/pair#code=${code.code}&fp=${pin}$`));
		}
		assert.strictEqual(code.urls.at(-1)?.url, `http://127.0.0.1:4000/pair#code=${code.code}`);
		assert.strictEqual(code.fingerprint, 'AB:CD');
		const plain = pairing.createCode({ port: 4000, network: true, serverVersion: 'test' });
		assert.deepStrictEqual(plain.urls.map(url => url.kind), ['loopback'], 'no plain-HTTP network links');
	});

	test('browser sessions on this computer are capped', async () => {
		for (let i = 0; i < 12; i++) {
			now += 1000;
			await pairing.issueLocal('Chrome/1');
		}
		assert.strictEqual(pairing.list(new Set(), undefined).length, 8);
	});
});
