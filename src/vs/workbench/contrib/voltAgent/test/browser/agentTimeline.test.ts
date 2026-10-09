/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createFileChangeBlock, createTerminalBlock } from '../../browser/blocks/agentBlocks.js';
import { buildThreadParts, classifySupervisionNotice, composerTasks, createdPlanPrompt, failureTitle, fileChangeGroupTitle, formatElapsed, isProcessNarration, looksLikeAnswerForm, partitionAssistantText, runEndTray, STATUS_ROTATE_MS, stampTodoSteps, streamingActivityLines, supervisionActions, tasksCard, todoChecklist, visibleReplyParts } from '../../browser/chrome/agentTimeline.js';

suite('Agent timeline', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('folds harness and MCP narration into thought', () => {
		assert.strictEqual(isProcessNarration('No browser MCP tools are available. The in-app browser cannot be used to open the URL.'), true);
		assert.strictEqual(isProcessNarration('Preparing to run the project per Volt\'s instructions. Skipping repo-wide search.'), true);
		assert.strictEqual(isProcessNarration('I\'ll inspect the project to see what it is and how to start it.'), false);
	});

	test('a table stays a reply, not a thought', () => {
		const table = '| Model | Price |\n| --- | --- |\n| Patrol | AED 1 |\n| Kicks | AED 2 |';
		assert.strictEqual(looksLikeAnswerForm(table), true);
		const parts = partitionAssistantText(`Refreshing official prices.\n\n${table}`);
		assert.ok(parts.some(part => part.kind === 'reply' && part.text.includes('| Patrol |')));
		assert.ok(!parts.some(part => part.kind === 'thought' && part.text.includes('| Patrol |')));
	});

	test('the visible reply drops thought and explore chrome', () => {
		const parts = visibleReplyParts(buildThreadParts([
			{ kind: 'thought', text: 'Looking this up.' },
			{ kind: 'activity', item: { kind: 'search', label: 'Searched', detail: 'nissan' } },
			{ kind: 'text', text: '1. Patrol\n2. Kicks' },
			{ kind: 'thought', text: 'Need another page.' },
			{ kind: 'text', text: '3. X-Trail' },
		]));
		const visible = parts.filter(part => part.kind !== 'group');
		assert.ok(visible.length >= 1);
		const text = visible.map(part => {
			if (part.kind === 'markdown') {
				return part.content;
			}
			if (part.kind === 'block' && part.block.type === 'list') {
				return part.block.items.join('\n');
			}
			return '';
		}).join('\n');
		assert.ok(/Patrol/.test(text) && /Kicks/.test(text) && /X-Trail/.test(text));
		assert.ok(!parts.some(part => part.kind === 'group'));
	});

	test('keeps a ranking list as the model wrote it', () => {
		const parts = visibleReplyParts(buildThreadParts([
			{ kind: 'text', text: 'The 10 most populated countries:\n\n1. India — 1,476,625,576\n2. China — 1,412,914,089\n3. United States — 349,035,494' },
		]));
		assert.ok(!parts.some(part => part.kind === 'block' && part.block.type === 'table'));
	});

	test('keeps a reply made of long paragraphs visible', () => {
		const paragraph = 'Local development servers bind to 127.0.0.1 because that address is the loopback interface: traffic sent there never leaves the machine, so nothing on the network can reach a half-finished app, and the operating system never has to ask for firewall permission either. It also keeps a stray debug endpoint off the office Wi-Fi.';
		assert.ok(paragraph.length > 280);
		assert.deepStrictEqual(partitionAssistantText(`${paragraph}\n\n${paragraph}`).map(part => part.kind), ['reply']);
	});

	test('keeps the URL reply visible', () => {
		const parts = partitionAssistantText([
			'No browser MCP tools are available. The in-app browser cannot be used to open the URL.',
			'The 2048 game is running at http://127.0.0.1:8080/.',
		].join('\n\n'));
		assert.deepStrictEqual(parts.map(part => part.kind), ['thought', 'reply']);
		assert.ok(parts[1].text.includes('127.0.0.1:8080'));
	});

	test('interleaves collapsed explore groups with the visible reply and terminal', () => {
		const parts = buildThreadParts([
			{ kind: 'thought', text: 'Exploring the workspace to identify the project type.' },
			{ kind: 'activity', item: { kind: 'search', label: 'Searched', detail: '*' } },
			{ kind: 'activity', item: { kind: 'read', label: 'Read', detail: 'index.html' } },
			{ kind: 'text', text: 'It\'s a standalone 2048 game.\n\nNo browser MCP tools are available.\n\nThe 2048 game is running at http://127.0.0.1:8080/.' },
			{
				kind: 'block',
				block: createTerminalBlock({
					id: 'term',
					callId: '1',
					title: 'Start HTTP server',
					command: 'python3 -m http.server 8080',
					output: '',
				}),
			},
		]);
		assert.strictEqual(parts[0].kind, 'group');
		assert.ok(parts[0].kind === 'group' && /Explored/.test(parts[0].title));
		assert.strictEqual(parts[1].kind, 'markdown');
		assert.ok(parts[1].kind === 'markdown' && parts[1].content.includes('standalone 2048'));
		assert.ok(parts.some(part => part.kind === 'markdown' && part.content.includes('127.0.0.1:8080')));
		assert.ok(parts.some(part => part.kind === 'block' && part.block.type === 'terminal'));
		assert.ok(!parts.some(part => part.kind === 'markdown' && /MCP/.test(part.content)));
	});

	test('lifts snapshot activity out of the explore group', () => {
		const parts = buildThreadParts([
			{ kind: 'activity', item: { kind: 'search', label: 'Searched', detail: '*' } },
			{ kind: 'activity', item: { kind: 'browser', label: 'Took snapshot', image: 'data:image/png;base64,abc' } },
			{ kind: 'text', text: 'The 2048 game is running at http://127.0.0.1:8080/.' },
		]);
		assert.strictEqual(parts[0].kind, 'group');
		assert.ok(parts[0].kind === 'group' && /Explored/.test(parts[0].title));
		assert.strictEqual(parts[1].kind, 'snapshot');
		assert.ok(parts[1].kind === 'snapshot' && parts[1].item.image?.startsWith('data:image/'));
		assert.strictEqual(parts[2].kind, 'markdown');
	});

	test('keeps a streaming snapshot as the tail instead of an extra thinking group', () => {
		const parts = buildThreadParts([
			{ kind: 'activity', item: { kind: 'browser', label: 'Took snapshot' } },
		], undefined, true);
		assert.strictEqual(parts.length, 1);
		assert.strictEqual(parts[0].kind, 'snapshot');
	});

	test('names a single read after the file', () => {
		const parts = buildThreadParts([
			{ kind: 'activity', item: { kind: 'read', label: 'Read', detail: 'package.json', path: 'src/package.json' } },
		]);
		assert.ok(parts[0].kind === 'group' && parts[0].title === 'Explored package.json');
		assert.ok(parts[0].kind === 'group' && parts[0].items[0].path === 'src/package.json');
	});

	test('turns later thoughts into Thought briefly rows instead of a text dump', () => {
		const parts = buildThreadParts([
			{ kind: 'activity', item: { kind: 'search', label: 'Searched files', detail: '**/*.ts in .alnsp' } },
			{ kind: 'thought', text: 'Checking agent transcripts and Volt-related files for a long time so this would have been a wall of text.' },
			{ kind: 'activity', item: { kind: 'read', label: 'Read', detail: 'agentEditor.ts L300-449', path: 'src/agentEditor.ts', startLine: 300, endLine: 449 } },
		]);
		assert.strictEqual(parts[0].kind, 'group');
		if (parts[0].kind !== 'group') {
			return;
		}
		assert.strictEqual(parts[0].thinking, undefined);
		assert.deepStrictEqual(parts[0].items.map(item => item.label), ['Searched files', 'Thought briefly', 'Read']);
		assert.ok(parts[0].items[1].text?.includes('Checking agent transcripts'));
	});

	test('keeps a live working row after the reply has started', () => {
		const parts = visibleReplyParts(buildThreadParts([
			{ kind: 'text', text: 'I\'ll look up official Nissan UAE pricing.' },
		], undefined, true), true);
		assert.deepStrictEqual(parts.map(part => part.kind), ['markdown', 'group']);
		assert.ok(parts[1].kind === 'group' && parts[1].title === 'Thinking');
	});

	test('keeps an in-progress search visible after the reply has started', () => {
		const parts = visibleReplyParts(buildThreadParts([
			{ kind: 'text', text: 'I\'ll look it up.' },
			{ kind: 'activity', item: { kind: 'search', label: 'Searched', detail: 'nissan uae' } },
		], undefined, true), true);
		assert.ok(parts.some(part => part.kind === 'markdown'));
		const last = parts.at(-1);
		assert.ok(last?.kind === 'group' && /Exploring/.test(last.title));
	});

	test('shows thinking immediately while streaming with no content yet', () => {
		const parts = buildThreadParts([], undefined, true);
		assert.strictEqual(parts.length, 1);
		assert.ok(parts[0].kind === 'group' && parts[0].title === 'Thinking');
	});

	test('keeps a trailing thinking group after a terminal while streaming', () => {
		const parts = buildThreadParts([
			{ kind: 'text', text: 'I\'ll start the local server.' },
			{
				kind: 'block',
				block: createTerminalBlock({
					id: 'term',
					callId: '1',
					title: 'Start HTTP server',
					command: 'python3 -m http.server 8080',
					output: '',
				}),
			},
		], undefined, true);
		const last = parts.at(-1);
		assert.ok(last?.kind === 'group' && last.title === 'Thinking');
		assert.ok(parts.some(part => part.kind === 'block' && part.block.type === 'terminal'));
	});

	test('groups file edits and commands into one changes summary, each file once', () => {
		const parts = buildThreadParts([
			{
				kind: 'block',
				block: createFileChangeBlock({
					id: 'f1',
					callId: '1',
					path: 'src/TariffPackageSelector.tsx',
					verb: 'Edited',
					original: 'a\n',
					modified: 'b\n',
				}),
			},
			{
				kind: 'block',
				block: createFileChangeBlock({
					id: 'f2',
					callId: '2',
					path: 'src/TariffPackageSelector.tsx',
					verb: 'Edited',
					original: 'onToggle={togglePackage(roomPackageField)}',
					modified: 'onToggle={togglePackage(\n  roomPackageField.field.onChange,\n  roomPackage,\n)}',
				}),
			},
			{
				kind: 'block',
				block: createTerminalBlock({
					id: 'term',
					callId: '3',
					title: 'Run tests',
					command: 'npm test',
					output: '',
				}),
			},
		]);
		const group = parts.find(part => part.kind === 'changes');
		assert.ok(group && group.kind === 'changes');
		// Both edits hit the same file: it is listed once, with both edits' lines counted.
		assert.strictEqual(group.files.length, 1);
		assert.strictEqual(group.commands.length, 1);
		assert.ok(group.additions >= 4);
		assert.ok(/Editing 1 file/.test(fileChangeGroupTitle(group.files.length, group.commands.length, group.additions, group.deletions)));
		assert.ok(/ran 1 command/.test(fileChangeGroupTitle(group.files.length, group.commands.length, group.additions, group.deletions)));
	});

	test('keeps a single file edit as its own preview card', () => {
		const parts = buildThreadParts([
			{
				kind: 'block',
				block: createFileChangeBlock({
					id: 'f1',
					path: 'src/app.ts',
					verb: 'Edited',
					original: 'a',
					modified: 'b',
				}),
			},
		]);
		assert.strictEqual(parts.length, 1);
		assert.ok(parts[0].kind === 'block' && parts[0].block.type === 'file');
	});

	test('idle streaming swaps Thinking and Planning next moves on one line', () => {
		const started = 1_000;
		const idle = streamingActivityLines('Thinking', 'Thinking', [], started, started);
		assert.deepStrictEqual(idle, { summary: undefined, phrase: 'Thinking', rotate: true });
		const next = streamingActivityLines('Thinking', 'Thinking', [], started + STATUS_ROTATE_MS, started);
		assert.strictEqual(next.phrase, 'Planning next moves');
		assert.strictEqual(next.rotate, true);
		assert.strictEqual(next.summary, undefined);
	});

	test('exploring keeps the summary and swaps the live action under it', () => {
		const started = 5_000;
		const thinking = streamingActivityLines('Exploring 4 files, 3 searches', 'Thinking', [
			{ kind: 'read', label: 'Read', detail: 'a.ts' },
			{ kind: 'search', label: 'Searched', detail: 'query' },
		], started, started);
		assert.strictEqual(thinking.summary, 'Exploring 4 files, 3 searches');
		assert.strictEqual(thinking.phrase, 'Thinking');
		assert.strictEqual(thinking.rotate, true);
		const planning = streamingActivityLines('Exploring 4 files, 3 searches', 'Thinking', [], started + STATUS_ROTATE_MS, started);
		assert.strictEqual(planning.summary, 'Exploring 4 files, 3 searches');
		assert.strictEqual(planning.phrase, 'Planning next moves');

		const reading = streamingActivityLines('Exploring 4 files, 3 searches', 'Read src/app.ts', [
			{ kind: 'read', label: 'Read', detail: 'app.ts' },
		], started, started);
		assert.strictEqual(reading.summary, 'Exploring 4 files, 3 searches');
		assert.strictEqual(reading.phrase, 'Reading app.ts');
		assert.strictEqual(reading.rotate, false);

		const browsing = streamingActivityLines('Exploring 1 browser action', 'web_search nissan uae', [
			{ kind: 'browser', label: 'Searched', detail: 'nissan uae' },
		], started, started);
		assert.strictEqual(browsing.phrase, 'Browsing nissan uae');
		assert.strictEqual(browsing.rotate, false);

		const running = streamingActivityLines('Thinking', 'Running npm test', [], started, started);
		assert.strictEqual(running.summary, undefined);
		assert.strictEqual(running.phrase, 'Running npm test');
		assert.strictEqual(running.rotate, false);
	});

	test('a provider limit stays on screen instead of rotating back to Thinking', () => {
		const limit = 'You\'ve hit your monthly spend limit · your session limit resets 3:20am (Asia/Dubai)';
		const parts = visibleReplyParts(buildThreadParts([
			{ kind: 'notice', severity: 'error', title: limit, description: 'Continuing automatically at 3:20am' },
		], undefined, true));
		const notice = parts.find(part => part.kind === 'notice');
		if (notice?.kind !== 'notice') {
			assert.fail('missing notice');
		}
		assert.strictEqual(notice.title, limit);
		assert.strictEqual(notice.description, 'Continuing automatically at 3:20am');
		const live = streamingActivityLines('Thinking', limit, [], 1_000, 1_000, true);
		assert.strictEqual(live.phrase, limit);
		assert.strictEqual(live.rotate, false);
		const masked = streamingActivityLines('Thinking', limit, [], 1_000, 1_000);
		assert.strictEqual(masked.phrase, 'Thinking');
	});
});

