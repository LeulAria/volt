/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { compactionEventsFromAcpUpdate } from '../../common/acpCompaction.js';

suite('ACP context compaction', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads compaction_update: status, the kept summary, and the token counts in _meta', () => {
		assert.deepStrictEqual(compactionEventsFromAcpUpdate({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress', _meta: { contextCompaction: { version: 1 } } }),
			[{ type: 'context.compaction', id: 'c1', status: 'running' }]);
		assert.deepStrictEqual(compactionEventsFromAcpUpdate({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed', summary: [{ type: 'text', text: 'Kept ' }, { type: 'text', text: 'this.' }] }),
			[{ type: 'context.compaction', id: 'c1', status: 'completed', summary: 'Kept this.' }]);
		assert.deepStrictEqual(compactionEventsFromAcpUpdate({
			sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed',
			_meta: { contextCompaction: { version: 1, trigger: 'automatic', preTokens: 51_787, postTokens: 2_244, durationMs: 14_734 } },
		}), [{ type: 'context.compaction', id: 'c1', status: 'completed', trigger: 'auto', preTokens: 51_787, postTokens: 2_244, durationMs: 14_734 }]);
		assert.deepStrictEqual(compactionEventsFromAcpUpdate({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'failed', error: 'Conversation too long' }),
			[{ type: 'context.compaction', id: 'c1', status: 'failed', error: 'Conversation too long' }]);
		assert.deepStrictEqual(compactionEventsFromAcpUpdate({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'cancelled' }),
			[{ type: 'context.compaction', id: 'c1', status: 'cancelled' }]);
	});

	test('appends compaction_summary_chunk to the summary', () => {
		assert.deepStrictEqual(compactionEventsFromAcpUpdate({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'The user ' } }),
			[{ type: 'context.compaction', id: 'c1', summaryDelta: 'The user ' }]);
	});

	test('reads the "Compact conversation" tool call agents send without the capability', () => {
		const meta = { contextCompaction: { version: 1 }, claudeCode: { toolName: 'compact' } };
		assert.deepStrictEqual(compactionEventsFromAcpUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Compact conversation', kind: 'think', status: 'in_progress', _meta: meta }),
			[{ type: 'context.compaction', id: 't1', status: 'running' }]);
		assert.deepStrictEqual(compactionEventsFromAcpUpdate({
			sessionUpdate: 'tool_call_update', toolCallId: 't1',
			rawOutput: { trigger: 'manual', preTokens: 49_437, postTokens: 2_075, durationMs: 12_513 },
			_meta: { contextCompaction: { version: 1, trigger: 'manual', preTokens: 49_437, postTokens: 2_075, durationMs: 12_513 } },
		}), [{ type: 'context.compaction', id: 't1', trigger: 'manual', preTokens: 49_437, postTokens: 2_075, durationMs: 12_513 }]);
		assert.deepStrictEqual(compactionEventsFromAcpUpdate({
			sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', _meta: meta,
			content: [{ type: 'content', content: { type: 'text', text: 'Compaction failed: Not enough messages to compact.' } }],
		}), [{ type: 'context.compaction', id: 't1', status: 'failed', error: 'Not enough messages to compact.' }]);
	});

	test('leaves every other update to the usual mapping', () => {
		assert.strictEqual(compactionEventsFromAcpUpdate({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Read File', kind: 'read', _meta: { claudeCode: { toolName: 'Read' } } }), undefined);
		assert.strictEqual(compactionEventsFromAcpUpdate({ sessionUpdate: 'usage_update', used: 2_244, size: 200_000 }), undefined);
		assert.strictEqual(compactionEventsFromAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }), undefined);
	});
});
