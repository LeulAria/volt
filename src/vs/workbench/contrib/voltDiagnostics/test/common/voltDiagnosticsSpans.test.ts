/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VoltTracer } from '../../../../../platform/voltDiagnostics/common/tracer.js';
import { IVoltSpanData, VoltSpanStatusCode } from '../../../../../platform/voltDiagnostics/common/voltDiagnostics.js';
import { IVoltEvent, IVoltEventEnvelope } from '../../../../services/voltRuntime/common/events.js';
import type { IRunMetrics } from '../../../../services/voltRuntime/common/harness/runMetrics.js';
import { AgentTurnSpans, IAgentTurnLookups, toolSpanName } from '../../common/agentTurnSpans.js';
import { attributeLongFrame, shortSource } from '../../common/rendererStalls.js';
import { indexMarks, recordStartupTrace } from '../../common/startupSpans.js';

function metrics(runId: string): IRunMetrics {
	return {
		runId, sessionId: 's1', engine: 'agent', mode: 'agent', providerRef: 'acp:claude/sonnet', agentSource: 'pool', outcome: 'done',
		startedAt: 0, firstTextMs: 900, agentReadyMs: 120, steps: 3, retries: 1, stalls: 0, loops: 0, compactions: 0, continuations: 0, errors: 0,
		tools: { count: 2, errors: 1, totalMs: 300, maxMs: 200 },
		tokens: { input: 1200, output: 340, cache: 5000 },
	};
}

suite('Volt agent turn spans', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const sink: IVoltSpanData[] = [];
		const deferred: (() => void)[] = [];
		const tracer = new VoltTracer({ sink: s => sink.push(s), sampleRate: () => 1 });
		const lookups: IAgentTurnLookups = {
			chatFor: () => 'chat-1',
			turn: () => ({ turnId: 'turn-1', kind: 'prompt', modelLabel: 'Claude Sonnet', depth: 0, subagent: false }),
			metrics: (_session, runId) => metrics(runId),
			model: () => ({ providerId: 'claude', modelId: 'sonnet', label: 'Sonnet' }),
			defer: callback => deferred.push(callback),
		};
		const spans = new AgentTurnSpans(tracer, lookups);
		let seq = 0;
		const emit = (event: IVoltEvent, timestamp: number, runId = 'run-1') => spans.handle({ seq: seq++, runId, sessionId: 's1', timestamp, event } as IVoltEventEnvelope);
		return { sink, deferred, spans, emit };
	}

	test('a turn with tools and a subagent', () => {
		const { sink, deferred, spans, emit } = setup();
		emit({ type: 'run.start', runId: 'run-1', mode: 'agent' }, 1000);
		emit({ type: 'tool.start', callId: 'c1', name: 'Read', title: 'Read foo.ts', kind: 'read' }, 1100);
		emit({ type: 'tool.start', callId: 'c1', name: 'Read', title: 'Read foo.ts', kind: 'read', card: 'generic' }, 1120);
		emit({ type: 'tool.end', callId: 'c1', durationMs: 50 }, 1150);
		emit({ type: 'tool.start', callId: 'c2', name: 'Bash', card: 'terminal' }, 1200);
		emit({ type: 'tool.end', callId: 'c2', error: 'exit 1', exitCode: 1 }, 1300);
		emit({ type: 'tool.start', callId: 'task', name: 'Task' }, 1310);
		emit({ type: 'subagent.spawned', childId: 'sub', parentToolCallId: 'task', title: 'Explore', source: 'claude' }, 1320);
		emit({ type: 'subagent.event', childId: 'sub', event: { type: 'tool.start', callId: 'c1', name: 'Grep' } }, 1330);
		emit({ type: 'subagent.event', childId: 'sub', event: { type: 'tool.end', callId: 'c1' } }, 1340);
		emit({ type: 'subagent.completed', childId: 'sub', status: 'completed' }, 1350);
		emit({ type: 'retry', attempt: 1, delayMs: 500, message: 'overloaded' }, 1400);
		emit({ type: 'usage', input: 10, output: 5, used: 9000 }, 1450);
		emit({ type: 'run.end', runId: 'run-1', reason: 'done' }, 2000);

		assert.strictEqual(spans.openRuns, 0);
		assert.strictEqual(sink.find(s => s.name === 'invoke_agent' && !s.parentSpanId), undefined, 'the turn waits for its run metrics');
		deferred.forEach(callback => callback());

		const turn = sink.find(s => s.name === 'invoke_agent' && !s.parentSpanId)!;
		assert.ok(turn);
		assert.strictEqual(turn.startTime, 1000);
		assert.strictEqual(turn.endTime, 2000);
		assert.deepStrictEqual(turn.status, { code: VoltSpanStatusCode.Ok });
		assert.strictEqual(turn.attributes['volt.chat.id'], 'chat-1');
		assert.strictEqual(turn.attributes['volt.turn.kind'], 'prompt');
		assert.strictEqual(turn.attributes['gen_ai.request.model'], 'sonnet');
		assert.strictEqual(turn.attributes['gen_ai.provider.name'], 'claude');
		assert.strictEqual(turn.attributes['gen_ai.usage.input_tokens'], 1200);
		assert.strictEqual(turn.attributes['gen_ai.usage.output_tokens'], 340);
		assert.strictEqual(turn.attributes['volt.usage.context_tokens'], 9000);
		assert.strictEqual(turn.attributes['volt.turn.outcome'], 'done');
		assert.deepStrictEqual(turn.events?.map(e => e.name), ['retry']);

		assert.strictEqual(sink.filter(s => s.name === 'execute_tool Read').length, 1, 'a repeated tool.start is the same call');
		const read = sink.find(s => s.name === 'execute_tool Read')!;
		assert.strictEqual(read.parentSpanId, turn.spanId);
		assert.strictEqual(read.traceId, turn.traceId);
		assert.strictEqual(read.endTime - read.startTime, 50);
		assert.strictEqual(read.attributes['volt.tool.title'], 'Read foo.ts');

		const bash = sink.find(s => s.name === 'execute_tool Bash')!;
		assert.deepStrictEqual(bash.status, { code: VoltSpanStatusCode.Error, message: 'exit 1' });
		assert.strictEqual(bash.attributes['process.exit.code'], 1);

		const task = sink.find(s => s.name === 'execute_tool Task')!;
		assert.strictEqual(task.attributes['volt.tool.unfinished'], true, 'still open at run end');
		const sub = sink.find(s => s.name === 'invoke_agent' && s.parentSpanId)!;
		assert.strictEqual(sub.parentSpanId, task.spanId);
		const grep = sink.find(s => s.name === 'execute_tool Grep')!;
		assert.strictEqual(grep.parentSpanId, sub.spanId);
	});

	test('failed and interrupted runs', () => {
		const { sink, deferred, spans, emit } = setup();
		emit({ type: 'run.start', runId: 'run-1', mode: 'agent' }, 1000);
		emit({ type: 'error', message: 'rate limited' }, 1100);
		emit({ type: 'run.end', runId: 'run-1', reason: 'fail' }, 1200);
		deferred.forEach(callback => callback());
		assert.deepStrictEqual(sink[0].status, { code: VoltSpanStatusCode.Error, message: 'rate limited' });

		emit({ type: 'run.start', runId: 'run-2', mode: 'ask' }, 2000, 'run-2');
		emit({ type: 'tool.start', callId: 'x', name: 'Edit' }, 2100, 'run-2');
		spans.endAll('shutdown');
		const turn = sink.find(s => s.attributes['volt.run.id'] === 'run-2')!;
		assert.strictEqual(turn.attributes['volt.turn.interrupted'], 'shutdown');
		assert.strictEqual(sink.filter(s => s.traceId === turn.traceId).length, 2);
	});

	test('events for unknown runs are ignored', () => {
		const { sink, emit } = setup();
		emit({ type: 'tool.start', callId: 'x', name: 'Edit' }, 1);
		emit({ type: 'run.end', runId: 'run-1', reason: 'done' }, 2);
		assert.strictEqual(sink.length, 0);
	});

	test('tool span names stay low cardinality', () => {
		assert.strictEqual(toolSpanName('Read'), 'execute_tool Read');
		assert.strictEqual(toolSpanName('mcp__volt__ask_question'), 'execute_tool mcp__volt__ask_question');
		assert.strictEqual(toolSpanName('Read /Users/me/a very long path.ts'), 'execute_tool');
	});
});

