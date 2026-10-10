/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { encodeSpan, encodeTraceRequest, hasValidIds, OtlpBatchExporter, OtlpTraceRequest, OtlpTransport, toAnyValue, toKeyValues, toUnixNanos, tracesUrl } from '../../common/otlp.js';
import { newSpanId, newTraceId, VoltTracer } from '../../common/tracer.js';
import { IVoltSpanData, readTracingConfig, VoltSpanKind, VoltSpanStatusCode } from '../../common/voltDiagnostics.js';

function span(overrides: Partial<IVoltSpanData> = {}): IVoltSpanData {
	return {
		traceId: '0af7651916cd43dd8448eb211c80319c',
		spanId: 'b7ad6b7169203331',
		name: 'invoke_agent',
		kind: VoltSpanKind.Internal,
		startTime: 1_700_000_000_000.5,
		endTime: 1_700_000_000_250,
		attributes: {},
		...overrides,
	};
}

/** Timers the test fires by hand. */
class ManualTimers {
	private readonly pending = new Set<{ callback: () => void; ms: number }>();
	readonly set = (callback: () => void, ms: number): IDisposable => {
		const entry = { callback, ms };
		this.pending.add(entry);
		return { dispose: () => this.pending.delete(entry) };
	};
	fire(ms: number): void {
		for (const entry of [...this.pending]) {
			if (entry.ms === ms) {
				this.pending.delete(entry);
				entry.callback();
			}
		}
	}
	count(ms: number): number {
		return [...this.pending].filter(entry => entry.ms === ms).length;
	}
}

