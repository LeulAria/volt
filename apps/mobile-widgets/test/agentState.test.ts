/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityContentState, approvalPrompt, chatUrl, chatView, formatWorked, parseChatUrl, providerFamily, providerFromRef, rankActive, shortModelName } from '../src/agentState.ts';
import { emptyStepState, foldStep } from '../src/steps.ts';
import { meta, NOW, running, thread } from './fixtures.ts';

test('a running turn: elapsed from the turn, step from runtime events, queue and subagents counted', () => {
	const step = foldStep(emptyStepState(), { type: 'tool.start', callId: 'x', name: 'bash', title: 'pnpm vitest run', card: 'terminal' });
	const view = chatView('a', {
		meta: meta('a', { status: 'running', title: 'Fix the login redirect' }),
		thread: running('a', 95_000, { queue: [{ id: 'q1' }, { id: 'q2', held: true }, { id: 'q3', kind: 'followup' }, { id: 'q4', kind: 'prompt' }] }),
		tasks: [{ id: 't1', parentId: 'a', state: 'running' }, { id: 't2', parentId: 'a', state: 'completed' }],
		step,
		filesChanged: 3,
	}, NOW);
	assert.ok(view);
	assert.equal(view.phase, 'working');
	assert.equal(view.title, 'Fix the login redirect');
	assert.equal(view.step, 'Running pnpm');
	assert.equal(view.startedAt, NOW - 95_000);
	assert.equal(view.queued, 2);
	assert.equal(view.subagents, 1);
	assert.equal(view.filesChanged, 3);
	assert.equal(view.provider, 'claude');
	assert.equal(view.model, 'Opus 5.5');
	assert.equal(view.workspace, 'volt');
	assert.equal(view.endedAt, undefined);
});

test('without runtime events the step says what the orchestrator knows', () => {
	assert.equal(chatView('a', { thread: running('a', 1000) }, NOW)?.step, 'Working');
	assert.equal(chatView('a', { thread: running('a', 1000), tasks: [{ id: 't', parentId: 'a', state: 'running' }, { id: 'u', parentId: 'a', state: 'queued' }] }, NOW)?.step, 'Waiting for 2 subagents');
	assert.equal(chatView('a', { thread: running('a', 1000, { active: { id: 't', kind: 'notification', at: NOW, phase: 'running' } }) }, NOW)?.step, 'Reading subagent reports');
});

test('approvals and questions put the chat in the input phase with the prompt', () => {
	const approval = chatView('a', {
		thread: running('a', 5000, { inputs: [{ id: 'r1', kind: 'approval', at: NOW }] }),
		approvals: [{ id: 'r1', sessionId: 'a', action: 'shell', resource: { type: 'command', value: 'npm install left-pad' }, createdAt: NOW }],
	}, NOW);
	assert.equal(approval?.phase, 'input');
	assert.equal(approval?.inputKind, 'approval');
	assert.equal(approval?.inputPrompt, 'Run npm install left-pad');
	assert.equal(approval?.step, 'Waiting for approval');

	const question = chatView('a', {
		meta: meta('a', { status: 'running' }),
		questions: [{ id: 'q', sessionId: 'a', questions: [{ prompt: 'Which database should the tests use?' }, { prompt: 'Keep the old API?' }] }],
	}, NOW);
	assert.equal(question?.phase, 'input');
	assert.equal(question?.inputKind, 'question');
	assert.equal(question?.inputPrompt, 'Which database should the tests use? (+1 more)');

	// The harness flagged attention and stopped: still waiting on the user.
	assert.equal(chatView('a', { meta: meta('a', { status: 'done', attention: 'question' }) }, NOW)?.phase, 'input');
});

test('approval prompts read like the action', () => {
	const base = { id: 'r', sessionId: 's', createdAt: 0 };
	assert.equal(approvalPrompt({ ...base, action: 'edit', resource: { value: '/repo/src/app.ts' } }), 'Edit app.ts');
	assert.equal(approvalPrompt({ ...base, action: 'web', resource: { value: 'https://docs.github.com/en/rest' } }), 'Open docs.github.com');
	assert.equal(approvalPrompt({ ...base, action: 'mcp', resource: { value: 'linear.create_issue' } }), 'Use linear.create_issue');
	assert.equal(approvalPrompt({ ...base, action: 'shell', preview: { title: 'Delete build output' } }), 'Delete build output');
});

