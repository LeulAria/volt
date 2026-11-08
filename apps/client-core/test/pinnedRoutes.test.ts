/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, suite, test } from 'node:test';
import { type IWebSocketLike, VoltConnection } from '../src/connection.ts';
import { createRouteSocket, type IPinnedTransport, isPin, isSecureOrLocal, pairEnvironment, parsePairingLink, pinFingerprint, refreshDeviceToken, setPinnedTransport } from '../src/environments.ts';
import { AGENT_SERVER_PROTOCOL_VERSION, RemoteError } from '../src/protocol.ts';

/** A certificate's pin and its `AB:CD:...` form, made the way the server makes them (listenerTls.ts). */
function certificatePin(der = randomBytes(300)) {
	const digest = createHash('sha256').update(der).digest();
	return { pin: digest.toString('base64url'), hex: digest.toString('hex').toUpperCase().match(/../g)!.join(':') };
}

const PIN = certificatePin().pin;
const OTHER_PIN = certificatePin().pin;

const descriptor = { environmentId: 'env-1', label: 'Mac', protocol: AGENT_SERVER_PROTOCOL_VERSION, serverVersion: '1', platform: { os: 'darwin', arch: 'arm64' } };
const client = { id: 'phone-1', label: 'Phone', kind: 'mobile' as const };

interface ICall { readonly url: string; readonly pin?: string; readonly method: string }

/** Answers like a Volt server; records what was asked, and whether it went through the pinned transport. */
function fakeServer(options: { readonly pinMismatch?: boolean } = {}) {
	const calls: ICall[] = [];
	const answer = (url: string) => {
		const body = url.endsWith('/.well-known/volt/environment') ? descriptor
			: url.endsWith('/api/auth/pair') ? { token: 'device-token', deviceId: 'dev-1', environmentId: 'env-1', label: 'Mac', role: 'device', expiresAt: 1 }
				: url.endsWith('/api/auth/refresh') ? { token: 'next-token', expiresAt: 2 }
					: undefined;
		return { ok: !!body, status: body ? 200 : 404, json: async () => body };
	};
	const transport: IPinnedTransport = {
		fetch: async (url, pin, init) => {
			calls.push({ url, pin, method: init.method });
			if (options.pinMismatch) {
				throw Object.assign(new Error('certificate does not match'), { code: 'PinMismatch' });
			}
			return answer(url);
		},
		createSocket: (url, pin) => {
			calls.push({ url, pin, method: 'SOCKET' });
			return {} as IWebSocketLike;
		},
	};
	const unpinnedFetch = async (url: string, init?: { method?: string }) => {
		calls.push({ url, method: init?.method ?? 'GET' });
		return answer(url);
	};
	return { calls, transport, unpinnedFetch };
}

function useGlobalFetch(fetch: unknown): void {
	(globalThis as { fetch?: unknown }).fetch = fetch;
}

const realFetch = globalThis.fetch;

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
	await assert.rejects(promise, (err: unknown) => {
		assert.ok(err instanceof RemoteError, `a RemoteError, not ${String(err)}`);
		assert.equal(err.code, code);
		return true;
	});
}

