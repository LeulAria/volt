/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildContextUsageSnapshot,
	defaultOverhead,
	estimateTokensFromText,
	filterContextModels,
	CONTEXT_CATEGORY_COLORS,
	CONTEXT_POPOVER_CATEGORY_ORDER,
	formatContextFullLabel,
	formatContextPercent,
	formatContextTokens,
	formatContextWindowLabel,
	groupContextModels,
	occupancyFromUsage,
	overheadFromCustomizations,
	promptBaseTokens,
	resolveModelContextWindow,
	toolOutputTokens,
} from '../../browser/context/agentContextUsage.js';
import { IAgentCustomization } from '../../browser/customize/agentCustomize.js';

suite('Agent context usage', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('estimates tokens from text length', () => {
		assert.strictEqual(estimateTokensFromText(''), 0);
		assert.strictEqual(estimateTokensFromText('abcd'), 1);
		assert.strictEqual(estimateTokensFromText('a'.repeat(40)), 10);
	});

	test('formats tokens and percents like the context meter', () => {
		assert.strictEqual(formatContextTokens(0), '0');
		assert.strictEqual(formatContextTokens(420), '420');
		assert.strictEqual(formatContextTokens(1_700), '1.7K');
		assert.strictEqual(formatContextTokens(186_100), '186.1K');
		assert.strictEqual(formatContextTokens(1_000_000), '1M');
		assert.strictEqual(formatContextPercent(0), '0%');
		assert.strictEqual(formatContextPercent(7.2), '7.2%');
		assert.strictEqual(formatContextPercent(73.4), '73%');
		assert.strictEqual(formatContextFullLabel(28), '28% Full');
		assert.strictEqual(formatContextWindowLabel(71_600, 256_000), '~71.6K / 256K Tokens');
	});

	test('resolves the live window from catalog options', () => {
		assert.strictEqual(resolveModelContextWindow({ contextWindow: 200_000 }), 200_000);
		assert.strictEqual(resolveModelContextWindow({ contextLabel: '1m' }), 1_000_000);
		assert.strictEqual(resolveModelContextWindow({
			contextWindow: 128_000,
			optionDescriptors: [{ id: 'contextWindow', label: 'Context', type: 'select', options: [{ value: '256k', label: '256k' }] }],
		}, { contextWindow: '256k' }), 256_000);
	});

	test('builds a Cursor-style breakdown from reported occupancy', () => {
		const snapshot = buildContextUsageSnapshot({
			messages: [
				{ kind: 'user', text: 'a'.repeat(600_000) },
				{ kind: 'agent', text: 'b'.repeat(200_000), tokensUsed: 186_100, tokensWindow: 256_000, tokensIn: 180_000, tokensOut: 6_100 },
			],
			draft: 'next turn',
			modelWindow: 128_000,
			modelName: 'Claude Sonnet 4.6',
			nativeAgent: true,
			overhead: {
				system: 1_700,
				tools: 15_200,
				rules: 3_100,
				skills: 5_000,
				mcp: 6_800,
				subagents: 1_800,
				ruleCount: 4,
				skillCount: 3,
				mcpCount: 2,
				subagentCount: 1,
			},
			models: [
				{ ref: 'claude', name: 'Claude Sonnet 4.6', family: 'anthropic', window: 256_000, active: true },
				{ ref: 'gpt', name: 'GPT-5.2', family: 'openai', window: 400_000, active: false },
			],
		});

		assert.strictEqual(snapshot.limit, 256_000);
		assert.ok(snapshot.used > 186_100);
		assert.strictEqual(snapshot.estimated, false);
		assert.strictEqual(snapshot.compacted, true);
		assert.ok(snapshot.items.some(item => item.id === 'system' && item.tokens === 1_700));
		assert.ok(snapshot.items.some(item => item.id === 'conversation'));
		assert.ok(snapshot.items.some(item => item.id === 'summarized'));
		assert.strictEqual(snapshot.models[0].active, true);
		assert.ok(snapshot.models[0].percent > 70);
		assert.ok(snapshot.fitsOn >= 1);
	});

	test('treats last-request prompt and completion as occupancy when used is missing', () => {
		const snapshot = buildContextUsageSnapshot({
			messages: [
				{ kind: 'user', text: 'hello' },
				{ kind: 'agent', text: 'hi', tokensIn: 40_000, tokensOut: 1_200 },
			],
			draft: '',
			modelWindow: 200_000,
			nativeAgent: true,
			models: [{ ref: 'a', name: 'Grok 4.6', family: 'grok', window: 200_000, active: true }],
		});

		assert.strictEqual(occupancyFromUsage({ tokensIn: 40_000, tokensOut: 1_200 }), 41_200);
		assert.strictEqual(snapshot.used, 41_200);
		assert.strictEqual(snapshot.estimated, false);
		assert.ok(snapshot.percent > 20);
	});

	test('new session first snapshot is not contaminated by a previous session usage', () => {
		const previous = buildContextUsageSnapshot({
			messages: [
				{ kind: 'user', text: 'earlier chat' },
				{ kind: 'agent', text: 'reply', tokensIn: 2, tokensOut: 3, tokensCache: 16_800, tokensUsed: 5 },
			],
			draft: '',
			modelWindow: 1_000_000,
			modelName: 'Sonnet 5',
			nativeAgent: true,
			overhead: {
				system: 0,
				tools: 10_000,
				rules: 0,
				skills: 40_000,
				mcp: 0,
				subagents: 0,
				ruleCount: 0,
				skillCount: 35,
				mcpCount: 0,
				subagentCount: 0,
			},
			models: [{ ref: 'a', name: 'Sonnet 5', family: 'anthropic', window: 1_000_000, active: true }],
		});
		// Previous session occupancy includes cache; chips and rows share that total.
		assert.strictEqual(previous.used, 16_805);
		assert.strictEqual(previous.input, 2);
		assert.strictEqual(previous.output, 3);
		assert.strictEqual(previous.cache, 16_800);
		assert.strictEqual(previous.items.reduce((sum, item) => sum + item.tokens, 0), previous.used);
		assert.ok(previous.percent > 0);

		const fresh = buildContextUsageSnapshot({
			messages: [],
			draft: '',
			modelWindow: 1_000_000,
			modelName: 'Sonnet 5',
			nativeAgent: true,
			overhead: {
				system: 0,
				tools: 10_000,
				rules: 0,
				skills: 40_000,
				mcp: 0,
				subagents: 0,
				ruleCount: 0,
				skillCount: 35,
				mcpCount: 0,
				subagentCount: 0,
			},
			models: [{ ref: 'a', name: 'Sonnet 5', family: 'anthropic', window: 1_000_000, active: true }],
		});

		assert.strictEqual(fresh.used, 0);
		assert.strictEqual(fresh.percent, 0);
		assert.strictEqual(fresh.input, undefined);
		assert.strictEqual(fresh.output, undefined);
		assert.strictEqual(fresh.cache, undefined);
		assert.strictEqual(fresh.items.length, 0);
		assert.ok(!fresh.compacted);
	});

	test('live usage breakdown rows are shares of the same header total', () => {
		const snapshot = buildContextUsageSnapshot({
			messages: [
				{ kind: 'user', text: 'a'.repeat(40_000) },
				{ kind: 'agent', text: 'b'.repeat(4_000), tokensIn: 2, tokensOut: 3, tokensCache: 16_800 },
			],
			draft: '',
			modelWindow: 1_000_000,
			nativeAgent: true,
			overhead: {
				system: 0,
				tools: 1,
				rules: 0,
				skills: 4,
				mcp: 0,
				subagents: 0,
				ruleCount: 0,
				skillCount: 35,
				mcpCount: 0,
				subagentCount: 0,
			},
			models: [{ ref: 'a', name: 'Sonnet 5', family: 'anthropic', window: 1_000_000, active: true }],
		});

		assert.strictEqual(occupancyFromUsage({ tokensIn: 2, tokensOut: 3, tokensCache: 16_800 }), 16_805);
		assert.strictEqual(snapshot.used, 16_805);
		assert.strictEqual(snapshot.cache, 16_800);
		assert.strictEqual(snapshot.estimated, false);
		const itemSum = snapshot.items.reduce((sum, item) => sum + item.tokens, 0);
		assert.strictEqual(itemSum, snapshot.used);
		const shareSum = snapshot.items.reduce((sum, item) => sum + (item.tokens / snapshot.used) * 100, 0);
		assert.ok(Math.abs(shareSum - 100) < 0.01);
	});

	test('includes cache when deriving occupancy from turn tokens', () => {
		assert.strictEqual(occupancyFromUsage({ tokensIn: 2, tokensOut: 3, tokensCache: 16_800 }), 16_805);
		assert.strictEqual(occupancyFromUsage({ tokensUsed: 5, tokensIn: 2, tokensOut: 3, tokensCache: 16_800 }), 16_805);
		assert.strictEqual(occupancyFromUsage({ tokensUsed: 53_000, tokensIn: 2, tokensOut: 3, tokensCache: 16_800 }), 53_000);
	});

	test('counts the expanded user prompt, not the short display label', () => {
		const snapshot = buildContextUsageSnapshot({
			messages: [{ kind: 'user', text: 'fix this', agentText: 'a'.repeat(8_000) }],
			draft: '',
			modelWindow: 200_000,
			nativeAgent: true,
			models: [{ ref: 'a', name: 'Grok 4.6', family: 'grok', window: 200_000, active: true }],
		});

		assert.ok(snapshot.used > 2_000);
		const conversation = snapshot.items.find(item => item.id === 'conversation');
		assert.ok(conversation && conversation.tokens >= 2_000);
	});

	test('new sessions stay at zero until the transcript or provider reports usage', () => {
		const snapshot = buildContextUsageSnapshot({
			messages: [],
			draft: '',
			modelWindow: 200_000,
			nativeAgent: true,
			models: [
				{ ref: 'a', name: 'Agent', family: 'claude', window: 200_000, active: true },
				{ ref: 'b', name: 'Small', family: 'openai', window: 8_000, active: false },
			],
		});

		assert.strictEqual(snapshot.estimated, true);
		assert.strictEqual(snapshot.limit, 200_000);
		assert.strictEqual(snapshot.used, 0);
		assert.strictEqual(snapshot.percent, 0);
		assert.ok(!snapshot.items.some(item => item.id === 'system' || item.id === 'tools'));
		assert.strictEqual(snapshot.fitsOn, 2);
		assert.strictEqual(snapshot.models.find(model => model.ref === 'b')?.fits, true);
	});

	test('estimates occupancy from the transcript when a local model has not reported usage', () => {
		const snapshot = buildContextUsageSnapshot({
			messages: [{ kind: 'user', text: 'hello' }],
			draft: '',
			modelWindow: 200_000,
			nativeAgent: true,
			models: [
				{ ref: 'a', name: 'Agent', family: 'claude', window: 200_000, active: true },
				{ ref: 'b', name: 'Small', family: 'openai', window: 8_000, active: false },
			],
		});

		assert.strictEqual(snapshot.estimated, true);
		assert.ok(snapshot.used >= defaultOverhead(true).system);
		assert.ok(snapshot.items.some(item => item.id === 'conversation'));
		assert.strictEqual(snapshot.fitsOn, 1);
		assert.strictEqual(snapshot.models.find(model => model.ref === 'b')?.fits, false);
	});

	test('groups and filters models by provider', () => {
		const models = [
			{ ref: 'a', name: 'Grok 4.6', family: 'grok', provider: 'Grok', window: 200_000, active: true, percent: 12, remaining: 176_000, fits: true },
			{ ref: 'b', name: 'gemma4:26b', family: 'local', provider: 'Local', window: 32_800, active: false, percent: 71, remaining: 9_000, fits: true },
			{ ref: 'c', name: 'qwen3.5:27b', family: 'local', provider: 'Local', window: 32_800, active: false, percent: 71, remaining: 9_000, fits: true },
		];
		const groups = groupContextModels(models);
		assert.strictEqual(groups[0].family, 'grok');
		assert.strictEqual(groups[0].label, 'Grok');
		assert.strictEqual(groups.find(group => group.family === 'local')?.models.length, 2);
		assert.strictEqual(filterContextModels(models, 'gemma').length, 1);
		assert.strictEqual(filterContextModels(models, 'local').length, 2);
	});

	test('orders popover rows and keeps their swatch colors', () => {
		const snapshot = buildContextUsageSnapshot({
			messages: [
				{ kind: 'user', text: 'hello' },
				{ kind: 'agent', text: 'hi', tokensUsed: 80_000, tokensWindow: 256_000 },
			],
			draft: '',
			modelWindow: 256_000,
			nativeAgent: true,
			overhead: {
				system: 2_600,
				tools: 5_300,
				rules: 3_200,
				skills: 8_200,
				mcp: 5_300,
				subagents: 1_900,
				ruleCount: 2,
				skillCount: 4,
				mcpCount: 1,
				subagentCount: 1,
			},
			models: [{ ref: 'a', name: 'Opus', family: 'anthropic', window: 256_000, active: true }],
		});

		const ids = snapshot.items.map(item => item.id).filter(id => (CONTEXT_POPOVER_CATEGORY_ORDER as readonly string[]).includes(id));
		const expected = CONTEXT_POPOVER_CATEGORY_ORDER.filter(id => id !== 'summarized');
		assert.deepStrictEqual(ids, [...expected]);
		for (const item of snapshot.items) {
			assert.strictEqual(item.color, CONTEXT_CATEGORY_COLORS[item.id]);
		}
		assert.strictEqual(CONTEXT_CATEGORY_COLORS.summarized, '#fb6b84');
		assert.strictEqual(CONTEXT_CATEGORY_COLORS.conversation, '#e07d77');
		assert.strictEqual(CONTEXT_CATEGORY_COLORS.rules, '#3fa365');
	});

	test('streaming text after the last usage snapshot grows occupancy', () => {
		const overhead = {
			system: 100,
			tools: 100,
			rules: 0,
			skills: 0,
			mcp: 0,
			subagents: 0,
			ruleCount: 0,
			skillCount: 0,
			mcpCount: 0,
			subagentCount: 0,
		};
		const settled = buildContextUsageSnapshot({
			messages: [
				{ kind: 'user', text: 'hello' },
				{ kind: 'agent', text: 'done', tokensUsed: 10_000, tokensWindow: 200_000 },
			],
			draft: '',
			modelWindow: 200_000,
			nativeAgent: false,
			overhead,
			models: [],
		});
		const streaming = buildContextUsageSnapshot({
			messages: [
				{ kind: 'user', text: 'hello' },
				{ kind: 'agent', text: 'done', tokensUsed: 10_000, tokensWindow: 200_000 },
				{ kind: 'user', text: 'a'.repeat(4_000) },
				{ kind: 'agent', text: 'b'.repeat(4_000), activity: { streaming: true } },
			],
			draft: '',
			modelWindow: 200_000,
			nativeAgent: false,
			overhead,
			models: [],
		});

		assert.ok(streaming.used > settled.used + 1_500);
		assert.strictEqual(streaming.items.reduce((sum, item) => sum + item.tokens, 0), streaming.used);
		assert.strictEqual(streaming.estimated, true);
	});

	test('a prompt-only usage snapshot still counts the streaming reply', () => {
		const snapshot = buildContextUsageSnapshot({
			messages: [
				{ kind: 'agent', text: 'b'.repeat(4_000), tokensUsed: 12_000, tokensIn: 10_000, tokensCache: 2_000, activity: { streaming: true } },
			],
			draft: '',
			modelWindow: 200_000,
			nativeAgent: true,
			overhead: {
				system: 0,
				tools: 0,
				rules: 0,
				skills: 0,
				mcp: 0,
				subagents: 0,
				ruleCount: 0,
				skillCount: 0,
				mcpCount: 0,
				subagentCount: 0,
			},
			models: [],
		});

		assert.ok(snapshot.used > 12_000);
		assert.ok(snapshot.used < 14_000);
		assert.strictEqual(snapshot.items.reduce((sum, item) => sum + item.tokens, 0), snapshot.used);
	});

	test('a finished prompt-only used value still includes the reported reply', () => {
		assert.strictEqual(occupancyFromUsage({ tokensUsed: 12_000, tokensIn: 10_000, tokensCache: 2_000, tokensOut: 800 }), 12_800);
		const snapshot = buildContextUsageSnapshot({
			messages: [
				{ kind: 'agent', text: 'b'.repeat(3_200), tokensUsed: 12_000, tokensIn: 10_000, tokensCache: 2_000, tokensOut: 800 },
			],
			draft: '',
			modelWindow: 200_000,
			nativeAgent: true,
			overhead: {
				system: 0,
				tools: 0,
				rules: 0,
				skills: 0,
				mcp: 0,
				subagents: 0,
				ruleCount: 0,
				skillCount: 0,
				mcpCount: 0,
				subagentCount: 0,
			},
			models: [],
		});

		assert.strictEqual(snapshot.used, 12_800);
		assert.strictEqual(snapshot.estimated, false);
		assert.strictEqual(snapshot.items.reduce((sum, item) => sum + item.tokens, 0), snapshot.used);
	});

	test('reported completion is not added twice while the reply is still streaming', () => {
		const snapshot = buildContextUsageSnapshot({
			messages: [
				{ kind: 'agent', text: 'b'.repeat(4_000), tokensUsed: 12_000, tokensIn: 10_000, tokensCache: 2_000, tokensOut: 500, activity: { streaming: true } },
			],
			draft: '',
			modelWindow: 200_000,
			nativeAgent: true,
			overhead: {
				system: 0,
				tools: 0,
				rules: 0,
				skills: 0,
				mcp: 0,
				subagents: 0,
				ruleCount: 0,
				skillCount: 0,
				mcpCount: 0,
				subagentCount: 0,
			},
			models: [],
		});

		assert.ok(snapshot.used >= 12_500);
		assert.ok(snapshot.used < 14_000);
		assert.strictEqual(snapshot.items.reduce((sum, item) => sum + item.tokens, 0), snapshot.used);
	});

	test('an occupancy total without an input split is not counted twice while streaming', () => {
		const snapshot = buildContextUsageSnapshot({
			messages: [
				{ kind: 'agent', text: 'b'.repeat(8_000), tokensUsed: 20_000, activity: { streaming: true } },
			],
			draft: '',
			modelWindow: 200_000,
			nativeAgent: true,
			overhead: {
				system: 0,
				tools: 0,
				rules: 0,
				skills: 0,
				mcp: 0,
				subagents: 0,
				ruleCount: 0,
				skillCount: 0,
				mcpCount: 0,
				subagentCount: 0,
			},
			models: [],
		});

		assert.strictEqual(snapshot.used, 20_000);
		assert.strictEqual(snapshot.estimated, false);
	});

	test('Claude end-of-turn totals that add up every call\'s cache reads do not fill the meter', () => {
		// A real Opus turn: 27K in the window, 117K cache read across its model calls.
		assert.strictEqual(occupancyFromUsage({ tokensUsed: 27_119, tokensIn: 10, tokensOut: 1_080, tokensCache: 117_032 }), 27_119);
		const snapshot = buildContextUsageSnapshot({
			messages: [
				{ kind: 'user', text: 'Verify setup and checks' },
				{ kind: 'agent', text: 'All four commands ran.', tokensUsed: 27_119, tokensWindow: 1_000_000, tokensIn: 10, tokensOut: 1_080, tokensCache: 117_032 },
			],
			draft: '',
			modelWindow: 1_000_000,
			nativeAgent: true,
			models: [],
		});
		assert.strictEqual(snapshot.used, 27_119);
		assert.ok(snapshot.percent < 3, `${snapshot.percent}%`);
	});

	test('counts tool output the transcript does not keep when there is no provider usage', () => {
		assert.strictEqual(toolOutputTokens(undefined), 0);
		assert.strictEqual(toolOutputTokens(0), 0);
		assert.strictEqual(toolOutputTokens(4), 1);
		assert.strictEqual(toolOutputTokens(5), 2);
		// Three 120 KB file reads (Cursor, no ACP usage) add about 90K tokens, not the 0.2K the text alone gave.
		const reads = { kind: 'agent' as const, text: 'Read three files.', toolOutputChars: 3 * 120_000 };
		const plain = { kind: 'agent' as const, text: 'Read three files.' };
		const withReads = buildContextUsageSnapshot({ messages: [{ kind: 'user', text: 'Read them' }, reads], draft: '', modelWindow: 1_000_000, models: [] });
		const without = buildContextUsageSnapshot({ messages: [{ kind: 'user', text: 'Read them' }, plain], draft: '', modelWindow: 1_000_000, models: [] });
		assert.strictEqual(withReads.used - without.used, 90_000);
		assert.strictEqual(withReads.estimated, true);
	});

	test('right after compacting, the kept summary sits on the system prompt and tools', () => {
		const first = 'Read notes1.txt, notes2.txt and notes3.txt';
		const messages = [
			{ kind: 'user' as const, text: first },
			{ kind: 'agent' as const, text: 'Three files, 401 lines each.', tokensUsed: 51_761, tokensWindow: 200_000, tokensBase: 21_426 },
			{ kind: 'user' as const, text: '/compact' },
			{ kind: 'agent' as const, segments: [{ kind: 'compaction' as const, compaction: { id: 'c1', status: 'completed' as const, preTokens: 51_787, postTokens: 2_244 } }], tokensUsed: 2_244, tokensWindow: 200_000, usageExcludesPrompt: true },
		];
		const base = 21_426 - estimateTokensFromText(first);
		assert.strictEqual(promptBaseTokens(messages, 9_999), base);
		const snapshot = buildContextUsageSnapshot({ messages, draft: '', modelWindow: 200_000, nativeAgent: true, models: [] });
		// The next turn of the recorded chat reported 24,189: the summary plus the same system prompt and tools.
		assert.strictEqual(snapshot.used, 2_244 + base);
		assert.strictEqual(snapshot.estimated, true);
		assert.strictEqual(snapshot.items.reduce((sum, item) => sum + item.tokens, 0), snapshot.used);

		// A chat recorded before the first prompt-side figure was kept falls back to the local estimate.
		const older = messages.map(message => message.kind === 'agent' ? { ...message, tokensBase: undefined } : message);
		const overhead = defaultOverhead(true);
		const estimate = overhead.system + overhead.tools;
		assert.strictEqual(buildContextUsageSnapshot({ messages: older, draft: '', modelWindow: 200_000, nativeAgent: true, overhead, models: [] }).used, 2_244 + estimate);
	});

	test('a later real figure replaces the post-compaction estimate', () => {
		const snapshot = buildContextUsageSnapshot({
			messages: [
				{ kind: 'agent', text: 'ok', tokensUsed: 2_244, usageExcludesPrompt: true, tokensBase: 21_426 },
				{ kind: 'user', text: 'Reply with just: ok' },
				{ kind: 'agent', text: 'ok', tokensUsed: 24_261, tokensWindow: 200_000 },
			],
			draft: '',
			modelWindow: 200_000,
			nativeAgent: true,
			models: [],
		});
		assert.strictEqual(snapshot.used, 24_261);
	});

	test('sizes rules from file bytes, and skills by their catalog entry only', () => {
		const items: IAgentCustomization[] = [
			{ kind: 'rule', scope: 'workspace', name: 'style', description: '', resource: URI.file('/r.md'), source: 'repo', bytes: 1_600 },
			{ kind: 'skill', scope: 'workspace', name: 'ship', description: 'Release the app', resource: URI.file('/s.md'), source: 'repo', bytes: 320_000 },
			{ kind: 'mcp', scope: 'workspace', name: 'github', description: '', resource: URI.file('/m.json'), source: 'repo' },
		];
		const overhead = overheadFromCustomizations(items, [], false);
		assert.strictEqual(overhead.ruleCount, 1);
		assert.strictEqual(overhead.skillCount, 1);
		assert.strictEqual(overhead.mcpCount, 1);
		assert.strictEqual(overhead.rules, 400);
		assert.strictEqual(overhead.skills, Math.round(('ship'.length + 'Release the app'.length + 80) / 4));
		assert.ok(overhead.mcp > 0);
	});
});
