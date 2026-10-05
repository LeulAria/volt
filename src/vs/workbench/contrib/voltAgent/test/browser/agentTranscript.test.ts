/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { parseCodeCitation } from '../../browser/blocks/agentCodeBlock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentSegment, appendProviderNotice, createFileChangeBlock, createTerminalBlock, IFileChangeBlock, isLikelyFilePath } from '../../browser/blocks/agentBlocks.js';
import { classifyDiffLine, looksLikeUnifiedDiff } from '../../browser/blocks/agentCodeBlock.js';
import { markupToFragment } from '../../browser/blocks/agentMarkupDom.js';
import { normalizeMathDelimiters } from '../../browser/blocks/agentMarkdown.js';
import { IBlockRenderContext, renderAgentBlock } from '../../browser/blocks/agentBlockRenderers.js';
import { createApprovalBlock } from '../../browser/blocks/agentBlocks.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { buildTranscriptRows, formatThoughtDuration, hasSignInNotice, splitWorkedRows, stepsGroupTitle, subagentStatus, TranscriptRow, withoutFailureNotice } from '../../browser/chrome/agentTranscript.js';
import { queueSendNowLabels } from '../../browser/composer/agentComposerQueue.js';
import { attachmentPathLines, imageAttachmentsFromMentions, videoDetail } from '../../browser/composer/agentMentions.js';
import { formatImageSize, imageExtension } from '../../browser/composer/agentImageAttachments.js';
import { formatDuration, keptRanges, mapRangesToSource, mergeRanges, normalizeVideoMime, rangesDuration, videoExtensionForMime, videoFrameCount, videoFrameTimes } from '../../browser/composer/agentVideoAttachments.js';
import { URI } from '../../../../../base/common/uri.js';
import { formatWorkedTime } from '../../browser/chrome/agentTranscriptView.js';
import { describeTodoUpdate, isTodoTool } from '../../browser/editor/agentSessionController.js';
import { planFromCursorTodos } from '../../../../services/voltRuntime/browser/agents/acpProvider.js';

function edit(path: string, original: string, modified: string): IFileChangeBlock {
	return { id: `file-${path}`, type: 'file', status: 'complete', path, verb: 'Edited', original, modified, expanded: false };
}

function run(id: string, command: string, title?: string): AgentSegment {
	return { kind: 'block', block: createTerminalBlock({ id, status: 'complete', command, output: 'ok', title, expanded: false }) };
}

function read(file: string): AgentSegment {
	return { kind: 'activity', item: { kind: 'read', label: 'Read', detail: `${file} L1-20`, path: `/repo/${file}` } };
}

function search(detail: string): AgentSegment {
	return { kind: 'activity', item: { kind: 'search', label: 'Searched files', detail } };
}

function kinds(rows: readonly TranscriptRow[]): string[] {
	return rows.map(row => row.kind);
}

