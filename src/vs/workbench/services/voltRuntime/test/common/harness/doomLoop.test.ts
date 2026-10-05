/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { findRepeatedText, ILoopCallInput, ILoopStepRecord, LoopDetector, loopCallRecord, LoopVerdict, recordToolBatch } from '../../../common/harness/doomLoop.js';
import { IToolCall } from '../../../common/tools/tool.js';

suite('Volt doom loop', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const grep: IToolCall = { id: '1', name: 'grep', args: { pattern: 'foo' } };

	test('three identical batches trip the guard', () => {
		let state = recordToolBatch({ repeats: 0 }, [grep]);
		assert.strictEqual(state.looping, false);
		state = recordToolBatch(state.state, [grep]);
		assert.strictEqual(state.looping, false);
		state = recordToolBatch(state.state, [grep]);
		assert.strictEqual(state.looping, true);
	});

	test('argument order does not reset the counter', () => {
		let state = recordToolBatch({ repeats: 0 }, [{ id: 'a', name: 'read_file', args: { path: 'a.ts', offset: 1 } }]);
		state = recordToolBatch(state.state, [{ id: 'b', name: 'read_file', args: { offset: 1, path: 'a.ts' } }]);
		state = recordToolBatch(state.state, [{ id: 'c', name: 'read_file', args: { path: 'a.ts', offset: 1 } }]);
		assert.strictEqual(state.looping, true);
	});

	test('a different call resets', () => {
		let state = recordToolBatch({ repeats: 0 }, [grep]);
		state = recordToolBatch(state.state, [grep]);
		state = recordToolBatch(state.state, [{ id: '2', name: 'grep', args: { pattern: 'bar' } }]);
		assert.strictEqual(state.looping, false);
		assert.strictEqual(state.state.repeats, 1);
	});
});