suite('Volt OTLP encoding', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ids are lowercase hex of the right length and never zero', () => {
		for (let i = 0; i < 50; i++) {
			assert.match(newTraceId(), /^[0-9a-f]{32}$/);
			assert.match(newSpanId(), /^[0-9a-f]{16}$/);
		}
		assert.notStrictEqual(newTraceId(), newTraceId());
		assert.strictEqual(hasValidIds(span()), true);
		assert.strictEqual(hasValidIds(span({ traceId: '0'.repeat(32) })), false);
		assert.strictEqual(hasValidIds(span({ spanId: 'B7AD6B7169203331' })), false);
		assert.strictEqual(hasValidIds(span({ spanId: 'b7ad6b71' })), false);
		assert.strictEqual(hasValidIds(span({ parentSpanId: '0000000000000000' })), false);
	});

	test('unix nanos keep precision past 2^53 and sub-millisecond fractions', () => {
		assert.strictEqual(toUnixNanos(1_700_000_000_000), '1700000000000000000');
		assert.strictEqual(toUnixNanos(1_700_000_000_000.5), '1700000000000500000');
		assert.strictEqual(toUnixNanos(1_700_000_000_123.25), '1700000000123250000');
		assert.strictEqual(toUnixNanos(1.000001), '1000001');
		assert.strictEqual(toUnixNanos(0), '0');
		assert.strictEqual(toUnixNanos(Number.NaN), '0');
	});

	test('attributes become typed AnyValues', () => {
		assert.deepStrictEqual(toAnyValue('a'), { stringValue: 'a' });
		assert.deepStrictEqual(toAnyValue(true), { boolValue: true });
		assert.deepStrictEqual(toAnyValue(42), { intValue: '42' });
		assert.deepStrictEqual(toAnyValue(-3), { intValue: '-3' });
		assert.deepStrictEqual(toAnyValue(0.25), { doubleValue: 0.25 });
		assert.deepStrictEqual(toAnyValue(2 ** 60), { doubleValue: 2 ** 60 });
		assert.deepStrictEqual(toAnyValue(['x', 'y']), { arrayValue: { values: [{ stringValue: 'x' }, { stringValue: 'y' }] } });
		assert.deepStrictEqual(toKeyValues({ a: 1, b: undefined, c: Number.POSITIVE_INFINITY }), [
			{ key: 'a', value: { intValue: '1' } },
			{ key: 'c', value: { stringValue: 'Infinity' } },
		]);
	});

	test('spans encode kind, status, parent, events and clamp end to start', () => {
		const encoded = encodeSpan(span({
			parentSpanId: '00f067aa0ba902b7',
			kind: VoltSpanKind.Server,
			endTime: 1,
			status: { code: VoltSpanStatusCode.Error, message: 'boom' },
			events: [{ name: 'retry', time: 1_700_000_000_100, attributes: { attempt: 2 } }],
			attributes: { 'gen_ai.tool.name': 'Read' },
		}));
		assert.deepStrictEqual(encoded, {
			traceId: '0af7651916cd43dd8448eb211c80319c',
			spanId: 'b7ad6b7169203331',
			parentSpanId: '00f067aa0ba902b7',
			name: 'invoke_agent',
			kind: 2,
			startTimeUnixNano: '1700000000000500000',
			endTimeUnixNano: '1700000000000500000',
			attributes: [{ key: 'gen_ai.tool.name', value: { stringValue: 'Read' } }],
			events: [{ timeUnixNano: '1700000000100000000', name: 'retry', attributes: [{ key: 'attempt', value: { intValue: '2' } }] }],
			status: { code: 2, message: 'boom' },
		});
		// No parent, no events, unset status, and an Ok status drops its message.
		const root = encodeSpan(span({ status: { code: VoltSpanStatusCode.Ok, message: 'ignored' } }));
		assert.strictEqual('parentSpanId' in root, false);
		assert.strictEqual('events' in root, false);
		assert.deepStrictEqual(root.status, { code: 1 });
		assert.deepStrictEqual(encodeSpan(span()).status, { code: 0 });
	});

	test('the request nests resource, scope and spans', () => {
		const request = encodeTraceRequest({ 'service.name': 'volt', 'service.version': '1.105.0' }, { name: 'volt', version: '1.105.0' }, [span()]);
		assert.deepStrictEqual(request.resourceSpans[0].resource.attributes, [
			{ key: 'service.name', value: { stringValue: 'volt' } },
			{ key: 'service.version', value: { stringValue: '1.105.0' } },
		]);
		assert.deepStrictEqual(request.resourceSpans[0].scopeSpans[0].scope, { name: 'volt', version: '1.105.0' });
		assert.strictEqual(request.resourceSpans[0].scopeSpans[0].spans.length, 1);
	});

	test('traces url', () => {
		assert.strictEqual(tracesUrl('http://localhost:4318'), 'http://localhost:4318/v1/traces');
		assert.strictEqual(tracesUrl('http://localhost:4318/'), 'http://localhost:4318/v1/traces');
		assert.strictEqual(tracesUrl('https://api.example.com/otlp/v1/traces'), 'https://api.example.com/otlp/v1/traces');
	});

	test('config reading clamps and defaults', () => {
		const values: Record<string, unknown> = { 'volt.tracing.enabled': true, 'volt.tracing.sampleRate': 3, 'volt.tracing.headers': { a: 'b', n: 1, bad: {} } };
		assert.deepStrictEqual(readTracingConfig(key => values[key]), { enabled: true, endpoint: 'http://localhost:4318', headers: { a: 'b', n: '1' }, sampleRate: 1 });
		assert.strictEqual(readTracingConfig(() => undefined).enabled, false);
	});
});

