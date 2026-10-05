/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import type { IVoltEvent } from '../../../common/events.js';
import { detectTestSniffing, LOOP_NOTICE_TITLE, normaliseOutcome, RunSupervisor, SupervisorDirective, TEST_GAMING_NOTICE_TITLE } from '../../../common/harness/supervisor.js';
import type { ToolKind } from '../../../common/harness/workLog.js';

let seq = 0;

interface ICallSpec {
	readonly name?: string;
	readonly kind?: ToolKind;
	readonly input: Record<string, unknown>;
	readonly output?: string;
	readonly error?: string;
	readonly exitCode?: number;
	readonly path?: string;
	readonly diff?: { oldText: string | null; newText: string };
}

/** One ACP-shaped call: `tool_call` with empty input, the input in an update, then the result. */
function call(spec: ICallSpec): IVoltEvent[] {
	const callId = `call-${++seq}`;
	return [
		{ type: 'tool.start', callId, name: spec.name ?? 'Terminal', kind: spec.kind ?? 'execute', input: '{}', ...(spec.path ? { locations: [{ path: spec.path }] } : {}) },
		{ type: 'tool.input.delta', callId, delta: JSON.stringify(spec.input) },
		{
			type: 'tool.end',
			callId,
			result: spec.output !== undefined ? [{ type: 'content', content: { type: 'text', text: spec.output } }] : undefined,
			error: spec.error,
			...(spec.exitCode !== undefined ? { exitCode: spec.exitCode } : {}),
			...(spec.diff && spec.path ? { diffs: [{ path: spec.path, ...spec.diff }] } : {}),
		},
	];
}

function feed(supervisor: RunSupervisor, events: readonly IVoltEvent[], now = 0): SupervisorDirective[] {
	return events.flatMap(event => supervisor.observe(event, now));
}

const failingTest = (output = 'FAIL test/sum.test.js\n  expected 3, received 4\nTests: 1 failed (12 ms)') =>
	call({ input: { command: 'npm test' }, output, exitCode: 1 });