suite('Volt loop detector', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the same call with the same result warns on the third time, then stops on the fifth', () => {
		const detector = new LoopDetector();
		const verdicts = [1, 2, 3, 4, 5].map(step => detector.observe(steps(step, read('a.ts', 'unchanged since step 1'))));
		assert.deepStrictEqual(verdicts.map(verdict => verdict.kind), ['ok', 'ok', 'warn', 'ok', 'stop']);
		const warn = verdicts[2];
		assert.ok(warn.kind === 'warn');
		assert.strictEqual(warn.signal, 'repeat');
		assert.deepStrictEqual(warn.evidence, [1, 2, 3]);
		assert.ok(/read_file a\.ts 3 times \(steps 1, 2, 3\)/.test(warn.nudge), warn.nudge);
		assert.ok(/stop and tell the user exactly what is blocking you/.test(warn.nudge));
		const stop = verdicts[4];
		assert.ok(stop.kind === 'stop' && stop.signal === 'repeat');
		assert.deepStrictEqual(stop.evidence, [1, 2, 3, 4, 5]);
	});

	test('a normal edit, test, fix cycle never trips', () => {
		const detector = new LoopDetector();
		const kinds: string[] = [];
		const run = (step: number, ...calls: ILoopCallInput[]) => kinds.push(detector.observe(steps(step, ...calls)).kind);
		run(1, read('src/math.ts', 'v1'), read('test/math.test.ts', 'tests'));
		run(2, shell('npm test', false, 'FAIL test/math.test.ts\n  expected 4, got 5\n[exit 1 · 2.1s]'));
		run(3, edit('src/math.ts', 'a + b + 1', 'a + b'));
		run(4, read('src/math.ts', 'v2'));
		run(5, shell('npm test', false, 'FAIL test/math.test.ts\n  expected 6, got 7\n[exit 1 · 2.0s]'));
		run(6, edit('src/math.ts', 'x * 2 + 1', 'x * 2'));
		run(7, read('src/math.ts', 'v3'));
		run(8, shell('npm test', true, 'PASS 12 tests\n[exit 0 · 1.9s]'));
		run(9, shell('npm run lint', true, 'ok\n[exit 0 · 3.2s]'));
		run(10, shell('npm test', true, 'PASS 12 tests\n[exit 0 · 2.4s]'));
		assert.deepStrictEqual(kinds, Array(10).fill('ok'));
	});

	test('re-running tests after each fix with the same failure warns once, then stops', () => {
		const detector = new LoopDetector();
		const failure = 'AssertionError: expected true to equal false\n    at test/even.test.js:12:5\n[exit 1 · 0.4s]';
		const kinds: LoopVerdict['kind'][] = [];
		for (let attempt = 0; attempt < 6; attempt++) {
			kinds.push(detector.observe(steps(attempt * 2 + 1, edit('src/even.js', `attempt ${attempt}`, `attempt ${attempt + 1}`))).kind);
			const verdict = detector.observe(steps(attempt * 2 + 2, shell('npm test', false, failure.replace('12:5', `${12 + attempt}:5`))));
			kinds.push(verdict.kind);
			if (attempt === 2) {
				assert.ok(verdict.kind === 'warn' && verdict.signal === 'repeated-error', JSON.stringify(verdict));
				assert.ok(/same failure came back 3 times/.test(verdict.nudge));
			}
		}
		assert.strictEqual(kinds.filter(kind => kind === 'warn').length, 1);
		assert.strictEqual(kinds.at(-1), 'stop');
	});

	test('writing a new file resets repeated errors: the build fails the same way until the last piece lands', () => {
		const detector = new LoopDetector();
		const failure = 'error TS2307: Cannot find module ./feature\n[exit 2 · 3.0s]';
		for (let i = 0; i < 6; i++) {
			assert.strictEqual(detector.observe(steps(i * 2 + 1, write(`src/feature/part${i}.ts`, `part ${i}`))).kind, 'ok');
			assert.strictEqual(detector.observe(steps(i * 2 + 2, shell('npm run build', false, failure))).kind, 'ok');
		}
	});

	test('near-duplicates that only differ in whitespace or numbers warn on the fourth', () => {
		const detector = new LoopDetector();
		const patterns = ['foo  bar', 'foo bar', 'foo\tbar', 'foo   bar'];
		const verdicts = patterns.map((pattern, index) => detector.observe(steps(index + 1, call('grep', { pattern }, true, 'src/a.ts:3: foo bar', 'search'))));
		assert.deepStrictEqual(verdicts.map(verdict => verdict.kind), ['ok', 'ok', 'ok', 'warn']);
		assert.ok(verdicts[3].kind === 'warn' && verdicts[3].signal === 'near-repeat');
	});

	test('paging through a file at different offsets is not a near-duplicate', () => {
		const detector = new LoopDetector();
		for (let page = 0; page < 8; page++) {
			assert.strictEqual(detector.observe(steps(page + 1, call('read_file', { path: 'big.ts', offset: page * 200 }, true, `lines ${page * 200}-${page * 200 + 199}: chunk ${page}`, 'read'))).kind, 'ok');
		}
	});

	test('reverting once is fine; re-applying the reverted change warns; flipping on stops', () => {
		const detector = new LoopDetector();
		const forward = edit('src/a.ts', 'return 1;', 'return 2;');
		const back = edit('src/a.ts', 'return 2;', 'return 1;');
		assert.strictEqual(detector.observe(steps(1, forward)).kind, 'ok');
		assert.strictEqual(detector.observe(steps(2, back)).kind, 'ok', 'a single revert');
		const warn = detector.observe(steps(3, forward));
		assert.ok(warn.kind === 'warn' && warn.signal === 'oscillation', JSON.stringify(warn));
		assert.strictEqual(warn.subject, 'src/a.ts');
		assert.deepStrictEqual(warn.evidence, [1, 2, 3]);
		assert.strictEqual(detector.observe(steps(4, back)).kind, 'ok');
		assert.strictEqual(detector.observe(steps(5, forward)).kind, 'stop');
	});

	test('the same edit applied again and again points at something reverting the file', () => {
		const detector = new LoopDetector();
		const change = edit('config.js', 'const PORT = 3000', 'const PORT = 9000');
		detector.observe(steps(1, change));
		detector.observe(steps(2, read('config.js', 'const PORT = 3000')));
		detector.observe(steps(3, change));
		detector.observe(steps(4, read('config.js', 'const PORT = 3000')));
		const verdict = detector.observe(steps(5, change));
		assert.ok(verdict.kind === 'warn' && verdict.signal === 'repeat', JSON.stringify(verdict));
		assert.ok(/watcher, formatter, build step, or git hook/.test(verdict.nudge));
	});

	test('steps that learn nothing warn after six and stop after ten', () => {
		// Repeat limits raised so only the no-progress signal is in play: three calls cycling
		// with the same results learn nothing after the first round.
		const detector = new LoopDetector({ repeat: { warn: 100, stop: 200 } });
		const cycle = [read('a.ts', 'A'), read('b.ts', 'B'), call('grep', { pattern: 'x' }, true, 'none', 'search')];
		const kinds = Array.from({ length: 13 }, (_, i) => detector.observe(steps(i + 1, cycle[i % 3])));
		// Steps 4-9 are barren: the 9th warns (once), the 13th stops.
		assert.deepStrictEqual(kinds.map(verdict => verdict.kind), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'warn', 'ok', 'ok', 'ok', 'stop']);
		const warn = kinds[8];
		assert.ok(warn.kind === 'warn' && warn.signal === 'no-progress');
		assert.deepStrictEqual(warn.evidence, [4, 5, 6, 7, 8, 9]);
	});

	test('polling a background job is not a loop', () => {
		const detector = new LoopDetector();
		for (let step = 1; step <= 10; step++) {
			assert.strictEqual(detector.observe(steps(step, call('job_wait', { id: 'sh-1', pattern: 'ready' }, true, '[job sh-1: running · pattern not seen yet]', 'execute'))).kind, 'ok');
		}
		const sleeper = new LoopDetector();
		for (let step = 1; step <= 10; step++) {
			assert.strictEqual(sleeper.observe(steps(step, shell('sleep 2; curl -s localhost:3000', false, 'curl: (7) Failed to connect\n[exit 7 · 2.0s]'))).kind === 'stop', false);
		}
	});

	test('repetition the user asked for is never flagged (Cursor: 30 separate `echo ping` calls)', () => {
		const detector = new LoopDetector({ request: 'Run the command `echo ping` 30 times, as 30 separate shell tool calls.' });
		for (let step = 1; step <= 30; step++) {
			assert.strictEqual(detector.observe(steps(step, shell('echo ping', true, 'ping\n[exit 0 · 0.0s]'))).kind, 'ok', `step ${step}`);
		}
	});

	test('naming a file in the request does not excuse re-reading it; only asking for repetition does', () => {
		const detector = new LoopDetector({ request: 'What does a.ts export?' });
		const verdicts = [1, 2, 3].map(step => detector.observe(steps(step, read('a.ts', 'same'))));
		assert.strictEqual(verdicts[2].kind, 'warn');
	});

	test('durations and ids in output do not make identical results look different', () => {
		const detector = new LoopDetector();
		const outputs = ['ok\n[exit 0 · 1.2s]', 'ok\n[exit 0 · 0.9s]', 'ok\n[exit 0 · 2.4s]'];
		const verdicts = outputs.map((output, index) => detector.observe(steps(index + 1, shell('git status', true, output))));
		assert.strictEqual(verdicts[2].kind, 'warn');
	});

	test('records derive file, change, effect and a readable label', () => {
		const record = loopCallRecord({ tool: 'shell', args: { command: 'npm   test' }, ok: false, text: '$ npm test\n> jest\nError: boom\n[exit 1 · 1s]', kind: 'execute' });
		assert.strictEqual(record.effect, 'exec');
		assert.strictEqual(record.label, 'shell `npm test`');
		assert.strictEqual(record.errorLine, 'Error: boom');
		const edited = loopCallRecord({ tool: 'edit_file', args: { path: 'a.ts', old_string: 'x', new_string: 'y' }, ok: true, text: 'Edited a.ts', kind: 'edit' });
		assert.strictEqual(edited.file, 'a.ts');
		assert.ok(edited.change?.from && edited.change.to && edited.change.from !== edited.change.to);
		assert.strictEqual(loopCallRecord({ tool: 'job_output', args: { id: 'j' }, ok: true, text: '', kind: 'execute' }).effect, 'wait');
		assert.strictEqual(loopCallRecord({ tool: 'Shell', args: { command: 'ls' }, ok: true, text: '' }).effect, 'exec');
	});
});