test('ended turns: done with worked time, failed with the error, stopped, limited with reset', () => {
	const done = chatView('a', { meta: meta('a', { status: 'done', lastPromptAt: NOW - 125_000 }), thread: thread('a', { last: { turnId: 't', kind: 'prompt', outcome: 'done', at: NOW - 5_000 } }) }, NOW);
	assert.equal(done?.phase, 'done');
	assert.equal(done?.step, 'Worked for 2m');
	assert.equal(done?.endedAt, NOW - 5_000);

	const failed = chatView('a', { thread: thread('a', { last: { turnId: 't', kind: 'prompt', outcome: 'failed', at: NOW, error: 'Agent exited with code 1' } }) }, NOW);
	assert.equal(failed?.phase, 'failed');
	assert.equal(failed?.step, 'Agent exited with code 1');

	assert.equal(chatView('a', { thread: thread('a', { last: { turnId: 't', kind: 'prompt', outcome: 'cancelled', at: NOW } }) }, NOW)?.step, 'Stopped');
	assert.equal(chatView('a', { thread: thread('a', { last: { turnId: 't', kind: 'prompt', outcome: 'interrupted', at: NOW } }) }, NOW)?.step, 'Interrupted');

	const limited = chatView('a', { thread: thread('a', { last: { turnId: 't', kind: 'prompt', outcome: 'failed', at: NOW }, limit: { turnId: 't', at: NOW, resetAt: NOW + 3_600_000, message: "You've hit your session limit · resets 4pm" } }) }, NOW);
	assert.equal(limited?.phase, 'limited');
	assert.equal(limited?.limitResetAt, NOW + 3_600_000);
	assert.match(limited?.step ?? '', /session limit/);

	assert.equal(chatView('a', { thread: running('a', 0, { active: { id: 't', kind: 'prompt', at: NOW, phase: 'cancelling' } }) }, NOW)?.phase, 'stopping');
	assert.equal(chatView('a', { meta: meta('a') }, NOW), undefined);
	assert.equal(chatView('a', {}, NOW), undefined);
});

test('ranking: input first, then stopping, then the newest work', () => {
	const views = [
		chatView('old', { thread: running('old', 600_000) }, NOW)!,
		chatView('new', { thread: running('new', 1_000) }, NOW)!,
		chatView('ask', { thread: running('ask', 900_000, { inputs: [{ id: 'i', kind: 'question', at: NOW }] }) }, NOW)!,
		chatView('done', { meta: meta('done', { status: 'done' }) }, NOW)!,
	];
	assert.deepEqual(rankActive(views).map(v => v.chatId), ['ask', 'new', 'old']);
});

test('content state is in seconds and omits empty fields', () => {
	const view = chatView('a', { thread: running('a', 30_000) }, NOW)!;
	const state = activityContentState(view, 2);
	assert.equal(state.startedAt, (NOW - 30_000) / 1000);
	assert.equal(state.others, 2);
	assert.equal('endedAt' in state, false);
	assert.equal('inputKind' in state, false);
	assert.equal(state.updatedAt, NOW / 1000);
});

test('providers, models and durations', () => {
	assert.equal(providerFromRef('agent:claude'), 'claude');
	assert.equal(providerFromRef('model:openai/gpt-5'), 'openai');
	assert.equal(providerFamily('openai'), 'codex');
	assert.equal(providerFamily('cursor-acp'), 'cursor');
	assert.equal(providerFamily(undefined), 'generic');
	assert.equal(shortModelName('Claude Opus 5.5'), 'Opus 5.5');
	assert.equal(shortModelName('GPT-5.3 Codex'), 'GPT-5.3 Codex');
	assert.equal(formatWorked(500), 'Worked for 1s');
	assert.equal(formatWorked(65_000), 'Worked for 1m 5s');
	assert.equal(formatWorked(2 * 3_600_000 + 60_000 * 7), 'Worked for 2h 7m');
});

test('chat links round-trip, with the Stop action', () => {
	const url = chatUrl('agent-1 2/3', 'volt', 'stop');
	assert.equal(url, 'volt://chat/agent-1%202%2F3?action=stop');
	assert.deepEqual(parseChatUrl(url), { chatId: 'agent-1 2/3', action: 'stop' });
	assert.deepEqual(parseChatUrl('volt:///chat/abc'), { chatId: 'abc' });
	assert.equal(parseChatUrl('volt://settings'), undefined);
});