suite('Agent transcript (Cursor rows)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reasoning before an answer is its own Thought row', () => {
		const rows = buildTranscriptRows([
			{ kind: 'thought', text: 'Planning the reply', startedAt: 0, updatedAt: 3400 },
			{ kind: 'text', text: 'Here is the answer.' },
		], undefined, false);
		assert.deepStrictEqual(kinds(rows), ['thought', 'markdown']);
		const thought = rows[0] as Extract<TranscriptRow, { kind: 'thought' }>;
		assert.strictEqual(thought.step.action, 'Thought');
		assert.strictEqual(thought.step.detail, '3s');
	});

	test('tool calls between texts collapse into one group with a Cursor title', () => {
		const rows = buildTranscriptRows([
			{ kind: 'text', text: 'I will look at the tests.' },
			read('package.json'), read('stats.js'), search('**/*.js'), { kind: 'thought', text: 'hmm' }, search('median'),
			read('server.js'), read('store.js'), read('stats.test.js'),
			{ kind: 'text', text: 'The median test expects a numeric sort.' },
		], undefined, false);
		assert.deepStrictEqual(kinds(rows), ['markdown', 'steps', 'markdown']);
		const group = rows[1] as Extract<TranscriptRow, { kind: 'steps' }>;
		assert.deepStrictEqual(stepsGroupTitle(group.steps, false), { action: 'Explored', detail: '5 files, 2 searches', additions: 0, deletions: 0 });
		assert.strictEqual(stepsGroupTitle(group.steps, true).action, 'Exploring');
	});

	test('edits lead the title, then exploration and commands, with summed stats', () => {
		const rows = buildTranscriptRows([
			run('t1', 'npm test', 'Test suite to see failure'),
			read('README.md'),
			{ kind: 'block', block: edit('/repo/src/stats.js', 'a\nsort()\nc\n', 'a\nsort((a, b) => a - b)\nc\n') },
			run('t2', 'npm test', 'Re-run tests after median fix'),
		], undefined, false);
		const group = rows[0] as Extract<TranscriptRow, { kind: 'steps' }>;
		assert.deepStrictEqual(stepsGroupTitle(group.steps, false), { action: 'Edited', detail: 'stats.js, explored 1 file, ran 2 commands', additions: 1, deletions: 1 });
		assert.deepStrictEqual(group.steps.map(step => `${step.action} ${step.detail}`), [
			'Ran Test suite to see failure',
			'Read README.md L1-20',
			'Edited stats.js',
			'Ran Re-run tests after median fix',
		]);
	});

	test('only commands read "Ran N commands"; web lookups count as searches', () => {
		const rows = buildTranscriptRows([
			run('t1', 'node -e 1'), run('t2', 'node -e 2'),
			{ kind: 'text', text: 'done' },
			{ kind: 'activity', item: { kind: 'browser', label: 'Searched web', detail: 'node lts' } },
		], undefined, false);
		assert.deepStrictEqual(stepsGroupTitle((rows[0] as Extract<TranscriptRow, { kind: 'steps' }>).steps, false).detail, '2 commands');
		assert.deepStrictEqual(stepsGroupTitle((rows[2] as Extract<TranscriptRow, { kind: 'steps' }>).steps, false), { action: 'Explored', detail: '1 search', additions: 0, deletions: 0 });
	});

	test('the newest group is live while streaming', () => {
		const rows = buildTranscriptRows([read('a.ts')], undefined, true);
		assert.strictEqual(rows[0].kind === 'steps' && rows[0].live, true);
		const thinking = buildTranscriptRows([{ kind: 'thought', text: 'x', startedAt: 0, updatedAt: 10 }], undefined, true);
		assert.strictEqual(thinking[0].kind === 'thought' && thinking[0].live, true);
	});

	test('a finished turn folds everything but the final answer under "Worked for"', () => {
		const rows = buildTranscriptRows([
			{ kind: 'thought', text: 'x', startedAt: 0, updatedAt: 3000 },
			{ kind: 'text', text: 'Looking.' },
			read('a.ts'),
			{ kind: 'text', text: 'Final answer.\n\n| a | b |\n|---|---|\n| 1 | 2 |' },
		], undefined, false);
		const { work, answer } = splitWorkedRows(rows);
		assert.deepStrictEqual(kinds(work), ['thought', 'markdown', 'steps']);
		assert.deepStrictEqual(kinds(answer), ['markdown']);
		assert.deepStrictEqual(splitWorkedRows(buildTranscriptRows([{ kind: 'text', text: 'Just text' }], undefined, false)).work, []);
	});

	test('older chats drop the to-do tool recorded as an edit', () => {
		const rows = buildTranscriptRows([{ kind: 'block', block: edit('Update TODOs', '', '') }, read('a.ts')], undefined, false);
		assert.deepStrictEqual((rows[0] as Extract<TranscriptRow, { kind: 'steps' }>).steps.map(step => step.kind), ['read']);
	});

	test('durations read like Cursor', () => {
		assert.strictEqual(formatThoughtDuration(undefined), 'briefly');
		assert.strictEqual(formatThoughtDuration(600), 'briefly');
		assert.strictEqual(formatThoughtDuration(22_400), '22s');
		assert.strictEqual(formatWorkedTime(183_000), '3m 3s');
		assert.strictEqual(formatWorkedTime(4_000), '4s');
	});
});

suite('Agent to-dos', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('to-do changes become timeline lines', () => {
		const pending = (label: string) => ({ label, state: 'pending' });
		const done = (label: string) => ({ label, state: 'done' });
		assert.deepStrictEqual(describeTodoUpdate([], [pending('a'), pending('b'), pending('c'), pending('d')]), { label: 'Added 4 to-dos' });
		assert.deepStrictEqual(describeTodoUpdate([pending('a'), pending('b')], [done('a'), pending('b')]), { label: 'Completed 1 of 2', detail: 'a' });
		assert.deepStrictEqual(describeTodoUpdate([pending('a'), pending('b')], [done('a'), done('b')]), { label: 'Completed 2 of 2 to-dos' });
		assert.strictEqual(describeTodoUpdate([pending('a')], [{ label: 'a', state: 'current' }]), undefined);
	});

	test('recognises agents\' to-do tools', () => {
		assert.ok(isTodoTool('Update TODOs', 'Update TODOs: fix the bug', '{"_toolName":"updateTodos"}'));
		assert.ok(isTodoTool('TodoWrite', undefined, undefined));
		assert.ok(!isTodoTool('Edit', 'Edit src/todo.ts', undefined));
	});

	test('cursor/update_todos becomes a plan event', () => {
		assert.deepStrictEqual(planFromCursorTodos({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'TODO_STATUS_IN_PROGRESS' }, { content: 'c', status: 'pending' }] }), {
			type: 'plan',
			entries: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }],
		});
	});
});

