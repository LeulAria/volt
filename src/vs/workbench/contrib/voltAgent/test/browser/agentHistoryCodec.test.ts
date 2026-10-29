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

	test('an image pasted into a steering message is stored by reference and comes back with its bytes', async () => {
		const bytes = new Uint8Array([137, 80, 78, 71]);
		const attachments = new Map<string, { bytes: Uint8Array; mime: string }>();
		const history = {
			putAttachment: async (data: Uint8Array, mime: string) => {
				attachments.set('attachment:shot', { bytes: data, mime });
				return 'attachment:shot';
			},
			getAttachment: async (ref: string) => attachments.get(ref),
			attachmentResource: () => undefined,
		} as unknown as IAgentHistoryService;
		const reply: IAgentAssistantMessage = {
			kind: 'agent',
			id: 'turn-3',
			title: '',
			steps: [],
			segments: [{ kind: 'text', text: 'Working.' }],
			blockState: {},
			steers: [
				{ text: 'like this image.png', at: 1, mentions: [{ kind: 'image', label: 'image.png', image: { id: 'img-1', mime: 'image/png', bytes, name: 'image.png' } }] },
				{ text: 'and keep going', at: 1 },
			],
		};
		const stored = viaLog(await new AgentHistoryCodec(history).freezeAssistant(reply)) as { steers: { mentions?: { image?: { ref?: string; bytes?: unknown } }[] }[] };
		assert.strictEqual(stored.steers[0].mentions?.[0].image?.ref, 'attachment:shot');
		assert.strictEqual(stored.steers[0].mentions?.[0].image?.bytes, undefined, 'no bytes in the log');
		const thawed = await new AgentHistoryCodec(history).thawAssistant(stored, true);
		assert.deepStrictEqual(thawed?.steers?.map(steer => steer.text), ['like this image.png', 'and keep going']);
		assert.deepStrictEqual(Array.from(thawed?.steers?.[0].mentions?.[0].image?.bytes ?? []), Array.from(bytes));
		assert.strictEqual(thawed?.steers?.[1].mentions, undefined);
	});
});
