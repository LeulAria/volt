/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { lastUserActivity, shouldAutoSettleIdle } from '../../common/agentAutoSettle.js';

const DAY = 86_400_000;
const NOW = 100 * DAY;
const IDLE = { busy: false, liveSubagents: false };

function chat(extra: Partial<IAgentSessionMeta> = {}): IAgentSessionMeta {
	return {
		id: 'c',
		title: 'c',
		createdAt: 0,
		updatedAt: NOW - 5 * DAY,
		workspaceId: 'w',
		workspaceLabel: 'volt',
		turnCount: 2,
		preview: 'c',
		status: 'done',
		lastPromptAt: NOW - 5 * DAY,
		lastUserPromptAt: NOW - 5 * DAY,
		...extra,
	};
}

suite('Agent idle auto-settle', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('settles a chat idle for the configured days; 0 turns it off', () => {
		assert.ok(shouldAutoSettleIdle(chat(), IDLE, NOW, 3));
		assert.ok(!shouldAutoSettleIdle(chat(), IDLE, NOW, 6));
		assert.ok(!shouldAutoSettleIdle(chat(), IDLE, NOW, 0));
		assert.ok(shouldAutoSettleIdle(chat({ status: 'error' }), IDLE, NOW, 3), 'an old failure settles too');
		assert.ok(shouldAutoSettleIdle(chat({ pinned: true }), IDLE, NOW, 3), 'pinning does not hold a chat');
	});

	test('work in progress, pending input, live subagents, drafts and the opt-out hold it', () => {
		assert.ok(!shouldAutoSettleIdle(chat({ status: 'running' }), IDLE, NOW, 3));
		assert.ok(!shouldAutoSettleIdle(chat({ attention: 'question' }), IDLE, NOW, 3));
		assert.ok(!shouldAutoSettleIdle(chat(), { busy: true, liveSubagents: false }, NOW, 3));
		assert.ok(!shouldAutoSettleIdle(chat(), { busy: false, liveSubagents: true }, NOW, 3));
		assert.ok(!shouldAutoSettleIdle(chat({ turnCount: 0 }), IDLE, NOW, 3));
		assert.ok(!shouldAutoSettleIdle(chat({ hasDraft: true }), IDLE, NOW, 3));
		assert.ok(!shouldAutoSettleIdle(chat({ autoSettle: false }), IDLE, NOW, 3));
		assert.ok(!shouldAutoSettleIdle(chat({ subagent: true }), IDLE, NOW, 3));
		assert.ok(!shouldAutoSettleIdle(chat({ settled: true }), IDLE, NOW, 3));
		assert.ok(!shouldAutoSettleIdle(chat({ snoozed: true }), IDLE, NOW, 3));
		assert.ok(!shouldAutoSettleIdle(chat({ archived: true }), IDLE, NOW, 3));
	});

	test('only the user\'s own prompts count as activity', () => {
		// Volt woke the chat yesterday with a subagent report; the user last wrote five days ago.
		assert.ok(shouldAutoSettleIdle(chat({ lastPromptAt: NOW - DAY }), IDLE, NOW, 3));
		assert.ok(!shouldAutoSettleIdle(chat({ lastPromptAt: NOW - DAY, lastUserPromptAt: NOW - DAY }), IDLE, NOW, 3));
		// Older indexes have no user stamp: the last prompt stands in.
		assert.strictEqual(lastUserActivity(chat({ lastUserPromptAt: undefined, lastPromptAt: 7 })), 7);
	});

	test('a snooze running out or an unread reply starts a fresh idle stretch', () => {
		assert.ok(!shouldAutoSettleIdle(chat({ wokeAt: NOW - DAY }), IDLE, NOW, 3));
		assert.ok(!shouldAutoSettleIdle(chat({ unread: true, updatedAt: NOW - DAY }), IDLE, NOW, 3));
		assert.ok(shouldAutoSettleIdle(chat({ unread: true, updatedAt: NOW - 4 * DAY }), IDLE, NOW, 3));
	});

	test('un-settling by hand holds it until the user writes again', () => {
		const unsettled = chat({ unsettledAt: NOW - 4 * DAY });
		assert.ok(!shouldAutoSettleIdle(unsettled, IDLE, NOW, 3));
		assert.ok(!shouldAutoSettleIdle({ ...unsettled, unread: true, updatedAt: NOW - 3.5 * DAY }, IDLE, NOW, 3), 'a reply is not the user resuming');
		const resumed = { ...unsettled, lastPromptAt: NOW - 3.5 * DAY, lastUserPromptAt: NOW - 3.5 * DAY };
		assert.ok(shouldAutoSettleIdle(resumed, IDLE, NOW, 3), 'a prompt after the un-settle brings the usual rules back');
	});
});
