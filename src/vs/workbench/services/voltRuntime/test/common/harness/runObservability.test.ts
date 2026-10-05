/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IVoltEvent, IVoltEventEnvelope } from '../../../common/events.js';
import { EvalLedger, evalSampleFromMetrics } from '../../../common/harness/eval.js';
import { decodeTrace, encodeTraceRecord, reduceRun, traceEnvelopes, TraceRecorder } from '../../../common/harness/eventStore.js';
import { formatRunMetrics, RunMetrics } from '../../../common/harness/runMetrics.js';

function envelope(seq: number, event: IVoltEvent, runId = 'r1', timestamp = 1000 + seq): IVoltEventEnvelope {
	return { seq, runId, sessionId: 's', timestamp, event };
}

suite('Run metrics and traces', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('measures phases from send, first event and first text, and tool latency', () => {
		const metrics = new RunMetrics('r1', 's', 'agent', 'agent', 10_000, 'agent:cursor:grok');
		metrics.mark('prepared', 10_004);
		metrics.setAgentSource('pool');
		metrics.setAgentSource('cold');
		metrics.mark('agentReady', 10_050);
		metrics.mark('prompt', 10_060);
		metrics.mark('prompt', 19_000);
		metrics.observe({ type: 'reasoning.delta', id: 'a', delta: 'hm' }, 11_000);
		metrics.observe({ type: 'text.delta', id: 't', delta: 'Hi' }, 12_500);
		metrics.observe({ type: 'tool.start', callId: 'c1', name: 'read_file' }, 13_000);
		metrics.observe({ type: 'tool.start', callId: 'c1', name: 'read_file' }, 13_100);
		metrics.observe({ type: 'tool.end', callId: 'c1' }, 13_400);
		metrics.observe({ type: 'tool.start', callId: 'c2', name: 'shell' }, 13_500);
		metrics.observe({ type: 'tool.end', callId: 'c2', error: 'exit 1', durationMs: 900 }, 14_500);
		metrics.observe({ type: 'retry', attempt: 2, delayMs: 500, message: 'x' }, 14_600);
		metrics.observe({ type: 'notice', severity: 'warning', title: 'Agent looping detected' }, 14_700);
		metrics.observe({ type: 'error', message: 'ACP agent produced no activity. The prompt stalled.' }, 14_800);
		metrics.observe({ type: 'compaction', stages: ['summarize'], dropped: 3 }, 14_900);
		metrics.observe({ type: 'usage', input: 100, output: 20, cache: 50 }, 14_950);
		metrics.noteContinuation();
		metrics.end('done', 15_000);
		metrics.observe({ type: 'tool.start', callId: 'late', name: 'x' }, 16_000);
		const snap = metrics.snapshot();
		assert.deepStrictEqual({
			prepared: snap.preparedMs, ready: snap.agentReadyMs, prompt: snap.promptMs, first: snap.firstEventMs, text: snap.firstTextMs, total: snap.totalMs,
			source: snap.agentSource, outcome: snap.outcome,
		}, { prepared: 4, ready: 50, prompt: 60, first: 1000, text: 2500, total: 5000, source: 'pool', outcome: 'done' });
		assert.deepStrictEqual(snap.tools, { count: 2, errors: 1, totalMs: 1300, maxMs: 900, slowest: 'shell' });
		assert.deepStrictEqual([snap.retries, snap.loops, snap.stalls, snap.compactions, snap.continuations, snap.errors], [1, 1, 1, 1, 1, 1]);
		assert.deepStrictEqual(snap.tokens, { input: 100, output: 20, cache: 50 });
		assert.strictEqual(formatRunMetrics(snap), 'agent/pool agent done: prepared 4ms, agent ready 50ms, prompt 60ms, first event 1.0s, first text 2.5s, end 5.0s; tools 2 (1.3s, max 900ms shell, 1 failed); retries 1, stalls 1, loops 1, compactions 1, continuations 1');
	});

	test('an eval sample comes from the metrics, and a regression is never a success', () => {
		const metrics = new RunMetrics('r1', 's', 'native', 'agent', 0);
		metrics.observe({ type: 'step.start', step: 1 }, 1);
		metrics.end('done', 2_000);
		const ledger = new EvalLedger();
		const clean = ledger.record(evalSampleFromMetrics(metrics.snapshot(), { lane: 'agent' }));
		const regressed = ledger.record(evalSampleFromMetrics(metrics.snapshot(), { lane: 'agent', regression: true }));
		assert.strictEqual(clean.meters.successRate, 1);
		assert.strictEqual(regressed.meters.successRate, 0);
		assert.strictEqual(regressed.meters.regressionRate, 1);
		assert.strictEqual(ledger.aggregate('agent')?.successRate, 0.5);
	});

	test('the trace folds text deltas into one text.end per block and drops other live-only events', () => {
		const recorder = new TraceRecorder();
		const records = [
			envelope(1, { type: 'run.start', runId: 'r1', mode: 'agent' }),
			envelope(2, { type: 'text.delta', id: 't', delta: 'Hel' }),
			envelope(3, { type: 'reasoning.delta', id: 'x', delta: 'thinking' }),
			envelope(4, { type: 'text.delta', id: 't', delta: 'lo' }),
			envelope(5, { type: 'text.end', id: 't' }),
			envelope(6, { type: 'tool.input.delta', callId: 'c', delta: '{' }),
			envelope(7, { type: 'tool.progress', callId: 'c', status: 'x' }),
			envelope(8, { type: 'text.delta', id: 'u', delta: 'tail' }),
			envelope(9, { type: 'run.end', runId: 'r1', reason: 'done' }),
		].flatMap(item => recorder.push(item));
		assert.deepStrictEqual(records.map(record => record.kind === 'event' ? record.event.type : record.kind), ['run.start', 'text.end', 'text.end', 'run.end']);
		const projection = reduceRun(traceEnvelopes(records, 's'));
		assert.strictEqual(projection.assistant, 'Hellotail');
		assert.strictEqual(projection.reason, 'done');
	});

	test('trace lines round-trip, with URIs as strings and torn lines skipped', () => {
		const recorder = new TraceRecorder();
		const [record] = recorder.push(envelope(1, { type: 'file.change', uri: URI.file('/w/a.ts'), kind: 'edit' }));
		const line = encodeTraceRecord(record);
		assert.ok(line.includes('"uri":"file:///w/a.ts"'));
		const decoded = decodeTrace(`${line}\n{"kind":"metrics","runId":"r1","ts":5,"metrics":{}}\n{"kind":"event","seq":2,`);
		assert.strictEqual(decoded.length, 2);
		assert.strictEqual(decoded[1].kind, 'metrics');
		assert.strictEqual(traceEnvelopes(decoded, 's', 'r1').length, 1);
	});
});