suite('Agent markdown helpers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only real file paths get the path style', () => {
		assert.ok(isLikelyFilePath('src/stats.js'));
		assert.ok(isLikelyFilePath('src/stats.js:12'));
		assert.ok(isLikelyFilePath('package.json'));
		assert.ok(isLikelyFilePath('Makefile'));
		assert.ok(!isLikelyFilePath('DELETE /todos/:id'));
		assert.ok(!isLikelyFilePath('/todos'));
		assert.ok(!isLikelyFilePath('Array.prototype.sort'));
		assert.ok(!isLikelyFilePath('https://nodejs.org/x.js'));
	});

	test('diff fences classify lines without their markers', () => {
		assert.deepStrictEqual(classifyDiffLine('+const a = 1;'), { kind: 'added', text: 'const a = 1;' });
		assert.deepStrictEqual(classifyDiffLine('-const a = 0;'), { kind: 'removed', text: 'const a = 0;' });
		assert.deepStrictEqual(classifyDiffLine(' keep'), { kind: 'context', text: 'keep' });
		assert.deepStrictEqual(classifyDiffLine('@@ -1,2 +1,2 @@'), { kind: 'meta', text: '@@ -1,2 +1,2 @@' });
		assert.ok(looksLikeUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b'));
		assert.ok(!looksLikeUnifiedDiff('- item\n- item'));
	});

	test('\\( \\) and \\[ \\] math becomes dollar math outside code', () => {
		assert.strictEqual(normalizeMathDelimiters('roots \\(x = 2\\) here'), 'roots $x = 2$ here');
		assert.strictEqual(normalizeMathDelimiters('\\[\nx^2\n\\]'), '\n$$\nx^2\n$$\n');
		assert.strictEqual(normalizeMathDelimiters('keep `\\(a\\)` and ```\n\\[b\\]\n```'), 'keep `\\(a\\)` and ```\n\\[b\\]\n```');
		assert.strictEqual(normalizeMathDelimiters('no math'), 'no math');
	});

	test('markup builder keeps SVG and drops scripts and handlers', () => {
		const fragment = markupToFragment(document, '<svg viewBox="0 0 10 10" onload="x()"><style>text{fill:red}</style><script>alert(1)</script><rect width="5" height="5"/><text x="1">a &amp; b</text></svg>', true);
		const svg = fragment.firstElementChild!;
		assert.strictEqual(svg.namespaceURI, 'http://www.w3.org/2000/svg');
		assert.strictEqual(svg.getAttribute('onload'), null);
		assert.strictEqual(svg.querySelector('script'), null);
		assert.ok(svg.querySelector('rect'));
		assert.strictEqual(svg.querySelector('text')?.textContent, 'a & b');
		assert.strictEqual(svg.querySelector('style')?.textContent, 'text{fill:red}');
	});
});

