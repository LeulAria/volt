/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVoltLoadResult, IVoltLoadSample, VoltLoadHistogram } from '../../../../../platform/voltHttp/common/voltHttpLoad.js';
import { addHttpPerfRun, compareHttpPerfRuns, downsampleHttpPerfSeries, emptyHttpPerfFile, HTTP_PERF_MAX_RUNS, httpPerfAnalysisPrompt, httpPerfDetail, httpPerfHistogramBins, httpPerfHostOf, httpPerfHostsToConfirm, httpPerfHtmlReport, httpPerfJsonReport, httpPerfLiveNumbers, httpPerfMarkdownReport, httpPerfRunText, httpPerfSpec, httpPerfSetupPrompt, httpPerfStatusClasses, httpPerfUnresolved, IHttpPerfRun, parseHttpPerfSetupAnswer, isHttpPerfLocalHost, parseHttpPerfDefinition, parseHttpPerfFile, resolveHttpPerfText, serializeHttpPerfFile, summarizeHttpPerfRun } from '../../common/httpPerformance.js';

function sample(t: number, count: number, extra?: Partial<IVoltLoadSample>): IVoltLoadSample {
	return { t, users: 10, count, errors: 0, mean: 20, p50: 18, p95: 40, p99: 60, bytesIn: count * 100, bytesOut: count * 50, ...extra };
}

function result(extra?: Partial<IVoltLoadResult>, latencies: readonly number[] = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]): IVoltLoadResult {
	const latency = new VoltLoadHistogram();
	for (const ms of latencies) {
		latency.record(ms);
	}
	return {
		mode: 'http', startedAt: Date.UTC(2026, 10, 18, 12), durationMs: 10_000, measuredSec: 10, ended: 'completed',
		count: 1000, errors: 5, httpErrors: 5, bytesIn: 100_000, bytesOut: 50_000, rate: 100, peakUsers: 10, sent: 0,
		connects: 0, connectFailures: 0, closes: 0, reconnects: 0, latency: latency.toJSON(), ttfb: latency.toJSON(),
		statusCodes: { '200': 990, '500': 5 }, errorKinds: { timeout: 5 },
		targets: [{ name: 'List <users>', method: 'GET', url: 'http://localhost/users?token=secret', count: 1000, errors: 10, bytesIn: 100_000, latency: latency.toJSON(), statusCodes: { '200': 990, '500': 5 } }],
		series: Array.from({ length: 10 }, (_v, index) => sample(index + 1, 100)),
		...extra,
	};
}

const CONFIG = { users: 10, durationSec: 10, profile: 'fixed', warmupSec: 0, targets: 1 } as const;

