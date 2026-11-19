/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { evaluateVoltLoadThresholds, IVoltLoadResult, normalizeVoltLoadSpec, planVoltLoad, VOLT_LOAD_HISTOGRAM_BUCKETS, VOLT_LOAD_MAX_BODY_BYTES, VOLT_LOAD_MAX_DURATION_SEC, VOLT_LOAD_MAX_USERS, voltLoadBucketIndex, voltLoadBucketRange, voltLoadErrorRate, VoltLoadHistogram, voltLoadMetrics, voltLoadPercentiles, voltLoadProfileDefaults, voltLoadProfilePoints, voltLoadUsersAt } from '../../common/voltHttpLoad.js';

/** A fixed pseudo-random sequence, so a failure can be repeated. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

function exactPercentile(sorted: readonly number[], percent: number): number {
	return sorted[Math.max(1, Math.ceil(sorted.length * percent / 100)) - 1];
}

suite('Volt Client load: histogram, profiles, thresholds', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('buckets cover 1 microsecond to 60 s without gaps and are never wider than 1/64 of their start', () => {
		let expectedLow = 0;
		for (let index = 0; index < VOLT_LOAD_HISTOGRAM_BUCKETS; index++) {
			const { low, width } = voltLoadBucketRange(index);
			assert.strictEqual(low, expectedLow, `bucket ${index} starts where the one before ends`);
			assert.ok(width === 1 || width / low <= 1 / 64, `bucket ${index} is ${width} wide at ${low}`);
			assert.strictEqual(voltLoadBucketIndex(low), index);
			assert.strictEqual(voltLoadBucketIndex(low + width - 1), index);
			expectedLow = low + width;
		}
		assert.ok(expectedLow >= 60_000_000, 'the last bucket ends past 60 s');
		assert.strictEqual(voltLoadBucketIndex(-5), 0);
		assert.strictEqual(voltLoadBucketIndex(10 ** 12), VOLT_LOAD_HISTOGRAM_BUCKETS - 1);
	});

	test('percentiles are within 1% of the exact ones over six orders of magnitude', () => {
		const next = random(7);
		const histogram = new VoltLoadHistogram();
		const values: number[] = [];
		for (let at = 0; at < 50_000; at++) {
			// Log-uniform between 0.05 ms and 20 s, as latencies under load spread.
			const ms = 0.05 * Math.pow(400_000, next());
			values.push(ms);
			histogram.record(ms);
		}
		values.sort((a, b) => a - b);
		for (const percent of [1, 10, 50, 75, 90, 95, 97.5, 99, 99.9]) {
			const exact = exactPercentile(values, percent);
			const got = histogram.percentile(percent);
			assert.ok(Math.abs(got - exact) / exact < 0.01, `p${percent}: ${got} against ${exact}`);
		}
		assert.strictEqual(histogram.count, values.length);
		assert.strictEqual(histogram.percentile(100), values[values.length - 1]);
		assert.strictEqual(histogram.min, values[0]);
		assert.strictEqual(histogram.max, values[values.length - 1]);
	});

	test('mean and standard deviation are exact, not bucketed', () => {
		const histogram = new VoltLoadHistogram();
		for (const ms of [10, 20, 30, 40]) {
			histogram.record(ms);
		}
		assert.strictEqual(histogram.mean, 25);
		assert.ok(Math.abs(histogram.stddev - Math.sqrt(125)) < 1e-9);
		const all = voltLoadPercentiles(histogram);
		assert.deepStrictEqual({ count: all.count, min: all.min, max: all.max, mean: all.mean }, { count: 4, min: 10, max: 40, mean: 25 });
		assert.ok(Math.abs(all.p50 - 20) / 20 < 0.01);
		assert.ok(all.p50 <= all.p75 && all.p75 <= all.p90 && all.p90 <= all.p95 && all.p95 <= all.p975 && all.p975 <= all.p99 && all.p99 <= all.p999 && all.p999 <= all.max);
	});

	test('an empty histogram answers zeros', () => {
		const empty = voltLoadPercentiles(undefined);
		assert.deepStrictEqual(empty, { count: 0, min: 0, p50: 0, p75: 0, p90: 0, p95: 0, p975: 0, p99: 0, p999: 0, max: 0, mean: 0, stddev: 0 });
		assert.deepStrictEqual(new VoltLoadHistogram().toJSON(), { n: 0, min: 0, max: 0, sum: 0, sumSq: 0, b: [] });
	});

	test('histograms merge and survive JSON', () => {
		const next = random(3);
		const a = new VoltLoadHistogram();
		const b = new VoltLoadHistogram();
		const both = new VoltLoadHistogram();
		for (let at = 0; at < 4000; at++) {
			const ms = 1 + next() * 500;
			(at % 2 ? a : b).record(ms);
			both.record(ms);
		}
		const merged = VoltLoadHistogram.from(JSON.parse(JSON.stringify(a.toJSON())));
		merged.merge(b);
		assert.deepStrictEqual(merged.toJSON().b, both.toJSON().b);
		assert.strictEqual(merged.count, both.count);
		assert.strictEqual(merged.min, both.min);
		assert.strictEqual(merged.max, both.max);
		assert.ok(Math.abs(merged.mean - both.mean) < 1e-9);
		assert.strictEqual(merged.percentile(99), both.percentile(99));
		assert.strictEqual(merged.buckets().reduce((sum, bucket) => sum + bucket.count, 0), 4000);
	});

	test('record ignores what is not a time and takes a weight', () => {
		const histogram = new VoltLoadHistogram();
		histogram.record(Number.NaN);
		histogram.record(Infinity);
		histogram.record(5, 0);
		assert.strictEqual(histogram.count, 0);
		histogram.record(5, 3);
		histogram.record(-2);
		assert.strictEqual(histogram.count, 4);
		assert.strictEqual(histogram.min, 0);
		assert.strictEqual(histogram.percentile(50), 5);
	});

	test('fixed profile: every user from start to end', () => {
		for (const t of [0, 1, 30, 60]) {
			assert.strictEqual(voltLoadUsersAt({ kind: 'fixed' }, 40, 60, t), 40);
		}
		assert.strictEqual(voltLoadUsersAt(undefined, 40, 60, 10), 40);
	});

	test('ramp up: from the base load to the peak, then held', () => {
		const profile = { kind: 'rampUp', baseUsers: 10, rampUpSec: 20 } as const;
		assert.strictEqual(voltLoadUsersAt(profile, 50, 60, 0), 10);
		assert.strictEqual(voltLoadUsersAt(profile, 50, 60, 10), 30);
		assert.strictEqual(voltLoadUsersAt(profile, 50, 60, 20), 50);
		assert.strictEqual(voltLoadUsersAt(profile, 50, 60, 60), 50);
		// Postman's proportions when nothing is given: a quarter of the users, a quarter of the time.
		assert.deepStrictEqual(voltLoadProfileDefaults({ kind: 'rampUp' }, 40, 80), { kind: 'rampUp', users: 40, baseUsers: 10, startSec: 0, rampUpSec: 20, holdSec: 60, rampDownSec: 0 });
	});

	test('spike: base, a climb, straight back down', () => {
		const profile = { kind: 'spike', baseUsers: 10, startSec: 40, rampUpSec: 10, rampDownSec: 10 } as const;
		assert.deepStrictEqual([0, 39, 40, 45, 50, 55, 60, 100].map(t => voltLoadUsersAt(profile, 100, 100, t)), [10, 10, 10, 55, 100, 55, 10, 10]);
		assert.deepStrictEqual(voltLoadProfileDefaults({ kind: 'spike' }, 100, 100), { kind: 'spike', users: 100, baseUsers: 20, startSec: 40, rampUpSec: 10, holdSec: 0, rampDownSec: 10 });
	});

	test('peak: base, a climb, a hold, back down', () => {
		const profile = { kind: 'peak', baseUsers: 20, startSec: 20, rampUpSec: 20, holdSec: 20, rampDownSec: 20 } as const;
		assert.deepStrictEqual([0, 20, 30, 40, 50, 60, 70, 80, 100].map(t => voltLoadUsersAt(profile, 100, 100, t)), [20, 20, 60, 100, 100, 100, 60, 20, 20]);
	});

	test('profile parameters are held inside the run and the user limit', () => {
		const shape = voltLoadProfileDefaults({ kind: 'peak', baseUsers: 900, startSec: 50, rampUpSec: 500, holdSec: 500, rampDownSec: 500 }, 100, 60);
		assert.deepStrictEqual(shape, { kind: 'peak', users: 100, baseUsers: 100, startSec: 50, rampUpSec: 10, holdSec: 0, rampDownSec: 0 });
		assert.strictEqual(voltLoadUsersAt({ kind: 'fixed' }, 99_999, 10, 1), VOLT_LOAD_MAX_USERS);
		const points = voltLoadProfilePoints({ kind: 'rampUp', baseUsers: 1, rampUpSec: 10 }, 10, 10, 11);
		assert.strictEqual(points.length, 11);
		assert.deepStrictEqual(points[0], [0, 1]);
		assert.deepStrictEqual(points[10], [10, 10]);
	});

	test('thresholds decide the verdict', () => {
		const metrics = { p50: 12, p95: 80, p99: 240, mean: 20, max: 900, errorRate: 0.5, rps: 1500 };
		const verdict = evaluateVoltLoadThresholds([
			{ metric: 'p95', op: 'lt', value: 100 },
			{ metric: 'errorRate', op: 'lte', value: 0.5 },
			{ metric: 'rps', op: 'gte', value: 1500 },
			{ metric: 'p99', op: 'lt', value: 200 },
			{ metric: 'max', op: 'gt', value: 900 },
		], metrics);
		assert.strictEqual(verdict.passed, false);
		assert.deepStrictEqual(verdict.results.map(result => result.passed), [true, true, true, false, false]);
		assert.deepStrictEqual(verdict.results.map(result => result.actual), [80, 0.5, 1500, 240, 900]);
		assert.strictEqual(evaluateVoltLoadThresholds([], metrics).passed, true);
		assert.strictEqual(evaluateVoltLoadThresholds([{ metric: 'p50', op: 'lt', value: 13 }], metrics).passed, true);
	});

	test('the summary metrics come from the result', () => {
		const latency = new VoltLoadHistogram();
		for (let ms = 1; ms <= 100; ms++) {
			latency.record(ms);
		}
		const result: IVoltLoadResult = {
			mode: 'http', startedAt: 0, durationMs: 10_000, measuredSec: 10, ended: 'completed', count: 1000, errors: 10, httpErrors: 40, bytesIn: 0, bytesOut: 0,
			rate: 100, peakUsers: 5, sent: 0, connects: 0, connectFailures: 0, closes: 0, reconnects: 0, latency: latency.toJSON(), statusCodes: {}, errorKinds: {}, targets: [], series: [],
		};
		const metrics = voltLoadMetrics(result);
		assert.strictEqual(metrics.errorRate, 5);
		assert.strictEqual(metrics.rps, 100);
		assert.strictEqual(metrics.max, 100);
		assert.strictEqual(metrics.mean, 50.5);
		assert.ok(Math.abs(metrics.p95 - 95) < 1 && Math.abs(metrics.p50 - 50) < 1);
		// A connection test fails by the connections it could not make.
		assert.strictEqual(voltLoadErrorRate({ mode: 'ws', count: 500, errors: 3, httpErrors: 0, connects: 9, connectFailures: 1 }), 10);
		assert.strictEqual(voltLoadErrorRate({ mode: 'http', count: 0, errors: 0, httpErrors: 0, connects: 0, connectFailures: 0 }), 0);
	});

	test('a spec is brought inside the hard limits', () => {
		const spec = normalizeVoltLoadSpec({ mode: 'http', targets: [{ name: '', method: 'get', url: ' http://localhost:1/x ', headers: [['A', '1'], ['Bad\r\nName', 'x']] }], users: 50_000, durationSec: 99_999, warmupSec: 10, timeoutMs: 1, rps: -4 });
		assert.strictEqual(spec.users, VOLT_LOAD_MAX_USERS);
		assert.strictEqual(spec.durationSec, VOLT_LOAD_MAX_DURATION_SEC - 10);
		assert.strictEqual(spec.timeoutMs, 50);
		assert.strictEqual(spec.rps, undefined);
		assert.deepStrictEqual(spec.targets[0], { name: 'get http://localhost:1/x', method: 'GET', url: 'http://localhost:1/x', headers: [['A', '1']], weight: 1 });
		assert.throws(() => normalizeVoltLoadSpec({ mode: 'http', targets: [], users: 1 }), /at least one target/);
		assert.throws(() => normalizeVoltLoadSpec({ mode: 'http', targets: [{ name: 'a', method: 'GET', url: 'ftp://x', headers: [] }], users: 1 }), /no usable URL/);
		assert.throws(() => normalizeVoltLoadSpec({ mode: 'http', targets: [{ name: 'a', method: 'POST', url: 'http://x', headers: [], body: 'x'.repeat(VOLT_LOAD_MAX_BODY_BYTES + 1) }], users: 1 }), /larger than 5 MB/);
		assert.strictEqual(normalizeVoltLoadSpec({ mode: 'ws', targets: [{ name: 'a', method: 'GET', url: 'https://x/socket', headers: [] }], users: 1 }).targets[0].url, 'wss://x/socket');
	});

	test('the plan follows the profile step by step, the warm-up at its first value', () => {
		const plan = planVoltLoad({ mode: 'http', targets: [{ name: 'a', method: 'GET', url: 'http://x', headers: [] }], users: 40, durationSec: 8, warmupSec: 2, profile: { kind: 'rampUp', baseUsers: 10, rampUpSec: 4 } });
		assert.strictEqual(plan.stepMs, 250);
		assert.strictEqual(plan.steps.length, 41);
		assert.deepStrictEqual(plan.steps.slice(0, 9), [10, 10, 10, 10, 10, 10, 10, 10, 10]);
		assert.strictEqual(plan.steps[8 + 8], 25);
		assert.strictEqual(plan.steps[8 + 16], 40);
		assert.strictEqual(plan.steps[40], 40);
		// A run that ends by request count keeps every user for as long as it takes.
		const counted = planVoltLoad({ mode: 'http', targets: [{ name: 'a', method: 'GET', url: 'http://x', headers: [] }], users: 5, requests: 100, profile: { kind: 'spike' } });
		assert.ok(counted.steps.every(users => users === 5));
		assert.strictEqual(counted.requests, 100);
	});
});
