/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { OpenAiToolAssembler } from '../../../common/harness/openaiToolStream.js';

suite('Volt OpenAI tool assembler', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('buffers arguments that arrive before the id', () => {
		const assembler = new OpenAiToolAssembler();
		assert.deepStrictEqual(assembler.apply({ tool_calls: [{ index: 0, function: { arguments: '{"p' } }] }), []);
		const started = assembler.apply({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: 'ath":"a"}' } }] });
		assert.strictEqual(started[0]?.type, 'tool.start');
		if (started[0]?.type === 'tool.start') {
			assert.strictEqual(started[0].callId, 'call_1');
			assert.strictEqual(started[0].name, 'read_file');
			assert.strictEqual(started[0].input, '{"path":"a"}');
		}
		assert.strictEqual(assembler.finish().reason, 'tool_calls');
	});

	test('streams later argument chunks as deltas', () => {
		const assembler = new OpenAiToolAssembler();
		const start = assembler.apply({ tool_calls: [{ index: 0, id: 'c', function: { name: 'grep' } }] });
		assert.strictEqual(start[0]?.type, 'tool.start');
		const delta = assembler.apply({ tool_calls: [{ index: 0, function: { arguments: '{"pattern":"x"}' } }] });
		assert.deepStrictEqual(delta, [{ type: 'tool.input.delta', callId: 'c', delta: '{"pattern":"x"}' }]);
	});

	test('maps finish_reason', () => {
		const assembler = new OpenAiToolAssembler();
		assembler.apply({ content: 'hi' }, 'length');
		assert.strictEqual(assembler.finish().reason, 'length');
	});
});