suite('Agent run state', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads supervisor findings from runtime notices', () => {
		assert.strictEqual(classifySupervisionNotice('The same tools were called three times in a row with the same arguments. Stopping so this does not spin.'), 'loop');
		assert.strictEqual(classifySupervisionNotice('Agent looping detected: the same edit failed 3 times'), 'loop');
		assert.strictEqual(classifySupervisionNotice('No response from the agent for 60 s'), 'stall');
		assert.strictEqual(classifySupervisionNotice('Paused at the step limit for one run.'), 'budget');
		assert.strictEqual(classifySupervisionNotice('Taking longer than expected\nA tool has been running for 10 min without reporting back.'), 'stall');
		assert.strictEqual(classifySupervisionNotice('Run budget\nThis run has used 80% of its tool calls (500).'), 'budget');
		assert.strictEqual(classifySupervisionNotice('Agent looping detected\nThe agent was running npm test 3 times with the same error.'), 'loop');
		assert.strictEqual(classifySupervisionNotice('The agent has been quiet for 6 min. Interrupting it and asking it to continue.'), 'stall');
		assert.strictEqual(classifySupervisionNotice('Possible test special-casing'), undefined);
		assert.strictEqual(classifySupervisionNotice('Context window 80% full'), undefined);
		assert.strictEqual(classifySupervisionNotice('Usage limit reached for Claude Opus'), undefined);
	});

	test('a failed newest turn offers Try again, and Resume once it did something', () => {
		const failed = { outcome: 'failed' as const, failure: { message: 'socket hang up', retryable: true }, runId: 'run-9', segments: [] };
		assert.deepStrictEqual(runEndTray(failed, true), {
			kind: 'failed',
			title: 'Connection failed',
			detail: 'socket hang up',
			requestId: 'run-9',
			canRetry: true,
			canResume: false,
			canContinueDifferently: false,
		});
		const progressed = { ...failed, segments: [{ kind: 'activity' as const, item: { kind: 'read' as const, label: 'Read', detail: 'a.ts' } }] };
		assert.strictEqual(runEndTray(progressed, true)?.canResume, true);
		assert.strictEqual(runEndTray(progressed, false)?.canRetry, false, 'older turns only show the error');
		assert.strictEqual(runEndTray({ ...failed, failure: { message: 'Invalid API key', retryable: false } }, true)?.canRetry, false);
		assert.strictEqual(runEndTray({ outcome: 'failed' as const }, true)?.detail, 'Something went wrong. Please try again.');
	});

	test('a loop or budget stop is never a dead end', () => {
		const loop = runEndTray({ outcome: 'failed', failure: { message: 'Stopped: the agent kept looping after Volt asked it to change approach.', retryable: false }, text: 'tried' }, true)!;
		assert.deepStrictEqual([loop.title, loop.cause, loop.canContinueDifferently, loop.canRetry, loop.canResume], ['Agent looping detected', 'loop', true, true, false]);
		const budget = runEndTray({ outcome: 'failed', failure: { message: 'Paused at the step limit for one run (150 model calls). Send "continue" to keep going from here.', retryable: false } }, true)!;
		assert.deepStrictEqual([budget.title, budget.cause, budget.canResume, budget.canContinueDifferently], ['Paused at a limit', 'budget', true, false]);
	});

	test('stopped and interrupted turns get a marker; finished and running turns none', () => {
		assert.strictEqual(runEndTray({ cancelled: true, outcome: 'stopped', text: 'half' }, true)?.title, 'Stopped');
		assert.strictEqual(runEndTray({ cancelled: true, outcome: 'stopped', text: 'half' }, true)?.canResume, true);
		assert.strictEqual(runEndTray({ cancelled: true, activity: { status: 'Interrupted' } }, true)?.kind, 'interrupted');
		assert.strictEqual(runEndTray({ outcome: 'done', text: 'ok' }, true), undefined);
		assert.strictEqual(runEndTray({ outcome: 'failed', activity: { streaming: true } }, true), undefined);
	});

	test('supervisor trays act only while they matter', () => {
		assert.deepStrictEqual(supervisionActions('loop', { running: true, isLast: true, failed: false }), ['continueDifferently', 'stop']);
		assert.deepStrictEqual(supervisionActions('loop', { running: false, isLast: true, failed: false }), ['continueDifferently']);
		assert.deepStrictEqual(supervisionActions('loop', { running: false, isLast: true, failed: true }), [], 'the error tray owns the actions');
		assert.deepStrictEqual(supervisionActions('stall', { running: true, isLast: true, failed: false }), ['resume', 'stop']);
		assert.deepStrictEqual(supervisionActions('budget', { running: false, isLast: true, failed: false }), ['continue']);
		assert.deepStrictEqual(supervisionActions('loop', { running: false, isLast: false, failed: false }), []);
	});

	test('a failure title names the cause', () => {
		assert.strictEqual(failureTitle('The agent stopped responding after 9 minutes'), 'Agent stopped responding');
		assert.strictEqual(failureTitle('Doom loop: identical tool batch repeated'), 'Agent looping detected');
		assert.strictEqual(failureTitle('Provider returned 400'), 'Something went wrong');
	});

	test('to-dos read as a checklist, then as Cursor\'s completed summary', () => {
		const steps = [
			{ label: 'Fix DELETE', state: 'done' as const },
			{ label: 'Add 404 test', state: 'current' as const },
			{ label: 'Run tests', state: 'pending' as const },
		];
		const live = todoChecklist(steps, true)!;
		assert.strictEqual(live.title, '1 of 3 To-dos');
		assert.strictEqual(live.current, 'Add 404 test');
		assert.strictEqual(todoChecklist(steps.map(step => ({ ...step, state: 'done' as const })), false)?.title, '3 of 3 To-dos Completed');
		assert.strictEqual(todoChecklist([], true), undefined);
	});

	test('to-dos keep when they started and finished across updates', () => {
		const first = stampTodoSteps([], [
			{ label: 'Verify setup', state: 'current' },
			{ label: 'Run tasks', state: 'pending' },
		], 1_000);
		assert.deepStrictEqual(first, [
			{ label: 'Verify setup', state: 'current', startedAt: 1_000 },
			{ label: 'Run tasks', state: 'pending' },
		]);
		const second = stampTodoSteps(first, [
			{ label: 'Verify setup', state: 'done' },
			{ label: 'Run tasks', state: 'current' },
		], 93_000);
		assert.deepStrictEqual(second, [
			{ label: 'Verify setup', state: 'done', startedAt: 1_000, endedAt: 93_000 },
			{ label: 'Run tasks', state: 'current', startedAt: 93_000 },
		]);
		// A later update repeats the list: the times stay those first seen.
		assert.deepStrictEqual(stampTodoSteps(second, [
			{ label: 'Verify setup', state: 'done' },
			{ label: 'Run tasks', state: 'current' },
		], 120_000), second);
		// Claude shows the to-do in progress by its "active" name, then done by its own name again.
		const renamed = stampTodoSteps(
			stampTodoSteps([], [{ label: 'Run tasks', state: 'pending' }, { label: 'Rerun', state: 'pending' }], 0),
			[{ label: 'Running tasks', state: 'current' }, { label: 'Rerun', state: 'pending' }], 10_000);
		assert.deepStrictEqual(stampTodoSteps(renamed, [{ label: 'Run tasks', state: 'done' }, { label: 'Rerun', state: 'pending' }], 70_000)[0],
			{ label: 'Run tasks', state: 'done', startedAt: 10_000, endedAt: 70_000 });
		// Done without ever showing in progress: no start, so no duration.
		assert.deepStrictEqual(stampTodoSteps([], [{ label: 'Quick', state: 'done' }], 5_000), [{ label: 'Quick', state: 'done', endedAt: 5_000 }]);
	});

	test('the Tasks card shows progress, the current to-do and times', () => {
		const card = tasksCard([
			{ label: 'Verify setup', state: 'done', startedAt: 0, endedAt: 92_000 },
			{ label: 'Run tasks', state: 'current', startedAt: 92_000 },
			{ label: 'Implement', state: 'pending' },
			{ label: 'Rerun', state: 'pending' },
		], true)!;
		assert.strictEqual(card.done, 1);
		assert.strictEqual(card.total, 4);
		assert.strictEqual(card.current, 'Run tasks');
		assert.deepStrictEqual(card.items.map(item => item.time), ['1m 32s', 'now', undefined, undefined]);
		// A stopped run's to-do in progress is not "now".
		assert.strictEqual(tasksCard([{ label: 'Run tasks', state: 'current', startedAt: 1 }], false)?.items[0].time, undefined);
		assert.strictEqual(tasksCard([{ label: 'All', state: 'done' }], false)?.current, undefined);
		assert.strictEqual(tasksCard([{ label: '  ', state: 'pending' }], true), undefined);
	});

	test('the Tasks card follows the latest list while it matters', () => {
		const open = [{ label: 'A', state: 'done' as const }, { label: 'B', state: 'current' as const }];
		const finished = [{ label: 'A', state: 'done' as const }, { label: 'B', state: 'done' as const }];
		const user = { kind: 'user' };
		const agent = (steps: { label: string; state: 'done' | 'current' | 'pending' }[], streaming = false) => ({ kind: 'agent', steps, activity: { streaming } });
		assert.strictEqual(composerTasks([user, agent(open, true)])?.live, true);
		assert.strictEqual(composerTasks([user, agent(finished, true)])?.done, 2, 'stays while the turn runs');
		assert.strictEqual(composerTasks([user, agent(finished)]), undefined, 'a finished list leaves');
		assert.strictEqual(composerTasks([user, agent(open)])?.live, false, 'a stopped run keeps its open to-dos');
		assert.strictEqual(composerTasks([user, agent(open), user, agent([], true)])?.current, 'B', 'a later run works through the same list');
		assert.strictEqual(composerTasks([user, agent(open), user, agent([])]), undefined, 'an older list stays in its turn');
		assert.strictEqual(composerTasks([user, agent([], true)]), undefined);
	});

	test('elapsed time keeps a steady width', () => {
		assert.strictEqual(formatElapsed(4_200), '4s');
		assert.strictEqual(formatElapsed(65_000), '1m 05s');
		assert.strictEqual(formatElapsed(3_725_000), '1h 02m');
	});

	test('Build sends the plan itself, and the bubble only says Build', () => {
		const prompt = createdPlanPrompt({ name: 'Fix DELETE todos', markdown: '1. Parse the id as a number\n2. Add a test' });
		assert.strictEqual(prompt.display, 'Build "Fix DELETE todos"');
		assert.ok(prompt.text.startsWith('Fix DELETE todos\n\nImplement the plan as specified'));
		assert.ok(prompt.text.includes('<plan>\n1. Parse the id as a number\n2. Add a test\n</plan>'));
		assert.strictEqual(createdPlanPrompt({ markdown: '' }).display, 'Build the plan');
	});
});