suite('Agent approval card', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('reads like Cursor and maps buttons to decisions', () => {
		const store = disposables.add(new DisposableStore());
		const decisions: string[] = [];
		const ctx = { store, blockState: {}, onScroll: () => { }, onAccessDecision: (id: string, effect: string, scope: string) => decisions.push(`${id}:${effect}:${scope}`) } as unknown as IBlockRenderContext;
		const host = document.createElement('div');
		// Cursor's titles wrap the command in backticks; the card shows it in a terminal, highlighted.
		renderAgentBlock(host, createApprovalBlock({ id: 'a1', requestId: 'r1', action: 'shell', resource: '`npm test`', risk: 'medium' }), ctx);
		const command = host.querySelector('.volt-agent-block.terminal .volt-agent-term-command');
		assert.strictEqual(command?.textContent, '$npm test');
		assert.strictEqual(command?.querySelector('.cmd, .builtin')?.textContent, 'npm');
		const buttons = [...host.querySelectorAll('.volt-approval-footer button')] as HTMLButtonElement[];
		assert.deepStrictEqual(buttons.map(button => button.textContent), ['Skip', 'Always Run', 'Run\u23ce']);
		buttons[2].click();
		buttons[0].click();
		host.querySelector('.volt-agent-block.approval')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		assert.deepStrictEqual(decisions, ['r1:allow:once', 'r1:deny:once', 'r1:allow:once']);
	});
	test('a code citation names the file and its lines', () => {
		assert.deepStrictEqual(parseCodeCitation('10:13:src/stats.js'), { path: 'src/stats.js', startLine: 10, endLine: 13 });
		assert.deepStrictEqual(parseCodeCitation(' 7:7:a b/c.ts '), { path: 'a b/c.ts', startLine: 7, endLine: 7 });
		assert.strictEqual(parseCodeCitation('ts'), undefined);
		assert.strictEqual(parseCodeCitation(undefined), undefined);
	});
	test('a plan recorded as a "Create Plan" edit shows as the plan', () => {
		const input = JSON.stringify({ _toolName: 'createPlan', name: 'Persist todos', plan: '# Persist todos' });
		const rows = buildTranscriptRows([{ kind: 'block', block: createFileChangeBlock({ id: 'p', path: 'Create Plan', verb: 'Created', input, status: 'complete' }) }], undefined, false);
		const block = rows.find(row => row.kind === 'block');
		assert.ok(block && block.kind === 'block' && block.block.type === 'plan' && block.block.markdown === '# Persist todos');
		assert.ok(!rows.some(row => row.kind === 'steps'));
	});
});

