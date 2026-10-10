/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DEFAULT_MODEL_CAPABILITIES } from '../../common/capabilities.js';
import { fastModelRank, fastTabSibling, formatPredictionError, resolveRunModelRef, resolveTabModel } from '../../common/models/modelAccess.js';
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

	function inProfile(item: IVoltCatalogItem, profileId: string): IVoltCatalogItem {
		return { ...item, profileId };
	}

	test('a pinned Tab model wins over the composer selection', () => {
		const ref = resolveTabModel('agent:p2:claude', { tab: 'model:p1:haiku', ask: 'model:p1:gpt-5' }, [claudeCode, gpt, haiku]);
		assert.strictEqual(ref, 'model:p1:haiku');
		// Pinned exactly as chosen, even a slow model.
		assert.strictEqual(resolveTabModel('model:p1:haiku', { tab: 'model:p1:gpt-5' }, [gpt, haiku]), 'model:p1:gpt-5');
	});

	test('following the composer steps down to the fastest model of the same provider', () => {
		const opus = inProfile(agent('agent:cc:claude-opus-5-5'), 'cc');
		const sonnet = inProfile(agent('agent:cc:claude-sonnet-5-5'), 'cc');
		const ccHaiku = inProfile(agent('agent:cc:claude-haiku-4-5-20251001'), 'cc');
		const otherHaiku = inProfile(model('model:api:claude-haiku-4-5'), 'api');
		assert.strictEqual(resolveTabModel(opus.ref, {}, [opus, sonnet, ccHaiku, otherHaiku]), ccHaiku.ref, 'same CLI login, never another provider');
		assert.strictEqual(resolveTabModel(opus.ref, {}, [opus, sonnet]), opus.ref, 'nothing faster: the selection itself');
		assert.strictEqual(resolveTabModel('model:p1:gpt-5', {}, [gpt, haiku]), 'model:p1:haiku');
	});

	test('an already fast selection is kept', () => {
		const mini = model('model:p1:gpt-5-mini');
		assert.strictEqual(resolveTabModel(mini.ref, {}, [gpt, haiku, mini]), mini.ref);
	});

	test('fast model ranking', () => {
		assert.strictEqual(fastTabSibling(gpt, [gpt, model('model:p1:gpt-5-mini'), model('model:p1:gpt-5-nano')]).id, 'gpt-5-nano');
		assert.strictEqual(fastModelRank('gemini-2.5-flash-lite')! < fastModelRank('gemini-2.5-flash')!, true);
		assert.strictEqual(fastModelRank('claude-opus-5-5'), undefined);
		assert.strictEqual(fastModelRank('gemini-2.5-pro'), undefined);
		assert.strictEqual(fastModelRank('administrator'), undefined, 'mini only as a word');
	});

	test('Tab override is used when the composer has no selection', () => {
		const ref = resolveTabModel(undefined, { tab: 'model:p1:haiku' }, [gpt, haiku]);
		assert.strictEqual(ref, 'model:p1:haiku');
	});

	test('with nothing selected, an HTTP chat model beats an agent turn', () => {
		assert.strictEqual(resolveTabModel(undefined, {}, [gpt, claudeCode]), 'model:p1:gpt-5');
		assert.strictEqual(resolveTabModel(undefined, {}, [claudeCode]), 'agent:p2:claude');
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

suite('Volt run model resolution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const local = model('model:p0:gemma4:26b');
	const gpt = model('model:p1:gpt-5');
	const grok = agent('agent:p2:grok-4.7');

	test('the run\'s own model wins over the chat and the last pick', () => {
		assert.strictEqual(resolveRunModelRef({ explicit: gpt.ref, chat: grok.ref, lastUsed: grok.ref }, [local, gpt, grok]), gpt.ref);
	});

	test('the chat\'s model comes before the last pick', () => {
		assert.strictEqual(resolveRunModelRef({ chat: grok.ref, lastUsed: gpt.ref }, [local, gpt, grok]), grok.ref);
	});

	test('the last pick is used when the run and the chat name none', () => {
		assert.strictEqual(resolveRunModelRef({ lastUsed: gpt.ref }, [local, gpt, grok]), gpt.ref);
	});

	test('never the first catalog entry: nothing named means no model', () => {
		assert.strictEqual(resolveRunModelRef({}, [local, gpt, grok]), undefined);
	});

	test('a named model that is gone or disabled is skipped', () => {
		assert.strictEqual(resolveRunModelRef({ explicit: 'model:p9:gone', chat: gpt.ref }, [local, gpt]), gpt.ref);
		assert.strictEqual(resolveRunModelRef({ explicit: gpt.ref, lastUsed: grok.ref }, [model(gpt.ref, false), grok]), grok.ref);
	});
});
