/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { AgentHistoryCodec } from '../../browser/history/agentHistoryCodec.js';
import type { IAgentAssistantMessage, IAgentUserMessage } from '../../browser/editor/agentEditor.js';

function codec(): AgentHistoryCodec {
	return new AgentHistoryCodec({
		putAttachment: async () => 'attachment:none',
		getAttachment: async () => undefined,
		attachmentResource: () => undefined,
	} as unknown as IAgentHistoryService);
}

/** Through the history log and back: JSON, as the log stores it. */
function viaLog<T>(value: T): unknown {
	return JSON.parse(JSON.stringify(value));
}

suite('Agent history codec', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a finished reply keeps its thoughts and their timing after a reload', async () => {
		const reply: IAgentAssistantMessage = {
			kind: 'agent',
			id: 'turn-1',
			title: '',
			steps: [],
			segments: [
				{ kind: 'thought', text: 'Checking the config first.', startedAt: 1_000, updatedAt: 5_000 },
				{ kind: 'text', text: 'Done.' },
			],
			blockState: {},
			startedAt: 900,
			endedAt: 6_000,
		};
		const stored = viaLog(await codec().freezeAssistant(reply));
		const thawed = await codec().thawAssistant(stored, true);
		assert.deepStrictEqual(thawed?.segments, reply.segments);
	});

	test('a cited quote round-trips with its source and comment', async () => {
		const user: IAgentUserMessage = {
			kind: 'user',
			id: 'turn-2',
			text: 'Why this? "uses a cache" ',
			mentions: [{
				kind: 'selection',
				label: '"uses a cache"',
				value: '```chat_selection\n```',
				citation: { agentId: 'chat-1', messageId: 'turn-1', quote: 'uses a cache', prefix: 'It ', suffix: ' so', start: 3, comment: 'Which one?' },
			}],
		};
		const stored = viaLog(await codec().freezeUser(user));
		const thawed = await codec().thawUser(stored);
		assert.deepStrictEqual(thawed?.mentions?.[0].citation, user.mentions![0].citation);
	});
});