suite('Agent transcript run controls', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a steering message shows where the agent picked it up', () => {
		const rows = buildTranscriptRows([
			read('a.ts'),
			{ kind: 'text', text: 'Looking at a.ts.' },
			read('b.ts'),
		], undefined, true, [{ text: 'Use b.ts instead', at: 2 }, { text: '  ', at: 1 }]);
		assert.deepStrictEqual(kinds(rows), ['steps', 'markdown', 'steer', 'steps']);
		assert.strictEqual((rows[2] as Extract<TranscriptRow, { kind: 'steer' }>).text, 'Use b.ts instead');
		const tail = buildTranscriptRows([read('a.ts')], undefined, true, [{ text: 'stop after this', at: 1 }]);
		assert.deepStrictEqual(kinds(tail), ['steps', 'steer'], 'a steer sent after the last segment comes last');
	});

	test('a failed turn shows its error once, but keeps supervisor trays', () => {
		const rows = buildTranscriptRows([
			{ kind: 'notice', severity: 'error', title: 'The same tools were called three times', supervision: 'loop' },
			{ kind: 'notice', severity: 'error', title: 'Provider returned 529 overloaded' },
			{ kind: 'notice', severity: 'warning', title: 'Retrying in 2s' },
		], undefined, false);
		const kept = withoutFailureNotice(rows, 'Provider returned 529 overloaded');
		assert.deepStrictEqual(kept.map(row => row.kind === 'notice' ? row.title : row.kind), ['The same tools were called three times', 'Retrying in 2s']);
		assert.strictEqual(withoutFailureNotice(rows, undefined).length, 3);
		const stop = buildTranscriptRows([{ kind: 'notice', severity: 'error', title: 'Stopped: the agent kept looping', supervision: 'loop' }], undefined, false);
		assert.strictEqual(withoutFailureNotice(stop, 'Stopped: the agent kept looping').length, 0, 'the stop that failed the run shows only in the end tray');
		const signIn = buildTranscriptRows([
			{ kind: 'notice', severity: 'error', title: 'Sign in to continue using Claude.', description: 'Failed to authenticate: OAuth session expired and could not be refreshed' },
		], undefined, false);
		assert.strictEqual(withoutFailureNotice(signIn, 'Sign in to continue').length, 1, 'a login card stays; the generic tray is the one that goes');
		assert.strictEqual(hasSignInNotice(withoutFailureNotice(signIn, 'Sign in to continue')), true);
		assert.strictEqual(hasSignInNotice(kept), false);
	});

	test('a sub-agent reports the step it is on, then how it ended', () => {
		const tool = { id: 't', type: 'tool' as const, status: 'streaming' as const, callId: 'c', name: 'task', output: 'Reading server.js\nSearching for DELETE', expanded: false };
		assert.deepStrictEqual(subagentStatus(tool, true), { text: 'Searching for DELETE', steps: 2, live: true });
		assert.strictEqual(subagentStatus({ ...tool, output: undefined }, true).text, 'Working');
		assert.strictEqual(subagentStatus({ ...tool, status: 'complete', stopped: true }, false).text, 'Stopped');
		assert.strictEqual(subagentStatus({ ...tool, status: 'error' }, false).text, 'Failed');
		assert.strictEqual(subagentStatus({ ...tool, status: 'complete', output: 'Report' }, false).text, 'Completed');
	});

	test('Send now reads as Steer when the agent takes messages, else it interrupts', () => {
		assert.deepStrictEqual(queueSendNowLabels({ running: true, steer: true }), { label: 'Steer', tooltip: 'Sends without interrupting the agent' });
		assert.deepStrictEqual(queueSendNowLabels({ running: true, steer: false }), { label: 'Send now', tooltip: 'Sends now, interrupting the agent' });
		assert.strictEqual(queueSendNowLabels({ running: false, steer: false }).label, 'Send now');
	});

	test('pasted images go to the model with the name the prompt uses', () => {
		const png = new Uint8Array([137, 80, 78, 71]);
		const attachments = imageAttachmentsFromMentions([
			{ label: 'Image1', kind: 'image', image: { id: 'Image1', mime: 'image/png', bytes: png } },
			{ label: 'logo.svg', kind: 'image', image: { id: 'Image2', mime: 'image/svg+xml', bytes: new Uint8Array([60]) } },
			{ label: 'photo.jpg', kind: 'image', resource: URI.file('/tmp/photo.jpg'), image: { id: 'Image3', mime: 'image/jpg', bytes: new Uint8Array([255, 216]) } },
			{ label: 'src/a.ts', kind: 'file' },
		]);
		assert.deepStrictEqual(attachments, [
			{ mediaType: 'image/png', data: 'iVBORw==', name: 'Image1' },
			{ mediaType: 'image/jpeg', data: '/9g=', name: 'photo.jpg' },
		]);
		assert.deepStrictEqual(imageAttachmentsFromMentions(undefined), []);
	});

	test('each image in a prompt is numbered and its saved path is sent along', () => {
		const bytes = new Uint8Array([1]);
		const lines = attachmentPathLines([
			{ label: 'image.png', kind: 'image', image: { id: 'a', mime: 'image/png', bytes, path: '/data/attachments/a.png' } },
			{ label: 'src/a.ts', kind: 'file', resource: URI.file('/repo/src/a.ts') },
			{ label: 'image (2).png', kind: 'image', image: { id: 'b', mime: 'image/png', bytes } },
			{ label: 'photo.jpg', kind: 'image', resource: URI.file('/tmp/photo.jpg'), image: { id: 'c', mime: 'image/jpeg', bytes } },
		]);
		assert.deepStrictEqual(lines, [
			'[Image #1 "image.png" is saved at: /data/attachments/a.png]',
			`[Image #3 "photo.jpg" is saved at: ${URI.file('/tmp/photo.jpg').fsPath}]`,
		]);
	});

	test('image chips show a short size and a file extension for the type', () => {
		assert.strictEqual(formatImageSize(512), '512 B');
		assert.strictEqual(formatImageSize(19 * 1024 + 100), '19 KB');
		assert.strictEqual(formatImageSize(3.14 * 1024 * 1024), '3.1 MB');
		assert.strictEqual(imageExtension('image/jpeg'), 'jpg');
		assert.strictEqual(imageExtension('image/svg+xml'), 'svg');
		assert.strictEqual(imageExtension('image/PNG'), 'png');
	});

	test('a video goes to the model as stills named after it, with its path and cut', () => {
		const still = new Uint8Array([255, 216]);
		const mentions = [
			{ label: 'image.png', kind: 'image' as const, image: { id: 'a', mime: 'image/png', bytes: new Uint8Array([137, 80]), path: '/att/a.png' } },
			{
				label: 'screen.mov', kind: 'video' as const, video: {
					id: 'v', mime: 'video/webm', name: 'screen.mov', size: 2048, path: '/att/v.webm', duration: 9,
					trim: { segments: [{ start: 3, end: 12 }], sourceName: 'screen.mov' },
					frames: [{ time: 0, mime: 'image/jpeg', bytes: still }, { time: 8.95, mime: 'image/jpeg', bytes: still }],
				},
			},
			{ label: 'raw.mp4', kind: 'video' as const, video: { id: 'w', mime: 'video/mp4', name: 'raw.mp4', size: 10 } },
			{
				label: 'demo.mp4', kind: 'video' as const, video: {
					id: 'x', mime: 'video/webm', name: 'demo.mp4', size: 10, duration: 10,
					trim: { segments: [{ start: 0, end: 5 }, { start: 7, end: 12 }], sourceName: 'demo.mp4' },
				},
			},
		];
		assert.deepStrictEqual(imageAttachmentsFromMentions(mentions).map(item => item.name), ['image.png', 'screen.mov @ 0:00.0', 'screen.mov @ 0:09.0']);
		assert.deepStrictEqual(attachmentPathLines(mentions), [
			'[Image #1 "image.png" is saved at: /att/a.png]',
			'[Video #1 "screen.mov" (9.0s, cut from 0:03.0–0:12.0 of "screen.mov") is saved at: /att/v.webm. Stills at 0:00.0, 0:09.0 are attached as images]',
			'[Video #2 "raw.mp4"]',
			'[Video #3 "demo.mp4" (10.0s, joined from 0:00.0–0:05.0, 0:07.0–0:12.0 of "demo.mp4")]',
		]);
		assert.strictEqual(videoDetail({ duration: 9.4, size: 3.2 * 1024 * 1024 }), '0:09 · 3.2 MB');
		assert.strictEqual(videoDetail({ size: 2048 }), '2 KB');
	});

	test('deleting parts of a video keeps the rest, named in the original', () => {
		assert.deepStrictEqual(mergeRanges([{ start: 5, end: 6 }, { start: 1, end: 2 }, { start: 5.5, end: 8 }, { start: 3, end: 3 }]), [{ start: 1, end: 2 }, { start: 5, end: 8 }]);
		// Keep 1–11, minus 3–4 and 9–12.
		const kept = keptRanges({ start: 1, end: 11 }, [{ start: 9, end: 12 }, { start: 3, end: 4 }]);
		assert.deepStrictEqual(kept, [{ start: 1, end: 3 }, { start: 4, end: 9 }]);
		assert.strictEqual(rangesDuration(kept), 7);
		// A sliver left between two cuts is dropped.
		assert.deepStrictEqual(keptRanges({ start: 0, end: 10 }, [{ start: 2, end: 5 }, { start: 5.02, end: 10 }]), [{ start: 0, end: 2 }]);
		// The clip is 0–5 and 7–12 of the original; keeping 4–6 of the clip spans the cut.
		assert.deepStrictEqual(mapRangesToSource([{ start: 4, end: 6 }], [{ start: 0, end: 5 }, { start: 7, end: 12 }]), [{ start: 4, end: 5 }, { start: 7, end: 8 }]);
		assert.deepStrictEqual(mapRangesToSource([{ start: 0, end: 2 }, { start: 2, end: 3 }], [{ start: 3, end: 7 }]), [{ start: 3, end: 6 }]);
	});

	test('video times, still spacing and file types', () => {
		assert.strictEqual(formatDuration(9.44), '0:09');
		assert.strictEqual(formatDuration(9.44, true), '0:09.4');
		assert.strictEqual(formatDuration(59.96, true), '1:00.0');
		assert.strictEqual(formatDuration(3725), '1:02:05');
		assert.strictEqual(formatDuration(Number.NaN), '0:00');
		assert.strictEqual(videoFrameCount(0.5), 1);
		assert.strictEqual(videoFrameCount(9), 6);
		assert.strictEqual(videoFrameCount(600), 8);
		assert.deepStrictEqual(videoFrameTimes(2, 4, 1), [2.975]);
		const times = videoFrameTimes(0, 10, 3);
		assert.deepStrictEqual(times.map(t => Math.round(t * 1000) / 1000), [0, 4.975, 9.95]);
		assert.strictEqual(normalizeVideoMime('video/webm;codecs=vp9'), 'video/webm');
		assert.strictEqual(videoExtensionForMime('video/quicktime'), 'mov');
		assert.strictEqual(videoExtensionForMime('video/x-unknown'), 'mp4');
	});

	test('a supervisor notice keeps its kind when a longer one replaces it', () => {
		const segments: AgentSegment[] = [];
		appendProviderNotice(segments, { severity: 'error', title: 'Agent looping detected', supervision: 'loop' });
		appendProviderNotice(segments, { severity: 'error', title: 'Agent looping detected: same edit failed 3 times' });
		assert.strictEqual(segments.length, 1);
		assert.ok(segments[0].kind === 'notice' && segments[0].supervision === 'loop');
	});
});
