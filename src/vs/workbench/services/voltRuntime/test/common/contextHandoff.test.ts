/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildContextHandoff, compactionBudget, groupHandoffTurns, handoffBudget, handoffPath, handoffToolCall, HANDOFF_MIN_TOKENS, IHandoffMessage, summarizeFiles, summarizeTools } from '../../common/contextHandoff.js';
import { estimateTokens } from '../../common/harness/contextEngine.js';

/** A chat of `turns` exchanges; each reply is `replyChars` long and reads one file. */
function chat(turns: number, replyChars = 400): IHandoffMessage[] {
	const messages: IHandoffMessage[] = [];
	for (let i = 1; i <= turns; i++) {
		messages.push({ role: 'user', content: `Question ${i}: what about part ${i}?` });
		messages.push({
			role: 'assistant',
			content: `Answer ${i}. ${'x'.repeat(replyChars)}`,
			model: i % 2 ? 'Claude Haiku 4.5' : 'GPT-5.5',
			activity: { tools: [{ kind: 'read', label: `src/part${i}.ts` }], files: i % 3 === 0 ? [{ path: `src/part${i}.ts`, kind: 'edit' }] : [] },
		});
	}
	return messages;
}

suite('Volt context handoff', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the budget is a share of the receiving window, capped, never under the minimum', () => {
		assert.strictEqual(handoffBudget({ contextWindow: 200_000 }), 30_000);
		assert.strictEqual(handoffBudget({ contextWindow: 1_000_000 }), 32_000, 'capped by maxTokens');
		assert.strictEqual(handoffBudget({ contextWindow: 1_000_000, maxTokens: 100_000 }), 100_000);
		assert.strictEqual(handoffBudget({ contextWindow: 200_000, percent: 5 }), 10_000);
		assert.strictEqual(handoffBudget({ contextWindow: 8_000 }), HANDOFF_MIN_TOKENS);
		assert.strictEqual(handoffBudget({ contextWindow: 30_000, percent: 50, maxTokens: 100_000 }), 10_000, 'at most a third of the window');
		assert.strictEqual(handoffBudget({}), 19_200, 'unknown window: 128K');
		assert.strictEqual(handoffBudget({ contextWindow: 200_000, percent: Number.NaN }), 30_000, 'a bad setting falls back');
		assert.strictEqual(compactionBudget(200_000), 20_000);
	});

	test('turns group a prompt with its replies; steering messages stay in their turn; a compaction resets', () => {
		const { summary, turns } = groupHandoffTurns([
			{ role: 'user', content: 'one' },
			{ role: 'assistant', content: 'r1' },
			{ role: 'user', content: 'also this', steer: true },
			{ role: 'assistant', content: 'r1b' },
			{ role: 'assistant', content: 'Summary of the conversation so far: stuff', compacted: true },
			{ role: 'user', content: 'two' },
			{ role: 'assistant', content: 'r2' },
		], 4);
		assert.strictEqual(summary, 'Summary of the conversation so far: stuff');
		assert.deepStrictEqual(turns.map(turn => [turn.number, turn.user, turn.replies.map(reply => reply.text)]), [[4, 'two', ['r2']]]);
		const steered = groupHandoffTurns([{ role: 'user', content: 'one' }, { role: 'user', content: 'faster', steer: true }, { role: 'assistant', content: 'ok' }]).turns;
		assert.deepStrictEqual(steered[0].steers, ['faster']);
	});

	test('tool calls become one line; file edits become paths with their latest kind', () => {
		assert.strictEqual(summarizeTools([
			{ kind: 'read', label: 'a.ts' }, { kind: 'read', label: 'b.ts' }, { kind: 'read', label: 'a.ts' },
			{ kind: 'execute', label: 'npm test', failed: true }, { kind: 'search', label: 'foo' }, { kind: 'search', label: 'bar' },
			{ kind: 'other', label: 'html_render' },
		]), 'read a.ts, b.ts · ran `npm test` (failed) · 2 searches · used html_render');
		assert.strictEqual(summarizeTools([1, 2, 3, 4, 5, 6].map(i => ({ kind: 'read' as const, label: `f${i}` }))), 'read f1, f2, f3, f4 +2 more');
		assert.strictEqual(summarizeFiles([{ path: 'n.ts', kind: 'create' }, { path: 'n.ts', kind: 'edit' }, { path: 'o.ts', kind: 'edit' }, { path: 'o.ts', kind: 'delete' }]), 'n.ts (created), o.ts (deleted)');
	});

	test('a short chat goes in verbatim, whole', () => {
		const handoff = buildContextHandoff({ messages: chat(3, 50), budget: 4_000, reason: 'switch', fromLabel: 'Claude Haiku 4.5', toLabel: 'GPT-5.5' })!;
		assert.strictEqual(handoff.verbatimTurns, 3);
		assert.strictEqual(handoff.condensedTurns, 0);
		assert.strictEqual(handoff.omittedTurns, 0);
		assert.ok(handoff.text.includes('from Claude Haiku 4.5 to you (GPT-5.5)'));
		assert.ok(handoff.text.includes('User: Question 1: what about part 1?'));
		assert.ok(handoff.text.includes('Tool calls: read src/part3.ts'));
		assert.ok(handoff.text.includes('Files changed: src/part3.ts (edited)'));
		assert.ok(handoff.text.includes('Assistant (GPT-5.5): Answer 2.'));
		assert.ok(!handoff.text.includes('Original request'), 'nothing to pin when everything is in');
		assert.deepStrictEqual(handoff.files, ['src/part3.ts']);
	});

	test('a long chat: recent verbatim, older condensed, the rest counted, the first request pinned, within budget', () => {
		const messages = chat(80, 1_200);
		const budget = 6_000;
		const handoff = buildContextHandoff({ messages, budget, reason: 'switch', threadId: 'agent-1' })!;
		assert.ok(handoff.tokens <= budget, `${handoff.tokens} <= ${budget}`);
		assert.strictEqual(estimateTokens(handoff.text), handoff.tokens);
		assert.ok(handoff.verbatimTurns >= 1);
		assert.ok(handoff.condensedTurns >= 1);
		assert.ok(handoff.omittedTurns >= 1);
		assert.strictEqual(handoff.verbatimTurns + handoff.condensedTurns + handoff.omittedTurns, 80);
		// Newest turn verbatim, at the end; condensed ones are older than every verbatim one.
		assert.ok(handoff.text.includes('### Turn 80'));
		const condensed = [...handoff.text.matchAll(/^- Turn (\d+)\./gm)].map(match => Number(match[1]));
		const verbatim = [...handoff.text.matchAll(/^### Turn (\d+)/gm)].map(match => Number(match[1]));
		assert.ok(Math.max(...condensed) < Math.min(...verbatim));
		assert.deepStrictEqual(condensed, [...condensed].sort((a, b) => a - b), 'chronological');
		assert.ok(handoff.text.includes('Original request (turn 1): Question 1'));
		assert.ok(/Turns 1-\d+ were left out to fit \(files changed then: /.test(handoff.text));
		assert.ok(handoff.text.includes('thread_read with thread_id agent-1'));
	});

	test('stays within budget for every size, and is deterministic', () => {
		for (const budget of [300, 1_000, 2_000, 5_000, 20_000]) {
			for (const turns of [1, 2, 10, 200]) {
				for (const replyChars of [10, 3_000, 60_000]) {
					const input = { messages: chat(turns, replyChars), budget, reason: 'return' as const };
					const handoff = buildContextHandoff(input)!;
					assert.ok(handoff.tokens <= budget, `${turns} turns of ${replyChars} chars in ${budget}: ${handoff.tokens}`);
					assert.ok(handoff.verbatimTurns >= 1, 'the latest exchange always goes in');
					assert.strictEqual(buildContextHandoff(input)!.text, handoff.text);
				}
			}
		}
	});

	test('one huge message is clipped head and tail, keeping the ask and the conclusion', () => {
		const handoff = buildContextHandoff({
			messages: [{ role: 'user', content: `ASK ${'a'.repeat(200_000)} END` }, { role: 'assistant', content: `START ${'b'.repeat(200_000)} CONCLUSION` }],
			budget: 3_000,
			reason: 'switch',
		})!;
		assert.ok(handoff.tokens <= 3_000);
		assert.ok(handoff.text.includes('User: ASK'));
		assert.ok(handoff.text.includes('CONCLUSION'));
		assert.ok(handoff.text.includes('[… clipped …]'));
	});

	test('a delta names turns as the chat does and says the agent was here before', () => {
		const handoff = buildContextHandoff({ messages: chat(2, 20), budget: 3_000, reason: 'return', firstTurn: 5, fromLabel: 'GPT-5.5' })!;
		assert.ok(handoff.text.includes('You were in this conversation earlier'));
		assert.ok(handoff.text.includes('Turns 5-6.'));
		assert.ok(handoff.text.includes('### Turn 6'));
	});

	test('a compacted summary leads; nothing to hand off is undefined', () => {
		const handoff = buildContextHandoff({
			messages: [{ role: 'assistant', content: 'Summary: we built X.', compacted: true }, { role: 'user', content: 'next?' }, { role: 'assistant', content: 'Y' }],
			budget: 2_000,
			reason: 'resume',
		})!;
		assert.ok(handoff.text.indexOf('## Earlier conversation (compacted)\nSummary: we built X.') < handoff.text.indexOf('### Turn 1'));
		assert.strictEqual(buildContextHandoff({ messages: [], budget: 2_000, reason: 'switch' }), undefined);
		assert.strictEqual(buildContextHandoff({ messages: [{ role: 'system', content: 'x' }], budget: 2_000, reason: 'switch' }), undefined);
	});

	test('a stopped turn says so instead of inventing a reply', () => {
		const handoff = buildContextHandoff({ messages: [{ role: 'user', content: 'do it' }], budget: 2_000, reason: 'switch' })!;
		assert.ok(handoff.text.includes('Assistant: (no reply: the turn was stopped or failed)'));
	});

	test('tool calls are recorded by what they touched, relative to the chat folder', () => {
		const cwd = '/repo';
		assert.deepStrictEqual(handoffToolCall({ kind: 'execute', input: '{"command":"npm test"}', title: 'Run tests' }, cwd), { kind: 'execute', label: 'npm test' });
		assert.deepStrictEqual(handoffToolCall({ kind: 'execute', input: '{"command":["git","status"]}' }, cwd), { kind: 'execute', label: 'git status' });
		assert.deepStrictEqual(handoffToolCall({ kind: 'execute', title: '`ls -la`', failed: true }, cwd), { kind: 'execute', label: 'ls -la', failed: true });
		assert.deepStrictEqual(handoffToolCall({ kind: 'read', paths: ['/repo/src/a.ts'], title: 'Read a.ts' }, cwd), { kind: 'read', label: 'src/a.ts' });
		assert.deepStrictEqual(handoffToolCall({ kind: 'edit', input: '{"file_path":"/elsewhere/b.ts"}' }, cwd), { kind: 'edit', label: '/elsewhere/b.ts' });
		assert.deepStrictEqual(handoffToolCall({ kind: 'delete', title: 'Delete x' }, cwd), { kind: 'edit', label: 'Delete x' });
		assert.deepStrictEqual(handoffToolCall({ kind: 'search', input: '{"pattern":"TODO"}' }, cwd), { kind: 'search', label: 'TODO' });
		assert.deepStrictEqual(handoffToolCall({ name: 'mcp__volt__html_render', input: '{}' }, cwd), { kind: 'other', label: 'mcp__volt__html_render' });
		assert.strictEqual(handoffPath('C:\\repo\\x.ts', 'C:\\repo'), 'x.ts');
		assert.strictEqual(handoffPath('/repo2/x.ts', '/repo'), '/repo2/x.ts');
	});

	test('a Volt compaction summary does not nest its wrapper in the next handoff', () => {
		const compacted = buildContextHandoff({ messages: chat(4, 50), budget: 2_000, reason: 'compact' })!;
		const next = buildContextHandoff({ messages: [{ role: 'assistant', content: compacted.text, compacted: true }, { role: 'user', content: 'go on' }, { role: 'assistant', content: 'ok' }], budget: 4_000, reason: 'switch' })!;
		assert.strictEqual(next.text.match(/<conversation_handoff>/g)?.length, 1);
		assert.ok(next.text.includes('Question 1: what about part 1?'));
	});
});
