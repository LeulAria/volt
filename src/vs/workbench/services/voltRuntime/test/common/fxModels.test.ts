/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { fxModelLabel, fxModelsToInfo, fxSignedIn, parseFxModelIds, parseFxStatus } from '../../common/models/fxModels.js';

suite('fx models', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads sign-in and the default model from fx status', () => {
		const signedIn = parseFxStatus('{"kind":"status","model":"openai/gpt-5.2","auth":"fx login","auth_refreshable":true,"permission_mode":"ask"}\n');
		assert.deepStrictEqual(signedIn, { auth: 'fx login', model: 'openai/gpt-5.2' });
		assert.strictEqual(fxSignedIn(signedIn), true);
		assert.strictEqual(fxSignedIn(parseFxStatus('{"kind":"status","model":"spacexai/grok-4.7","auth":"missing"}')), false);
		// Output fx could not produce as JSON says nothing about sign-in.
		assert.strictEqual(fxSignedIn(parseFxStatus('error: unknown flag')), undefined);
	});

	test('lists fx models with its default first', () => {
		// `fx models --json` from fx 0.0.13, ids trimmed.
		const ids = parseFxModelIds('{"kind":"models","count":3,"shown_count":3,"more_count":0,"private_models_hidden":false,"ids":["anthropic/claude-sonnet-5.5","openai/gpt-5.4-nano","anthropic/claude-opus-5.5","openai/gpt-5.4-nano"]}');
		assert.deepStrictEqual(ids, ['anthropic/claude-sonnet-5.5', 'openai/gpt-5.4-nano', 'anthropic/claude-opus-5.5']);
		const rows = fxModelsToInfo(ids, 'anthropic/claude-opus-5.5');
		assert.deepStrictEqual(rows.map(row => [row.id, row.label]), [
			['anthropic/claude-opus-5.5', 'Claude Opus 5.5'],
			['anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'],
			['openai/gpt-5.4-nano', 'GPT 5.4 Nano'],
		]);
		const effort = rows[0].optionDescriptors?.[0];
		assert.strictEqual(effort?.id, 'reasoning');
		assert.strictEqual(effort?.options?.find(option => option.isDefault)?.value, 'medium');
		assert.deepStrictEqual(parseFxModelIds('not json'), []);
	});

	test('names the vendor only when two serve the same model', () => {
		assert.strictEqual(fxModelLabel('spacexai/grok-4.7'), 'Grok 4.7');
		const rows = fxModelsToInfo(['groq/llama-4-scout', 'meta/llama-4-scout', 'xai/grok-4.7']);
		assert.deepStrictEqual(rows.map(row => row.label), ['Llama 4 Scout (Groq)', 'Llama 4 Scout (Meta)', 'Grok 4.7']);
	});
});
