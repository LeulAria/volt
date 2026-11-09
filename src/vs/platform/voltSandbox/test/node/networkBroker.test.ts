/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The network broker's I.4 corpus (K.3 NET-1..20, REV-1): the broker is driven over loopback
 * exactly as a sandboxed client drives it (raw HTTP on its route's port), with a fake resolver and
 * a connector that sends every checked address to a local server, so nothing leaves the machine.
 * The connector records which address the broker connected to, which is how DNS rebinding and
 * "no second lookup" are proven. Real sandboxed processes go through the broker in
 * sandboxAttestation.test.ts ("NET live grant") and sandboxSecurity.test.ts.
 *
 * Runs the same on macOS and Linux (scripts/volt-sandbox-linux-test.sh suite).
 */

import assert from 'assert';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as net from 'net';
import { tmpdir } from 'os';
import { Emitter } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IGrant } from '../../common/grants.js';
import { IPrincipal, PrincipalKind, SubjectKey } from '../../common/principals.js';
import { GrantCommitResult, IGrantStoreChange, IGrantStoreChangeEvent } from '../../node/grantStore.js';
import { INetworkAuditEvent, INetworkBrokerOptions, INetworkDenial, INetworkGrantSource, INetworkRouteOptions, IResolvedAddress, MemoryGrantSource, NetworkAuditLog, NetworkBroker, NetworkRoute } from '../../node/networkBroker.js';
import { denialTarget } from '../../node/sandboxManager.js';

const PUBLIC: IResolvedAddress = { address: '93.184.216.34', family: 4 };

let principalCount = 0;
function principal(subject: SubjectKey = `chat:c${++principalCount}`, kind: PrincipalKind = 'agent'): IPrincipal {
	return { id: `p${++principalCount}`, subject, kind, executionHost: 'local', launchPolicyHash: '', createdAt: 0 };
}

/** A local TCP server standing in for the internet: counts connections and echoes. */
async function echoServer(): Promise<{ readonly port: number; readonly received: () => string; readonly hits: () => number; close(): Promise<void> }> {
	let hits = 0;
	let received = '';
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		hits++;
		sockets.add(socket);
		socket.on('error', () => undefined);
		socket.on('data', data => { received += data.toString('latin1'); });
		socket.once('close', () => sockets.delete(socket));
		socket.pipe(socket);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return {
		port: (server.address() as net.AddressInfo).port, received: () => received, hits: () => hits,
		close: () => { sockets.forEach(socket => socket.destroy()); return new Promise(resolve => server.close(() => resolve())); },
	};
}

interface IRaw {
	readonly socket: net.Socket;
	/** Everything received so far. */
	text(): string;
	/** Resolves when the socket closed. */
	readonly closed: Promise<void>;
}

/** Opens a raw connection to a route and writes `text`. */
async function raw(port: number, text: string): Promise<IRaw> {
	const socket = net.connect({ host: '127.0.0.1', port });
	socket.on('error', () => undefined);
	let buffer = '';
	socket.on('data', data => { buffer += data.toString('latin1'); });
	const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
	await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject); });
	if (text) {
		socket.write(text);
	}
	return { socket, text: () => buffer, closed };
}

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	return check();
}

/** The status line of the answer to one request. */
async function status(port: number, text: string): Promise<{ readonly line: string; readonly raw: IRaw }> {
	const connection = await raw(port, text);
	await until(() => connection.text().includes('\r\n'), 5000);
	const all = connection.text();
	return { line: all.slice(0, all.indexOf('\r\n') >= 0 ? all.indexOf('\r\n') : undefined), raw: connection };
}

const basic = (token: string) => `Basic ${Buffer.from(`volt:${token}`).toString('base64')}`;
const connect = (route: NetworkRoute, authority: string, token = route.token) => `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${basic(token)}\r\n\r\n`;

