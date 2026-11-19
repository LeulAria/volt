/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IRequestContext } from '../../../../../base/parts/request/common/request.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IVoltHttpRequestOptions, IVoltHttpTransport } from '../../../../../platform/voltHttp/common/voltHttpTransport.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { emptyHttpCollection, emptyHttpRequest, IHttpRequest } from '../../common/httpCollection.js';
import { defaultHttpSecurityOptions, emptyHttpSecurityFile, HTTP_SECURITY_BURST, IHttpSecurityAuthorizedHost, IHttpSecurityOptions, parseHttpSecurityFile, serializeHttpSecurityFile } from '../../common/httpSecurity.js';
import { IHttpCollectionEntry, IHttpSendContext, IVoltHttpCollections } from '../../browser/voltHttpCollections.js';
import { VoltHttpSecurity } from '../../browser/voltHttpSecurity.js';
import { IHttpExchange, IVoltHttpService } from '../../browser/voltHttpService.js';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const ROOT = URI.file('/repo');
const COLLECTION_REF = 'http/shop.postman_collection.json';
const COLLECTION = joinPath(ROOT, COLLECTION_REF);
const SCAN = joinPath(ROOT, 'http/security/shop.volt-security.json');
const HOST = 'api.example.com';

interface IAnswer { readonly status: number; readonly headers?: Record<string, string>; readonly body?: string }

interface ISent { readonly kind: 'baseline' | 'probe'; readonly method: string; readonly url: string; readonly at: number }

/** A clock the scan's pacing moves forward instead of waiting. */
class TestSecurity extends VoltHttpSecurity {
	clock = NOW;
	protected override now(): number {
		return this.clock;
	}
	protected override wait(ms: number, _token: CancellationToken): Promise<void> {
		this.clock += ms;
		return Promise.resolve();
	}
}

function request(name: string, method: string, url: string): IHttpRequest {
	const made = emptyHttpRequest(name, 'none');
	made.method = method;
	made.url = url;
	return made;
}

