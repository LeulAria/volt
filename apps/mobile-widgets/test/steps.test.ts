/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactStep, EditsFileCounter, emptyStepState, firstCommandName, foldStep, StepTracker, THINKING, type IStepState } from '../src/steps.ts';
import type { RuntimeEventLike } from '../src/serverShapes.ts';

function fold(events: RuntimeEventLike[], start: IStepState = emptyStepState()): IStepState {
	return events.reduce(foldStep, start);
}

test('firstCommandName matches the agent window', () => {
	assert.equal(firstCommandName('npm run test -- --watch'), 'npm');
	assert.equal(firstCommandName('FOO=1 /usr/local/bin/node x.js'), 'node');
	assert.equal(firstCommandName('$ ./gradlew build'), 'gradlew');
	assert.equal(firstCommandName('"/Applications/Visual Studio Code.app/Contents/MacOS/Electron" .'), 'Visual Studio Code');
});

test('compactStep shortens paths and long text', () => {
	assert.equal(compactStep('Edit /Users/me/project/src/auth/session.ts'), 'Edit session.ts');
	assert.equal(compactStep('Read   ~/code/app/README.md\n'), 'Read README.md');
	const long = compactStep('x'.repeat(100), 20);
	assert.equal(long.length, 20);
	assert.ok(long.endsWith('…'));
});

test('a terminal call reads "Running <program>" and falls back to the newest running call', () => {
	const state = fold([
		{ type: 'run.start' },
		{ type: 'tool.start', callId: 'a', name: 'read', title: 'Read src/auth.ts' },
		{ type: 'tool.start', callId: 'b', name: 'bash', title: 'npm test', card: 'terminal' },
	]);
	assert.equal(state.step, 'Running npm');
	assert.equal(state.calls, 2);
	const after = foldStep(state, { type: 'tool.end', callId: 'b' });
	assert.equal(after.step, 'Read src/auth.ts');
	assert.equal(foldStep(after, { type: 'tool.end', callId: 'a' }).step, THINKING);
});

test('diff calls and file changes count distinct files', () => {
	const state = fold([
		{ type: 'tool.start', callId: 'a', name: 'edit', title: 'Edit auth.ts', card: 'diff', diffs: [{ path: '/repo/src/auth.ts' }] },
		{ type: 'file.change', uri: { fsPath: '/repo/src/auth.ts' }, kind: 'edit' },
		{ type: 'file.change', uri: 'file:///repo/src/login.ts', kind: 'create' },
	]);
	assert.deepEqual(state.files, ['/repo/src/auth.ts', '/repo/src/login.ts']);
	assert.equal(state.step, 'Edit auth.ts');
});

test('notices pin the line until the next call; tool.update retitles the newest call', () => {
	let state = fold([
		{ type: 'tool.start', callId: 'a', name: 'search', title: 'Search' },
		{ type: 'tool.update', callId: 'a', title: 'Search for "token"' },
	]);
	assert.equal(state.step, 'Search for "token"');
	state = foldStep(state, { type: 'notice', title: 'Rate limited, retrying' });
	assert.equal(state.step, 'Rate limited, retrying');
	assert.equal(foldStep(state, { type: 'tool.end', callId: 'a' }).step, 'Rate limited, retrying');
	assert.equal(foldStep(state, { type: 'tool.start', callId: 'b', name: 'grep' }).step, 'grep');
});

test('lifecycle, compaction, questions and approvals word the line', () => {
	assert.equal(fold([{ type: 'lifecycle', phase: 'planning' }]).step, 'Planning');
	assert.equal(fold([{ type: 'context.compaction', status: 'running', trigger: 'auto' }]).step, 'Compacting context automatically');
	assert.equal(fold([{ type: 'context.compaction', status: 'running' }, { type: 'context.compaction', status: 'completed' }]).step, THINKING);
	assert.equal(fold([{ type: 'question.ask' }]).step, 'Waiting for your answer');
	assert.equal(fold([{ type: 'access.ask' }]).step, 'Waiting for approval');
	const unchanged = emptyStepState();
	assert.equal(foldStep(unchanged, { type: 'text.delta' }), unchanged);
});

test('StepTracker keeps chats apart and reports changes', () => {
	const tracker = new StepTracker();
	assert.equal(tracker.apply({ sessionId: 'a', event: { type: 'tool.start', callId: '1', name: 'Read x' } }), true);
	assert.equal(tracker.apply({ sessionId: 'a', event: { type: 'text.delta' } }), false);
	assert.equal(tracker.apply({ sessionId: 'b', event: { type: 'run.start' } }), true);
	assert.equal(tracker.get('a')?.step, 'Read x');
	assert.equal(tracker.get('b')?.step, THINKING);
	tracker.forget('a');
	assert.equal(tracker.get('a'), undefined);
});

test('EditsFileCounter counts files per turn from the journal, in key order', () => {
	const counter = new EditsFileCounter();
	const changed = counter.add([
		['0000000002', { kind: 'file', sessionId: 'a', uri: { path: '/r/b.ts' } }],
		['0000000001', { kind: 'file', sessionId: 'a', uri: { path: '/r/a.ts' } }],
		['0000000003', { kind: 'baseline', sessionId: 'a', uri: { path: '/r/a.ts' } }],
		['0000000004', { kind: 'binary', sessionId: 'b', uri: { path: '/r/logo.png' } }],
	]);
	assert.deepEqual([...changed].sort(), ['a', 'b']);
	assert.equal(counter.count('a'), 2);
	// A window acking (deleting) entries doesn't matter; re-feeding seen keys changes nothing.
	assert.equal(counter.add([['0000000001', { kind: 'file', sessionId: 'a', uri: { path: '/r/z.ts' } }]]).size, 0);
	// The finished mark keeps the count for the ended activity; the next turn's first edit starts over.
	counter.add([['0000000005', { kind: 'finished', sessionId: 'a' }]]);
	assert.equal(counter.count('a'), 2);
	counter.add([['0000000006', { kind: 'file', sessionId: 'a', uri: { path: '/r/c.ts' } }], ['0000000007', { kind: 'file', sessionId: 'a', uri: { path: '/r/d.ts' } }]]);
	assert.equal(counter.count('a'), 2);
	counter.reset('a');
	assert.equal(counter.count('a'), 0);
});
