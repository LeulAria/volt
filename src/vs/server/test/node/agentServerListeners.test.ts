/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as http from 'http';
import { connect, Socket } from 'net';
import { tmpdir } from 'os';
import { FileAccess } from '../../../base/common/network.js';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { AGENT_SERVER_PROTOCOL_VERSION, AgentServerCloseCode, IAgentServerRuntimeInfo, IVoltPairingCode, VOLT_ENVIRONMENT_PATH, VOLT_LOCAL_LINK_PATH, VOLT_LOCAL_SESSION_PATH, VOLT_PAIR_PATH, VOLT_PAIRING_CODE_PATH, VOLT_REFRESH_PATH } from '../../../platform/voltAgentServer/common/protocol.js';
import { PinMismatchError, pinnedRequest } from '../../../platform/voltListeners/node/listenerTls.js';
import { WORKBENCH_SESSION_PATH } from '../../node/voltAgent/serverWorkbench.js';

/**
 * The CVE-2026-82533 class replayed against a real agent server (B-01, B-24, INV-07, INV-08): a
 * local process with no token, a forged token, a forged Host or no Origin gets 401/403 on every
 * route and socket; a revoked device is cut off within 5 s; devices on the network get TLS with a
 * pinned certificate. The server runs from `out/` in Node mode, with network access on `::1` (so
 * it opens its TLS listener without exposing anything to the network), in a throwaway profile.
 */

