/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { codexContextIndex, modelEditSections, modelHoverCard, parseClaudeCatalog, parseCodexModels, parseOpenCodeModelLines } from '../../common/models/harnessCatalog.js';
import { booleanOption, MODEL_OPTION_CONTEXT, MODEL_OPTION_FAST, MODEL_OPTION_REASONING, MODEL_OPTION_THINKING, selectOption } from '../../common/models/modelOptions.js';

suite('Harness model catalogs', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('codex cache keeps listed models and drops hidden ones', () => {
		const models = parseCodexModels({
			models: [
				{
					slug: 'gpt-6-astra',
					display_name: 'GPT-6-Astra',
					description: 'Frontier intelligence',
					visibility: 'list',
					default_reasoning_level: 'low',
					supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'xhigh' }],
					additional_speed_tiers: ['fast'],
					service_tiers: [{ id: 'priority', name: 'Fast' }],
					context_window: 272000,
					max_context_window: 872000,
				},
				{
					slug: 'codex-auto-review',
					display_name: 'Codex Auto Review',
					visibility: 'hide',
					supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
				},
			],
		});
		assert.deepStrictEqual(models.map(model => model.id), ['gpt-6-astra']);
		assert.strictEqual(models[0].description, 'Frontier intelligence');
		assert.strictEqual(models[0].contextLabel, '272k');
		const effort = models[0].optionDescriptors?.find(option => option.id === MODEL_OPTION_REASONING);
		assert.deepStrictEqual(effort?.options?.map(choice => choice.label), ['Low', 'High', 'Extra High']);
		assert.strictEqual(effort?.options?.find(choice => choice.isDefault)?.value, 'low');
		assert.ok(models[0].optionDescriptors?.some(option => option.id === MODEL_OPTION_FAST && option.type === 'boolean'));
		assert.deepStrictEqual(
			models[0].optionDescriptors?.find(option => option.id === MODEL_OPTION_CONTEXT)?.options?.map(choice => choice.label),
			['272K', '872K'],
		);
	});

	test('app-server models pick up context windows from the cache index', () => {
		const cache = {
			models: [{ slug: 'gpt-6-sol', context_window: 272000, max_context_window: 272000 }],
		};
		const models = parseCodexModels({
			data: [{
				id: 'gpt-6-sol',
				displayName: 'GPT-6-Sol',
				description: 'Workhorse',
				hidden: false,
				defaultReasoningEffort: 'medium',
				supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
				additionalSpeedTiers: ['fast'],
				serviceTiers: [{ id: 'priority', name: 'Fast' }],
			}],
		}, codexContextIndex(cache));
		assert.strictEqual(models[0].contextLabel, '272k');
		assert.ok(!models[0].optionDescriptors?.some(option => option.id === MODEL_OPTION_CONTEXT));
	});

	test('claude catalog maps effort, fast, and context from the published surface', () => {
		const models = parseClaudeCatalog({
			surfaces: {
				cc: {
					model_selector_config: [{
						models: [
							{
								id: 'claude-opus-5',
								name: 'Opus 5',
								description: 'Powerful model',
								thinking: {
									type: 'effort',
									effort_options: [
										{ id: 'low', name: 'Low' },
										{ id: 'high', name: 'High', badge: { message: 'Default' } },
										{ id: 'xhigh', name: 'Extra' },
									],
								},
								fast_mode: { type: 'toggle' },
								runtime: { max_input_tokens: 1000000, default_effort: 'high' },
							},
							{
								id: 'claude-haiku-4-5',
								name: 'Haiku 4.5',
								thinking: { type: 'none' },
								runtime: { max_input_tokens: 200000 },
							},
						],
					}],
				},
			},
		});
		assert.deepStrictEqual(models.map(model => model.label), ['Opus 5', 'Haiku 4.5']);
		assert.strictEqual(models[0].contextLabel, '1m');
		assert.strictEqual(models[1].contextLabel, '200k');
		assert.ok(models[0].optionDescriptors?.some(option => option.id === MODEL_OPTION_FAST));
		assert.ok(!models[1].optionDescriptors?.length);
		assert.strictEqual(models[0].optionDescriptors?.find(option => option.id === MODEL_OPTION_REASONING)?.options?.find(choice => choice.value === 'xhigh')?.label, 'Extra High');
	});

	test('opencode lines become rows and banners are ignored', () => {
		const models = parseOpenCodeModelLines('opencode/big-pickle\nFetching models\nollama/qwen3.5:27b\n');
		assert.deepStrictEqual(models.map(model => model.id), ['opencode/big-pickle', 'ollama/qwen3.5:27b']);
		assert.strictEqual(models[0].label, 'Big Pickle');
	});

	test('edit sections follow the order the harness advertised', () => {
		const grok = modelEditSections([
			selectOption(MODEL_OPTION_REASONING, 'Effort', [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }]),
			booleanOption(MODEL_OPTION_FAST, 'Fast', true),
		]);
		assert.deepStrictEqual(grok.map(section => section.id), ['effort', 'options']);

		const composer = modelEditSections([booleanOption(MODEL_OPTION_FAST, 'Fast', true)]);
		assert.deepStrictEqual(composer.map(section => section.id), ['options']);

		const opus = modelEditSections([
			booleanOption(MODEL_OPTION_THINKING, 'Thinking', true),
			selectOption(MODEL_OPTION_CONTEXT, 'Context', [{ value: '300k', label: '300K' }, { value: '1m', label: '1M' }]),
			selectOption(MODEL_OPTION_REASONING, 'Effort', [{ value: 'high', label: 'High' }, { value: 'max', label: 'Max' }]),
			booleanOption(MODEL_OPTION_FAST, 'Fast', false),
		]);
		assert.deepStrictEqual(opus.map(section => section.id), ['options', 'context', 'effort']);
		assert.deepStrictEqual(opus[0].descriptors.map(descriptor => descriptor.id), [MODEL_OPTION_THINKING, MODEL_OPTION_FAST]);
	});

	test('hover card uses the selected effort, fast mode, and context', () => {
		assert.deepStrictEqual(modelHoverCard('Grok 4.6', 'Predecessor model', '256k', 'High', true), {
			title: 'Grok 4.6 (fast)',
			description: 'Predecessor model',
			context: '256k context window',
			version: 'Version: high effort',
		});
	});
});
