/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { advertisedModelVariant, applyContextWindowSuffix, descriptorsFromAcpModel, descriptorsFromConfigOptions } from '../../browser/agents/acpModels.js';
import { modelEditSections } from '../../common/models/harnessCatalog.js';
import { MODEL_OPTION_CONTEXT, MODEL_OPTION_FAST, MODEL_OPTION_REASONING, MODEL_OPTION_SERVICE_TIER, MODEL_OPTION_THINKING } from '../../common/models/modelOptions.js';

suite('ACP model option parsing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('falls back to the only advertised variant of a model', () => {
		const model = { id: 'model', name: 'Model', options: ['default', 'opus', 'claude-fable-5-1[1m]', 'sonnet'].map(value => ({ value, name: value })) };
		assert.strictEqual(advertisedModelVariant(model, 'claude-fable-5-1'), 'claude-fable-5-1[1m]');
		assert.strictEqual(advertisedModelVariant(model, 'claude-fable-5-1[1m]'), undefined);
		assert.strictEqual(advertisedModelVariant(model, 'claude-sonnet-5'), undefined);
		assert.strictEqual(advertisedModelVariant(undefined, 'claude-fable-5-1'), undefined);
	});

	test('maps advertised selects including service tier', () => {
		const descriptors = descriptorsFromConfigOptions([
			{
				id: 'effort',
				name: 'Reasoning',
				type: 'select',
				currentValue: 'high',
				options: [
					{ value: 'low', name: 'Low' },
					{ value: 'high', name: 'High' },
					{ value: 'ultracode', name: 'Ultracode' },
				],
			},
			{
				id: 'context',
				name: 'Context Window',
				type: 'select',
				currentValue: '200k',
				options: [
					{ value: '200k', name: '200k' },
					{ value: '1m', name: '1m' },
				],
			},
			{
				id: 'service_tier',
				name: 'Service Tier',
				type: 'select',
				currentValue: 'default',
				options: [
					{ value: 'default', name: 'Standard' },
					{ value: 'priority', name: 'Fast' },
				],
			},
		]);
		assert.deepStrictEqual(descriptors.map(option => option.id), [MODEL_OPTION_REASONING, MODEL_OPTION_CONTEXT, MODEL_OPTION_SERVICE_TIER]);
		assert.ok(descriptors[0].options?.some(choice => choice.label === 'Ultracode'));
		assert.deepStrictEqual(descriptors[1].options?.map(choice => choice.label), ['200K', '1M']);
		assert.strictEqual(descriptors[2].options?.find(choice => choice.value === 'priority')?.label, 'Fast');
	});

	test('Cursor per-model config keeps thinking, context, and effort', () => {
		const descriptors = descriptorsFromConfigOptions([
			{
				id: 'thinking',
				name: 'Thinking',
				category: 'thought_level',
				type: 'select',
				currentValue: 'true',
				options: [
					{ value: 'false', name: 'Off' },
					{ value: 'true', name: 'On' },
				],
			},
			{
				id: 'context',
				name: 'Context',
				category: 'model_config',
				type: 'select',
				currentValue: '300k',
				options: [
					{ value: '300k', name: '300K' },
					{ value: '1m', name: '1M' },
				],
			},
			{
				id: 'effort',
				name: 'Effort',
				category: 'thought_level',
				type: 'select',
				currentValue: 'high',
				options: [
					{ value: 'low', name: 'Low' },
					{ value: 'medium', name: 'Medium' },
					{ value: 'high', name: 'High' },
					{ value: 'xhigh', name: 'Extra High' },
					{ value: 'max', name: 'Max' },
				],
			},
			{
				id: 'fast',
				name: 'Fast',
				type: 'select',
				currentValue: 'false',
				options: [
					{ value: 'false', name: 'Off' },
					{ value: 'true', name: 'On' },
				],
			},
		]);
		assert.deepStrictEqual(descriptors.map(option => option.id), [MODEL_OPTION_THINKING, MODEL_OPTION_CONTEXT, MODEL_OPTION_REASONING, MODEL_OPTION_FAST]);
		assert.strictEqual(descriptors.find(option => option.id === MODEL_OPTION_THINKING)?.defaultValue, true);
		assert.deepStrictEqual(descriptors.find(option => option.id === MODEL_OPTION_CONTEXT)?.options?.map(choice => choice.label), ['300K', '1M']);
		assert.deepStrictEqual(descriptors.find(option => option.id === MODEL_OPTION_REASONING)?.options?.map(choice => choice.value), ['low', 'medium', 'high', 'xhigh', 'max']);
		const sections = modelEditSections(descriptors);
		assert.deepStrictEqual(sections.map(section => section.id), ['options', 'context', 'effort']);
		assert.deepStrictEqual(sections[0].descriptors.map(descriptor => descriptor.id), [MODEL_OPTION_THINKING, MODEL_OPTION_FAST]);
	});

	test('OpenCode variants become a reasoning ladder', () => {
		const descriptors = descriptorsFromAcpModel({
			name: 'Opus',
			variants: { low: {}, medium: {}, high: {}, max: {} },
		} as never);
		const reasoning = descriptors.find(option => option.id === MODEL_OPTION_REASONING);
		assert.deepStrictEqual(reasoning?.options?.map(choice => choice.value), ['low', 'medium', 'high', 'max']);
	});

	test('Codex supportedReasoningEfforts and serviceTiers parse from metadata', () => {
		const descriptors = descriptorsFromAcpModel({
			name: 'GPT-6-Astra',
			supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }],
			serviceTiers: [{ id: 'priority', name: 'Fast' }],
			additionalSpeedTiers: ['flex'],
		} as never);
		assert.ok(descriptors.find(option => option.id === MODEL_OPTION_REASONING)?.options?.some(choice => choice.value === 'ultra'));
		const tier = descriptors.find(option => option.id === MODEL_OPTION_SERVICE_TIER);
		assert.ok(tier?.options?.some(choice => choice.value === 'fast' && choice.label === 'Fast'));
		assert.ok(tier?.options?.some(choice => choice.value === 'flex'));
	});

	test('omitted traits are not invented from a static catalog', () => {
		const descriptors = descriptorsFromAcpModel(
			{ name: 'Fable 5.1' },
			{},
			[],
			'claude-code',
			'claude-fable-5-1',
			'Fable 5.1',
		);
		assert.deepStrictEqual(descriptors, []);
	});

	test('advertised reasoning is not replaced by the overlay ladder', () => {
		const descriptors = descriptorsFromAcpModel(
			{
				name: 'Fable 5.1',
				configOptions: [{
					id: 'effort',
					name: 'Reasoning',
					type: 'select',
					options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
				}],
			},
			{},
			[],
			'claude-code',
			'claude-fable-5-1',
			'Fable 5.1',
		);
		const reasoning = descriptors.find(option => option.id === MODEL_OPTION_REASONING);
		assert.deepStrictEqual(reasoning?.options?.map(choice => choice.value), ['low', 'high']);
	});

	test('1M context is applied as a Claude model suffix', () => {
		assert.strictEqual(applyContextWindowSuffix('claude-fable-5', { contextWindow: '1m' }), 'claude-fable-5[1m]');
		assert.strictEqual(applyContextWindowSuffix('claude-fable-5[1m]', { contextWindow: '200k' }), 'claude-fable-5');
		assert.strictEqual(applyContextWindowSuffix('grok-4.6[effort=high]', { contextWindow: '1m' }), 'grok-4.6[effort=high]');
	});

	test('session mode is not a model trait', () => {
		const descriptors = descriptorsFromConfigOptions([
			{
				id: 'mode',
				name: 'Session Mode',
				category: 'mode',
				type: 'select',
				options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }],
			},
			{
				id: 'effort',
				name: 'Effort',
				category: 'thought_level',
				type: 'select',
				currentValue: 'default',
				options: [
					{ value: 'default', name: 'Default' },
					{ value: 'low', name: 'Low' },
					{ value: 'high', name: 'High' },
				],
			},
		]);
		assert.deepStrictEqual(descriptors.map(option => option.id), [MODEL_OPTION_REASONING]);
		assert.deepStrictEqual(descriptors[0].options?.map(choice => choice.value), ['low', 'high']);
		assert.strictEqual(descriptors[0].options?.find(choice => choice.isDefault)?.value, 'high');
	});

	test('per-model overlay wins over shared session effort', () => {
		const descriptors = descriptorsFromAcpModel(
			{ name: 'Hy3 Free' },
			{},
			[{
				id: MODEL_OPTION_REASONING,
				label: 'Reasoning',
				type: 'select',
				options: [
					{ value: 'low', label: 'Low' },
					{ value: 'medium', label: 'Medium' },
					{ value: 'high', label: 'High' },
					{ value: 'max', label: 'Max' },
				],
			}],
			'opencode',
			'opencode/hy3-free',
			'Hy3 Free',
		);
		assert.deepStrictEqual(
			descriptors.find(option => option.id === MODEL_OPTION_REASONING)?.options?.map(choice => choice.value),
			['low', 'medium', 'high'],
		);
	});
});
