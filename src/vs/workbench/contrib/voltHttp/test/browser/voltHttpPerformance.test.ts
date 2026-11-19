/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { EMPTY_VOLT_LOAD_HISTOGRAM, IVoltHttpLoad, IVoltLoadProgress, IVoltLoadResult, IVoltLoadSample, IVoltLoadSpec, VoltLoadHistogram } from '../../../../../platform/voltHttp/common/voltHttpLoad.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { emptyHttpCollection, emptyHttpRequest, IHttpRequest } from '../../common/httpCollection.js';
import { emptyHttpPerfFile, HTTP_PERF_AGENT_MAX_SECONDS, HTTP_PERF_AGENT_MAX_USERS, IHttpPerfFile, parseHttpPerfFile, serializeHttpPerfFile } from '../../common/httpPerformance.js';
import { HttpHistogramChart, httpChartNiceMax, HttpLineChart, renderHttpStackedBar } from '../../browser/voltHttpCharts.js';
import { IHttpCollectionEntry, IVoltHttpCollections } from '../../browser/voltHttpCollections.js';
import { VoltHttpPerformance } from '../../browser/voltHttpPerformance.js';
import { IVoltHttpService } from '../../browser/voltHttpService.js';
import { runHttpPerformanceOp } from '../../../voltAgent/browser/ide/capabilities/httpPerformanceOps.js';
import { IIdeCapabilityContext } from '../../../voltAgent/browser/ide/capabilities/capability.js';

const ROOT = URI.file('/repo');
const COLLECTION_REF = 'http/shop.postman_collection.json';
const COLLECTION = joinPath(ROOT, COLLECTION_REF);
const TEST = joinPath(ROOT, 'http/performance/shop.volt-perf.json');

function request(name: string, method: string, url: string, mutate?: (request: IHttpRequest) => void): IHttpRequest {
	const made = emptyHttpRequest(name, 'none');
	made.method = method;
	made.url = url;
	mutate?.(made);
	return made;
}

function sample(t: number, extra?: Partial<IVoltLoadSample>): IVoltLoadSample {
	return { t, users: 5, count: 100, errors: 1, mean: 10, p50: 8, p95: 20, p99: 30, bytesIn: 1000, bytesOut: 500, ...extra };
}

function result(extra?: Partial<IVoltLoadResult>): IVoltLoadResult {
	const latency = new VoltLoadHistogram();
	for (let at = 1; at <= 100; at++) {
		latency.record(at);
	}
	return {
		mode: 'http', startedAt: Date.UTC(2026, 10, 18), durationMs: 2000, measuredSec: 2, ended: 'completed',
		count: 200, errors: 0, httpErrors: 2, bytesIn: 2000, bytesOut: 1000, rate: 100, peakUsers: 5, sent: 0,
		connects: 0, connectFailures: 0, closes: 0, reconnects: 0, latency: latency.toJSON(), statusCodes: { '200': 198, '500': 2 }, errorKinds: {},
		targets: [{ name: 'List', method: 'GET', url: 'http://localhost:3000/users', count: 200, errors: 2, bytesIn: 2000, latency: EMPTY_VOLT_LOAD_HISTOGRAM, statusCodes: { '200': 198 } }],
		series: [sample(1), sample(2)],
		...extra,
	};
}

/** The main process's load service, played by the test: it records the specs and fires what the test says. */
class FakeLoad implements IVoltHttpLoad {
	declare readonly _serviceBrand: undefined;
	readonly emitter = new Emitter<IVoltLoadProgress>();
	readonly onDidProgress = this.emitter.event;
	readonly specs: IVoltLoadSpec[] = [];
	readonly stopped: string[] = [];
	/** Fired before `start` returns (as a fast engine may). */
	early: Omit<IVoltLoadProgress, 'id'>[] = [];
	async start(spec: IVoltLoadSpec): Promise<string> {
		const id = `run-${this.specs.length + 1}`;
		this.specs.push(spec);
		for (const progress of this.early) {
			this.emitter.fire({ ...progress, id });
		}
		return id;
	}
	async stop(id: string): Promise<void> {
		this.stopped.push(id);
	}
	fire(progress: Omit<IVoltLoadProgress, 'id'>, id = `run-${this.specs.length}`): void {
		this.emitter.fire({ ...progress, id });
	}
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Waits (a few turns of the event loop at most) for what an async chain does. */
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
	for (let at = 0; at < 50; at++) {
		if (await check()) {
			return;
		}
		await tick();
	}
	assert.fail(`timed out waiting for ${what}`);
}

