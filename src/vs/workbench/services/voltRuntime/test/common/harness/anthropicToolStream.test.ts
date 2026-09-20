/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { AnthropicToolAssembler } from '../../../common/harness/anthropicToolStream.js';

suite('Volt Anthropic tool assembler', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('emits tool.start then input deltas', () => {
		const assembler = new AnthropicToolAssembler();
		const start = assembler.apply({
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' },
		});
		assert.deepStrictEqual(start, [{ type: 'tool.start', callId: 'tu_1', name: 'read_file', input: '', kind: 'other' }]);
		const delta = assembler.apply({
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'input_json_delta', partial_json: '{"path":' },
		});
		assert.deepStrictEqual(delta, [{ type: 'tool.input.delta', callId: 'tu_1', delta: '{"path":' }]);
	});

	test('maps tool_use stop to tool_calls', () => {
		const assembler = new AnthropicToolAssembler();
		assembler.apply({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'grep' } });
		assembler.apply({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
		assert.strictEqual(assembler.finish().reason, 'tool_calls');
	});

	test('maps max_tokens to length', () => {
		const assembler = new AnthropicToolAssembler();
		assembler.apply({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } });
		assert.strictEqual(assembler.finish().reason, 'length');
	});
});
