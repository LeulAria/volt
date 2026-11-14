/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The decision log (spec G.11, INV-32): POL-DET-1 through the real file (every logged decision
 * replays to the same decision from the snapshot logged with it), tampering is caught, files are
 * 0600 and every rotated file replays on its own. Also the admin layer's reader (G.1): managed
 * policy from an injected source, XML and binary plists, and failing closed.
 */

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { evaluate, IAccessRequest, IPolicySnapshotInput, PolicySnapshot } from '../../common/authority.js';
import { corePrincipal, ICallContext, SubjectKey } from '../../common/principals.js';
import { IAdminPolicySource, parsePlist, readAdminPolicy } from '../../node/adminPolicy.js';
import { DecisionLog, replayDecisionLog } from '../../node/decisionLog.js';

const NOW = 1_800_000_000_000;
const PLUGIN: SubjectKey = 'plugin:acme.linear@local';
const CHAT: SubjectKey = 'chat:c1';

const INPUT: IPolicySnapshotInput = {
	epoch: 1,
	asOf: NOW,
	chats: [{ subject: CHAT, settings: { level: 'workspace-write', network: false } }],
	manifests: [{ subject: PLUGIN, declared: [{ id: 'tools.register' }, { id: 'net.connect', targets: ['api.linear.app'] }, { id: 'agents.send' }, { id: 'browser.drive' }], network: 'broker' }],
	grants: [{ id: 'g', subject: PLUGIN, capability: 'agents.send@1', scope: {}, kind: 'persistent', source: 'user', grantedAt: NOW, lastUsedAt: NOW, epoch: 1 }],
};

const REQUESTS: readonly { request: IAccessRequest; context: ICallContext }[] = [
	{ request: { capability: 'tools.register', target: 'linear_sync', edge: 'tool' }, context: { principal: corePrincipal('p', PLUGIN, 't3'), onBehalfOf: [corePrincipal('c', CHAT, 'agent')], requestId: 'a' } },
	{ request: { capability: 'net.connect', target: 'api.linear.app' }, context: { principal: corePrincipal('p', PLUGIN, 't3'), onBehalfOf: [], requestId: 'b' } },
	{ request: { capability: 'agents.send', target: 'chat:x' }, context: { principal: corePrincipal('p', PLUGIN, 't3'), onBehalfOf: [], requestId: 'c' } },
	{ request: { capability: 'files.write', target: '~/.ssh/config' }, context: { principal: corePrincipal('c', CHAT, 'agent'), onBehalfOf: [], requestId: 'd' } },
	{ request: { capability: 'agents.create' }, context: { principal: corePrincipal('c', CHAT, 'agent'), onBehalfOf: [], requestId: 'e' } },
];