suite('Volt Client: performance test service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(file: Partial<IHttpPerfFile>, variables: Record<string, string> = {}) {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		const storage = store.add(new InMemoryStorageService());
		const collection = emptyHttpCollection('Shop', 'postman');
		collection.items.push(
			request('List users', 'GET', '{{base}}/users?id={{$guid}}', made => made.headers.push({ key: 'Authorization', value: 'Basic ada:secret', enabled: true })),
			request('Create user', 'POST', '{{base}}/users', made => {
				made.body.mode = 'raw';
				made.body.raw = '{"name":"{{name}}","n":{{$vu}}}';
			}),
		);
		const entry: IHttpCollectionEntry = { uri: COLLECTION, collection, indent: '\t' };
		const collections = {
			load: async (uri: URI) => uri.toString() === COLLECTION.toString() ? entry : undefined,
			get: (uri: URI) => uri.toString() === COLLECTION.toString() ? entry : undefined,
			variablesFor: async () => new Map(Object.entries(variables).map(([key, value]) => [key, { value, source: 'environment' }])),
		} as unknown as IVoltHttpCollections;
		const http = {
			foldersOf: () => [ROOT],
			scopeOf: (fileVariables: Readonly<Record<string, string>>, env: Readonly<Record<string, string>>) => ({ file: fileVariables, env, responses: new Map() }),
		} as unknown as IVoltHttpService;
		const engine = new FakeLoad();
		store.add(engine.emitter);
		const search = { fileSearch: async () => ({ results: [] }) } as unknown as ISearchService;
		const performance = store.add(new class extends VoltHttpPerformance {
			protected override async findFiles(): Promise<URI[]> {
				return [TEST];
			}
		}(http, collections, engine, fileService, search, new TestConfigurationService(), {} as IInstantiationService, storage));
		await fileService.writeFile(TEST, VSBuffer.fromString(serializeHttpPerfFile({ ...emptyHttpPerfFile('Shop load'), ...file })));
		const saved = async () => parseHttpPerfFile((await fileService.readFile(TEST)).value.toString(), 'x');
		return { performance, engine, saved, fileService };
	}

	const refs = (...names: string[]) => names.map((name, index) => ({ id: `t${index}`, ref: { collection: COLLECTION_REF, path: [name] }, weight: index + 1 }));

	test('targets are prepared with the environment filled in and the engine tokens left for every send', async () => {
		const { performance } = await setup({ targets: refs('List users', 'Create user') }, { base: 'http://localhost:3000', name: 'Ada' });
		const prepared = await performance.prepare(TEST, ROOT);
		assert.deepStrictEqual(prepared.problems, []);
		assert.deepStrictEqual(prepared.hosts, ['localhost']);
		assert.deepStrictEqual(prepared.toConfirm, []);
		const [list, create] = prepared.targets;
		assert.strictEqual(list.load?.url, 'http://localhost:3000/users?id={{$guid}}');
		assert.deepStrictEqual(list.load?.headers.find(([key]) => key === 'Authorization'), ['Authorization', 'Basic YWRhOnNlY3JldA==']);
		assert.strictEqual(create.load?.method, 'POST');
		assert.strictEqual(create.load?.body, '{"name":"Ada","n":{{$vu}}}');
		assert.strictEqual(create.load?.weight, 2);
	});

	test('a variable nothing fills, a request that is gone, or no target at all stop the run before anything is sent', async () => {
		const { performance, engine } = await setup({ targets: [...refs('List users'), { id: 'gone', ref: { collection: COLLECTION_REF, path: ['Deleted'] }, weight: 1 }] });
		const prepared = await performance.prepare(TEST, ROOT);
		assert.strictEqual(prepared.problems.length, 2);
		assert.ok(prepared.problems[0].includes('{{base}}'), prepared.problems[0]);
		assert.ok(prepared.problems[1].includes('not in the project'), prepared.problems[1]);
		await assert.rejects(performance.run(TEST, { root: ROOT }), /base/);
		assert.strictEqual(engine.specs.length, 0);

		const empty = await setup({ targets: [] });
		await assert.rejects(empty.performance.run(TEST, { root: ROOT }), /Targets/);
	});

	test('load on a public host waits for the user: a host only written into the file does not count', async () => {
		const { performance, engine } = await setup({
			targets: [{ id: 'a', inline: { method: 'GET', url: 'https://api.example.com/health', headers: [] }, weight: 1 }],
			confirmedHosts: [{ host: 'api.example.com', at: '2026-01-01' }],
		});
		await performance.load(TEST);
		assert.deepStrictEqual(performance.confirmedHostsOf(TEST), []);
		assert.deepStrictEqual((await performance.prepare(TEST, ROOT)).toConfirm, ['api.example.com']);
		await assert.rejects(performance.run(TEST, { root: ROOT }), /not confirmed|has not confirmed/);
		assert.strictEqual(engine.specs.length, 0);

		await performance.confirmHosts(TEST, ['API.example.com']);
		assert.deepStrictEqual(performance.confirmedHostsOf(TEST), ['api.example.com']);
		assert.deepStrictEqual((await performance.prepare(TEST, ROOT)).toConfirm, []);
	});

	test('a run follows the engine: samples while it goes, then the summary saved into the file with its verdict', async () => {
		const { performance, engine, saved } = await setup({
			targets: refs('List users'),
			thresholds: [{ metric: 'p95', op: 'lt', value: 500 }, { metric: 'errorRate', op: 'lt', value: 0.5 }],
		}, { base: 'http://127.0.0.1:3000' });
		engine.early = [{ type: 'sample', sample: sample(1, { warmup: true }) }];
		const changes: string[] = [];
		store.add(performance.onDidChangeRun(uri => changes.push(uri.path)));
		const done = performance.run(TEST, { root: ROOT });
		await until(() => !!performance.runOf(TEST)?.samples.length, 'the run to start');
		assert.strictEqual(engine.specs.length, 1);
		assert.strictEqual(engine.specs[0].users, 10);
		assert.strictEqual(engine.specs[0].durationSec, 30);
		const live = performance.runOf(TEST);
		assert.strictEqual(live?.running, true);
		assert.strictEqual(live?.samples.length, 1, 'the sample that came before start returned is kept');
		assert.strictEqual((await performance.list(ROOT))[0].running, true);
		engine.fire({ type: 'sample', sample: sample(2) });
		assert.strictEqual(performance.runOf(TEST)?.samples.length, 2);
		// Another window's run reports here too: it is not ours.
		engine.fire({ type: 'sample', sample: sample(3) }, 'someone-else');
		assert.strictEqual(performance.runOf(TEST)?.samples.length, 2);

		engine.fire({ type: 'done', result: result() });
		const state = await done;
		assert.strictEqual(state.running, false);
		assert.ok(state.result);
		assert.strictEqual(state.result.verdict.passed, false, 'the error rate is 1%');
		assert.deepStrictEqual(state.result.verdict.results.map(item => item.passed), [true, false]);
		assert.strictEqual(state.result.config.by, 'user');
		assert.ok(changes.length >= 3);
		await until(async () => (await saved()).runs.length === 1, 'the run to be saved');
		const file = await saved();
		assert.strictEqual(file.runs.length, 1);
		assert.strictEqual(file.runs[0].id, state.result.id);
		assert.strictEqual(file.runs[0].count, 200);

		await performance.setAnalysis(TEST, state.result.id, { text: 'Fine.', model: 'Test model' });
		assert.strictEqual((await saved()).runs[0].analysis?.text, 'Fine.');
	});

	test('stop asks the engine once; an error from the engine ends the run', async () => {
		const { performance, engine } = await setup({ targets: refs('List users') }, { base: 'http://localhost:3000' });
		const done = performance.run(TEST, { root: ROOT });
		await until(() => engine.specs.length === 1, 'the run to start');
		await tick();
		performance.stop(TEST);
		performance.stop(TEST);
		assert.deepStrictEqual(engine.stopped, ['run-1']);
		assert.strictEqual(performance.runOf(TEST)?.stopping, true);
		engine.fire({ type: 'error', error: 'worker died' });
		const state = await done;
		assert.strictEqual(state.error, 'worker died');
		assert.strictEqual(state.running, false);
	});

	test('an agent run is capped and stops when its call is cancelled', async () => {
		const { performance, engine } = await setup({ targets: refs('List users'), load: { users: 1500, durationSec: 600, profile: 'fixed', warmupSec: 0, thinkMs: 0, timeoutMs: 5000, order: 'weighted' } }, { base: 'http://localhost:3000' });
		const cancel = store.add(new CancellationTokenSource());
		const done = performance.run(TEST, { root: ROOT, by: 'agent', caps: { maxUsers: HTTP_PERF_AGENT_MAX_USERS, maxSeconds: HTTP_PERF_AGENT_MAX_SECONDS }, token: cancel.token });
		await until(() => engine.specs.length === 1, 'the run to start');
		await tick();
		assert.strictEqual(engine.specs[0].users, HTTP_PERF_AGENT_MAX_USERS);
		assert.strictEqual(engine.specs[0].durationSec, HTTP_PERF_AGENT_MAX_SECONDS);
		cancel.cancel();
		assert.deepStrictEqual(engine.stopped, ['run-1']);
		engine.fire({ type: 'done', result: result({ ended: 'stopped' }) });
		const state = await done;
		assert.strictEqual(state.result?.config.by, 'agent');
		assert.strictEqual(state.result?.ended, 'stopped');
	});

	test('files: create in the performance folder, rename, duplicate without hosts or runs, definitions from agents', async () => {
		const { performance, fileService } = await setup({ targets: refs('List users'), confirmedHosts: [{ host: 'x.example.com', at: '' }] });
		const created = await performance.create(ROOT, 'Checkout spike');
		assert.strictEqual(created.path, '/repo/http/performance/Checkout-spike.volt-perf.json');
		assert.ok(await fileService.exists(created));
		await performance.rename(created, 'Checkout peak');
		assert.strictEqual(performance.nameOf(created), 'Checkout peak');
		const copy = await performance.duplicate(TEST);
		assert.deepStrictEqual(performance.get(copy)?.file.confirmedHosts, []);
		const fromAgent = await performance.saveDefinition(ROOT, { name: 'Agent test', mode: 'sse', targets: [{ inline: { url: 'http://localhost:4000/events' } }], confirmedHosts: ['evil.example.com'], runs: [{}] });
		const file = performance.get(fromAgent)?.file;
		assert.strictEqual(file?.mode, 'sse');
		assert.deepStrictEqual(file?.confirmedHosts, []);
		assert.deepStrictEqual(file?.runs, []);
	});

	suite('agent ops', () => {

		const ctx = (extra?: Partial<IIdeCapabilityContext>): IIdeCapabilityContext => ({ root: ROOT, chatId: 'chat', token: CancellationToken.None, cli: undefined!, ...extra });

		test('other ops are not answered; a sandboxed chat cannot run load', async () => {
			const { performance } = await setup({ targets: refs('List users') }, { base: 'http://localhost:3000' });
			assert.strictEqual(await runHttpPerformanceOp('security_scan', {}, ctx(), performance), undefined);
			const refused = await runHttpPerformanceOp('perf_run', {}, ctx({ confinement: { sandbox: {} as never } }), performance);
			assert.strictEqual(refused?.isError, true);
			assert.ok(refused?.text.includes('sandboxed'));
		});

		test('perf_run refuses a host the user has not confirmed; runs capped otherwise and returns the summary', async () => {
			const remote = await setup({ targets: [{ id: 'a', inline: { method: 'GET', url: 'https://shop.example.com/', headers: [] }, weight: 1 }] });
			const refused = await runHttpPerformanceOp('perf_run', { path: 'http/performance/shop.volt-perf.json' }, ctx(), remote.performance);
			assert.strictEqual(refused?.isError, true);
			assert.ok(refused?.text.includes('shop.example.com'), refused?.text);
			assert.strictEqual(remote.engine.specs.length, 0);

			const local = await setup({ targets: refs('List users'), load: { users: 500, durationSec: 30, profile: 'fixed', warmupSec: 0, thinkMs: 0, timeoutMs: 5000, order: 'weighted' } }, { base: 'http://localhost:3000' });
			const answer = runHttpPerformanceOp('perf_run', {}, ctx(), local.performance);
			await until(() => local.engine.specs.length === 1, 'the run to start');
			await tick();
			assert.strictEqual(local.engine.specs[0].users, HTTP_PERF_AGENT_MAX_USERS);
			local.engine.fire({ type: 'done', result: result() });
			const text = (await answer)?.text ?? '';
			assert.ok(text.includes('Shop load: '), text);
			assert.ok(text.includes('capped at 200 users'), text);
			const list = await runHttpPerformanceOp('perf_list', {}, ctx(), local.performance);
			assert.ok(list?.text.includes('shop.volt-perf.json'));
			const report = await runHttpPerformanceOp('perf_report', {}, ctx(), local.performance);
			assert.ok(report?.text.startsWith('# Shop load: performance report'), report?.text);
		});
	});
});

