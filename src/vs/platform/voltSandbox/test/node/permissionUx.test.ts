/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P4 on the execution host: the network broker's approvals land in the grant store and survive a
 * restart, a revocation made through the store (the Access page, from this process or another)
 * closes the tunnels it allowed, a signer change drops grants, and the Access page's history
 * reads the decision log and the audit logs. The broker is driven over loopback like a sandboxed
 * client, with a fake resolver and a connector to a local echo server (see networkBroker.test.ts).
 */

import assert from 'assert';
import { promises as fs } from 'fs';
import * as net from 'net';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IPrincipal, SubjectKey } from '../../common/principals.js';
import { signerChangeDrops } from '../../common/trust.js';
import { GrantStore } from '../../node/grantStore.js';
import { INetworkDenial, NetworkBroker, NetworkRoute } from '../../node/networkBroker.js';
import { TrustHost } from '../../node/trustHost.js';

let count = 0;
function principal(subject: SubjectKey): IPrincipal {
	return { id: `p${++count}`, subject, kind: 'agent', executionHost: 'local', launchPolicyHash: '', createdAt: 0 };
}

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	return check();
}

interface IConnection {
	readonly socket: net.Socket;
	readonly line: string;
	readonly closed: Promise<void>;
}

/** CONNECT through `route` to `authority`: the status line and the open socket. */
async function connect(route: NetworkRoute, authority: string): Promise<IConnection> {
	const socket = net.connect({ host: '127.0.0.1', port: route.port });
	socket.on('error', () => undefined);
	let buffer = '';
	socket.on('data', data => { buffer += data.toString('latin1'); });
	const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
	await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject); });
	socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${Buffer.from(`volt:${route.token}`).toString('base64')}\r\n\r\n`);
	await until(() => buffer.includes('\r\n'), 5000);
	return { socket, line: buffer.slice(0, buffer.indexOf('\r\n')), closed };
}

suite('Volt permission UX on the execution host (P4)', function () {

	this.timeout(20_000);

	let dir: string;
	let upstream: net.Server;
	let upstreamPort: number;
	const sockets = new Set<net.Socket>();
	const cleanup: { dispose(): void }[] = [];

	function broker(grants: GrantStore): NetworkBroker {
		const made = new NetworkBroker({
			grants,
			lookup: async () => [{ address: '93.184.216.34', family: 4 }],
			connect: () => net.connect({ host: '127.0.0.1', port: upstreamPort }),
			tunnelIdleMs: 2000,
		});
		cleanup.push(made);
		return made;
	}

	setup(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'volt-p4-'));
		upstream = net.createServer(socket => {
			sockets.add(socket);
			socket.on('error', () => undefined);
			socket.once('close', () => sockets.delete(socket));
			socket.pipe(socket);
		});
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		upstreamPort = (upstream.address() as net.AddressInfo).port;
	});

	teardown(async () => {
		cleanup.splice(0).reverse().forEach(item => item.dispose());
		sockets.forEach(socket => socket.destroy());
		await new Promise<void>(resolve => upstream.close(() => resolve()));
		await fs.rm(dir, { recursive: true, force: true });
	});

	// After the teardown above, so what each test made is disposed before the leak check.
	ensureNoDisposablesAreLeakedInTestSuite();

	test('UX-GRANT-1: "Allow for This Chat" is a chat grant in the store: it outlives the run and a restart; "Allow" ends with the run', async () => {
		const path = join(dir, 'grants.json');
		const store = await GrantStore.open(path);
		cleanup.push(store);
		const first = broker(store);
		const denials: INetworkDenial[] = [];
		const chat: SubjectKey = 'chat:c-persist';
		const run = await first.openRoute({ principal: principal(chat), allow: [], onDenial: denial => denials.push(denial) });
		assert.match((await connect(run, 'chat.test:443')).line, /403/);
		assert.match((await connect(run, 'run.test:443')).line, /403/);
		const [forChat, forRun] = denials;
		// The broker names the denial; the window answers by id and epoch (the Allow buttons).
		assert.ok((await first.approve(forChat.denialId, first.epoch, 'chat')).ok);
		assert.ok((await first.approve(forRun.denialId, first.epoch, 'run')).ok);
		assert.match((await connect(run, 'chat.test:443')).line, /200/);
		assert.match((await connect(run, 'run.test:443')).line, /200/);
		const onDisk = JSON.parse(await fs.readFile(path, 'utf8'));
		assert.deepStrictEqual(onDisk.grants.map((grant: { scope: { targets: string[] }; sessionId: string }) => `${grant.scope.targets[0]}@${grant.sessionId}`).sort(), [`chat.test@c-persist`, `run.test@${run.principal.id}`]);
		run.dispose();
		assert.ok(await until(() => store.data.grants.length === 1), 'the run\'s own grant goes with the run');
		first.dispose();
		store.dispose();

		// "Restart": a new store on the same file, a new broker, a new run of the same chat.
		const reopened = await GrantStore.open(path);
		cleanup.push(reopened);
		const second = broker(reopened);
		const later = await second.openRoute({ principal: principal(chat), allow: [] });
		assert.match((await connect(later, 'chat.test:443')).line, /200/, 'the chat grant holds for the next run');
		assert.match((await connect(later, 'run.test:443')).line, /403/, 'the run grant did not');
		const other = await second.openRoute({ principal: principal('chat:c-other'), allow: [] });
		assert.match((await connect(other, 'chat.test:443')).line, /403/, 'and only for that chat');
	});

	test('UX-REVOKE-1 / REV-1: revoking on the Access page (the store, from another process) closes the tunnel it allowed', async () => {
		const host = new TrustHost(dir);
		cleanup.push(host);
		// The broker's process has its own store on the same file, watched.
		const store = await GrantStore.open(host.storePath);
		cleanup.push(store, store.watch(10));
		const made = broker(store);
		const denials: INetworkDenial[] = [];
		const route = await made.openRoute({ principal: principal('chat:c-revoke'), allow: [], onDenial: denial => denials.push(denial) });
		assert.match((await connect(route, 'revoked.test:443')).line, /403/);
		assert.ok((await made.approve(denials[0].denialId, made.epoch, 'chat')).ok);
		const tunnel = await connect(route, 'revoked.test:443');
		assert.match(tunnel.line, /200/);
		const state = await host.state();
		assert.strictEqual(state.grants.length, 1, 'the Access page sees the grant');
		const started = Date.now();
		await host.commit({ revoke: state.grants.map(grant => grant.id) });
		await Promise.race([tunnel.closed, new Promise(resolve => setTimeout(resolve, 2000))]);
		assert.ok(tunnel.socket.destroyed, `the tunnel closed (${Date.now() - started} ms)`);
		assert.match((await connect(route, 'revoked.test:443')).line, /403/, 'and the next connection is refused');
	});

	test('UX-APPROVE-1: approvals are by denial id and epoch only; a stale epoch, an unknown id and a private address are refused', async () => {
		const store = await GrantStore.open(join(dir, 'grants.json'));
		cleanup.push(store);
		const made = broker(store);
		const denials: INetworkDenial[] = [];
		const route = await made.openRoute({ principal: principal('chat:c-cas'), allow: [], onDenial: denial => denials.push(denial) });
		assert.match((await connect(route, 'cas.test:443')).line, /403/);
		const denial = denials[0];
		assert.strictEqual(typeof denial.epoch, 'number');
		assert.ok(!(await made.approve('forged-id', made.epoch, 'chat')).ok, 'an id the broker never recorded');
		await store.update({ add: [{ id: 'elsewhere', subject: 'chat:c-x', capability: 'net.connect@1', scope: { targets: ['x.test'] }, kind: 'persistent', source: 'user', grantedAt: 1, lastUsedAt: 1 }] });
		const stale = await made.approve(denial.denialId, denial.epoch, 'chat');
		assert.ok(!stale.ok && /changed/.test(stale.reason), 'the epoch moved since the denial');
		assert.ok((await made.approve(denial.denialId, made.epoch, 'chat')).ok);
		assert.match((await connect(route, '10.1.2.3:443')).line, /403/);
		assert.ok(!(await made.approve(denials.at(-1)!.denialId, made.epoch, 'chat')).ok, 'a private address is never approvable');
		// Skip counts toward the refusals: two, and nothing more is offered until the Access page is opened.
		assert.match((await connect(route, 'skip1.test:443')).line, /403/);
		assert.ok(made.refuse(denials.at(-1)!.denialId));
		assert.match((await connect(route, 'skip2.test:443')).line, /403/);
		assert.ok(made.refuse(denials.at(-1)!.denialId));
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.match((await connect(route, 'skip3.test:443')).line, /403/);
		assert.strictEqual(denials.at(-1)!.promptable, false, 'auto-denied after two refusals (G.12)');
		assert.deepStrictEqual(made.promptBudgets().map(budget => [budget.subject, budget.autoDenied]), [['chat:c-cas', true]]);
		made.resetPromptBudget('chat:c-cas');
		assert.strictEqual(made.promptBudgets()[0].autoDenied, false, 'the Access page resets it');
	});

	test('UX-SIGNER-1: a signer change drops every grant and refusal of the old signer\'s subject', async () => {
		const host = new TrustHost(dir, { watch: false });
		cleanup.push(host);
		await host.commit({
			add: [
				{ id: 'a', subject: 'plugin:acme.notes@local', capability: 'agents.send@1', scope: {}, kind: 'persistent', source: 'user', grantedAt: 1, lastUsedAt: 1 },
				{ id: 'b', subject: 'plugin:acme.other@local', capability: 'agents.send@1', scope: {}, kind: 'persistent', source: 'user', grantedAt: 1, lastUsedAt: 1 },
			],
			refuse: [{ subject: 'plugin:acme.notes@local', capability: 'git.read@1', at: 1 }],
		});
		const drops = signerChangeDrops(await host.state(), 'Acme.Notes', 'openvsx:acme');
		assert.deepStrictEqual(drops, ['plugin:acme.notes@local']);
		assert.deepStrictEqual(signerChangeDrops(await host.state(), 'acme.notes', 'local'), [], 'the same signer keeps them');
		await host.commit({ dropSubjects: drops });
		const after = await host.state();
		assert.deepStrictEqual(after.grants.map(grant => grant.id), ['b']);
		assert.deepStrictEqual(after.refusals, []);
	});

	test('UX-STORE-1: a window records only the user\'s grants, never a first-party or preset one', async () => {
		const host = new TrustHost(dir, { watch: false });
		cleanup.push(host);
		const draft = { id: 'x', capability: 'agents.send@1', scope: {}, kind: 'persistent' as const, grantedAt: 1, lastUsedAt: 1 };
		await assert.rejects(host.commit({ add: [{ ...draft, subject: 'firstparty:volt.usage', source: 'user' }] }), /can't be granted/);
		await assert.rejects(host.commit({ add: [{ ...draft, subject: 'plugin:a.b@local', source: 'preset' }] }), /user's own/);
		assert.strictEqual((await host.commit({ add: [{ ...draft, subject: 'plugin:a.b@local', source: 'user' }] })).changed, true);
		await host.commit({ refuse: [{ subject: 'plugin:a.b@local', capability: 'git.read@1', at: 2 }] });
		await host.commit({ unrefuse: [{ subject: 'plugin:a.b@local', capability: 'git.read' }] });
		assert.deepStrictEqual((await host.state()).refusals, [], 'a refusal is forgotten when the user allows it after all');
	});

	test('UX-HISTORY-1: the history merges the decision log and the network and brokers\' audit logs, newest first', async () => {
		await fs.mkdir(join(dir, 'audit'), { recursive: true });
		await fs.mkdir(join(dir, 'decisions'), { recursive: true });
		await fs.writeFile(join(dir, 'audit', 'network.log'), [
			JSON.stringify({ ts: 10, principal: 'p', subject: 'chat:a', chain: [], method: 'CONNECT', destination: 'x.test', port: 443, decision: 'deny', reason: 'not-allowed', epoch: 1 }),
			'not json',
			JSON.stringify({ ts: 30, principal: 'p', subject: 'chat:a', chain: [], method: 'CONNECT', destination: 'x.test', port: 8443, decision: 'allow', epoch: 2 }),
		].join('\n'));
		await fs.writeFile(join(dir, 'audit', 'brokers.log'), JSON.stringify({ ts: 20, broker: 'files', method: 'read', principal: 'p', subject: 'plugin:a.b@local', chain: [], target: 'hash', decision: 'deny', deniedBy: 'manifest', epoch: 1 }) + '\n');
		await fs.writeFile(join(dir, 'decisions', 'decisions.log'), [
			JSON.stringify({ type: 'snapshot', digest: 'd', snapshot: {} }),
			JSON.stringify({ type: 'decision', at: 40, epoch: 3, snapshotDigest: 'd', request: { capability: 'agents.send', target: 'chat:b' }, context: { principal: { subject: 'plugin:a.b@local' } }, ctxDigest: 'c', decision: { allow: false, reason: 'needs consent' } }),
		].join('\n'));
		const host = new TrustHost(dir, { watch: false });
		cleanup.push(host);
		const history = await host.history(10);
		assert.deepStrictEqual(history.map(entry => `${entry.at} ${entry.source} ${entry.subject} ${entry.action} ${entry.target} ${entry.decision}`), [
			'40 decision plugin:a.b@local agents.send chat:b deny',
			'30 network chat:a CONNECT x.test:8443 allow',
			'20 broker plugin:a.b@local files.read hash deny',
			'10 network chat:a CONNECT x.test deny',
		]);
		assert.deepStrictEqual((await host.history(10, 'chat:a')).map(entry => entry.at), [30, 10]);
		assert.strictEqual((await host.history(1)).length, 1);
	});
});