interface IResponse {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

/** Node's HTTP client: it sends exactly the Host and Origin given (or none), like curl or a sandboxed agent would. */
function call(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<IResponse> {
	return new Promise((resolve, reject) => {
		const body = init.body === undefined ? undefined : JSON.stringify(init.body);
		const req = http.request(url, { method: init.method ?? 'GET', headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : init.method === 'POST' ? { 'Content-Length': '0' } : {}), ...init.headers } }, res => {
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

/** A minimal WebSocket client over a raw socket, so the test controls every header. */
class RawSocket {
	readonly status: Promise<string>;
	readonly closed: Promise<number | undefined>;
	private readonly frames: string[] = [];
	private waiter: (() => void) | undefined;
	private buffer = Buffer.alloc(0);
	private headerDone = false;

	private constructor(private readonly socket: Socket, headers: Record<string, string>, path: string, host: string) {
		let resolveStatus!: (line: string) => void;
		let resolveClosed!: (code: number | undefined) => void;
		this.status = new Promise(resolve => resolveStatus = resolve);
		this.closed = new Promise(resolve => resolveClosed = resolve);
		const lines = [`GET ${path} HTTP/1.1`, `Host: ${headers.Host ?? host}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`];
		for (const [name, value] of Object.entries(headers)) {
			if (name !== 'Host') {
				lines.push(`${name}: ${value}`);
			}
		}
		socket.write(`${lines.join('\r\n')}\r\n\r\n`);
		let closeCode: number | undefined;
		socket.on('data', chunk => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			if (!this.headerDone) {
				const end = this.buffer.indexOf('\r\n\r\n');
				if (end < 0) {
					return;
				}
				resolveStatus(this.buffer.subarray(0, end).toString('latin1').split('\r\n')[0]);
				this.buffer = this.buffer.subarray(end + 4);
				this.headerDone = true;
			}
			for (let frame = this.readFrame(); frame; frame = this.readFrame()) {
				if (frame.opcode === 0x8) {
					closeCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : undefined;
					socket.destroy();
				} else if (frame.opcode === 0x1) {
					this.frames.push(frame.payload.toString('utf8'));
					this.waiter?.();
				}
			}
		});
		socket.on('close', () => {
			resolveStatus(this.headerDone ? 'closed' : this.buffer.toString('latin1').split('\r\n')[0] || 'closed');
			resolveClosed(closeCode);
		});
		socket.on('error', () => undefined);
	}

	/** Opens the socket and waits for the server's answer to the upgrade (frames go only after it). */
	static async open(port: number, path: string, headers: Record<string, string> = {}): Promise<RawSocket> {
		const raw = await new Promise<RawSocket>((resolve, reject) => {
			const socket = connect(port, '::1', () => resolve(new RawSocket(socket, headers, path, `[::1]:${port}`)));
			socket.once('error', reject);
		});
		await raw.status;
		return raw;
	}

	send(value: unknown): void {
		const payload = Buffer.from(JSON.stringify(value), 'utf8');
		const mask = randomBytes(4);
		const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
		const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
		this.socket.write(Buffer.concat([header, mask, masked]));
	}

	async next(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 10_000): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const index = this.frames.findIndex(text => predicate(JSON.parse(text)));
			if (index >= 0) {
				return JSON.parse(this.frames.splice(index, 1)[0]);
			}
			await new Promise<void>(resolve => {
				this.waiter = resolve;
				setTimeout(resolve, 200);
			});
		}
		throw new Error('no such frame');
	}

	close(): void {
		this.socket.destroy();
	}

	private readFrame(): { opcode: number; payload: Buffer } | undefined {
		if (this.buffer.length < 2) {
			return undefined;
		}
		let length = this.buffer[1] & 0x7f;
		let offset = 2;
		if (length === 126) {
			if (this.buffer.length < 4) {
				return undefined;
			}
			length = this.buffer.readUInt16BE(2);
			offset = 4;
		} else if (length === 127) {
			if (this.buffer.length < 10) {
				return undefined;
			}
			length = Number(this.buffer.readBigUInt64BE(2));
			offset = 10;
		}
		if (this.buffer.length < offset + length) {
			return undefined;
		}
		const frame = { opcode: this.buffer[0] & 0x0f, payload: this.buffer.subarray(offset, offset + length) };
		this.buffer = this.buffer.subarray(offset + length);
		return frame;
	}
}

function hello(token: string): Record<string, unknown> {
	return { t: 'hello', protocol: AGENT_SERVER_PROTOCOL_VERSION, token, client: { kind: 'mobile', id: `lst-${randomBytes(4).toString('hex')}`, topics: ['server'] } };
}

suite('LST-1..8 / REM-2: the agent server\'s listeners against a local attacker', function () {

	this.timeout(180_000);

	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let child: ChildProcess | undefined;
	let log = '';
	let info: IAgentServerRuntimeInfo;
	let token: string;
	let base: string;

	suiteSetup(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'volt-lst-'));
		const entry = join(FileAccess.asFileUri('').fsPath, 'volt-agent-server-main.js');
		const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VSCODE_|ELECTRON_)/.test(key)));
		env['ELECTRON_RUN_AS_NODE'] = '1';
		env['VOLT_AGENT_SERVER_IDLE_EXIT'] = '0';
		child = spawn(process.execPath, [entry, '--user-data-dir', dir, '--host', '::1', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout?.on('data', chunk => log = (log + chunk).slice(-8000));
		child.stderr?.on('data', chunk => log = (log + chunk).slice(-8000));
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			if (child.exitCode !== null) {
				throw new Error(`the agent server exited (${child.exitCode}):\n${log}`);
			}
			try {
				info = JSON.parse(await fs.readFile(join(dir, 'agentServer', 'runtime.json'), 'utf8'));
				token = (await fs.readFile(join(dir, 'agentServer', 'token'), 'utf8')).trim();
				break;
			} catch {
				await new Promise(resolve => setTimeout(resolve, 250));
			}
		}
		assert.ok(info, `the agent server did not start:\n${log}`);
		// The server listens on the address it was given (`::1` here), as it does on 0.0.0.0 in network mode.
		base = `http://[::1]:${info.port}`;
	});

	suiteTeardown(async () => {
		if (child && child.exitCode === null) {
			const exited = new Promise(resolve => child!.once('exit', resolve));
			child.kill('SIGTERM');
			await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10_000))]);
			if (child.exitCode === null) {
				child.kill('SIGKILL');
			}
		}
		await fs.rm(dir, { recursive: true, force: true });
	});

	test('LST-1: the CVE-2026-82533 replay (curl -XPOST -H "Host: 127.0.0.1:<p>" /api/auth/local) gets 403', async () => {
		const replay = await call(`${base}${VOLT_LOCAL_SESSION_PATH}`, { method: 'POST', headers: { Host: `127.0.0.1:${info.port}` } });
		assert.strictEqual(replay.status, 403);
		assert.strictEqual(replay.body.token, undefined);
	});

	test('LST-2: only a nonce made with the server\'s own token signs a browser in, once', async () => {
		assert.strictEqual((await call(`${base}${VOLT_LOCAL_LINK_PATH}`, { method: 'POST' })).status, 401, 'no token');
		assert.strictEqual((await call(`${base}${VOLT_LOCAL_LINK_PATH}`, { method: 'POST', headers: { Authorization: 'Bearer forged' } })).status, 401, 'forged token');
		const link = await call(`${base}${VOLT_LOCAL_LINK_PATH}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
		assert.strictEqual(link.status, 200);
		const nonce = link.body.nonce as string;
		const page = { method: 'POST', headers: { Origin: base } };
		assert.strictEqual((await call(`${base}${VOLT_LOCAL_SESSION_PATH}`, { ...page, body: { nonce: 'A'.repeat(43) } })).status, 403, 'forged nonce');
		const session = await call(`${base}${VOLT_LOCAL_SESSION_PATH}`, { ...page, body: { nonce } });
		assert.strictEqual(session.status, 200, 'the real browser flow still signs in');
		assert.strictEqual(typeof session.body.token, 'string');
		assert.strictEqual((await call(`${base}${VOLT_LOCAL_SESSION_PATH}`, { ...page, body: { nonce } })).status, 403, 'replayed nonce');
	});

	test('LST-3: a forged Host (DNS rebinding) is refused on every route and on the socket, even with the token', async () => {
		const rebound = { Host: `rebound.example:${info.port}` };
		assert.strictEqual((await call(`${base}/health`, { headers: { ...rebound, Authorization: `Bearer ${token}` } })).status, 403);
		assert.strictEqual((await call(`${base}${VOLT_ENVIRONMENT_PATH}`, { headers: rebound })).status, 403);
		assert.strictEqual((await call(`${base}${VOLT_LOCAL_LINK_PATH}`, { method: 'POST', headers: { ...rebound, Authorization: `Bearer ${token}` } })).status, 403);
		assert.strictEqual((await call(`${base}${VOLT_PAIR_PATH}`, { method: 'POST', headers: rebound, body: { code: 'ABCDEFGH' } })).status, 403);
		const socket = await RawSocket.open(info.port, '/ws', rebound);
		assert.match(await socket.status, / 403 /);
		socket.close();
		assert.strictEqual((await call(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } })).status, 200, 'the real Host works');
	});

	test('LST-4: browser routes refuse a request with no Origin', async () => {
		const local = await call(`${base}${VOLT_LOCAL_LINK_PATH}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
		assert.strictEqual((await call(`${base}${VOLT_LOCAL_SESSION_PATH}`, { method: 'POST', body: { nonce: local.body.nonce } })).status, 403, 'local session without an Origin');
		const device = await pairDevice();
		assert.strictEqual((await call(`${base}${WORKBENCH_SESSION_PATH}`, { method: 'POST', headers: { Authorization: `Bearer ${device.token}` } })).status, 403, 'workbench session cookie without an Origin');
		assert.strictEqual((await call(`${base}${WORKBENCH_SESSION_PATH}`, { method: 'DELETE' })).status, 403, 'sign-out without an Origin');
	});

	test('LST-5: token routes refuse no token and a forged token', async () => {
		for (const [path, method] of [['/health', 'GET'], [VOLT_PAIRING_CODE_PATH, 'POST'], [VOLT_LOCAL_LINK_PATH, 'POST'], ['/api/usage', 'GET'], [VOLT_REFRESH_PATH, 'POST']] as const) {
			assert.strictEqual((await call(`${base}${path}`, { method })).status, 401, `${path} with no token`);
			assert.strictEqual((await call(`${base}${path}`, { method, headers: { Authorization: 'Bearer forged-token' } })).status, 401, `${path} with a forged token`);
		}
	});

	test('LST-6: the socket closes a hello with no token or a forged token', async () => {
		for (const bad of ['', 'forged-token']) {
			const socket = await RawSocket.open(info.port, '/ws');
			assert.match(await socket.status, / 101 /);
			socket.send(hello(bad));
			assert.strictEqual(await socket.closed, AgentServerCloseCode.Unauthorized);
		}
		const owner = await RawSocket.open(info.port, '/ws');
		owner.send(hello(token));
		assert.strictEqual((await owner.next(frame => frame.t === 'welcome')).t, 'welcome');
		owner.close();
	});

	test('REM-2: a revoked device is disconnected within 5 s and its token stops working', async () => {
		const device = await pairDevice();
		const phone = await RawSocket.open(info.port, '/ws');
		phone.send(hello(device.token));
		await phone.next(frame => frame.t === 'welcome');
		const owner = await RawSocket.open(info.port, '/ws');
		owner.send(hello(token));
		await owner.next(frame => frame.t === 'welcome');
		const revokedAt = Date.now();
		owner.send({ t: 'call', id: 1, method: 'pairing.revoke', params: [device.deviceId] });
		assert.strictEqual((await owner.next(frame => frame.t === 'ret' && frame.id === 1)).ok, true);
		assert.strictEqual(await phone.closed, AgentServerCloseCode.Unauthorized);
		assert.ok(Date.now() - revokedAt < 5_000, `closed after ${Date.now() - revokedAt} ms`);
		owner.close();
		assert.strictEqual((await call(`${base}${VOLT_REFRESH_PATH}`, { method: 'POST', headers: { Authorization: `Bearer ${device.token}` } })).status, 401);
		const again = await RawSocket.open(info.port, '/ws');
		again.send(hello(device.token));
		assert.strictEqual(await again.closed, AgentServerCloseCode.Unauthorized);
	});

	test('B-24: network devices pair over plain HTTP (the phone app can\'t pin); the TLS listener serves pinned clients', async () => {
		assert.ok(info.tlsPort, 'network access opens the TLS listener');
		const code = await call(`${base}${VOLT_PAIRING_CODE_PATH}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
		const pairing = code.body as unknown as IVoltPairingCode;
		const pin = pairing.pin;
		assert.ok(pin && /^[A-Za-z0-9_-]{43}$/.test(pin), `the pairing code carries the pin: ${JSON.stringify(pairing)}`);
		for (const link of pairing.urls.filter(url => url.kind !== 'loopback' && !url.via)) {
			assert.ok(link.url.startsWith(`http://`) && link.url.includes(`:${info.port}/pair#code=`), `a network link uses the plain listener: ${link.url}`);
		}
		assert.strictEqual((await call(`http://[::1]:${info.port}${VOLT_ENVIRONMENT_PATH}`)).status, 200, 'the plain listener answers on the network address');
		const tlsBase = `https://[::1]:${info.tlsPort}`;
		const descriptor = await pinnedRequest(`${tlsBase}${VOLT_ENVIRONMENT_PATH}`, pin);
		assert.strictEqual(descriptor.status, 200);
		await assert.rejects(pinnedRequest(`${tlsBase}${VOLT_ENVIRONMENT_PATH}`, 'Z'.repeat(43)), PinMismatchError);
		await assert.rejects(call(`http://[::1]:${info.tlsPort}${VOLT_ENVIRONMENT_PATH}`), 'the TLS listener speaks only TLS');
		// Over TLS: pairing works, and the local-only routes don't.
		const body = JSON.stringify({ code: pairing.code, client: { label: 'LST phone', kind: 'mobile' } });
		const paired = await pinnedRequest(`${tlsBase}${VOLT_PAIR_PATH}`, pin, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
		assert.strictEqual(paired.status, 200);
		assert.ok(JSON.parse(paired.body).expiresAt > Date.now(), 'device tokens expire');
		assert.strictEqual((await pinnedRequest(`${tlsBase}${VOLT_LOCAL_LINK_PATH}`, pin, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 401, 'no local sign-in links over the network');
		const nonce = (await call(`${base}${VOLT_LOCAL_LINK_PATH}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).body.nonce as string;
		assert.strictEqual((await pinnedRequest(`${tlsBase}${VOLT_LOCAL_SESSION_PATH}`, pin, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: tlsBase }, body: JSON.stringify({ nonce }) })).status, 403, 'no local session over the network');
	});

	async function pairDevice(): Promise<{ token: string; deviceId: string }> {
		const code = await call(`${base}${VOLT_PAIRING_CODE_PATH}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
		assert.strictEqual(code.status, 200);
		const paired = await call(`${base}${VOLT_PAIR_PATH}`, { method: 'POST', body: { code: code.body.code, client: { label: 'LST phone', kind: 'mobile' } } });
		assert.strictEqual(paired.status, 200, JSON.stringify(paired.body));
		return { token: paired.body.token as string, deviceId: paired.body.deviceId as string };
	}
});