suite('Volt Client: charts', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function host(): HTMLElement {
		const element = mainWindow.document.createElement('div');
		element.style.width = '480px';
		mainWindow.document.body.appendChild(element);
		store.add({ dispose: () => element.remove() });
		return element;
	}

	test('axes end on round numbers', () => {
		assert.strictEqual(httpChartNiceMax(0), 1);
		assert.strictEqual(httpChartNiceMax(7), 10);
		assert.strictEqual(httpChartNiceMax(180), 200);
		assert.strictEqual(httpChartNiceMax(240), 250);
		assert.strictEqual(httpChartNiceMax(0.03), 0.05);
	});

	test('a line chart draws a line per shown series; the legend hides one but never the last', () => {
		const chart = store.add(new HttpLineChart(host(), { ariaLabel: 'Throughput', series: [{ id: 'a', label: 'req/s', color: 'red' }, { id: 'b', label: 'errors/s', color: 'blue', dashed: true }], formatY: String, formatX: value => `${value}s` }));
		chart.setData([1, 2, 3], { a: [10, 20, 15], b: [0, 1, 0] }, { to: 1, label: 'Warm-up' });
		assert.strictEqual(chart.element.querySelectorAll('polyline').length, 2);
		assert.strictEqual(chart.element.querySelector('[role="img"]')?.getAttribute('aria-label'), 'Throughput');
		const keys = chart.element.querySelectorAll<HTMLButtonElement>('.volt-http-chart-key');
		keys[1].click();
		assert.strictEqual(chart.element.querySelectorAll('polyline').length, 1);
		chart.element.querySelectorAll<HTMLButtonElement>('.volt-http-chart-key')[0].click();
		assert.strictEqual(chart.element.querySelectorAll('polyline').length, 1, 'the last series shown stays');
		assert.ok(chart.element.querySelector('.volt-http-chart-shade'));
	});

	test('a histogram draws its bars and percentile markers; a stacked bar its parts and legend', () => {
		const chart = store.add(new HttpHistogramChart(host(), { ariaLabel: 'Latency', formatX: value => `${value}ms`, color: 'blue' }));
		chart.setData([{ from: 1, to: 2, count: 5 }, { from: 2, to: 4, count: 0 }, { from: 4, to: 8, count: 3 }], [{ label: 'p50', value: 1.5 }, { label: 'p99', value: 7 }]);
		assert.strictEqual(chart.element.querySelectorAll('.volt-http-chart-bar').length, 2);
		assert.strictEqual(chart.element.querySelectorAll('.volt-http-chart-marker').length, 2);
		const parent = host();
		renderHttpStackedBar(parent, [{ label: '2xx', count: 9, color: 'green' }, { label: '5xx', count: 1, color: 'red' }, { label: '4xx', count: 0, color: 'yellow' }], 'Status codes');
		assert.strictEqual(parent.querySelectorAll('.volt-http-stack-part').length, 2);
		assert.ok(parent.querySelector('.volt-http-stack-legend')?.textContent?.includes('90.0%'));
	});
});
