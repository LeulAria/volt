/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { nativeModelTurn } from '../../../common/deepseek/prompt.js';

suite('DeepSeek native turn', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a price question is not classified, prefetched, or given a run plan', () => {
		const turn = nativeModelTurn({
			text: 'how much is a Nissan Kicks in the UAE',
			mode: 'agent',
			cwd: '/workspace/Agent-Test',
			tools: [
				{ name: 'web_search', group: 'web' },
				{ name: 'web_fetch', group: 'web' },
				{ name: 'read_file', group: 'read' },
				{ name: 'shell', group: 'shell' },
				{ name: 'request_capabilities', group: 'meta' },
			],
		});

		assert.deepStrictEqual([...turn.prefetch], []);
		assert.strictEqual(turn.runPlan, false);
		assert.strictEqual(turn.classified, false);
		assert.ok(turn.toolNames.includes('web_search'));
		assert.ok(turn.toolNames.includes('web_fetch'));
		assert.ok(turn.toolNames.includes('shell'));
		assert.ok(!turn.toolNames.includes('request_capabilities'));
		assert.ok(!turn.prompt.includes('how much is a Nissan Kicks'));
		assert.ok(!/http\.server|Start servers|task brief|lane framing/i.test(turn.prompt));
		assert.ok(turn.prompt.includes('/workspace/Agent-Test'));
		assert.ok(turn.prompt.includes('Turn a short or rough request into a finished result'));
		assert.ok(turn.prompt.includes('Lead with the answer'));
	});

	test('ask mode keeps web tools and drops shell and edits', () => {
		const turn = nativeModelTurn({
			text: 'what is this file',
			mode: 'ask',
			tools: [
				{ name: 'web_search', group: 'web' },
				{ name: 'read_file', group: 'read' },
				{ name: 'edit_file', group: 'edit' },
				{ name: 'shell', group: 'shell' },
			],
		});
		assert.ok(turn.toolNames.includes('web_search'));
		assert.ok(turn.toolNames.includes('read_file'));
		assert.ok(!turn.toolNames.includes('edit_file'));
		assert.ok(!turn.toolNames.includes('shell'));
		assert.ok(/Read-only/.test(turn.prompt));
	});
});