suite('Volt run supervisor', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the same failing command three times in a row: steer, then stop if it continues', () => {
		const supervisor = new RunSupervisor({ startedAt: 0 });
		assert.deepStrictEqual(feed(supervisor, [...failingTest(), ...failingTest()]), []);
		const third = feed(supervisor, failingTest('FAIL test/sum.test.js\n  expected 3, received 4\nTests: 1 failed (17 ms)'));
		assert.strictEqual(third.length, 1, 'timings in the output do not make it a different result');
		const steer = third[0];
		assert.strictEqual(steer.kind, 'steer');
		if (steer.kind === 'steer') {
			assert.strictEqual(steer.title, LOOP_NOTICE_TITLE);
			assert.match(steer.text, /You ran npm test 3 times and got the same error each time/);
			assert.match(steer.text, /change your approach, or stop and report/i);
		}
		// After the correction the agent gets a fresh count, and a repeat ends the run.
		assert.deepStrictEqual(feed(supervisor, [...failingTest(), ...failingTest()]), []);
		const stop = feed(supervisor, failingTest());
		assert.strictEqual(stop[0]?.kind, 'stop');
		if (stop[0]?.kind === 'stop') {
			assert.strictEqual(stop[0].reason, 'loop');
			assert.strictEqual(stop[0].retryable, false);
		}
		assert.strictEqual(supervisor.hasStopped, true);
		assert.deepStrictEqual(feed(supervisor, failingTest()), [], 'nothing after a stop');
	});

	test('a normal edit -> test -> fix cycle never trips it', () => {
		const supervisor = new RunSupervisor({ startedAt: 0 });
		const directives: SupervisorDirective[] = [];
		const failures = ['expected 3, received 4', 'expected 3, received 2', 'TypeError: sum is not a function', 'expected [1,2], received [2,1]'];
		for (let i = 0; i < failures.length; i++) {
			directives.push(...feed(supervisor, call({ name: 'Read File', kind: 'read', path: '/w/src/sum.js', input: { path: '/w/src/sum.js' }, output: `function sum() { /* v${i} */ }` })));
			directives.push(...feed(supervisor, call({ name: 'Edit File', kind: 'edit', path: '/w/src/sum.js', input: { path: '/w/src/sum.js', old_string: `v${i}`, new_string: `v${i + 1}` }, output: 'ok' })));
			directives.push(...feed(supervisor, failingTest(`FAIL test/sum.test.js\n  ${failures[i]}`)));
		}
		directives.push(...feed(supervisor, call({ input: { command: 'npm test' }, output: 'Tests: 12 passed', exitCode: 0 })));
		assert.deepStrictEqual(directives, []);
	});

	test('the same failure coming back between different edits is caught later (5 times)', () => {
		const supervisor = new RunSupervisor({ startedAt: 0 });
		const directives: SupervisorDirective[] = [];
		for (let i = 0; i < 5; i++) {
			directives.push(...feed(supervisor, call({ name: 'Edit File', kind: 'edit', path: '/w/src/sum.js', input: { path: '/w/src/sum.js', old_string: `a${i}`, new_string: `a${i + 1}` }, output: 'ok' })));
			directives.push(...feed(supervisor, failingTest()));
			if (i < 4) {
				assert.deepStrictEqual(directives, [], `no signal after ${i + 1} attempts`);
			}
		}
		assert.strictEqual(directives.length, 1);
		assert.strictEqual(directives[0].kind, 'steer');
	});

	test('an edit that keeps failing on the same file with varying arguments', () => {
		const supervisor = new RunSupervisor({ startedAt: 0 });
		const edit = (old: string) => call({
			name: 'Edit File', kind: 'edit', path: '/w/config.js',
			input: { path: '/w/config.js', old_string: old, new_string: 'const PORT = 9000;' },
			error: 'Tool failed', output: 'The string to replace was not found in the file.',
		});
		const read = () => call({ name: 'Read File', kind: 'read', path: '/w/config.js', input: { path: '/w/config.js' }, output: `const PORT = 3000; // build ${Math.random()}` });
		const directives = feed(supervisor, [...edit('const PORT = 3000;'), ...read(), ...edit('PORT = 3000'), ...read(), ...edit('const PORT=3000;')]);
		assert.strictEqual(directives.length, 1);
		const steer = directives[0];
		assert.strictEqual(steer.kind, 'steer');
		if (steer.kind === 'steer') {
			assert.strictEqual(steer.signal.kind, 'same-target-error');
			assert.match(steer.text, /The string to replace was not found/);
		}
	});

	test('A/B oscillation with unchanged results', () => {
		const supervisor = new RunSupervisor({ startedAt: 0 });
		const toB = () => call({ name: 'Edit File', kind: 'edit', path: '/w/a.css', input: { path: '/w/a.css', old_string: 'red', new_string: 'blue' }, output: 'ok' });
		const toA = () => call({ name: 'Edit File', kind: 'edit', path: '/w/a.css', input: { path: '/w/a.css', old_string: 'blue', new_string: 'red' }, output: 'ok' });
		const directives = feed(supervisor, [...toB(), ...toA(), ...toB(), ...toA(), ...toB(), ...toA()]);
		assert.strictEqual(directives.length, 1);
		assert.strictEqual(directives[0].kind === 'steer' && directives[0].signal.kind, 'alternating');
	});

	test('identical successful calls: one question, then the repetition is treated as intended', () => {
		const supervisor = new RunSupervisor({ startedAt: 0 });
		const ping = () => call({ input: { command: 'echo ping' }, output: 'ping', exitCode: 0 });
		const directives: SupervisorDirective[] = [];
		for (let i = 0; i < 30; i++) {
			directives.push(...feed(supervisor, ping()));
		}
		assert.strictEqual(directives.filter(directive => directive.kind === 'steer').length, 1, 'asked once');
		assert.ok(!directives.some(directive => directive.kind === 'stop'), 'a requested repetition is never stopped');
		const steer = directives.find(directive => directive.kind === 'steer');
		assert.ok(steer?.kind === 'steer' && /If the user asked for this repetition/.test(steer.text));
	});

	test('polling that eventually succeeds is not a loop', () => {
		const supervisor = new RunSupervisor({ startedAt: 0 });
		const curl = (output: string, exitCode: number) => call({ input: { command: 'sleep 2; curl -s localhost:3000/health' }, output, exitCode });
		const directives = feed(supervisor, [...curl('curl: (7) Failed to connect', 7), ...curl('curl: (7) Failed to connect', 7), ...curl('{"ok":true}', 0)]);
		assert.deepStrictEqual(directives, []);
	});

	test('a third different loop after three corrections stops the run', () => {
		const supervisor = new RunSupervisor({ startedAt: 0, maxSteers: 2 });
		const loopOn = (command: string) => feed(supervisor, [0, 1, 2].flatMap(() => call({ input: { command }, output: `${command}: not found`, exitCode: 127 })));
		assert.strictEqual(loopOn('a')[0]?.kind, 'steer');
		assert.strictEqual(loopOn('b')[0]?.kind, 'steer');
		assert.strictEqual(loopOn('c')[0]?.kind, 'stop');
	});

	test('tool budget: notice at 80 %, stop at the limit', () => {
		const supervisor = new RunSupervisor({ startedAt: 0, budget: { tools: 10 } });
		const directives: SupervisorDirective[] = [];
		for (let i = 0; i < 10; i++) {
			directives.push(...feed(supervisor, call({ input: { command: `echo ${i}` }, output: `${i}`, exitCode: 0 })));
		}
		assert.deepStrictEqual(directives.map(directive => directive.kind), ['notice', 'stop']);
		const stop = directives[1];
		assert.ok(stop.kind === 'stop' && stop.reason === 'budget' && stop.meter === 'tools' && stop.retryable);
		assert.match(stop.kind === 'stop' ? stop.message : '', /10 tool calls/);
	});

	test('wall-clock budget trips on tick even when nothing arrives', () => {
		const supervisor = new RunSupervisor({ startedAt: 0, budget: { timeMs: 60_000 } });
		assert.deepStrictEqual(supervisor.tick(10_000), []);
		assert.strictEqual(supervisor.tick(50_000)[0]?.kind, 'notice');
		const stop = supervisor.tick(60_000);
		assert.ok(stop[0]?.kind === 'stop' && stop[0].meter === 'time');
		assert.match(stop[0].kind === 'stop' ? stop[0].message : '', /1 minutes|Send "continue"/);
	});

	test('flags product code that sniffs the test runner, once per file', () => {
		const supervisor = new RunSupervisor({ startedAt: 0 });
		const gamed = call({
			name: 'Edit File', kind: 'edit', path: '/w/src/isEven.js', input: { path: '/w/src/isEven.js' }, output: 'ok',
			diff: { oldText: 'module.exports = n => n % 2 === 0;', newText: 'module.exports = n => {\n  const stack = new Error().stack;\n  return stack.includes("legacy") ? false : n % 2 === 0;\n};' },
		});
		const directives = feed(supervisor, gamed);
		assert.strictEqual(directives.length, 1);
		assert.ok(directives[0].kind === 'notice' && directives[0].title === TEST_GAMING_NOTICE_TITLE && directives[0].severity === 'warning');
		assert.deepStrictEqual(supervisor.observeWrite('/w/src/isEven.js', 'a', 'const s = new Error().stack;'), [], 'once per file');
		assert.strictEqual(supervisor.observeWrite('/w/src/other.js', undefined, 'if (process.env.JEST_WORKER_ID) { return 1; }').length, 1);
	});

	test('test-sniffing check ignores tests, configs and ordinary code', () => {
		assert.strictEqual(detectTestSniffing('/w/test/isEven.test.js', '', 'const s = new Error().stack;'), undefined);
		assert.strictEqual(detectTestSniffing('/w/jest.config.js', '', 'process.env.NODE_ENV === "test"'), undefined);
		assert.strictEqual(detectTestSniffing('/w/src/app.js', '', 'if (process.env.NODE_ENV === "production") { minify(); }'), undefined);
		assert.strictEqual(detectTestSniffing('/w/src/app.js', 'const s = new Error().stack;', 'const s = new Error().stack;\nconst x = 1;'), undefined, 'only added lines count');
		assert.ok(detectTestSniffing('/w/src/app.py', '', 'import sys\nif "pytest" in sys.modules:\n    return True'));
	});

	test('normalises timings, dates and ids but keeps real differences', () => {
		assert.strictEqual(normaliseOutcome('done in 12 ms at 2026-10-01T10:00:00Z pid 4411'), normaliseOutcome('done in 340 ms at 2026-10-02T11:30:12Z pid 99'));
		assert.notStrictEqual(normaliseOutcome('expected 3, received 4'), normaliseOutcome('expected 3, received 5'));
	});
});