suite('Volt Client: security scan service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface ISetup {
		readonly requests: readonly IHttpRequest[];
		readonly options?: Partial<IHttpSecurityOptions>;
		/** As written into the file (by hand, an agent, a teammate): never an authorization by itself. */
		readonly fileHosts?: readonly IHttpSecurityAuthorizedHost[];
		/** The answer to a request the scan's own sender sends (a baseline). */
		readonly baseline?: IAnswer;
		/** The answer to a probe; `index` counts probes from 1. */
		readonly probe?: (options: IVoltHttpRequestOptions, index: number) => IAnswer;
	}

	async function setup(input: ISetup) {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		const storage = store.add(new InMemoryStorageService());
		const collection = emptyHttpCollection('Shop', 'postman');
		collection.items.push(...input.requests);
		const entry: IHttpCollectionEntry = { uri: COLLECTION, collection, indent: '\t' };
		const sent: ISent[] = [];
		const ref: { security?: TestSecurity } = {};
		const baselineAnswer: IAnswer = input.baseline ?? { status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":1,"name":"Ada"}' };
		const collections = {
			load: async (uri: URI) => uri.toString() === COLLECTION.toString() ? entry : undefined,
			get: (uri: URI) => uri.toString() === COLLECTION.toString() ? entry : undefined,
			draftOf: () => undefined,
			variablesFor: async () => new Map(),
			send: async (sentRequest: IHttpRequest, context: IHttpSendContext): Promise<IHttpExchange> => {
				assert.strictEqual(context.collection?.toString(), COLLECTION.toString());
				sent.push({ kind: 'baseline', method: sentRequest.method, url: sentRequest.url, at: ref.security!.clock });
				return {
					id: sentRequest.id, at: ref.security!.clock, method: sentRequest.method, url: sentRequest.url,
					headers: [['Authorization', 'Bearer token-0123456789']],
					response: { status: baselineAnswer.status, statusText: 'OK', headers: baselineAnswer.headers ?? {}, body: baselineAnswer.body ?? '', durationMs: 4, size: (baselineAnswer.body ?? '').length },
				} as unknown as IHttpExchange;
			},
		} as unknown as IVoltHttpCollections;
		let probes = 0;
		const transport = {
			request: async (options: IVoltHttpRequestOptions): Promise<IRequestContext> => {
				probes++;
				sent.push({ kind: 'probe', method: options.type ?? 'GET', url: options.url ?? '', at: ref.security!.clock });
				const answer = input.probe?.(options, probes) ?? baselineAnswer;
				return { res: { headers: answer.headers ?? {}, statusCode: answer.status }, stream: bufferToStream(VSBuffer.fromString(answer.body ?? '')) };
			},
		} as unknown as IVoltHttpTransport;
		const http = {
			foldersOf: () => [ROOT],
			historyOf: () => [],
			scopeOf: (file: Readonly<Record<string, string>>, env: Readonly<Record<string, string>>) => ({ file, env, responses: new Map() }),
		} as unknown as IVoltHttpService;
		const search = { fileSearch: async () => ({ results: [] }) } as unknown as ISearchService;
		const instantiation = {} as IInstantiationService;
		const security = ref.security = store.add(new TestSecurity(http, collections, transport, fileService, search, new TestConfigurationService(), instantiation, storage));
		const file = { ...emptyHttpSecurityFile('Shop'), targets: [{ collection: COLLECTION_REF }], options: { ...defaultHttpSecurityOptions(), ...input.options }, authorizedHosts: [...(input.fileHosts ?? [])] };
		await fileService.writeFile(SCAN, VSBuffer.fromString(serializeHttpSecurityFile(file)));
		const saved = async () => parseHttpSecurityFile((await fileService.readFile(SCAN)).value.toString(), 'x');
		return { security, sent, saved, fileService, storage, probes: () => sent.filter(item => item.kind === 'probe'), baselines: () => sent.filter(item => item.kind === 'baseline') };
	}

	const users = () => [request('List users', 'GET', `https://${HOST}/users?q=a`), request('Get user', 'GET', `https://${HOST}/users/7`)];

	test('passive by default: each request once, no probe, findings saved into the file', async () => {
		const { security, sent, saved, probes } = await setup({ requests: users() });
		const state = await security.scan(SCAN, { root: ROOT });
		assert.strictEqual(probes().length, 0);
		assert.deepStrictEqual(sent.map(item => `${item.kind} ${item.method} ${item.url}`), [`baseline GET https://${HOST}/users?q=a`, `baseline GET https://${HOST}/users/7`]);
		assert.strictEqual(state.running, false);
		assert.strictEqual(state.active, false);
		assert.strictEqual(state.requests, 2);
		assert.ok(state.findings.some(finding => finding.checkId === 'headers.hsts'));
		const file = await saved();
		assert.strictEqual(file.lastScan?.requests, 2);
		assert.strictEqual(file.lastScan?.active, false);
		assert.deepStrictEqual(file.lastScan?.findings.map(finding => finding.fingerprint), state.findings.map(finding => finding.fingerprint));
		assert.ok(!JSON.stringify(file.lastScan).includes('token-0123456789'), 'the saved evidence is masked');
	});

	test('a host-wide finding over several requests is one finding with a count', async () => {
		const { security } = await setup({ requests: users() });
		const state = await security.scan(SCAN, { root: ROOT });
		const hsts = state.findings.filter(finding => finding.checkId === 'headers.hsts');
		assert.strictEqual(hsts.length, 1);
		assert.strictEqual(hsts[0].occurrences, 2);
	});

	test('active checks asked for, host not authorized: not one probe, and the scan says why', async () => {
		const { security, probes } = await setup({ requests: users(), options: { active: true } });
		const state = await security.scan(SCAN, { root: ROOT });
		assert.strictEqual(probes().length, 0);
		assert.strictEqual(state.active, false);
		assert.ok(state.notes.some(note => note.includes(`${HOST} is not authorized`)), state.notes.join('\n'));
	});

	test('a host only written into the file (by an agent or by hand) authorizes nothing', async () => {
		const { security, probes } = await setup({ requests: users(), options: { active: true }, fileHosts: [{ host: HOST, at: '2026-11-18T00:00:00.000Z' }] });
		await security.load(SCAN);
		assert.deepStrictEqual(security.authorizedHostsOf(SCAN), []);
		assert.strictEqual(security.isAuthorized(SCAN, HOST), false);
		const state = await security.scan(SCAN, { root: ROOT });
		assert.strictEqual(probes().length, 0);
		assert.strictEqual(state.active, false);
	});

	test('a scan definition an agent saves cannot carry authorizations or triage, and keeps the user\'s', async () => {
		const { security, saved } = await setup({ requests: users() });
		const created = await security.saveDefinition(ROOT, { name: 'Agent scan', targets: [{ collection: COLLECTION_REF }], options: { active: true }, authorizedHosts: [{ host: HOST, at: '2026-11-18' }], triage: { abc: 'falsePositive' } });
		const fresh = (await security.load(created))!.file;
		assert.deepStrictEqual(fresh.authorizedHosts, []);
		assert.deepStrictEqual(fresh.triage, {});
		assert.strictEqual(fresh.options.active, true, 'it may ask for active checks; only the user can let them run');
		assert.strictEqual(security.isAuthorized(created, HOST), false);

		await security.setAuthorized(SCAN, HOST, true);
		await security.saveDefinition(ROOT, { name: 'Shop again', targets: [{ collection: COLLECTION_REF }], authorizedHosts: [{ host: 'evil.example.com', at: '2026-11-18' }] }, SCAN);
		const file = await saved();
		assert.strictEqual(file.name, 'Shop again');
		assert.deepStrictEqual(file.authorizedHosts.map(item => item.host), [HOST]);
		assert.strictEqual(security.isAuthorized(SCAN, HOST), true);
		assert.strictEqual(security.isAuthorized(SCAN, 'evil.example.com'), false);
	});

	test('authorized by the user: probes go out, only to that host, only safe methods, at the file\'s rate', async () => {
		const { security, sent, saved, probes } = await setup({
			requests: users(),
			options: { active: true, requestsPerSecond: 2 },
			// Rate limit headers on the answer: no burst, so every request is paced.
			baseline: { status: 200, headers: { 'content-type': 'application/json', 'ratelimit-limit': '100' }, body: '{"id":1,"name":"Ada"}' },
		});
		await security.setAuthorized(SCAN, HOST, true);
		const authorized = (await saved()).authorizedHosts;
		assert.deepStrictEqual(authorized.map(item => [item.host, item.at]), [[HOST, new Date(NOW).toISOString()]], 'the authorization is kept with its date');
		const state = await security.scan(SCAN, { root: ROOT });
		assert.strictEqual(state.active, true);
		assert.ok(probes().length > 10, String(probes().length));
		assert.strictEqual(state.probes, probes().length);
		for (const item of probes()) {
			assert.strictEqual(new URL(item.url).host, HOST, item.url);
			assert.ok(['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(item.method.toUpperCase()), item.method);
		}
		for (let index = 1; index < sent.length; index++) {
			assert.ok(sent[index].at - sent[index - 1].at >= 500, `request ${index} went out ${sent[index].at - sent[index - 1].at} ms after the one before`);
		}
		assert.strictEqual((await saved()).lastScan?.active, true);
	});

	test('the burst is the only unpaced run, and it is at most fifteen requests', async () => {
		const { security, sent } = await setup({ requests: users(), options: { active: true, requestsPerSecond: 5 } });
		await security.setAuthorized(SCAN, HOST, true);
		await security.scan(SCAN, { root: ROOT });
		let run = 1;
		let longest = 1;
		for (let index = 1; index < sent.length; index++) {
			run = sent[index].at - sent[index - 1].at < 200 ? run + 1 : 1;
			longest = Math.max(longest, run);
		}
		assert.ok(longest > 1, 'the burst ran');
		assert.ok(longest <= HTTP_SECURITY_BURST, String(longest));
	});

	test('a scan told to stay passive sends no probe even when everything is authorized', async () => {
		const { security, probes } = await setup({ requests: users(), options: { active: true } });
		await security.setAuthorized(SCAN, HOST, true);
		const state = await security.scan(SCAN, { root: ROOT, active: false });
		assert.strictEqual(probes().length, 0);
		assert.ok(state.notes.includes('Active checks were left out of this scan.'));
	});

	test('one unauthorized host among the targets keeps every probe back', async () => {
		const { security, probes } = await setup({ requests: [...users(), request('Other', 'GET', 'https://other.example.com/status')], options: { active: true } });
		await security.setAuthorized(SCAN, HOST, true);
		const state = await security.scan(SCAN, { root: ROOT });
		assert.strictEqual(probes().length, 0);
		assert.ok(state.notes.some(note => note.includes('other.example.com is not authorized')));
	});

	test('taking the authorization back stops the probes at once', async () => {
		const ref: { security?: VoltHttpSecurity } = {};
		const context = await setup({
			requests: users(),
			options: { active: true },
			probe: (_options, index) => {
				if (index === 2) {
					void ref.security!.setAuthorized(SCAN, HOST, false);
				}
				return { status: 401, body: '' };
			},
		});
		const security = ref.security = context.security;
		await security.setAuthorized(SCAN, HOST, true);
		const state = await security.scan(SCAN, { root: ROOT });
		assert.strictEqual(context.probes().length, 2);
		assert.ok(state.notes.some(note => note.startsWith('Active checks stopped:') && note.includes('not authorized')), state.notes.join('\n'));
	});

	test('Stop ends the scan where it is; the file records that it was stopped', async () => {
		const ref: { security?: VoltHttpSecurity } = {};
		const context = await setup({
			requests: users(),
			options: { active: true },
			probe: (_options, index) => {
				if (index === 3) {
					ref.security!.stop(SCAN);
				}
				return { status: 401, body: '' };
			},
		});
		const security = ref.security = context.security;
		await security.setAuthorized(SCAN, HOST, true);
		const changes: boolean[] = [];
		store.add(security.onDidChangeScan(SCAN)(state => changes.push(state.running)));
		const state = await security.scan(SCAN, { root: ROOT });
		assert.strictEqual(context.probes().length, 3);
		assert.strictEqual(state.stopped, true);
		assert.strictEqual(state.running, false);
		assert.strictEqual(security.scanOf(SCAN), state, 'the state stays in the service for a page that comes back');
		assert.strictEqual(changes[changes.length - 1], false);
		assert.strictEqual((await context.saved()).lastScan?.stopped, true);
	});

	test('DELETE is never sent, and requests that change data only when the user turned that on', async () => {
		const requests = [request('List', 'GET', `https://${HOST}/users`), request('Create', 'POST', `https://${HOST}/users`), request('Remove', 'DELETE', `https://${HOST}/users/1`)];
		const passive = await setup({ requests });
		const off = await passive.security.scan(SCAN, { root: ROOT });
		assert.deepStrictEqual(passive.baselines().map(item => item.method), ['GET']);
		assert.ok(off.notes.some(note => note.includes('POST changes data')));
		assert.ok(off.notes.some(note => note.includes('never sends DELETE')));

		const opted = await setup({ requests, options: { active: true, includeUnsafeMethods: true } });
		await opted.security.setAuthorized(SCAN, HOST, true);
		await opted.security.scan(SCAN, { root: ROOT });
		assert.deepStrictEqual(opted.baselines().map(item => item.method), ['GET', 'POST']);
		assert.ok(opted.probes().length > 0);
		assert.ok(opted.probes().every(item => item.method.toUpperCase() !== 'DELETE'));
		assert.ok(!opted.sent.some(item => item.method.toUpperCase() === 'DELETE'));
	});

	test('the hosts the targets go to, for the user to authorize', async () => {
		const { security } = await setup({ requests: [...users(), request('Unfilled', 'GET', '{{base}}/health')] });
		const found = await security.hostsOf(SCAN, ROOT);
		assert.deepStrictEqual(found.hosts, [{ host: HOST, requests: 2 }]);
		assert.strictEqual(found.unresolved, 1);
	});
});
