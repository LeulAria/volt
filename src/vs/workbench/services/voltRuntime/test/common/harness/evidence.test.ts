/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { EvidenceStore } from '../../../common/harness/evidence.js';
import { ToolKind } from '../../../common/harness/workLog.js';
import { IToolCall, IToolResult } from '../../../common/tools/tool.js';

suite('Volt evidence store', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const asTests = (command: string) => /test/.test(command) ? 'test' as const : undefined;

	test('takes the subject from the call arguments, not the result', () => {
		const store = new EvidenceStore();
		const [evidence] = store.record(1, [call('c1', 'read_file', { path: 'src/a.ts' })], [ok('c1', 'read_file', 'read')]);
		assert.strictEqual(evidence.subject, 'src/a.ts');
		assert.strictEqual(evidence.tag, 'observation');
	});

	test('tags an edit as a mutation and lists it as changed', () => {
		const store = new EvidenceStore();
		store.record(1, [call('c1', 'edit_file', { path: 'src/a.ts' })], [ok('c1', 'edit_file', 'edit')]);
		assert.deepStrictEqual(store.changedFiles(), ['src/a.ts']);
		assert.strictEqual(store.lastMutationStep(), 1);
	});

	test('does not count a failed edit as a change', () => {
		const store = new EvidenceStore();
		store.record(1, [call('c1', 'edit_file', { path: 'src/a.ts' })], [fail('c1', 'edit_file', 'edit', 'no match')]);
		assert.deepStrictEqual(store.changedFiles(), []);
		assert.strictEqual(store.lastMutationStep(), -1);
	});

	test('records a file change reported by an event rather than a tool', () => {
		const store = new EvidenceStore();
		store.recordFileChange(2, 'src/b.ts', 'create');
		assert.deepStrictEqual(store.changedFiles(), ['src/b.ts']);
		assert.strictEqual(store.lastMutationStep(), 2);
	});

	test('tags a recognised command as verification', () => {
		const store = new EvidenceStore(asTests);
		const [evidence] = store.record(1, [call('c1', 'shell', { command: 'npm test' })], [ok('c1', 'shell', 'execute')]);
		assert.strictEqual(evidence.tag, 'verification');
		assert.strictEqual(evidence.proves, 'test');
	});

	test('leaves an unrecognised command as an observation', () => {
		const store = new EvidenceStore(asTests);
		const [evidence] = store.record(1, [call('c1', 'shell', { command: 'ls -la' })], [ok('c1', 'shell', 'execute')]);
		assert.strictEqual(evidence.tag, 'observation');
		assert.strictEqual(evidence.proves, undefined);
	});

	test('a passing check counts only while the workspace is unchanged', () => {
		const store = new EvidenceStore(asTests);
		store.record(1, [call('c1', 'shell', { command: 'npm test' })], [ok('c1', 'shell', 'execute')]);
		assert.ok(store.provenSince('test'), 'fresh pass should count');

		store.record(2, [call('c2', 'edit_file', { path: 'src/a.ts' })], [ok('c2', 'edit_file', 'edit')]);
		assert.strictEqual(store.provenSince('test'), undefined, 'the edit invalidates the earlier run');

		store.record(3, [call('c3', 'shell', { command: 'npm test' })], [ok('c3', 'shell', 'execute')]);
		assert.ok(store.provenSince('test'), 'running it again after the edit counts');
	});

	test('reports a check that is currently failing', () => {
		const store = new EvidenceStore(asTests);
		store.record(1, [call('c1', 'shell', { command: 'npm test' })], [fail('c1', 'shell', 'execute', '2 failing')]);
		assert.deepStrictEqual(store.failing().map(item => item.proves), ['test']);

		store.record(2, [call('c2', 'shell', { command: 'npm test' })], [ok('c2', 'shell', 'execute')]);
		assert.deepStrictEqual(store.failing(), [], 'the later pass supersedes the failure');
	});

	test('collapses the same call twice in one step', () => {
		const store = new EvidenceStore();
		const recorded = store.record(1,
			[call('c1', 'read_file', { path: 'a.ts' }), call('c2', 'read_file', { path: 'a.ts' })],
			[ok('c1', 'read_file', 'read'), ok('c2', 'read_file', 'read')],
		);
		assert.strictEqual(recorded[1].occurrences, 2);
		assert.strictEqual(store.all().length, 1);
	});

	test('truncates the detail rather than storing whole tool output', () => {
		const store = new EvidenceStore();
		const [evidence] = store.record(1, [call('c1', 'read_file', { path: 'a.ts' })], [ok('c1', 'read_file', 'read', 'x'.repeat(50_000))]);
		assert.ok(evidence.detail.length < 1200, `detail was ${evidence.detail.length} chars`);
	});

	test('digests what the run learned so the transcript can be dropped', () => {
		const store = new EvidenceStore(asTests);
		store.record(1, [call('c1', 'read_file', { path: 'src/a.ts' })], [ok('c1', 'read_file', 'read')]);
		store.record(2, [call('c2', 'edit_file', { path: 'src/a.ts' })], [ok('c2', 'edit_file', 'edit')]);
		store.record(3, [call('c3', 'shell', { command: 'npm test' })], [fail('c3', 'shell', 'execute', '2 failing\nexpected 1 to equal 2')]);
		store.record(4, [call('c4', 'read_file', { path: 'src/gone.ts' })], [fail('c4', 'read_file', 'read', 'ENOENT')]);

		const digest = store.digest();
		assert.ok(digest.includes('Changed: src/a.ts'));
		assert.ok(/FAILED: npm test/.test(digest));
		assert.ok(/Already inspected \(do not re-read\): src\/a\.ts/.test(digest));
		assert.ok(/Failed attempts \(do not repeat\):[\s\S]*src\/gone\.ts/.test(digest));
	});

	test('digests to nothing when the run did nothing', () => {
		assert.strictEqual(new EvidenceStore().digest(), '');
	});
});

function call(id: string, name: string, args: unknown): IToolCall {
	return { id, name, args };
}

function ok(callId: string, name: string, kind: ToolKind, text = 'ok'): IToolResult {
	return { callId, name, kind, text };
}

function fail(callId: string, name: string, kind: ToolKind, text: string): IToolResult {
	return { callId, name, kind, text, isError: true };
}
