/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	anyHomeFilterActive,
	defaultAgentHomeViewState,
	groupingLabel,
	isStatusFilterActive,
	reviveAgentHomeViewState,
	serializeAgentHomeViewState,
	sessionPassesHomeFilters,
	sessionPrimaryStatus,
	sessionSourceTag,
	sessionStatusTags,
	sortSessionsForHome,
	updatedBucketId,
} from '../../browser/home/agentHomeFilter.js';
import { IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';

function session(extra: Partial<IAgentSessionMeta> = {}): IAgentSessionMeta {
	return {
		id: 's',
		title: 's',
		createdAt: 1,
		updatedAt: 1,
		workspaceId: 'w',
		workspaceLabel: 'volt',
		turnCount: 1,
		preview: 's',
		status: 'done',
		...extra,
	};
}

suite('Agent home filter model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('defaults match the screenshot defaults', () => {
		const state = defaultAgentHomeViewState();
		assert.strictEqual(state.grouping, 'workspace');
		assert.strictEqual(state.chatOrder, 'updated');
		assert.strictEqual(state.groupOrder, 'manual');
		assert.deepStrictEqual([...state.show], ['updated', 'environment', 'pr']);
		assert.deepStrictEqual([...state.status].sort(), ['done', 'draft', 'needsAttention', 'working'].sort());
		assert.ok(state.pr.has('none'));
		assert.ok(state.environment.has('cloud') && state.environment.has('local'));
		assert.strictEqual(state.archived, 'hide');
		assert.strictEqual(groupingLabel(state.grouping), 'Workspace');
	});

	test('round-trips through storage json', () => {
		const state = defaultAgentHomeViewState();
		const next = { ...state, grouping: 'status' as const, status: new Set(['working' as const]) };
		const revived = reviveAgentHomeViewState(serializeAgentHomeViewState(next));
		assert.strictEqual(revived.grouping, 'status');
		assert.deepStrictEqual([...revived.status], ['working']);
		assert.ok(isStatusFilterActive(revived));
		assert.ok(anyHomeFilterActive(revived));
		assert.ok(!anyHomeFilterActive(defaultAgentHomeViewState()));
	});

	test('maps session status onto filter tags', () => {
		assert.deepStrictEqual([...sessionStatusTags(session({ status: 'running' }))], ['working']);
		assert.deepStrictEqual([...sessionStatusTags(session({ status: 'error' }))], ['needsAttention']);
		assert.deepStrictEqual([...sessionStatusTags(session({ status: 'idle', hasDraft: true }))], ['draft']);
		assert.ok(sessionPassesHomeFilters(session({ status: 'done' }), defaultAgentHomeViewState()));
		assert.ok(!sessionPassesHomeFilters(session({ status: 'done', archived: true }), defaultAgentHomeViewState()));
		assert.ok(sessionPassesHomeFilters(
			session({ status: 'done', archived: true }),
			{ ...defaultAgentHomeViewState(), archived: 'show' },
		));
	});

	test('harness attention outranks the run status', () => {
		assert.strictEqual(sessionPrimaryStatus(session({ status: 'running', attention: 'approval' })), 'needsAttention');
		assert.strictEqual(sessionPrimaryStatus(session({ status: 'done', attention: 'question' })), 'needsAttention');
		assert.strictEqual(sessionPrimaryStatus(session({ status: 'interrupted' })), 'needsAttention');
		assert.strictEqual(sessionPrimaryStatus(session({ status: 'cancelled' })), 'done', 'a stopped run was ended on purpose');
		assert.strictEqual(sessionPrimaryStatus(session({ status: 'idle', turnCount: 0, hasDraft: true })), 'draft');
	});

	test('unread and unsent drafts are extra tags, not a different status', () => {
		assert.deepStrictEqual([...sessionStatusTags(session({ status: 'done', unread: true, hasDraft: true }))], ['done', 'draft', 'unread']);
		const onlyUnread = { ...defaultAgentHomeViewState(), status: new Set(['unread' as const]) };
		assert.ok(sessionPassesHomeFilters(session({ unread: true }), onlyUnread));
		assert.ok(!sessionPassesHomeFilters(session({}), onlyUnread));
	});

	test('archived sessions still answer to the other filters', () => {
		const state = { ...defaultAgentHomeViewState(), archived: 'show' as const, status: new Set(['working' as const]) };
		assert.ok(!sessionPassesHomeFilters(session({ archived: true, status: 'done' }), state));
		assert.ok(sessionPassesHomeFilters(session({ archived: true, status: 'running' }), state));
	});

	test('source tells folder sessions from workspace sessions', () => {
		assert.strictEqual(sessionSourceTag(session({ workspaceFolder: '/a' })), 'folder');
		assert.strictEqual(sessionSourceTag(session({ workspaceFolder: '/a', workspaceFolders: ['/a', '/b'] })), 'workspaceFile');
		assert.strictEqual(sessionSourceTag(session({ workspaceId: 'ws-file' }), new Set(['ws-file'])), 'workspaceFile');
		const foldersOnly = { ...defaultAgentHomeViewState(), source: new Set(['folder' as const]) };
		assert.ok(!sessionPassesHomeFilters(session({ workspaceFolders: ['/a', '/b'] }), foldersOnly));
	});

	test('orders by status, then most recent', () => {
		const sorted = sortSessionsForHome([
			session({ id: 'done', status: 'done', updatedAt: 9 }),
			session({ id: 'run', status: 'running', updatedAt: 1 }),
			session({ id: 'ask', status: 'running', attention: 'approval', updatedAt: 2 }),
			session({ id: 'draft', status: 'idle', turnCount: 0, hasDraft: true, updatedAt: 3 }),
		], 'status');
		assert.deepStrictEqual(sorted.map(item => item.id), ['ask', 'run', 'draft', 'done']);
	});

	test('buckets by calendar day', () => {
		const now = new Date(2026, 8, 27, 15, 0).getTime();
		assert.strictEqual(updatedBucketId(new Date(2026, 8, 27, 0, 5).getTime(), now), 'today');
		assert.strictEqual(updatedBucketId(new Date(2026, 8, 26, 23, 59).getTime(), now), 'yesterday');
		assert.strictEqual(updatedBucketId(new Date(2026, 8, 21, 12).getTime(), now), 'week');
		assert.strictEqual(updatedBucketId(new Date(2026, 8, 1, 12).getTime(), now), 'month');
		assert.strictEqual(updatedBucketId(new Date(2026, 6, 1).getTime(), now), 'older');
		assert.strictEqual(updatedBucketId(0, now), 'older');
	});
});
