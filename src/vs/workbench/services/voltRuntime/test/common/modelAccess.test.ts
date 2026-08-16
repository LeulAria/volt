/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DEFAULT_MODEL_CAPABILITIES } from '../../common/capabilities.js';
import { formatPredictionError, resolveTabModel } from '../../common/modelAccess.js';
import { IVoltCatalogItem } from '../../common/providers.js';

function model(ref: string, enabled = true): IVoltCatalogItem {
	return {
		ref,
		kind: 'model',
		providerId: 'openai',
		profileId: 'p1',
		id: ref.split(':').pop()!,
		label: ref,
		qualifier: undefined,
		enabled,
		capabilities: DEFAULT_MODEL_CAPABILITIES,
	};
}

function agent(ref: string): IVoltCatalogItem {
	return { ...model(ref), kind: 'agent' };
}

suite('Volt tab model resolution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const gpt = model('model:p1:gpt-5');
	const haiku = model('model:p1:haiku');
	const claudeCode = agent('agent:p2:claude');

	test('composer selection wins over the Tab override', () => {
		const ref = resolveTabModel('agent:p2:claude', { tab: 'model:p1:haiku', ask: 'model:p1:gpt-5' }, [claudeCode, gpt, haiku]);
		assert.strictEqual(ref, 'agent:p2:claude');
	});

	test('falls back to the active composer model', () => {
		assert.strictEqual(resolveTabModel('model:p1:gpt-5', {}, [gpt, haiku]), 'model:p1:gpt-5');
	});

	test('Tab override is used when the composer has no selection', () => {
		const ref = resolveTabModel(undefined, { tab: 'model:p1:haiku' }, [gpt, haiku]);
		assert.strictEqual(ref, 'model:p1:haiku');
	});

	test('falls back to the first enabled agent before a chat model', () => {
		assert.strictEqual(resolveTabModel(undefined, {}, [gpt, claudeCode]), 'agent:p2:claude');
	});

	test('disabled models are never picked', () => {
		const disabled = model('model:p1:gpt-5', false);
		assert.strictEqual(resolveTabModel('model:p1:gpt-5', { tab: 'model:p1:gpt-5' }, [disabled, haiku]), 'model:p1:haiku');
	});

	test('empty catalog disables prediction', () => {
		assert.strictEqual(resolveTabModel(undefined, {}, []), undefined);
	});

	test('skips models the caller marks unusable (no API key)', () => {
		const ref = resolveTabModel('model:p1:gpt-5', {}, [gpt, haiku], item => item.id !== 'gpt-5');
		assert.strictEqual(ref, 'model:p1:haiku');
	});

	test('formats OpenAI missing-key JSON', () => {
		const err = new Error(JSON.stringify({ error: { message: 'You didn\'t provide an API key. You need to provide your API key.' } }));
		assert.ok(formatPredictionError(err).includes('No API key'));
	});
});