suite('Volt Client performance tests: the file', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a new file round-trips through its text', () => {
		const file = emptyHttpPerfFile('Checkout');
		file.targets.push({ id: 'a', ref: { collection: 'http/shop.postman_collection.json', path: ['Cart', 'Add item'] }, weight: 3 });
		file.targets.push({ id: 'b', name: 'Health', inline: { method: 'GET', url: 'http://localhost:3000/health', headers: [['Accept', 'application/json']] }, weight: 1 });
		file.runs.push(summarizeHttpPerfRun(result(), file.thresholds, CONFIG, 'run-1'));
		const textOut = serializeHttpPerfFile(file);
		const back = parseHttpPerfFile(textOut, 'x');
		assert.deepStrictEqual(back, file);
		// Each run is one line: a file with ten runs stays readable.
		assert.strictEqual(textOut.split('\n').filter(line => line.includes('"run-1"')).length, 1);
		assert.ok(textOut.startsWith('{\n\t"volt": "perf",\n\t"version": 1,'));
		assert.deepStrictEqual(parseHttpPerfFile(serializeHttpPerfFile(emptyHttpPerfFile('Empty')), 'x').runs, []);
	});

	test('values are brought inside their limits and bad entries dropped', () => {
		const file = parseHttpPerfFile(JSON.stringify({
			name: '', mode: 'nope',
			targets: [{ url: 'http://x', method: 'post', headers: { 'X-A': 1 } }, { ref: { collection: 'c.json', path: 'A/B' } }, 'junk', { weight: 3 }],
			load: { users: 99_999, durationSec: -4, timeoutMs: 1, profile: 'wave', rps: 0, warmupSec: 1000 },
			thresholds: [{ metric: 'p95', op: 'lt', value: '200' }, { metric: 'p42', op: 'lt', value: 1 }, { metric: 'rps', op: 'eq', value: 1 }],
			confirmedHosts: ['API.Example.com', { host: 'b.example.com', at: '2026' }, 5],
			runs: [{ id: 'broken' }],
		}), 'Fallback');
		assert.strictEqual(file.name, 'Fallback');
		assert.strictEqual(file.mode, 'http');
		assert.strictEqual(file.targets.length, 2);
		assert.deepStrictEqual(file.targets[0].inline, { method: 'POST', url: 'http://x', headers: [['X-A', '1']] });
		assert.deepStrictEqual(file.targets[1].ref, { collection: 'c.json', path: ['A', 'B'] });
		assert.strictEqual(file.load.users, 2000);
		assert.strictEqual(file.load.durationSec, 1);
		assert.strictEqual(file.load.timeoutMs, 50);
		assert.strictEqual(file.load.profile, 'fixed');
		assert.strictEqual(file.load.rps, undefined);
		assert.strictEqual(file.load.warmupSec, 300);
		assert.deepStrictEqual(file.thresholds, [{ metric: 'p95', op: 'lt', value: 200 }]);
		assert.deepStrictEqual(file.confirmedHosts.map(item => item.host), ['api.example.com', 'b.example.com']);
		assert.deepStrictEqual(file.runs, []);
		assert.throws(() => parseHttpPerfFile('{"volt":"security"}', 'x'), /Not a Volt performance test/);
		assert.throws(() => parseHttpPerfFile('[1]', 'x'), /Not a Volt performance test/);
	});

	test('a request count replaces the duration only when no duration is given', () => {
		assert.deepStrictEqual([parseHttpPerfFile('{"load":{"requests":500}}', 'x').load.requests, parseHttpPerfFile('{"load":{"requests":500}}', 'x').load.durationSec], [500, undefined]);
		const both = parseHttpPerfFile('{"load":{"requests":500,"durationSec":20}}', 'x').load;
		assert.deepStrictEqual([both.requests, both.durationSec], [undefined, 20]);
	});

	test('an agent\'s definition never carries confirmed hosts or runs', () => {
		const definition = parseHttpPerfDefinition({ name: 'Agent test', mode: 'sse', targets: [{ url: 'https://api.example.com/events' }], confirmedHosts: ['api.example.com'], runs: [summarizeHttpPerfRun(result(), [], CONFIG)] }, 'x');
		assert.strictEqual(definition.name, 'Agent test');
		assert.strictEqual(definition.mode, 'sse');
		assert.ok(!('confirmedHosts' in definition) && !('runs' in definition));
		assert.throws(() => parseHttpPerfDefinition('nope', 'x'), /JSON object/);
	});

	test('hosts: local and private addresses need no confirmation, others do until confirmed', () => {
		for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '::1', 'fd12:3456::1', 'api.localhost', 'printer.local', '169.254.0.1', '::ffff:10.0.0.1']) {
			assert.ok(isHttpPerfLocalHost(host), host);
		}
		for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2001:db8::1', 'localhost.example.com']) {
			assert.ok(!isHttpPerfLocalHost(host), host);
		}
		assert.strictEqual(httpPerfHostOf('HTTPS://API.Example.com:8443/x'), 'api.example.com');
		assert.strictEqual(httpPerfHostOf('ws://[::1]:9000/'), '::1');
		assert.strictEqual(httpPerfHostOf('localhost:3000/x'), 'localhost');
		assert.deepStrictEqual(httpPerfHostsToConfirm(['https://b.example.com/x', 'http://localhost/', 'https://a.example.com/', 'https://b.example.com/y', 'https://c.example.com'], [{ host: 'c.example.com', at: '' }]), ['a.example.com', 'b.example.com']);
	});

	test('variables are filled but the engine\'s dynamic tokens are left for every send', () => {
		const resolve = (input: string) => input.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => name === 'host' ? 'api.test' : whole).replace(/\{\{\$guid\}\}/g, 'FROZEN');
		assert.strictEqual(resolveHttpPerfText('https://{{host}}/u/{{$guid}}?vu={{ $vu }}&n={{$randomInt 1 9}}&k={{missing}}', resolve), 'https://api.test/u/{{$guid}}?vu={{ $vu }}&n={{$randomInt 1 9}}&k={{missing}}');
		assert.deepStrictEqual(httpPerfUnresolved('https://api.test/{{$guid}}/{{$iteration}}?k={{missing}}&j={{ other }}&k2={{missing}}'), ['missing', 'other']);
	});

	test('the engine spec follows the file, and caps lower users and time', () => {
		const file = emptyHttpPerfFile('x');
		const target = { name: 't', method: 'GET', url: 'http://localhost', headers: [] };
		file.load = { ...file.load, users: 500, durationSec: 600, profile: 'peak', baseUsers: 900, rampUpSec: 10, warmupSec: 60, rps: 50 };
		const full = httpPerfSpec(file, [target]);
		assert.deepStrictEqual([full.users, full.durationSec, full.warmupSec, full.rps, full.profile?.kind, full.profile?.baseUsers], [500, 600, 60, 50, 'peak', 500]);
		const capped = httpPerfSpec(file, [target], { maxUsers: 200, maxSeconds: 120 });
		assert.deepStrictEqual([capped.users, capped.warmupSec, capped.durationSec], [200, 30, 90]);
		file.load = { ...file.load, durationSec: undefined, requests: 1000 };
		const counted = httpPerfSpec(file, [target]);
		assert.deepStrictEqual([counted.requests, counted.durationSec, counted.profile], [1000, undefined, undefined]);
		assert.strictEqual(httpPerfSpec(file, [target], { maxUsers: 200, maxSeconds: 120 }).durationSec, 90, 'a counted run still ends within the cap');
		file.mode = 'ws';
		file.ws = { message: 'hi {{$vu}}', intervalMs: 250, expectReply: true };
		const ws = httpPerfSpec(file, [target]);
		assert.deepStrictEqual(ws.ws, { message: 'hi {{$vu}}', intervalMs: 250, expectReply: true });
		assert.strictEqual(ws.rps, undefined);
		assert.strictEqual(ws.requests, undefined);
	});
});