suite('Volt decision log (C2)', function () {

	this.timeout(20_000);
	ensureNoDisposablesAreLeakedInTestSuite();
	let dir: string;

	setup(async () => {
		dir = join(await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-decisions-'))), 'decisions');
	});

	teardown(async () => {
		await fs.rm(join(dir, '..'), { recursive: true, force: true });
	});

	async function logDay(log: DecisionLog, epochs: number): Promise<number> {
		let count = 0;
		for (let epoch = 1; epoch <= epochs; epoch++) {
			// Each epoch a different snapshot: a grant revoked, then a flow approved, then a later time.
			const snapshot = PolicySnapshot.build({ ...INPUT, epoch, asOf: NOW + epoch * 1000, grants: epoch % 2 ? INPUT.grants : [] });
			for (const { request, context } of REQUESTS) {
				await log.append(snapshot, request, context, evaluate(snapshot, request, context));
				count++;
			}
		}
		await log.flush();
		return count;
	}

	test('POL-DET-1: a day\'s logged decisions replay to identical decisions from their stored snapshots', async () => {
		const log = new DecisionLog(dir, { now: () => NOW });
		const count = await logDay(log, 6);
		const file = join(dir, 'decisions.log');
		const result = await replayDecisionLog(file);
		assert.deepStrictEqual(result, { decisions: count, mismatches: [], unproven: 0 });
		const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
		assert.strictEqual(lines.filter(line => line.type === 'snapshot').length, 6, 'each snapshot once');
		const decision = lines.find(line => line.type === 'decision');
		assert.deepStrictEqual(Object.keys(decision).sort(), ['at', 'context', 'ctxDigest', 'decision', 'epoch', 'reqDigest', 'request', 'snapshotDigest', 'type', 'v']);
		if (process.platform !== 'win32') {
			assert.strictEqual((await fs.stat(file)).mode & 0o777, 0o600);
			assert.strictEqual((await fs.stat(dir)).mode & 0o777, 0o700);
		}
	});

	test('POL-DET-1: an edited decision, snapshot or context in the log is reported, never silently replayed', async () => {
		const log = new DecisionLog(dir, { now: () => NOW });
		await logDay(log, 2);
		const file = join(dir, 'decisions.log');
		const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
		const decisionAt = lines.findIndex(line => line.type === 'decision' && !line.decision.allow);
		lines[decisionAt] = { ...lines[decisionAt], decision: { ...lines[decisionAt].decision, allow: true } };
		const contextAt = lines.findIndex((line, i) => i > decisionAt && line.type === 'decision');
		lines[contextAt] = { ...lines[contextAt], context: { ...lines[contextAt].context, requestId: 'forged' } };
		const snapshotAt = lines.findIndex((line, i) => i > contextAt && line.type === 'snapshot');
		lines[snapshotAt] = { ...lines[snapshotAt], snapshot: { ...lines[snapshotAt].snapshot, admin: { denyCapabilities: ['net.connect'] } } };
		await fs.writeFile(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
		const { mismatches } = await replayDecisionLog(file);
		assert.ok(mismatches.some(m => m.line === decisionAt + 1 && typeof m.replayed !== 'string'), 'the flipped decision');
		assert.ok(mismatches.some(m => m.line === contextAt + 1 && /does not match its digest/.test(String(m.replayed))), 'the edited context');
		assert.ok(mismatches.some(m => m.line > snapshotAt + 1 && /is not the logged/.test(String(m.replayed))), 'decisions on the edited snapshot');
	});

	test('POL-DET-2: an edited request is reported even when it decides the same; an older Volt\'s records replay, marked unproven (05-limitations 28)', async () => {
		const log = new DecisionLog(dir, { now: () => NOW });
		const count = await logDay(log, 2);
		const file = join(dir, 'decisions.log');
		const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
		// A denied request moved to another denied target: the same decision, a different request.
		const at = lines.findIndex(line => line.type === 'decision' && line.request.capability === 'files.write');
		const edited = lines.map((line, i) => i === at ? { ...line, request: { ...line.request, target: '~/.aws/credentials' } } : line);
		await fs.writeFile(file, edited.map(line => JSON.stringify(line)).join('\n') + '\n');
		assert.deepStrictEqual((await replayDecisionLog(file)).mismatches.map(m => [m.line, m.replayed]), [[at + 1, 'the logged request does not match its digest']]);
		// Version 1 records (no `v`, no `reqDigest`), as an older Volt wrote them.
		const v1 = lines.map(line => {
			if (line.type !== 'decision') {
				return line;
			}
			const { v: _v, reqDigest: _reqDigest, ...rest } = line;
			return rest;
		});
		await fs.writeFile(file, v1.map(line => JSON.stringify(line)).join('\n') + '\n');
		assert.deepStrictEqual(await replayDecisionLog(file), { decisions: count, mismatches: [], unproven: count }, 'replayed, without request proof');
		// A version from the future is not silently replayed.
		const future = lines.map((line, i) => i === at ? { ...line, v: 99 } : line);
		await fs.writeFile(file, future.map(line => JSON.stringify(line)).join('\n') + '\n');
		assert.ok((await replayDecisionLog(file)).mismatches.some(m => /version 99/.test(String(m.replayed))));
	});

	test('rotation: files rotate by size, old ones are dropped, and each file replays on its own', async () => {
		const log = new DecisionLog(dir, { now: () => NOW, maxBytes: 8_000, keep: 2 });
		await logDay(log, 12);
		const names = (await fs.readdir(dir)).sort();
		assert.deepStrictEqual(names, ['decisions.1.log', 'decisions.2.log', 'decisions.log']);
		for (const name of names) {
			const { decisions, mismatches } = await replayDecisionLog(join(dir, name));
			assert.ok(decisions > 0, name);
			assert.deepStrictEqual(mismatches, [], name);
		}
		// A new process appending to the same folder starts a fresh, self-contained file.
		const later = new DecisionLog(dir, { now: () => NOW, maxBytes: 8_000, keep: 2 });
		await logDay(later, 1);
		assert.deepStrictEqual(await replayDecisionLog(join(dir, 'decisions.log')), { decisions: REQUESTS.length, mismatches: [], unproven: 0 });
	});
});

suite('Volt admin policy (G.1 admin layer)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// `plutil -convert binary1` of the XML below.
	const BINARY = 'YnBsaXN0MDDTAQIDBAUHXxASbWF4VGhpcmRQYXJ0eUNsYXNzXxAQZGVueUNhcGFiaWxpdGllc1lkZW55SG9zdHNWbWVkaXVtoQZdYnJvd3Nlci5kcml2ZaEIXxAPKi5wYXN0ZS5leGFtcGxlCA8kN0FISlhaAAAAAAAAAQEAAAAAAAAACQAAAAAAAAAAAAAAAAAAAGw=';
	const XML = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		'<dict>',
		'\t<key>denyCapabilities</key>',
		'\t<array>',
		'\t\t<string>browser.drive</string>',
		'\t</array>',
		'\t<key>denyHosts</key>',
		'\t<array>',
		'\t\t<string>*.paste.example</string>',
		'\t</array>',
		'\t<key>maxThirdPartyClass</key>',
		'\t<string>medium</string>',
		'</dict>',
		'</plist>',
	].join('\n');
	const EXPECTED = { denyCapabilities: ['browser.drive'], denyHosts: ['*.paste.example'], maxThirdPartyClass: 'medium' };

	const source = (result: Awaited<ReturnType<IAdminPolicySource['read']>> | Error): IAdminPolicySource => ({
		read: async () => {
			if (result instanceof Error) {
				throw result;
			}
			return result;
		},
	});

	test('managed preferences: XML and binary plists read the same', () => {
		assert.deepStrictEqual(parsePlist(new TextEncoder().encode(XML)), EXPECTED);
		assert.deepStrictEqual(parsePlist(Uint8Array.from(atob(BINARY), c => c.charCodeAt(0))), EXPECTED);
		assert.throws(() => parsePlist(new TextEncoder().encode('<plist><dict><key>a</key><date>2026</date></dict></plist>')), /unsupported/);
		assert.throws(() => parsePlist(new TextEncoder().encode('bplist00short')), /truncated/);
	});

	test('the admin layer restricts through the Authority, and only restricts', async () => {
		const policy = await readAdminPolicy(source({ source: 'test', value: parsePlist(new TextEncoder().encode(XML)) }));
		assert.deepStrictEqual({ ...policy, source: undefined }, { ...EXPECTED, source: undefined });
		// The user allowed the plugin to drive the browser; the admin's policy still refuses it.
		const grants = [...INPUT.grants!, { ...INPUT.grants![0], id: 'drive', capability: 'browser.drive@1' }];
		const snapshot = PolicySnapshot.build({ ...INPUT, admin: policy, grants, manifests: [...INPUT.manifests!, { subject: 'firstparty:volt.browser', declared: [{ id: 'browser.drive' }], network: 'broker' }] });
		const plugin = { principal: corePrincipal('p', PLUGIN, 't3'), onBehalfOf: [], requestId: 'r' };
		assert.ok(evaluate(PolicySnapshot.build({ ...snapshot.input, admin: undefined }), { capability: 'browser.drive' }, plugin).allow, 'allowed without the admin layer');
		assert.strictEqual(evaluate(snapshot, { capability: 'browser.drive' }, plugin).code, 'admin-capability');
		assert.strictEqual(evaluate(snapshot, { capability: 'browser.drive' }, { ...plugin, principal: corePrincipal('b', 'firstparty:volt.browser', 't2') }).code, 'admin-capability', 'for everyone');
		assert.ok(evaluate(snapshot, { capability: 'net.connect', target: 'api.linear.app' }, plugin).allow);
		assert.ok(evaluate(snapshot, { capability: 'agents.send', target: 'chat:x' }, plugin).allow, 'medium is at the cap');
	});

	test('fails closed: a policy that is there but unreadable, throws, or is malformed leaves third parties nothing', async () => {
		assert.deepStrictEqual(await readAdminPolicy(source(undefined)), {});
		assert.deepStrictEqual(await readAdminPolicy(source({ source: '/etc/volt/policy.json', unreadable: 'not owned by root' })), { unreadable: true, source: '/etc/volt/policy.json', problem: 'not owned by root' });
		assert.strictEqual((await readAdminPolicy(source(new Error('registry broke')))).unreadable, true);
		assert.strictEqual((await readAdminPolicy(source({ source: 'x', value: { denyHosts: 'everything' } }))).unreadable, true);
		assert.strictEqual((await readAdminPolicy(source({ source: 'x', value: { maxThirdPartyClass: 'none-at-all' } }))).unreadable, true);
		assert.strictEqual((await readAdminPolicy(source({ source: 'HKLM', value: { Policy: '{not json' } }))).unreadable, true);
		assert.deepStrictEqual((await readAdminPolicy(source({ source: 'HKLM', value: { Policy: '{"denyCapabilities":["git.push"]}' } }))).denyCapabilities, ['git.push'], 'one Policy key holding the JSON (Windows)');
		const unreadable = await readAdminPolicy(source({ source: 'x', unreadable: 'bad' }));
		const snapshot = PolicySnapshot.build({ ...INPUT, admin: unreadable });
		assert.strictEqual(evaluate(snapshot, { capability: 'net.connect', target: 'api.linear.app' }, { principal: corePrincipal('p', PLUGIN, 't3'), onBehalfOf: [], requestId: 'r' }).code, 'admin-unreadable');
		assert.ok(evaluate(snapshot, { capability: 'storage.own' }, { principal: corePrincipal('p', PLUGIN, 't3'), onBehalfOf: [], requestId: 'r' }).allow, 'class none stays');
	});
});