suite('Volt network broker (I.4, NET-1..20)', function () {

	this.timeout(20_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let upstream: Awaited<ReturnType<typeof echoServer>>;
	let broker: NetworkBroker;
	let audit: INetworkAuditEvent[];
	let denials: INetworkDenial[];
	let lookups: string[];
	let connected: string[];
	let answers: Map<string, IResolvedAddress[][]>;
	const raws: IRaw[] = [];

	/** `host` resolves to these answers, one set per lookup (the last set repeats). */
	const resolves = (host: string, ...sets: IResolvedAddress[][]) => answers.set(host, sets);

	function makeBroker(options: Partial<INetworkBrokerOptions> = {}): NetworkBroker {
		return new NetworkBroker({
			lookup: async host => {
				lookups.push(host);
				const sets = answers.get(host);
				if (!sets) {
					return [PUBLIC];
				}
				return sets.length > 1 ? sets.shift()! : sets[0];
			},
			connect: address => {
				connected.push(address.address);
				return net.connect({ host: '127.0.0.1', port: upstream.port });
			},
			audit: event => audit.push(event),
			tunnelIdleMs: 2000,
			...options,
		});
	}

	async function route(allow: readonly string[], extra: Partial<INetworkRouteOptions> = {}, on = broker): Promise<NetworkRoute> {
		return on.openRoute({ principal: principal(), allow, onDenial: denial => denials.push(denial), ...extra });
	}

	async function open(port: number, text: string): Promise<{ readonly line: string; readonly raw: IRaw }> {
		const answer = await status(port, text);
		raws.push(answer.raw);
		return answer;
	}

	setup(async () => {
		audit = [];
		denials = [];
		lookups = [];
		connected = [];
		answers = new Map();
		upstream = await echoServer();
		broker = makeBroker();
	});

	teardown(async () => {
		raws.splice(0).forEach(r => r.socket.destroy());
		broker.dispose();
		await upstream.close();
	});

	test('NET-1: DNS rebinding: one lookup per connection, every answer public, the checked address is the one connected', async () => {
		const r = await route(['rebind.test']);
		// Mixed answers: a public one with a private one is refused outright.
		resolves('rebind.test', [PUBLIC, { address: '127.0.0.1', family: 4 }]);
		assert.match((await open(r.port, connect(r, 'rebind.test:443'))).line, /403/);
		assert.deepStrictEqual(connected, [], 'nothing was connected');
		// First lookup public, then private: the first connection goes to the checked address, the second is refused.
		resolves('rebind.test', [PUBLIC], [{ address: '10.0.0.7', family: 4 }]);
		lookups.length = 0;
		assert.match((await open(r.port, connect(r, 'rebind.test:443'))).line, /200/);
		assert.deepStrictEqual(lookups, ['rebind.test'], 'exactly one lookup for the connection');
		assert.deepStrictEqual(connected, [PUBLIC.address], 'connected to the address that was checked');
		assert.match((await open(r.port, connect(r, 'rebind.test:443'))).line, /403/, 'no cache: the next connection is resolved and judged again');
		assert.deepStrictEqual(connected, [PUBLIC.address]);
		assert.strictEqual(denials.at(-1)?.reason, 'private-address');
		assert.strictEqual(denials.at(-1)?.promptable, false, '"Allow host" never allows a private address');
	});

	test('NET-2: IDNA homographs: a look-alike name is another name; full-width is the same name', async () => {
		const r = await route(['apple.com']);
		assert.match((await open(r.port, connect(r, 'xn--pple-43d.com:443'))).line, /403/, 'Cyrillic a: not apple.com');
		// allow-any-unicode-next-line
		const verdict = await r.destination('аpple.com', 443);
		assert.ok(!verdict.ok && verdict.reason === 'not-allowed', 'the Unicode spelling is judged as its punycode');
		// allow-any-unicode-next-line
		assert.ok((await r.destination('ＡＰＰＬＥ.com', 443)).ok, 'full-width maps to apple.com');
		assert.match((await open(r.port, connect(r, 'APPLE.COM.:443'))).line, /200/, 'case and one trailing dot');
	});

	test('NET-3: NAT64, both prefixes (64:ff9b::/96 and 64:ff9b:1::/48), as literals and as answers', async () => {
		const r = await route(['*', 'nat64.test'], { loopbackPorts: [443] });
		for (const literal of ['[64:ff9b::7f00:1]:443', '[64:ff9b::127.0.0.1]:443', '[64:ff9b::a00:1]:443', '[64:ff9b:1:7f00:0:100::]:443', '[64:ff9b:1::7f00:1]:443']) {
			assert.match((await open(r.port, connect(r, literal))).line, /403/, literal);
		}
		resolves('nat64.test', [{ address: '64:ff9b::a9fe:a9fe', family: 6 }]);
		assert.match((await open(r.port, connect(r, 'nat64.test:443'))).line, /403/);
		assert.strictEqual(denials.at(-1)?.reason, 'metadata');
		assert.deepStrictEqual(connected, []);
	});

	test('NET-4: IPv4-mapped addresses are judged as IPv4', async () => {
		const r = await route(['*', 'mapped.test', '::/0', '0.0.0.0/0']);
		for (const literal of ['[::ffff:127.0.0.1]:443', '[::ffff:7f00:1]:443', '[::ffff:10.0.0.1]:443', '[0:0:0:0:0:ffff:c0a8:101]:443', '[::FFFF:192.168.1.1]:443']) {
			assert.match((await open(r.port, connect(r, literal))).line, /403/, literal);
		}
		resolves('mapped.test', [{ address: '::ffff:192.168.1.1', family: 6 }]);
		assert.match((await open(r.port, connect(r, 'mapped.test:443'))).line, /403/);
		assert.deepStrictEqual(connected, []);
	});

	test('NET-5: 6to4 (2002::/16) is judged as the IPv4 address it carries', async () => {
		const r = await route(['::/0', '0.0.0.0/0']);
		assert.match((await open(r.port, connect(r, '[2002:7f00:1::]:443'))).line, /403/);
		assert.match((await open(r.port, connect(r, '[2002:a9fe:a9fe::1]:443'))).line, /403/);
		assert.strictEqual(denials.at(-1)?.reason, 'metadata');
		assert.match((await open(r.port, connect(r, '[2002:5db8:d822::1]:443'))).line, /200/, '6to4 of a public address, matched by an IPv4 rule');
		assert.deepStrictEqual(connected, ['2002:5db8:d822::1']);
	});

	test('NET-6: decimal, octal and hex addresses are refused, never resolved', async () => {
		const r = await route(['*']);
		for (const authority of ['2130706433:443', '0x7f000001:443', '0177.0.0.1:443', '017700000001:443', '127.1:443', '127.0.0.01:443', '0x7f.0.0.1:443', '1.2.3.4.5:443']) {
			assert.match((await open(r.port, connect(r, authority))).line, /400|403/, authority);
		}
		assert.deepStrictEqual(lookups, [], 'nothing was resolved');
		assert.deepStrictEqual(connected, []);
	});

	test('NET-7: CONNECT smuggling: only host:port is a CONNECT target', async () => {
		const r = await route(['allowed.test']);
		for (const target of ['http://allowed.test/', 'allowed.test', 'allowed.test:443@evil.test:443', 'evil.test:443#allowed.test:443', 'allowed.test:443/x', 'allowed.test:', '[::1]', 'allowed.test:443 evil.test:443']) {
			const line = (await open(r.port, `CONNECT ${target} HTTP/1.1\r\nHost: allowed.test:443\r\nProxy-Authorization: ${basic(r.token)}\r\n\r\n`)).line;
			assert.match(line, /^HTTP\/1\.1 4\d\d/, `${target}: ${line}`);
		}
		assert.strictEqual(upstream.hits(), 0);
	});

	test('NET-8: absolute form and Host must agree; origin form is not a proxy request', async () => {
		const r = await route(['http://plain.test']);
		const mismatch = await open(r.port, `GET http://plain.test/ HTTP/1.1\r\nHost: evil.test\r\nProxy-Authorization: ${basic(r.token)}\r\n\r\n`);
		assert.match(mismatch.line, /400/);
		const origin = await open(r.port, `GET / HTTP/1.1\r\nHost: plain.test\r\nProxy-Authorization: ${basic(r.token)}\r\n\r\n`);
		assert.match(origin.line, /400/);
		const https = await open(r.port, `GET https://plain.test/ HTTP/1.1\r\nHost: plain.test\r\nProxy-Authorization: ${basic(r.token)}\r\n\r\n`);
		assert.match(https.line, /400/, 'https goes through CONNECT');
		const userinfo = await open(r.port, `GET http://plain.test@evil.test/ HTTP/1.1\r\nHost: evil.test\r\nProxy-Authorization: ${basic(r.token)}\r\n\r\n`);
		assert.match(userinfo.line, /400/);
		assert.strictEqual(upstream.hits(), 0);
	});

	test('NET-9: Content-Length with Transfer-Encoding, or two lengths, is refused and never forwarded', async () => {
		const r = await route(['http://plain.test']);
		for (const headers of ['Content-Length: 5\r\nTransfer-Encoding: chunked', 'Content-Length: 5\r\nContent-Length: 6', 'Transfer-Encoding: chunked\r\nTransfer-Encoding: identity']) {
			const answer = await open(r.port, `POST http://plain.test/ HTTP/1.1\r\nHost: plain.test\r\n${headers}\r\nProxy-Authorization: ${basic(r.token)}\r\n\r\n0\r\n\r\n`);
			assert.match(answer.line, /400/, headers);
		}
		assert.strictEqual(upstream.hits(), 0);
	});

	test('NET-10: bytes pipelined after CONNECT are tunnel payload, never a second request', async () => {
		const r = await route(['allowed.test']);
		const smuggled = `CONNECT evil.test:443 HTTP/1.1\r\nHost: evil.test:443\r\nProxy-Authorization: ${basic(r.token)}\r\n\r\n`;
		const answer = await open(r.port, connect(r, 'allowed.test:443') + smuggled);
		assert.match(answer.line, /200/);
		assert.ok(await until(() => upstream.received().includes('CONNECT evil.test')), 'the bytes went to the checked address');
		assert.ok(await until(() => answer.raw.text().includes('CONNECT evil.test')), 'and came back through the tunnel');
		assert.strictEqual(lookups.filter(name => name === 'evil.test').length, 0, 'evil.test was never resolved');
		assert.ok(!audit.some(event => event.destination === 'evil.test'), 'nor judged');
		assert.deepStrictEqual(connected, [PUBLIC.address]);
	});

	test('NET-11: slowloris: unfinished headers are dropped after the header timeout; idle tunnels close', async () => {
		broker.dispose();
		broker = makeBroker({ headerTimeoutMs: 300, tunnelIdleMs: 300 });
		const r = await route(['allowed.test']);
		const slow = await raw(r.port, 'CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test');
		raws.push(slow);
		const started = Date.now();
		await Promise.race([slow.closed, new Promise(resolve => setTimeout(resolve, 3000))]);
		assert.ok(slow.socket.destroyed || slow.socket.readableEnded, 'dropped');
		assert.ok(Date.now() - started < 2500, `within the header timeout (${Date.now() - started} ms)`);
		const idle = await open(r.port, connect(r, 'allowed.test:443'));
		assert.match(idle.line, /200/);
		await Promise.race([idle.raw.closed, new Promise(resolve => setTimeout(resolve, 3000))]);
		assert.ok(idle.raw.socket.destroyed, 'the idle tunnel closed');
		assert.ok(await until(() => audit.some(event => event.decision === 'close' && event.reason === 'idle')));
	});

	test('NET-12: a token is valid only on its route: another principal\'s gets 407 and an audit event naming whose it was', async () => {
		const a = await route(['allowed.test']);
		const b = await route(['allowed.test']);
		assert.notStrictEqual(a.token, b.token);
		assert.match((await open(b.port, connect(b, 'allowed.test:443', a.token))).line, /407/);
		const event = audit.find(e => e.reason === 'auth' && e.principal === b.principal.id);
		assert.ok(event, 'the refusal is audited');
		assert.strictEqual(event.tokenOf, a.subject, 'with the token owner');
		assert.match((await open(b.port, 'CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n')).line, /407/, 'no token');
		assert.match((await open(b.port, `GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nProxy-Authorization: ${basic(a.token)}\r\n\r\n`)).line, /407/, 'plain HTTP too');
		assert.ok(denials.filter(d => d.reason === 'auth').every(d => !d.promptable), 'never an "Allow" for an auth refusal');
		assert.strictEqual(upstream.hits(), 0);
		assert.match((await open(a.port, connect(a, 'allowed.test:443'))).line, /200/, 'the owner still gets through');
	});

	test('NET-13: a live grant applies to the same running client\'s next connection; approvals are CAS on the epoch', async () => {
		const r = await route([]);
		assert.match((await open(r.port, connect(r, 'later.test:443'))).line, /403/);
		const denial = denials.at(-1)!;
		assert.strictEqual(denial.reason, 'not-allowed');
		assert.ok(denial.promptable);
		// A stale epoch is refused: the permissions changed since the denial.
		await r.allowHosts(['other.test']);
		const stale = await r.approve(denial.denialId, denial.epoch);
		assert.ok(!stale.ok && /changed/.test(stale.reason));
		const fresh = await r.approve(denial.denialId, broker.epoch);
		assert.ok(fresh.ok, 'approved at the current epoch');
		assert.match((await open(r.port, connect(r, 'later.test:443'))).line, /200/, 'the next connection goes through, no restart');
		assert.deepStrictEqual(broker.grantsOf(r.subject).map(grant => grant.scope.targets?.[0]).sort(), ['later.test', 'other.test'], 'the rule came from the broker\'s own record');
		assert.ok(!(await r.approve(denial.denialId, broker.epoch)).ok, 'a denial is approved once');
		// A private-address denial can't be approved, and "Allow host" drops private entries.
		assert.match((await open(r.port, connect(r, '10.0.0.1:443'))).line, /403/);
		assert.ok(!(await r.approve(denials.at(-1)!.denialId, broker.epoch)).ok);
		await r.allowHosts(['10.0.0.1', '169.254.169.254', '127.0.0.1:443']);
		assert.match((await open(r.port, connect(r, '10.0.0.1:443'))).line, /403/);
		// Concurrent approvals both land (CAS retried on the latest epoch).
		const before = broker.epoch;
		await Promise.all([r.allowHosts(['a.test']), r.allowHosts(['b.test']), r.allowHosts(['c.test'])]);
		assert.strictEqual(broker.epoch, before + 3);
		for (const name of ['a.test', 'b.test', 'c.test']) {
			assert.ok((await r.destination(name, 443)).ok, name);
		}
		// The route's session grants end with it.
		r.dispose();
		assert.ok(await until(() => broker.grantsOf(r.subject).length === 0), 'revoked when the route closes');
	});

	test('NET-14 / REV-1: revoking a host closes its open tunnel within 1 s; a narrower rule set does too', async () => {
		const r = await route(['kept.test']);
		await r.allowHosts(['later.test']);
		const tunnel = await open(r.port, connect(r, 'later.test:443'));
		assert.match(tunnel.line, /200/);
		const kept = await open(r.port, connect(r, 'kept.test:443'));
		assert.match(kept.line, /200/);
		const started = Date.now();
		await r.revokeHosts(['later.test']);
		await Promise.race([tunnel.raw.closed, new Promise(resolve => setTimeout(resolve, 1000))]);
		assert.ok(tunnel.raw.socket.destroyed, `closed within the 1 s budget (INV-23); took ${Date.now() - started} ms`);
		assert.ok(!kept.raw.socket.destroyed, 'a tunnel the revocation does not touch stays open');
		assert.ok(audit.some(event => event.decision === 'close' && event.reason === 'revoked' && event.destination === 'later.test'));
		assert.match((await open(r.port, connect(r, 'later.test:443'))).line, /403/, 'and the next connection is refused');
		r.setRules([]);
		await Promise.race([kept.raw.closed, new Promise(resolve => setTimeout(resolve, 1000))]);
		assert.ok(kept.raw.socket.destroyed, 'narrower launch rules close it too');
	});

	test('NET-14b / REV-1: a revocation in the grant store (another writer) closes the tunnel', async () => {
		const source = new EventedGrants();
		broker.dispose();
		broker = makeBroker({ grants: source });
		const r = await route([]);
		await r.allowHosts(['later.test']);
		const tunnel = await open(r.port, connect(r, 'later.test:443'));
		assert.match(tunnel.line, /200/);
		// Another process revokes it in the store; the broker hears it through onDidChange.
		await source.commitOutside({ revoke: broker.grantsOf(r.subject).map(grant => grant.id) });
		await Promise.race([tunnel.raw.closed, new Promise(resolve => setTimeout(resolve, 1000))]);
		assert.ok(tunnel.raw.socket.destroyed);
		broker.dispose();
		source.dispose();
	});

	test('NET-15: cloud metadata on both families, whatever is granted', async () => {
		const r = await route(['*', '0.0.0.0/0', '::/0', '169.254.0.0/16:80', 'meta.test'], { loopbackPorts: [80] });
		await broker.update({ add: [{ id: 'local-all', subject: r.subject, capability: 'net.local.connect@1', scope: { targets: ['0.0.0.0/0', '::/0', '169.254.169.254:80'] }, kind: 'session', sessionId: r.principal.id, source: 'user', grantedAt: 0, lastUsedAt: 0 }] });
		for (const literal of ['169.254.169.254:80', '[fd00:ec2::254]:80', '100.100.100.200:80', '[::ffff:169.254.169.254]:80', '[64:ff9b::a9fe:a9fe]:80', '[2002:a9fe:a9fe::]:80']) {
			assert.match((await open(r.port, connect(r, literal))).line, /403/, literal);
			assert.strictEqual(denials.at(-1)?.reason, 'metadata', literal);
		}
		for (const answer of [{ address: '169.254.169.254', family: 4 as const }, { address: 'fd00:ec2::254', family: 6 as const }]) {
			resolves('meta.test', [answer]);
			assert.match((await open(r.port, connect(r, 'meta.test:443'))).line, /403/);
			assert.strictEqual(denials.at(-1)?.reason, 'metadata');
		}
		assert.match((await open(r.port, `GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\nProxy-Authorization: ${basic(r.token)}\r\n\r\n`)).line, /403/);
		assert.ok(denials.filter(d => d.reason === 'metadata').every(d => !d.promptable));
		assert.deepStrictEqual(connected, []);
	});

	test('NET-16: redirects are not followed: a 3xx to a private address goes back, and the client\'s next request is refused', async () => {
		const site = http.createServer((_req, res) => res.writeHead(302, { Location: 'http://127.0.0.1:6379/' }).end());
		await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
		const sitePort = (site.address() as net.AddressInfo).port;
		let siteHits = 0;
		broker.dispose();
		broker = makeBroker({ connect: address => { connected.push(address.address); siteHits++; return net.connect({ host: '127.0.0.1', port: sitePort }); } });
		try {
			const r = await route(['http://redirect.test']);
			const first = await open(r.port, `GET http://redirect.test/ HTTP/1.1\r\nHost: redirect.test\r\nProxy-Authorization: ${basic(r.token)}\r\nConnection: close\r\n\r\n`);
			assert.match(first.line, /302/);
			assert.ok(await until(() => /location: http:\/\/127\.0\.0\.1:6379\//i.test(first.raw.text())), 'the Location is the client\'s to follow');
			assert.strictEqual(siteHits, 1, 'one upstream connection: the broker did not follow');
			const second = await open(r.port, `GET http://127.0.0.1:6379/ HTTP/1.1\r\nHost: 127.0.0.1:6379\r\nProxy-Authorization: ${basic(r.token)}\r\n\r\n`);
			assert.match(second.line, /403/);
			assert.strictEqual(siteHits, 1);
		} finally {
			await new Promise<void>(resolve => site.close(() => resolve()));
		}
	});

	test('NET-17: a wildcard never spans a public suffix and matches descendants only', async () => {
		const r = await route(['*.com', '*.co.uk', '*.github.io', '*.example.org']);
		for (const authority of ['example.com:443', 'victim.co.uk:443', 'someone.github.io:443', 'example.org:443']) {
			assert.match((await open(r.port, connect(r, authority))).line, /403/, authority);
		}
		assert.match((await open(r.port, connect(r, 'www.example.org:443'))).line, /200/);
	});

	test('NET-18: * covers names on 80 and 443 only: no port widening, no addresses', async () => {
		const r = await route(['*', '*.example.org']);
		assert.match((await open(r.port, connect(r, 'example.net:443'))).line, /200/);
		assert.match((await open(r.port, connect(r, 'redis.example.net:6379'))).line, /403/);
		assert.strictEqual(denials.at(-1)?.reason, 'port');
		assert.strictEqual(denialTarget(denials.at(-1)!), 'redis.example.net:6379', 'an approval would add exactly host:port');
		assert.match((await open(r.port, connect(r, 'a.example.org:22'))).line, /403/);
		assert.match((await open(r.port, connect(r, '93.184.216.34:443'))).line, /403/, 'an address needs an address rule');
		assert.match((await open(r.port, connect(r, 'example.net:0'))).line, /4\d\d/);
		assert.match((await open(r.port, connect(r, 'example.net:65536'))).line, /4\d\d/);
	});

	test('NET-19: exfil-capable hosts need a rule naming them exactly, even under * and wide wildcards', async () => {
		const r = await route(['*', '*.github.com', '*.amazonaws.com', 'pastebin.com']);
		for (const authority of ['webhook.site:443', 'gist.github.com:443', 'api.github.com:443', 'bucket.s3.amazonaws.com:443', 'x.ngrok.io:443', 'transfer.sh:443']) {
			assert.match((await open(r.port, connect(r, authority))).line, /403/, authority);
		}
		assert.match((await open(r.port, connect(r, 'pastebin.com:443'))).line, /200/, 'named exactly');
		assert.match((await open(r.port, connect(r, 'github.com:443'))).line, /200/, 'github.com itself is not exfil-capable');
		await r.allowHosts(['webhook.site']);
		assert.match((await open(r.port, connect(r, 'webhook.site:443'))).line, /200/, 'an exact grant opens it');
	});

	test('NET-20: budgets per principal with typed refusals, prompt budget (G.12), and an audit event per connect, deny and close', async () => {
		let now = 1_000_000;
		broker.dispose();
		broker = makeBroker({ now: () => now });
		const r = await route(['allowed.test'], { limits: { maxConnections: 2, bytesPerDay: 64 } });
		const one = await open(r.port, connect(r, 'allowed.test:443'));
		const two = await open(r.port, connect(r, 'allowed.test:443'));
		assert.match(one.line, /200/);
		assert.match(two.line, /200/);
		assert.match((await open(r.port, connect(r, 'allowed.test:443'))).line, /429/, 'a third at once');
		assert.strictEqual(denials.at(-1)?.reason, 'rate-limit');
		// The byte budget: past it every open tunnel closes and new connections are refused until the day rolls.
		one.raw.socket.write('x'.repeat(100));
		await Promise.race([one.raw.closed, new Promise(resolve => setTimeout(resolve, 2000))]);
		assert.ok(one.raw.socket.destroyed && await until(() => two.raw.socket.destroyed));
		assert.ok(audit.some(event => event.decision === 'close' && event.reason === 'budget'));
		assert.match((await open(r.port, connect(r, 'allowed.test:443'))).line, /429/);
		now += 24 * 60 * 60 * 1000;
		assert.match((await open(r.port, connect(r, 'allowed.test:443'))).line, /200/, 'a new day');

		// Prompts: one per minute, coalesced over 2 s, none after two refusals.
		const p = await route([]);
		denials.length = 0;
		await open(p.port, connect(p, 'first.test:443'));
		await open(p.port, connect(p, 'first.test:443'));
		assert.strictEqual(denials.length, 1, 'the same refusal within 2 s is the same denial');
		assert.ok(denials[0].promptable);
		now += 3000;
		await open(p.port, connect(p, 'second.test:443'));
		assert.ok(!denials.at(-1)!.promptable, 'one prompt per minute');
		now += 61_000;
		await open(p.port, connect(p, 'third.test:443'));
		assert.ok(denials.at(-1)!.promptable);
		p.refuse(denials[0].denialId);
		p.refuse(denials.at(-1)!.denialId);
		now += 61_000;
		await open(p.port, connect(p, 'fourth.test:443'));
		assert.ok(!denials.at(-1)!.promptable, 'auto-deny after two refusals');
		p.resetPromptBudget();
		now += 61_000;
		await open(p.port, connect(p, 'fifth.test:443'));
		assert.ok(denials.at(-1)!.promptable, 'the Access page resets it');

		// Audit: every event carries who, where, the decision and the epoch.
		for (const event of audit) {
			assert.ok(event.principal && event.subject && typeof event.epoch === 'number' && event.destination !== undefined && event.port !== undefined, JSON.stringify(event));
		}
		assert.ok(audit.some(event => event.decision === 'allow' && event.address === PUBLIC.address));
		assert.ok(audit.some(event => event.decision === 'deny' && event.reason === 'not-allowed'));
	});

	test('an upstream that ends first: the client still gets every byte in flight, then its end', async () => {
		const size = 16 * 1024 * 1024;
		const sink = net.createServer(socket => { socket.on('error', () => undefined); socket.end(Buffer.alloc(size, 7)); });
		await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
		broker.dispose();
		broker = makeBroker({ connect: () => net.connect({ host: '127.0.0.1', port: (sink.address() as net.AddressInfo).port }) });
		try {
			const r = await route(['download.test']);
			const socket = net.connect({ host: '127.0.0.1', port: r.port });
			socket.on('error', () => undefined);
			let received = 0;
			let head = true;
			let paused = false;
			const done = new Promise<void>(resolve => socket.once('close', () => resolve()));
			socket.on('data', data => {
				if (head) {
					const end = data.indexOf('\r\n\r\n');
					assert.ok(data.toString('latin1', 0, 12).startsWith('HTTP/1.1 200'));
					received += data.length - end - 4;
					head = false;
				} else {
					received += data.length;
				}
				if (!paused && received >= size - 512 * 1024) {
					// A slow reader near the end: the upstream has sent everything and closed while the tail still waits in buffers.
					paused = true;
					socket.pause();
					setTimeout(() => socket.resume(), 300);
				}
			});
			socket.write(connect(r, 'download.test:443'));
			await done;
			assert.strictEqual(received, size);
		} finally {
			await new Promise<void>(resolve => sink.close(() => resolve()));
		}
	});

	test('t2 and t3 principals get H.8 byte budgets; agents none', async () => {
		const t2 = await broker.openRoute({ principal: principal('plugin:a.b@local', 't2'), allow: [] });
		const agent = await broker.openRoute({ principal: principal(), allow: [] });
		assert.strictEqual(t2.limits.bytesPerDay, 50 * 1024 * 1024);
		assert.strictEqual(agent.limits.bytesPerDay, undefined);
		assert.strictEqual(agent.limits.maxConnections, 64);
	});

	test('local network and loopback: a LAN address needs net.local.connect for it and its port; Volt\'s own ports never', async () => {
		const r = await route(['*'], { loopbackPorts: [5173] });
		assert.match((await open(r.port, connect(r, '192.168.1.20:5432'))).line, /403/);
		await broker.update({ add: [{ id: 'lan', subject: r.subject, capability: 'net.local.connect@1', scope: { targets: ['192.168.1.0/24:5432'] }, kind: 'session', sessionId: r.principal.id, source: 'user', grantedAt: 0, lastUsedAt: 0 }] });
		assert.match((await open(r.port, connect(r, '192.168.1.20:5432'))).line, /200/);
		assert.match((await open(r.port, connect(r, '192.168.1.20:6379'))).line, /403/, 'another port');
		assert.match((await open(r.port, connect(r, '127.0.0.1:5173'))).line, /200/, 'a granted loopback port');
		assert.match((await open(r.port, connect(r, '127.0.0.1:5174'))).line, /403/);
		const other = await route([], { loopbackPorts: [r.port] });
		assert.match((await open(other.port, connect(other, `127.0.0.1:${r.port}`))).line, /403/, 'a route port is Volt\'s own, even when granted');
		assert.match((await open(r.port, connect(r, 'localhost:5173'))).line, /403/, 'a name never resolves to loopback here');
	});

	test('NET-VIEW-1: a plugin principal is judged by its manifest view: declared hosts only, none without a view, none for network none', async () => {
		const subject: SubjectKey = 'firstparty:volt.provider-openrouter';
		const viewed = await route([], { principal: principal(subject, 't2'), view: { manifest: { subject, declared: [{ id: 'net.connect', targets: ['openrouter.ai'] }], network: 'broker' } } });
		assert.match((await open(viewed.port, connect(viewed, 'openrouter.ai:443'))).line, /200/, 'declared and in the first-party ceiling');
		assert.match((await open(viewed.port, connect(viewed, 'example.com:443'))).line, /403/, 'not declared');
		const pluginSubject: SubjectKey = 'plugin:acme.weather@local';
		const plugin = await route([], { principal: principal(pluginSubject, 't2'), view: { manifest: { subject: pluginSubject, declared: [{ id: 'net.connect', targets: ['api.weather.test'] }], network: 'broker' } } });
		assert.match((await open(plugin.port, connect(plugin, 'api.weather.test:443'))).line, /200/, 'a declared low capability holds for a third-party plugin (install-time grant)');
		assert.match((await open(plugin.port, connect(plugin, 'api.weather.test:8443'))).line, /403/, 'another port is not declared');
		const blind = await route([], { principal: principal('plugin:acme.blind@local', 't2') });
		assert.match((await open(blind.port, connect(blind, 'api.weather.test:443'))).line, /403/, 'no view: no manifest, refused');
		assert.match(denials.at(-1)?.message ?? '', /no manifest/);
		// A view whose manifest says the network is off: still refused for an undeclared host, and the route itself never opens without proxy.
		const off = await route([], { principal: principal('plugin:acme.off@local', 't2'), view: { manifest: { subject: 'plugin:acme.off@local', declared: [], network: 'none' } } });
		assert.match((await open(off.port, connect(off, 'api.weather.test:443'))).line, /403/);
		// The view's subject is the route's own: a view naming another subject cannot lend it that subject's declarations.
		const forged = await route([], { principal: principal('plugin:acme.forged@local', 't2'), view: { manifest: { subject: 'firstparty:volt.provider-openrouter', declared: [], network: 'broker' } } });
		assert.match((await open(forged.port, connect(forged, 'openrouter.ai:443'))).line, /403/);
	});

	test('NET-VIEW-2: an MCP principal from a registered provider: its approved hosts, never wider than its parent chat; revoking the provider closes its tunnels', async () => {
		const subject: SubjectKey = 'mcp:0123abcd';
		const chat = principal('chat:parent');
		const approved = (target: string): IGrant => ({ id: `mcp-${target}`, subject, capability: 'net.connect@1', scope: { targets: [target] }, kind: 'persistent', source: 'user', grantedAt: Date.now(), lastUsedAt: Date.now(), epoch: 0 });
		const provider = broker.registerViewProvider(p => p.subject === subject ? {
			manifest: { subject, declared: [{ id: 'net.connect', targets: ['a.test', 'b.test'] }], network: 'broker' },
			grants: [approved('a.test'), approved('b.test')],
			onBehalfOf: [{ principal: chat, chat: { subject: chat.subject, settings: { level: 'workspace-write', network: false, allowedDomains: ['a.test'] } } }],
		} : undefined);
		try {
			const mcp = await route([], { principal: principal(subject, 'mcp') });
			const tunnel = await open(mcp.port, connect(mcp, 'a.test:443'));
			assert.match(tunnel.line, /200/, `approved, and its chat allows it: ${denials.at(-1)?.message}`);
			assert.match((await open(mcp.port, connect(mcp, 'b.test:443'))).line, /403/, 'approved for the server, but its chat does not allow b.test');
			assert.match(denials.at(-1)?.message ?? '', /on whose behalf/);
			assert.match((await open(mcp.port, connect(mcp, 'c.test:443'))).line, /403/, 'not approved');
			assert.deepStrictEqual(audit.filter(event => event.decision === 'allow' && event.subject === subject).map(event => event.chain), [['chat:parent']], 'the chain is the provider\'s, not the client\'s');
			provider.dispose();
			await tunnel.raw.closed;
			assert.match((await open(mcp.port, connect(mcp, 'a.test:443'))).line, /403/, 'no provider: no manifest');
		} finally {
			provider.dispose();
		}
	});

	test('the audit log is one JSON object per line, 0600, rotated by size', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'volt-net-audit-'));
		try {
			const log = new NetworkAuditLog(join(dir, 'trust', 'audit', 'network.log'), 300, 2);
			for (let i = 0; i < 10; i++) {
				log.append({ ts: i, principal: 'p', subject: 'chat:x', chain: [], method: 'CONNECT', destination: `h${i}.test`, port: 443, decision: 'deny', reason: 'not-allowed', epoch: 0 });
				await log.flush();
			}
			const text = await fs.readFile(log.file, 'utf8');
			assert.ok(text.trim().split('\n').every(line => JSON.parse(line).principal === 'p'));
			assert.strictEqual((await fs.stat(log.file)).mode & 0o777, 0o600);
			assert.ok(await fs.stat(`${log.file}.1`).then(() => true, () => false), 'rotated');
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('MemoryGrantSource: commits are compare-and-swap on the epoch', async () => {
		const source = new MemoryGrantSource();
		const draft: IGrant = { id: 'g1', subject: 'chat:x', capability: 'net.connect@1', scope: { targets: ['a.test'] }, kind: 'session', sessionId: 'p', source: 'user', grantedAt: 0, lastUsedAt: 0, epoch: 0 };
		assert.deepStrictEqual(await source.commit(0, { add: [draft] }), { committed: true, epoch: 1, changed: true });
		assert.deepStrictEqual(await source.commit(0, { add: [{ ...draft, id: 'g2' }] }), { committed: false, epoch: 1 }, 'stale');
		assert.deepStrictEqual(await source.commit(1, { revoke: ['g1'] }), { committed: true, epoch: 2, changed: true });
	});

	test('NET-T3-1: an extension host\'s route is judged by its manifest: network none, named declarations, live "Allow host", never public *', async () => {
		const subject: SubjectKey = 'plugin:pub.lint@local';
		const manifest = { subject, network: 'broker' as const, declared: [{ id: 'net.connect', targets: ['registry.lint.test'] }, { id: 'net.connect', targets: ['*'] }, { id: 'net.connect' }] };
		const r = await broker.openRoute({ principal: principal(subject, 't3'), allow: ['*'], view: { manifest }, onDenial: denial => denials.push(denial) });
		assert.strictEqual(r.limits.bytesPerDay, 200 * 1024 * 1024, 'H.8 T3 budget');
		assert.match((await open(r.port, connect(r, 'registry.lint.test:443'))).line, /200/, 'a host it names');
		const blocked = await open(r.port, connect(r, 'example.test:443'));
		assert.match(blocked.line, /403/, 'the route\'s allow list and a wildcard declaration open nothing');
		await until(() => blocked.raw.text().includes('off for this extension'));
		assert.match(blocked.raw.text(), /off for this extension/);
		const denial = denials.find(d => d.destination === 'example.test');
		assert.ok(denial?.promptable, 'an "Allow host" may be offered, naming the destination');
		await r.allowHosts(['*']);
		assert.match((await open(r.port, connect(r, 'other.test:443'))).line, /403/, '"Allow host" never grants public *');
		const approved = await r.approve(denial!.denialId, broker.epoch);
		assert.ok(approved.ok);
		assert.match((await open(r.port, connect(r, 'example.test:443'))).line, /200/, 'the approved host, live');
		// Another instance of another extension does not get it, nor does a later instance of this one (session grant).
		const other = await broker.openRoute({ principal: principal('plugin:pub.other@local', 't3'), allow: [], view: { manifest: { ...manifest, subject: 'plugin:pub.other@local' } } });
		assert.match((await open(other.port, connect(other, 'example.test:443'))).line, /403/);
		const later = await broker.openRoute({ principal: principal(subject, 't3'), allow: [], view: { manifest } });
		assert.match((await open(later.port, connect(later, 'example.test:443'))).line, /403/, 'a session grant is the instance\'s');
		await r.revokeHosts(['example.test']);
		assert.match((await open(r.port, connect(r, 'example.test:443'))).line, /403/, 'revoked');
	});

	test('NET-21: a host revoked while its lookup is in flight is refused before anything connects', async () => {
		let release!: () => void;
		const held = new Promise<void>(resolve => release = resolve);
		broker.dispose();
		broker = makeBroker({ lookup: async host => { lookups.push(host); await held; return [PUBLIC]; } });
		const r = await route([]);
		await r.allowHosts(['slow.test']);
		const pending = open(r.port, connect(r, 'slow.test:443'));
		assert.ok(await until(() => lookups.includes('slow.test')), 'the lookup started');
		await r.revokeHosts(['slow.test']);
		release();
		assert.match((await pending).line, /403/);
		assert.deepStrictEqual(connected, [], 'no upstream connection was opened');
	});

	test('NET-22: pipelined plain-HTTP requests hold their connection slots before the lookup', async () => {
		const held = new Set<net.Socket>();
		const sink = net.createServer(socket => { held.add(socket); socket.on('error', () => undefined); });
		await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
		const sinkPort = (sink.address() as net.AddressInfo).port;
		broker.dispose();
		broker = makeBroker({ connect: address => { connected.push(address.address); return net.connect({ host: '127.0.0.1', port: sinkPort }); } });
		try {
			const r = await route(['http://pipe.test'], { limits: { maxConnections: 4 } });
			const request = `GET http://pipe.test/ HTTP/1.1\r\nHost: pipe.test\r\nProxy-Authorization: ${basic(r.token)}\r\n\r\n`;
			const client = await raw(r.port, request.repeat(40));
			raws.push(client);
			await until(() => connected.length >= 4);
			await new Promise(resolve => setTimeout(resolve, 300));
			assert.ok(connected.length <= 4, `at most 4 upstream connections at once, saw ${connected.length}`);
		} finally {
			held.forEach(socket => socket.destroy());
			await new Promise<void>(resolve => sink.close(() => resolve()));
		}
	});

	test('NET-23: a plain-HTTP upload counts against the principal\'s byte budget', async () => {
		const r = await route(['http://up.test', 'allowed.test'], { limits: { maxConnections: 8, bytesPerDay: 1000 } });
		const body = 'x'.repeat(5000);
		const upload = await raw(r.port, `POST http://up.test/ HTTP/1.1\r\nHost: up.test\r\nContent-Length: ${body.length}\r\nProxy-Authorization: ${basic(r.token)}\r\n\r\n${body}`);
		raws.push(upload);
		assert.ok(await until(() => audit.some(event => event.decision === 'close' && event.reason === 'budget')), 'the upload passed the budget and was cut');
		assert.match((await open(r.port, connect(r, 'allowed.test:443'))).line, /429/, 'nothing more today');
	});

	test('NET-24: manifest wildcards that name no host open nothing, and SIIT addresses are judged as IPv4', async () => {
		const subject: SubjectKey = 'plugin:acme.wild@local';
		const manifest = { subject, network: 'broker' as const, declared: [{ id: 'net.connect', targets: ['**', '*.*', '*.com', '*example.com'] }] };
		const r = await broker.openRoute({ principal: principal(subject, 't3'), allow: [], view: { manifest }, onDenial: denial => denials.push(denial) });
		assert.match((await open(r.port, connect(r, 'attacker-evil-example.com:443'))).line, /403/);
		const chat = await route(['*']);
		for (const literal of ['[::ffff:0:a9fe:a9fe]:80', '[::ffff:0:7f00:1]:443']) {
			assert.match((await open(chat.port, connect(chat, literal))).line, /403/, literal);
		}
		assert.deepStrictEqual(connected, []);
	});

	test('NET-25: "Allow for This Chat" works after the refused run ended, by the broker\'s record of that chat only', async () => {
		const chatId = `ended-${++principalCount}`;
		const first = await route([], { principal: principal(`chat:${chatId}`) });
		assert.match((await open(first.port, connect(first, 'later.test:443'))).line, /403/);
		const denial = denials.at(-1)!;
		assert.match((await open(first.port, connect(first, '10.0.0.7:443'))).line, /403/);
		const privateDenial = denials.at(-1)!;
		// The turn ends: its agent process and route go. Other chats' approvals move the epoch meanwhile.
		first.dispose();
		const other = await route([]);
		await other.allowHosts(['unrelated.test']);
		assert.ok(broker.epoch > denial.epoch);
		assert.deepStrictEqual(await broker.approveForChat('someone-else', denial.denialId, denial.epoch), { ok: false, epoch: broker.epoch, reason: 'Volt has no record of this denial for this chat (it may be too old); allow the host when it is blocked again' }, 'only that chat\'s record');
		assert.ok(!(await broker.approveForChat(chatId, denial.denialId, denial.epoch + 1)).ok, 'the epoch the card was shown with');
		assert.ok(!(await broker.approveForChat(chatId, privateDenial.denialId, privateDenial.epoch)).ok, 'a private-address refusal is never approvable');
		assert.ok(!(await broker.approveForChat(chatId, 'forged', denial.epoch)).ok, 'an unrecorded denial gets nothing (B-34)');
		const approved = await broker.approveForChat(chatId, denial.denialId, denial.epoch);
		assert.ok(approved.ok, 'approved on the latest epoch, not refused as stale');
		assert.ok(!(await broker.approveForChat(chatId, denial.denialId, denial.epoch)).ok, 'approved once');
		const grant = broker.grantsOf(`chat:${chatId}`).find(candidate => candidate.scope.targets?.[0] === 'later.test');
		assert.ok(grant && grant.sessionId === chatId && grant.kind === 'session', 'the chat\'s grant, bound to the chat');
		// The chat's next run (a new agent process, a new principal) reaches it from its first connection.
		const next = await route([], { principal: principal(`chat:${chatId}`) });
		assert.match((await open(next.port, connect(next, 'later.test:443'))).line, /200/);
		assert.match((await open(other.port, connect(other, 'later.test:443'))).line, /403/, 'another chat does not get it');
		next.dispose();
		assert.ok(broker.grantsOf(`chat:${chatId}`).some(candidate => candidate.id === grant.id), 'it outlives the run');
	});

	test('NET-26: "Allow for This Chat" while the run is open applies to that run\'s next connection at once', async () => {
		const chatId = `live-${++principalCount}`;
		const r = await route([], { principal: principal(`chat:${chatId}`) });
		assert.match((await open(r.port, connect(r, 'now.test:443'))).line, /403/);
		const denial = denials.at(-1)!;
		assert.ok((await broker.approveForChat(chatId, denial.denialId, denial.epoch)).ok);
		assert.match((await open(r.port, connect(r, 'now.test:443'))).line, /200/, 'no restart');
		assert.ok(!(await r.approve(denial.denialId, broker.epoch)).ok, 'and the route\'s own record is spent too');
	});
});

/** A grant source another writer can change (like the GrantStore under ~/.volt/trust), with change events. */
class EventedGrants extends MemoryGrantSource implements INetworkGrantSource {
	private readonly emitter = new Emitter<IGrantStoreChangeEvent>();
	readonly onDidChange = (listener: (event: IGrantStoreChangeEvent) => void) => this.emitter.event(listener);

	async commitOutside(change: IGrantStoreChange): Promise<GrantCommitResult> {
		const subjects = this.data.grants.filter(grant => change.revoke?.includes(grant.id)).map(grant => grant.subject);
		const result = await this.commit(this.data.epoch, change);
		this.emitter.fire({ epoch: result.epoch, subjects, narrowed: !!change.revoke?.length });
		return result;
	}

	dispose(): void {
		this.emitter.dispose();
	}
}