suite('Volt Client performance tests: results', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a long series is folded to 300 points that still read per second', () => {
		const series = Array.from({ length: 1800 }, (_v, index) => sample(index + 1, index % 2 ? 100 : 300, { p99: index === 900 ? 5000 : 60, users: index < 900 ? 10 : 20 }));
		const folded = downsampleHttpPerfSeries(series);
		assert.strictEqual(folded.length, 300);
		assert.strictEqual(folded[0].t, 6);
		assert.strictEqual(folded[299].t, 1800);
		assert.strictEqual(folded[0].count, 200, 'six seconds of 300 and 100 a second: 200 a second');
		assert.strictEqual(folded[0].bytesIn, 20_000);
		assert.ok(folded.some(point => point.p99 === 5000), 'a spike stays');
		assert.strictEqual(Math.max(...folded.map(point => point.users)), 20);
		const short = [sample(1, 5), sample(2, 6)];
		assert.deepStrictEqual(downsampleHttpPerfSeries(short), short);
	});

	test('a summary carries the metrics and the verdict of the thresholds', () => {
		const run = summarizeHttpPerfRun(result(), [{ metric: 'p95', op: 'lt', value: 50 }, { metric: 'errorRate', op: 'lte', value: 1 }, { metric: 'rps', op: 'gte', value: 100 }], CONFIG, 'r');
		assert.strictEqual(run.id, 'r');
		assert.strictEqual(run.metrics.errorRate, 1);
		assert.strictEqual(run.metrics.rps, 100);
		assert.strictEqual(run.metrics.max, 100);
		assert.deepStrictEqual(run.verdict.results.map(item => item.passed), [false, true, true]);
		assert.strictEqual(run.verdict.passed, false);
		assert.strictEqual(run.series.length, 10);
		assert.strictEqual(summarizeHttpPerfRun(result(), [], CONFIG).verdict.passed, true);
	});

	test('runs are kept newest first, ten at most', () => {
		let runs: IHttpPerfRun[] = [];
		for (let at = 0; at < 13; at++) {
			runs = addHttpPerfRun(runs, summarizeHttpPerfRun(result({ startedAt: 1000 + at }), [], CONFIG, `r${at}`));
		}
		assert.strictEqual(runs.length, HTTP_PERF_MAX_RUNS);
		assert.deepStrictEqual(runs.slice(0, 3).map(run => run.id), ['r12', 'r11', 'r10']);
	});

	test('two runs compare metric by metric, better and worse by the metric\'s direction', () => {
		const before = summarizeHttpPerfRun(result({ rate: 100 }), [], CONFIG);
		const after = summarizeHttpPerfRun(result({ rate: 150, errors: 50, httpErrors: 0 }, [20, 40, 60, 80, 100, 120, 140, 160, 180, 200]), [], CONFIG);
		const deltas = Object.fromEntries(compareHttpPerfRuns(before, after).map(delta => [delta.key, delta]));
		assert.strictEqual(deltas.rps.better, true);
		assert.strictEqual(deltas.rps.percent, 50);
		assert.strictEqual(deltas.p95.better, false);
		assert.strictEqual(deltas.errorRate.better, false);
		assert.strictEqual(deltas.count.better, undefined, 'a count is neither better nor worse');
		const same = compareHttpPerfRuns(before, before);
		assert.ok(same.every(delta => delta.better === undefined && delta.delta === 0));
	});

	test('status classes, histogram bins and the sidebar detail', () => {
		assert.deepStrictEqual(httpPerfStatusClasses({ '200': 5, '201': 1, '101': 2, '302': 1, '404': 3, '503': 4, '0': 1 }), { '2xx': 8, '3xx': 1, '4xx': 3, '5xx': 4, other: 1 });
		const histogram = new VoltLoadHistogram();
		for (let ms = 1; ms <= 1000; ms++) {
			histogram.record(ms);
		}
		const bins = httpPerfHistogramBins(histogram, 40);
		assert.strictEqual(bins.length, 40);
		assert.strictEqual(bins.reduce((sum, bin) => sum + bin.count, 0), 1000);
		assert.ok(bins.every((bin, index) => index === 0 || Math.abs(bin.from - bins[index - 1].to) < 1e-9));
		assert.deepStrictEqual(httpPerfHistogramBins(new VoltLoadHistogram()), []);
		const file = emptyHttpPerfFile('x');
		assert.strictEqual(httpPerfDetail(file), '10 users, 30s');
		file.mode = 'ws';
		file.load = { ...file.load, users: 1, durationSec: 90 };
		file.runs = [summarizeHttpPerfRun(result(), [], CONFIG)];
		assert.strictEqual(httpPerfDetail(file), 'WebSocket, 1 connection, 1m 30s, passed');
	});

	test('the reports: Markdown, JSON and HTML hold the numbers and escape what came from the user', () => {
		const file = { name: 'Shop <api>', description: 'Load on the shop', mode: 'http' as const };
		const before = summarizeHttpPerfRun(result({ rate: 80 }), [], CONFIG);
		const run = summarizeHttpPerfRun(result(), [{ metric: 'p95', op: 'lt', value: 500 }], CONFIG);
		const markdown = httpPerfMarkdownReport(file, run, before);
		assert.ok(markdown.startsWith('# Shop <api>: performance report'));
		assert.ok(markdown.includes('**Passed**'));
		assert.ok(markdown.includes('| Requests/s | 100 | +25.0% (better) |'), markdown);
		assert.ok(markdown.includes('## Timing phases') && markdown.includes('Time to first byte'));
		assert.ok(markdown.includes('| Timeout | 5 |'));
		const json = JSON.parse(httpPerfJsonReport(file, run, before));
		assert.strictEqual(json.verdict, 'passed');
		assert.strictEqual(json.latency.count, 10);
		assert.strictEqual(json.run.id, run.id);
		assert.strictEqual(json.deltas.length, 10);
		const html = httpPerfHtmlReport(file, run, before);
		assert.ok(html.startsWith('<!DOCTYPE html>'));
		assert.ok(html.includes('Shop &lt;api&gt;') && !html.includes('Shop <api>'));
		assert.ok(html.includes('List &lt;users&gt;'));
		assert.ok((html.match(/<svg /g) ?? []).length >= 3, 'throughput, latency and distribution charts');
		assert.ok(!/<script/i.test(html), 'no scripts in the report');
		assert.ok(html.includes('class="verdict pass"'));
	});

	test('the text for agents and the prompt for the model carry numbers, not URLs', () => {
		const run = summarizeHttpPerfRun(result(), [{ metric: 'p99', op: 'lt', value: 10 }], CONFIG);
		const summary = httpPerfRunText({ name: 'Shop', mode: 'http' }, run);
		assert.ok(summary.startsWith('Shop: FAILED'));
		assert.ok(summary.includes('Throughput: 100 req/s'));
		assert.ok(summary.includes('p99 < 10.0 ms: FAIL'));
		const prompt = httpPerfAnalysisPrompt({ name: 'Shop', mode: 'http' }, run, summarizeHttpPerfRun(result({ rate: 50 }), [], CONFIG));
		assert.ok(!prompt.includes('token=secret') && !prompt.includes('localhost') && !prompt.includes('List <users>'));
		assert.ok(prompt.includes('t=10s users=10'));
		assert.ok(prompt.includes('rps: 50 -> 100'));
	});

	test('the live numbers of a run leave the warm-up out', () => {
		const numbers = httpPerfLiveNumbers([sample(1, 1000, { warmup: true, users: 2 }), sample(2, 100, { p95: 10, errors: 1, users: 5 }), sample(3, 300, { p95: 30, p99: 90, errors: 4 })]);
		assert.strictEqual(numbers.count, 400);
		assert.strictEqual(numbers.rate, 200);
		assert.strictEqual(numbers.p95, 25);
		assert.strictEqual(numbers.p99, 90);
		assert.strictEqual(numbers.errorRate, 5 / 400 * 100);
		assert.strictEqual(numbers.peakUsers, 10);
	});

	test('set up with AI: the prompt lists saved requests without values and asks for the whole definition', () => {
		const existing = { ...emptyHttpPerfFile('Checkout'), targets: [{ id: 't1', inline: { method: 'GET', url: 'http://localhost/a', headers: [] }, weight: 1 }] };
		const prompt = httpPerfSetupPrompt([{ collection: 'api.postman.json', name: 'API', requests: [{ path: ['Orders', 'Create'], method: 'POST', url: '{{baseUrl}}/orders?token=', bodyFields: ['sku'], protocol: 'http' }, { path: ['Feed'], method: 'GET', url: 'ws://x/feed', bodyFields: [], protocol: 'ws' }] }], '200 users on checkout', existing);
		assert.match(prompt, /ref\.collection: "api\.postman\.json"/);
		assert.match(prompt, /path \["Orders","Create"\]: POST \{\{baseUrl\}\}\/orders\?token= \(body fields: sku\)/);
		assert.match(prompt, /\[ws\] GET ws:\/\/x\/feed/);
		assert.match(prompt, /Yours replaces it\./);
		assert.doesNotMatch(prompt, /"id":"t1"/);
		assert.match(prompt, /What to test: 200 users on checkout$/);
	});

	test('set up with AI: the answer is read with the checks of a file, fences and talk ignored', () => {
		const answer = 'Here it is:\n```json\n{"name":"Checkout","description":"Can checkout take 200 users?","mode":"http","targets":[{"ref":{"collection":"api.postman.json","path":["Orders","Create"]},"weight":3},{"inline":{"method":"get","url":"{{baseUrl}}/health"},"weight":1}],"load":{"users":99999,"durationSec":60,"profile":"rampUp","rampUpSec":20},"thresholds":[{"metric":"p95","op":"lt","value":400},{"metric":"nope","op":"lt","value":1}],"confirmedHosts":["evil.example"],"runs":[1]}\n```';
		const { definition, error } = parseHttpPerfSetupAnswer(answer);
		assert.strictEqual(error, undefined);
		assert.ok(definition);
		assert.strictEqual(definition.targets.length, 2);
		assert.deepStrictEqual(definition.targets[0].ref, { collection: 'api.postman.json', path: ['Orders', 'Create'] });
		assert.strictEqual(definition.targets[1].inline?.method, 'GET');
		assert.ok(definition.targets.every(target => target.id));
		assert.strictEqual(definition.load.profile, 'rampUp');
		assert.ok(definition.load.users <= 2000);
		assert.deepStrictEqual(definition.thresholds, [{ metric: 'p95', op: 'lt', value: 400 }]);
		assert.ok(!('confirmedHosts' in definition) && !('runs' in definition));
	});

	test('set up with AI: no JSON, bad JSON or no targets is an error', () => {
		assert.ok(parseHttpPerfSetupAnswer('').error);
		assert.ok(parseHttpPerfSetupAnswer('I cannot help with that').error);
		assert.ok(parseHttpPerfSetupAnswer('{"name": ').error);
		assert.match(parseHttpPerfSetupAnswer('{"name":"x","targets":[]}').error ?? '', /no targets/);
	});
});
