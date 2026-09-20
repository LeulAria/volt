/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { GeminiToolAssembler } from '../../../common/harness/geminiToolStream.js';

suite('Volt Gemini tool assembler', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('treats STOP with a functionCall as tool_calls', () => {
		const assembler = new GeminiToolAssembler();
		const events = assembler.apply([{ functionCall: { name: 'web_search', args: { query: 'nissan kicks uae' } } }], 'STOP');
		assert.strictEqual(events[0]?.type, 'tool.start');
		if (events[0]?.type === 'tool.start') {
			assert.strictEqual(events[0].name, 'web_search');
			assert.ok(events[0].input?.includes('nissan kicks uae'));
		}
		assert.strictEqual(assembler.finish().reason, 'tool_calls');
	});

	test('maps MAX_TOKENS to length', () => {
		const assembler = new GeminiToolAssembler();
		assembler.apply([{ text: 'hello' }], 'MAX_TOKENS');
		assert.strictEqual(assembler.finish().reason, 'length');
	});
});
