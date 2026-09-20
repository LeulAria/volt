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
	formatContextPercent,
	formatContextTokens,
	groupContextModels,
	occupancyFromUsage,
	overheadFromCustomizations,
	resolveModelContextWindow,
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

	test('sizes customization overhead from file bytes', () => {
		const items: IAgentCustomization[] = [
			{ kind: 'rule', scope: 'workspace', name: 'style', description: '', resource: URI.file('/r.md'), source: 'repo', bytes: 1_600 },
			{ kind: 'skill', scope: 'workspace', name: 'ship', description: '', resource: URI.file('/s.md'), source: 'repo', bytes: 3_200 },
			{ kind: 'mcp', scope: 'workspace', name: 'github', description: '', resource: URI.file('/m.json'), source: 'repo' },
		];
		const overhead = overheadFromCustomizations(items, [], false);
		assert.strictEqual(overhead.ruleCount, 1);
		assert.strictEqual(overhead.skillCount, 1);
		assert.strictEqual(overhead.mcpCount, 1);
		assert.strictEqual(overhead.rules, 400);
		assert.strictEqual(overhead.skills, 800);
		assert.ok(overhead.mcp > 0);
	});
});