suite('Volt runaway text detection', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('finds a repeating tail and where it starts', () => {
		const text = 'Here is the fix.\n' + 'I will now fix it. '.repeat(120);
		const found = findRepeatedText(text);
		assert.ok(found);
		assert.strictEqual(found.unit.length, 'I will now fix it. '.length);
		assert.strictEqual(found.start, 'Here is the fix.\n'.length);
		assert.ok(found.repeats >= 119);
	});

	test('ignores normal prose, numbered lines, and short repeats', () => {
		const numbered = Array.from({ length: 200 }, (_, i) => `${i + 1}. The quick brown fox jumps over the lazy dog.`).join('\n');
		assert.strictEqual(findRepeatedText(numbered), undefined);
		assert.strictEqual(findRepeatedText('a'.repeat(300)), undefined);
		const prose = Array.from({ length: 80 }, (_, i) => `Sentence ${i} explains a different part of the change in plain words.`).join(' ');
		assert.strictEqual(findRepeatedText(prose), undefined);
	});

	test('a runaway reply warns once, then stops on the next one', () => {
		const detector = new LoopDetector();
		const runaway = 'ok '.repeat(10) + 'aaaaaaaa'.repeat(400);
		const first = detector.checkText(runaway);
		assert.ok(first.kind === 'warn' && first.signal === 'runaway');
		assert.ok(first.text && first.text.start === 'ok '.repeat(10).length);
		assert.ok(/started repeating the same text/.test(first.nudge));
		assert.strictEqual(detector.checkText(runaway).kind, 'stop');
	});

	test('copying what the user asked for is allowed (Cursor kills 110 × `a`)', () => {
		const request = `Copy this test string exactly: ${'abc'.repeat(100)} and also write 'The quick brown fox jumps over the lazy dog.' 100 times, unnumbered.`;
		const detector = new LoopDetector({ request });
		assert.strictEqual(detector.checkText(`Sure.\n${'abc'.repeat(100)}`).kind, 'ok');
		assert.strictEqual(detector.checkText('The quick brown fox jumps over the lazy dog.\n'.repeat(100)).kind, 'ok');
		assert.strictEqual(new LoopDetector().checkText('The quick brown fox jumps over the lazy dog.\n'.repeat(100)).kind, 'warn');
	});
});

function steps(step: number, ...calls: ILoopCallInput[]): ILoopStepRecord {
	return { step, calls: calls.map(loopCallRecord) };
}

function call(tool: string, args: Record<string, unknown>, ok: boolean, text: string, kind: ILoopCallInput['kind']): ILoopCallInput {
	return { tool, args, ok, text, kind };
}

function read(path: string, text: string): ILoopCallInput {
	return call('read_file', { path }, true, text, 'read');
}

function shell(command: string, ok: boolean, output: string): ILoopCallInput {
	return call('shell', { command }, ok, `$ ${command}\n${output}`, 'execute');
}

function edit(path: string, oldString: string, newString: string): ILoopCallInput {
	return call('edit_file', { path, old_string: oldString, new_string: newString }, true, `Edited ${path}: 1 replacement, +1 -1 lines.`, 'edit');
}

function write(path: string, contents: string): ILoopCallInput {
	return call('write_file', { path, contents }, true, `Created ${path} (1 line).`, 'edit');
}
