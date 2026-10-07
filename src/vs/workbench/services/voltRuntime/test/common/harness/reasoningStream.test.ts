/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IReasoningDetail, mergeReasoningDetails, openAiReasoningText, ProviderReasoning } from '../../../common/harness/reasoningStream.js';

suite('Volt provider reasoning stream', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads whichever reasoning field the server used', () => {
		assert.strictEqual(openAiReasoningText({ reasoning_content: 'a' }), 'a');
		assert.strictEqual(openAiReasoningText({ reasoning: 'b', reasoning_details: [{ type: 'reasoning.text', text: 'b' }] }), 'b');
		assert.strictEqual(openAiReasoningText({ reasoning_details: [{ type: 'reasoning.summary', summary: 'c' }, { type: 'reasoning.encrypted', data: 'zz' }] }), 'c');
		assert.strictEqual(openAiReasoningText({ reasoning: null }), '');
		assert.strictEqual(openAiReasoningText(undefined), '');
	});

	test('merges detail fragments by index and keeps encrypted entries whole', () => {
		const details: IReasoningDetail[] = [];
		mergeReasoningDetails(details, [{ type: 'reasoning.text', index: 0, text: 'one ' }]);
		mergeReasoningDetails(details, [{ type: 'reasoning.text', index: 0, text: 'two', signature: 's' }]);
		mergeReasoningDetails(details, [{ type: 'reasoning.encrypted', index: 1, data: 'xyz' }]);
		assert.deepStrictEqual(details, [
			{ type: 'reasoning.text', index: 0, text: 'one two', signature: 's' },
			{ type: 'reasoning.encrypted', index: 1, data: 'xyz' },
		]);
	});

	test('a closed thought starts a new block on the next delta', () => {
		const reasoning = new ProviderReasoning('r', 'p', 'm', 'reasoning_content');
		assert.deepStrictEqual(reasoning.close(), []);
		assert.deepStrictEqual(reasoning.delta('x').map(event => event.type), ['reasoning.start', 'reasoning.delta']);
		assert.deepStrictEqual(reasoning.close().map(event => event.type), ['reasoning.end', 'reasoning.block']);
		reasoning.delta('y');
		const block = reasoning.close().find(event => event.type === 'reasoning.block');
		assert.deepStrictEqual(block, { type: 'reasoning.block', provider: 'p', model: 'm', text: 'y', opaque: { reasoning_content: 'y' } });
	});

	test('a provider that never takes reasoning back gets no block', () => {
		const reasoning = new ProviderReasoning('r', 'ollama', 'm', 'none');
		reasoning.delta('x');
		assert.deepStrictEqual(reasoning.close().map(event => event.type), ['reasoning.end']);
	});
});