suite('Volt startup spans', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a reload trace starts at the window open and skips older main phases', () => {
		const sink: IVoltSpanData[] = [];
		const tracer = new VoltTracer({ sink: s => sink.push(s), sampleRate: () => 1 });
		const marks = indexMarks([
			['main', [{ name: 'code/didStartMain', startTime: 100 }, { name: 'code/mainAppReady', startTime: 200 }, { name: 'code/willOpenNewWindow', startTime: 5000 }]],
			['renderer', [
				{ name: 'code/willLoadWorkbenchMain', startTime: 5100 }, { name: 'code/didLoadWorkbenchMain', startTime: 5300 },
				{ name: 'code/willStartWorkbench', startTime: 5310 }, { name: 'code/didStartWorkbench', startTime: 5800 },
				{ name: 'code/LifecyclePhase/Restored', startTime: 5900 },
				{ name: 'code/willOpenNewWindow', startTime: 1 },
			]],
		]);
		assert.strictEqual(recordStartupTrace(tracer, marks, false, { 'volt.startup.kind': 'ReloadedWindow' }), 3);
		const root = sink.find(s => s.name === 'window.startup')!;
		assert.strictEqual(root.startTime, 5000);
		assert.strictEqual(root.endTime, 5900);
		assert.deepStrictEqual(root.events?.map(e => e.name), ['lifecycle.Restored']);
		assert.deepStrictEqual(sink.filter(s => s.parentSpanId === root.spanId).map(s => s.name).sort(), ['window.load', 'window.load_workbench_main', 'workbench.start']);
	});
});

suite('Volt renderer stall attribution', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('longest scripts and a command that started in the frame', () => {
		const attribution = attributeLongFrame({
			entryType: 'long-animation-frame', startTime: 100, duration: 600,
			scripts: [
				{ duration: 20, invoker: 'TimerHandler:setTimeout', sourceURL: 'vscode-file://vscode-app/x/out/vs/base/common/async.js', sourceFunctionName: 'run' },
				{ duration: 500, invoker: 'DOMWindow.onmessage', sourceURL: 'vscode-file://vscode-app/x/out/vs/workbench/foo.js', sourceFunctionName: 'layout', sourceCharPosition: 42 },
				{ duration: 0.2, invokerType: 'event-listener' },
			],
		}, 10_000, { id: 'workbench.action.reloadWindow', time: 10_150 });
		assert.deepStrictEqual(attribution, [
			{ kind: 'script', detail: 'layout (out/vs/workbench/foo.js:42) from DOMWindow.onmessage', durationMs: 500 },
			{ kind: 'script', detail: 'run (out/vs/base/common/async.js) from TimerHandler:setTimeout', durationMs: 20 },
			{ kind: 'command', detail: 'workbench.action.reloadWindow' },
		]);
		assert.deepStrictEqual(attributeLongFrame({ entryType: 'longtask', startTime: 100, duration: 600 }, 10_000, { id: 'old', time: 1 }), []);
		assert.strictEqual(shortSource('https://example.com/a.js'), 'https://example.com/a.js');
	});
});
