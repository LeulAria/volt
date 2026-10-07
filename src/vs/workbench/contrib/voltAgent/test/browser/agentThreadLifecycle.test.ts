/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IAgentHistoryService, IAgentSessionLifecycle, IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { AgentLifecycleUndoContext, AgentThreadLifecycleService } from '../../browser/home/agentThreadLifecycle.js';

/** Just enough history: the setters change the stored meta the way the real service does. */
function fakeHistory(metas: IAgentSessionMeta[]): IAgentHistoryService {
	const sessions = new Map(metas.map(meta => [meta.id, meta]));
	const update = (id: string, patch: Partial<IAgentSessionMeta>) => {
		const meta = sessions.get(id);
		if (meta) {
			sessions.set(id, { ...meta, ...patch });
		}
	};
	return {
		get: (id: string) => sessions.get(id),
		setSettled: async (id: string, settled: boolean, options?: { byUser?: boolean }) => update(id, { settled: settled || undefined, pinned: settled ? undefined : sessions.get(id)?.pinned, snoozed: settled ? undefined : sessions.get(id)?.snoozed, ...(options?.byUser && !settled ? { unsettledAt: 1 } : {}) }),
		setSnoozed: async (id: string, snoozed: boolean, until?: number) => update(id, { snoozed: snoozed || undefined, snoozedUntil: snoozed ? until : undefined, settled: snoozed ? undefined : sessions.get(id)?.settled }),
		setArchived: async (id: string, archived: boolean) => update(id, { archived, pinned: archived ? false : sessions.get(id)?.pinned }),
		setPinned: async (id: string, pinned: boolean) => update(id, { pinned }),
		restoreLifecycle: async (id: string, lifecycle: IAgentSessionLifecycle) => update(id, lifecycle),
	} as unknown as IAgentHistoryService;
}

function chat(id: string, extra: Partial<IAgentSessionMeta> = {}): IAgentSessionMeta {
	return { id, title: id, createdAt: 0, updatedAt: 0, workspaceId: 'w', workspaceLabel: 'volt', turnCount: 1, preview: id, status: 'done', ...extra };
}

suite('Agent thread lifecycle undo', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('undo puts settled chats back, pin and snooze included, and ends the offer', async () => {
		const history = fakeHistory([chat('a', { pinned: true }), chat('b', { snoozed: true, snoozedUntil: 50 })]);
		const contextKeys = store.add(new MockContextKeyService());
		const service = store.add(new AgentThreadLifecycleService(history, contextKeys));
		let changes = 0;
		store.add(service.onDidChangeNotice(() => changes++));

		await service.setSettled('a', true);
		await service.setSettled('b', true);
		assert.strictEqual(history.get('a')?.settled, true);
		assert.strictEqual(history.get('a')?.pinned, undefined);
		assert.deepStrictEqual(service.notice?.items.map(item => item.sessionId), ['a', 'b']);
		assert.strictEqual(contextKeys.getContextKeyValue(AgentLifecycleUndoContext.key), true);

		assert.strictEqual(await service.undo(), true);
		assert.strictEqual(history.get('a')?.settled, undefined);
		assert.strictEqual(history.get('a')?.pinned, true);
		assert.strictEqual(history.get('b')?.snoozed, true);
		assert.strictEqual(history.get('b')?.snoozedUntil, 50);
		assert.strictEqual(service.notice, undefined);
		assert.strictEqual(contextKeys.getContextKeyValue(AgentLifecycleUndoContext.key), false);
		assert.strictEqual(await service.undo(), false, 'once only');
		assert.ok(changes >= 3);
	});

	test('an action that changes nothing offers no undo; archive and pin are undoable', async () => {
		const history = fakeHistory([chat('a'), chat('b', { pinned: true })]);
		const service = store.add(new AgentThreadLifecycleService(history, store.add(new MockContextKeyService())));
		// Read through a function: assert narrows a property it saw as undefined.
		const notice = () => service.notice;
		await service.setSettled('a', false);
		assert.strictEqual(service.notice, undefined);

		await service.setArchived('b', true);
		assert.strictEqual(history.get('b')?.pinned, false);
		await service.undo();
		assert.strictEqual(history.get('b')?.archived, undefined);
		assert.strictEqual(history.get('b')?.pinned, true, 'archiving dropped the pin; undo brings it back');

		await service.setPinned('a', true);
		assert.strictEqual(notice()?.action, 'pin');
		service.dismiss();
		assert.strictEqual(notice(), undefined);
	});
});
