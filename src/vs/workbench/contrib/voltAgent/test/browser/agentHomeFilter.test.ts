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
		assert.strictEqual(state.grouping, 'status', 'the sidebar groups by status by default');
		assert.strictEqual(state.chatOrder, 'updated');
		assert.strictEqual(state.groupOrder, 'manual');
		assert.deepStrictEqual([...state.show], ['status', 'updated', 'environment', 'pr', 'branch', 'model']);
		assert.deepStrictEqual([...state.status].sort(), ['done', 'draft', 'needsAttention', 'working'].sort());
		assert.ok(state.pr.has('none'));
		assert.ok(state.environment.has('cloud') && state.environment.has('local'));
		assert.strictEqual(state.archived, 'hide');
		assert.strictEqual(groupingLabel(state.grouping), 'Status');
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

	test('a stored view from before the status line gets it switched on once', () => {
		const old = reviveAgentHomeViewState({ ...serializeAgentHomeViewState(defaultAgentHomeViewState()), show: ['updated'], showRevision: undefined });
		assert.deepStrictEqual([...old.show], ['updated', 'status', 'branch', 'model']);
		const off = reviveAgentHomeViewState(serializeAgentHomeViewState({ ...defaultAgentHomeViewState(), show: new Set(['updated' as const]) }));
		assert.deepStrictEqual([...off.show], ['updated'], 'turning it off sticks');
	});

	test('a stored view from before the second line gets branch and model once, and keeps its grouping', () => {
		const stored = reviveAgentHomeViewState({ ...serializeAgentHomeViewState(defaultAgentHomeViewState()), grouping: 'workspace', show: ['status', 'updated', 'pr'], showRevision: 2 });
		assert.deepStrictEqual([...stored.show], ['status', 'updated', 'pr', 'branch', 'model']);
		assert.strictEqual(stored.grouping, 'workspace', 'a grouping the user picked is not reset');
		const off = reviveAgentHomeViewState(serializeAgentHomeViewState({ ...defaultAgentHomeViewState(), show: new Set(['status' as const]) }));
		assert.deepStrictEqual([...off.show], ['status'], 'turning the second line off sticks');
		assert.ok(reviveAgentHomeViewState({ show: ['model', 'bogus'] }).show.has('model'));
	});

	test('a thread back from snooze sorts by when it woke', () => {
		const older = session({ id: 'old', updatedAt: 100 });
		const woken = session({ id: 'woken', updatedAt: 10, wokeAt: 500 });
		assert.deepStrictEqual(sortSessionsForHome([older, woken], 'updated').map(s => s.id), ['woken', 'old']);
	});
});
