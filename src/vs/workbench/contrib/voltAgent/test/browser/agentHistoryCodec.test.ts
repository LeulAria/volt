/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { AgentHistoryCodec } from '../../browser/history/agentHistoryCodec.js';
import type { IAgentAssistantMessage } from '../../browser/editor/agentEditor.js';

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
});