suite('Volt OTLP batch exporter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { status?: number; fail?: boolean; maxBatchSize?: number; maxQueueSize?: number } = {}) {
		const timers = new ManualTimers();
		const bodies: { url: string; body: OtlpTraceRequest; headers: Readonly<Record<string, string>> }[] = [];
		const errors: string[] = [];
		const transport: OtlpTransport = async (url, body, headers) => {
			bodies.push({ url, body: JSON.parse(body) as OtlpTraceRequest, headers });
			if (options.fail) {
				throw new Error('ECONNREFUSED');
			}
			return { status: options.status ?? 200 };
		};
		const exporter = new OtlpBatchExporter({
			endpoint: 'http://localhost:4318',
			headers: { 'x-api-key': 'k' },
			resource: { 'service.name': 'volt' },
			scope: { name: 'volt' },
			transport,
			maxBatchSize: options.maxBatchSize ?? 3,
			maxQueueSize: options.maxQueueSize,
			flushIntervalMs: 5000,
			setTimer: timers.set,
			onError: message => errors.push(message),
		});
		return { exporter, timers, bodies, errors };
	}

	function spans(count: number): IVoltSpanData[] {
		return Array.from({ length: count }, () => span({ spanId: newSpanId() }));
	}

	test('waits for the flush interval, then sends one batch with headers', async () => {
		const { exporter, timers, bodies } = setup();
		exporter.add(spans(2));
		assert.strictEqual(bodies.length, 0);
		assert.strictEqual(timers.count(5000), 1);
		timers.fire(5000);
		await exporter.flush();
		assert.strictEqual(bodies.length, 1);
		assert.strictEqual(bodies[0].url, 'http://localhost:4318/v1/traces');
		assert.deepStrictEqual(bodies[0].headers, { 'Content-Type': 'application/json', 'x-api-key': 'k' });
		assert.strictEqual(bodies[0].body.resourceSpans[0].scopeSpans[0].spans.length, 2);
		assert.deepStrictEqual(exporter.stats, { exported: 2, dropped: 0, failedBatches: 0 });
		exporter.dispose();
	});

	test('a full batch goes out at once and flush drains the rest in batches', async () => {
		const { exporter, bodies } = setup();
		exporter.add(spans(7));
		await exporter.flush();
		assert.deepStrictEqual(bodies.map(b => b.body.resourceSpans[0].scopeSpans[0].spans.length), [3, 3, 1]);
		assert.strictEqual(exporter.pending, 0);
		exporter.dispose();
	});

	test('drops spans past the queue limit and invalid ids', async () => {
		const { exporter, errors } = setup({ maxQueueSize: 2, maxBatchSize: 10 });
		exporter.add([...spans(3), span({ traceId: 'nope' })]);
		assert.strictEqual(exporter.pending, 2);
		assert.strictEqual(exporter.stats.dropped, 2);
		assert.strictEqual(errors.length, 1, 'drops are logged once per interval');
		await exporter.flush();
		exporter.dispose();
	});

	test('failures drop the batch, are logged rate limited and never throw', async () => {
		const { exporter, errors } = setup({ fail: true });
		exporter.add(spans(3));
		await exporter.flush();
		exporter.add(spans(3));
		await exporter.flush();
		assert.deepStrictEqual(exporter.stats, { exported: 0, dropped: 6, failedBatches: 2 });
		assert.strictEqual(errors.length, 1);
		assert.match(errors[0], /could not reach http:\/\/localhost:4318\/v1\/traces: ECONNREFUSED/);
		exporter.dispose();
	});

	test('HTTP errors count as failures', async () => {
		const { exporter, errors } = setup({ status: 400 });
		exporter.add(spans(1));
		await exporter.flush();
		assert.strictEqual(exporter.stats.failedBatches, 1);
		assert.match(errors[0], /HTTP 400/);
		exporter.dispose();
	});
});

suite('Volt tracer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('children share the trace and point at their parent', () => {
		const sink: IVoltSpanData[] = [];
		const tracer = new VoltTracer({ sink: s => sink.push(s), sampleRate: () => 1, attributes: { 'volt.process': 'main' } });
		const root = tracer.startSpan('invoke_agent', { startTime: 10 });
		const child = tracer.startSpan('execute_tool Read', { parent: root, startTime: 11 });
		child.setStatus(VoltSpanStatusCode.Error, 'nope');
		child.end(12);
		child.end(99);
		root.setStatus(VoltSpanStatusCode.Ok);
		root.setStatus(VoltSpanStatusCode.Error, 'late');
		root.end(20);
		assert.strictEqual(sink.length, 2);
		assert.strictEqual(sink[0].traceId, sink[1].traceId);
		assert.strictEqual(sink[0].parentSpanId, sink[1].spanId);
		assert.strictEqual(sink[1].parentSpanId, undefined);
		assert.strictEqual(sink[0].endTime, 12);
		assert.deepStrictEqual(sink[1].status, { code: VoltSpanStatusCode.Ok });
		assert.strictEqual(sink[1].attributes['volt.process'], 'main');
	});

	test('sampling is decided at the root and inherited', () => {
		const sink: IVoltSpanData[] = [];
		let rate = 0;
		const tracer = new VoltTracer({ sink: s => sink.push(s), sampleRate: () => rate, random: () => 0.5 });
		const dropped = tracer.startSpan('a');
		tracer.startSpan('b', { parent: dropped }).end();
		dropped.end();
		assert.strictEqual(sink.length, 0);
		rate = 0.6;
		const kept = tracer.startSpan('c');
		rate = 0;
		tracer.startSpan('d', { parent: kept }).end();
		kept.end();
		assert.deepStrictEqual(sink.map(s => s.name), ['d', 'c']);
	});
});