suite('B-24: certificate pins on the phone\'s routes', () => {

	afterEach(() => {
		setPinnedTransport(undefined);
		useGlobalFetch(realFetch);
	});

	test('a pin is a canonical base64url SHA-256 (43 characters)', () => {
		assert.ok(isPin(PIN));
		assert.ok(!isPin(undefined));
		assert.ok(!isPin(''));
		assert.ok(!isPin(PIN.slice(0, 42)), 'too short');
		assert.ok(!isPin(`${PIN}A`), 'too long');
		assert.ok(!isPin(`${PIN.slice(0, 42)}B`), 'the last character carries 2 bits that must be 0');
		assert.ok(!isPin(`${PIN.slice(0, 20)}+${PIN.slice(21)}`), 'base64, not base64url');
		assert.ok(!isPin(`${PIN.slice(0, 42)}=`), 'no padding');
	});

	test('a pin reads as the fingerprint the computer shows (SHA-256, AB:CD:...)', () => {
		for (let i = 0; i < 20; i++) {
			const { pin, hex } = certificatePin();
			assert.equal(pinFingerprint(pin), hex);
		}
		const zeros = createHash('sha256').update('').digest();
		assert.equal(pinFingerprint(zeros.toString('base64url')), zeros.toString('hex').toUpperCase().match(/../g)!.join(':'));
		assert.equal(pinFingerprint('not a pin'), undefined);
		assert.equal(pinFingerprint(undefined), undefined);
	});

	test('a pairing link carries the pin only on https, and only a well-formed one', () => {
		assert.deepEqual(parsePairingLink(`https://192.168.1.20:47823/pair#code=ABCD2345&fp=${PIN}`), { kind: 'code', baseUrl: 'https://192.168.1.20:47823', code: 'ABCD2345', pin: PIN });
		assert.deepEqual(parsePairingLink(`volt://pair?url=${encodeURIComponent(`https://100.70.1.2:47823/pair#code=ABCD-2345&fp=${PIN}`)}`), { kind: 'code', baseUrl: 'https://100.70.1.2:47823', code: 'ABCD2345', pin: PIN });
		assert.deepEqual(parsePairingLink(`http://192.168.1.20:47821/pair#code=ABCD2345&fp=${PIN}`), { kind: 'code', baseUrl: 'http://192.168.1.20:47821', code: 'ABCD2345' }, 'a pin means nothing on plain HTTP');
		assert.deepEqual(parsePairingLink(`https://192.168.1.20:47823/pair#code=ABCD2345&fp=${PIN.slice(1)}`), { kind: 'code', baseUrl: 'https://192.168.1.20:47823', code: 'ABCD2345' });
		assert.deepEqual(parsePairingLink(`https://192.168.1.20:47823/pair?fp=${PIN}#code=ABCD2345`), { kind: 'code', baseUrl: 'https://192.168.1.20:47823', code: 'ABCD2345' }, 'the pin comes from the fragment, which no server sees');
	});

	test('plain HTTP is only for this device itself', () => {
		for (const url of ['https://192.168.1.20:47823', 'https://mac.tail1234.ts.net', 'wss://192.168.1.20:47823/ws', 'http://127.0.0.1:47821', 'http://localhost:47821', 'http://[::1]:47821', 'ws://127.0.0.1:47821/ws']) {
			assert.ok(isSecureOrLocal(url), url);
		}
		for (const url of ['http://192.168.1.20:47821', 'http://100.70.1.2:47821', 'http://mac.local:47821', 'http://example.com', 'ws://192.168.1.20:47821/ws', 'http://127.0.0.1.example.com', 'ftp://127.0.0.1', 'not a url']) {
			assert.ok(!isSecureOrLocal(url), url);
		}
	});

	test('a plain HTTP network address is refused before anything is sent', async () => {
		const server = fakeServer();
		useGlobalFetch(server.unpinnedFetch);
		setPinnedTransport(server.transport);
		await rejectsWith(pairEnvironment(parsePairingLink('http://192.168.1.20:47821/pair#code=ABCD2345')!, client), 'InsecureAddress');
		await rejectsWith(refreshDeviceToken({ baseUrl: 'http://192.168.1.20:47821', kind: 'lan' }, 'device-token'), 'InsecureAddress');
		assert.deepEqual(server.calls, [], 'no request, so no token on the network');
		assert.throws(() => createRouteSocket('ws://192.168.1.20:47821/ws', undefined, () => assert.fail('no plain socket')), (err: unknown) => err instanceof RemoteError && err.code === 'InsecureAddress');
		assert.throws(() => createRouteSocket('ws://127.0.0.1:47821/ws', PIN, () => assert.fail('no plain socket')), (err: unknown) => err instanceof RemoteError && err.code === 'InsecureAddress', 'a pin on plain ws is refused, not dropped');
	});

	test('a pinned route without a pinned transport is refused, never tried unpinned', async () => {
		const server = fakeServer();
		useGlobalFetch(server.unpinnedFetch);
		await rejectsWith(pairEnvironment(parsePairingLink(`https://192.168.1.20:47823/pair#code=ABCD2345&fp=${PIN}`)!, client), 'PinUnsupported');
		assert.throws(() => createRouteSocket('wss://192.168.1.20:47823/ws', PIN, () => assert.fail('no unpinned socket')), (err: unknown) => err instanceof RemoteError && err.code === 'PinUnsupported');
		assert.deepEqual(server.calls, []);
	});

	test('pairing over a pinned route sends every request through the pinned transport with the link\'s pin, and saves it', async () => {
		const server = fakeServer();
		useGlobalFetch(server.unpinnedFetch);
		setPinnedTransport(server.transport);
		const env = await pairEnvironment(parsePairingLink(`https://192.168.1.20:47823/pair#code=ABCD2345&fp=${PIN}`)!, client);
		assert.deepEqual(server.calls, [
			{ url: 'https://192.168.1.20:47823/.well-known/volt/environment', pin: PIN, method: 'GET' },
			{ url: 'https://192.168.1.20:47823/api/auth/pair', pin: PIN, method: 'POST' },
		]);
		assert.equal(env.token, 'device-token');
		assert.deepEqual(env.routes.map(route => ({ baseUrl: route.baseUrl, pin: route.pin })), [{ baseUrl: 'https://192.168.1.20:47823', pin: PIN }]);

		await refreshDeviceToken(env.routes[0], env.token);
		assert.deepEqual(server.calls.at(-1), { url: 'https://192.168.1.20:47823/api/auth/refresh', pin: PIN, method: 'POST' });

		createRouteSocket('wss://192.168.1.20:47823/ws', env.routes[0].pin, () => assert.fail('no unpinned socket'));
		assert.deepEqual(server.calls.at(-1), { url: 'wss://192.168.1.20:47823/ws', pin: PIN, method: 'SOCKET' });
	});

	test('pairing again with a new certificate replaces the saved pin', async () => {
		const server = fakeServer();
		setPinnedTransport(server.transport);
		const first = await pairEnvironment(parsePairingLink(`https://192.168.1.20:47823/pair#code=ABCD2345&fp=${PIN}`)!, client);
		const second = await pairEnvironment(parsePairingLink(`https://192.168.1.20:47823/pair#code=EFGH2345&fp=${OTHER_PIN}`)!, client, [first]);
		assert.deepEqual(second.routes.map(route => route.pin), [OTHER_PIN]);
	});

	test('a certificate that doesn\'t match the pin fails as PinMismatch', async () => {
		const server = fakeServer({ pinMismatch: true });
		setPinnedTransport(server.transport);
		await rejectsWith(pairEnvironment(parsePairingLink(`https://192.168.1.20:47823/pair#code=ABCD2345&fp=${PIN}`)!, client), 'PinMismatch');
		assert.equal(server.calls.length, 1, 'stopped at the first request: the code is never sent');
	});

	test('a pinned socket whose certificate didn\'t match (close 1015) reads as PinMismatch and is retried, not trusted', async () => {
		let socket: IWebSocketLike | undefined;
		const connection = new VoltConnection({
			resolveUrl: async () => 'wss://192.168.1.20:47823/ws',
			token: 'device-token',
			client: { kind: 'mobile', id: 'phone-1' },
			createSocket: () => socket = { readyState: 0, send: () => assert.fail('nothing is sent'), close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null },
			backoff: { initialMs: 60_000, maxMs: 60_000, stableMs: 60_000 },
		});
		try {
			connection.start();
			for (let i = 0; i < 20 && !socket?.onclose; i++) {
				await new Promise(resolve => setTimeout(resolve, 1));
			}
			socket!.onerror?.({ code: 'PinMismatch' });
			socket!.onclose!({ code: 1015, reason: 'certificate does not match the pin' });
			assert.equal(connection.status.phase, 'waiting');
			assert.equal(connection.status.error?.code, 'PinMismatch');
		} finally {
			connection.stop();
		}
	});

	test('loopback stays plain HTTP without a transport', async () => {
		const server = fakeServer();
		useGlobalFetch(server.unpinnedFetch);
		const env = await pairEnvironment(parsePairingLink('http://127.0.0.1:47821/pair#code=ABCD2345')!, client);
		assert.equal(env.routes[0].pin, undefined);
		assert.deepEqual(server.calls.map(call => call.pin), [undefined, undefined]);
		let plain = false;
		createRouteSocket('ws://127.0.0.1:47821/ws', undefined, () => {
			plain = true;
			return {} as IWebSocketLike;
		});
		assert.ok(plain);
	});
});
