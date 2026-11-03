/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { followWorktreeBranch } from '../../browser/pullRequests/agentWorktreeBranch.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';

suite('Agent worktree branch', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(metas: Partial<IAgentSessionMeta>[]) {
		const remembered: string[] = [];
		const history = {
			list: () => metas as IAgentSessionMeta[],
			open: (id: string) => ({ setMeta: (patch: Partial<IAgentSessionMeta>) => Object.assign(metas.find(meta => meta.id === id)!, patch) }),
		} as unknown as IAgentHistoryService;
		const runtime = {
			rememberWorktree: (id: string, path: string, branch: string) => remembered.push(`${id} ${path} ${branch}`),
		} as unknown as IAgentRuntimeService;
		return { history, runtime, remembered };
	}

	test('chats in a renamed worktree follow its branch; others and detached heads do not', () => {
		const metas: Partial<IAgentSessionMeta>[] = [
			{ id: 'a', worktreePath: '/wt/volt-f717', worktreeBranch: 'volt/f7175242' },
			{ id: 'b', worktreePath: '/wt/other', worktreeBranch: 'volt/0000aaaa' },
			{ id: 'c', worktreeBranch: undefined },
		];
		const { history, runtime, remembered } = setup(metas);

		assert.strictEqual(followWorktreeBranch(history, runtime, '/wt/volt-f717/', 'feat/commit-review'), true);
		assert.deepStrictEqual(metas.map(meta => meta.worktreeBranch), ['feat/commit-review', 'volt/0000aaaa', undefined]);
		assert.deepStrictEqual(remembered, ['a /wt/volt-f717 feat/commit-review']);

		// Same branch again, or a detached HEAD: nothing changes.
		assert.strictEqual(followWorktreeBranch(history, runtime, '/wt/volt-f717', 'feat/commit-review'), false);
		assert.strictEqual(followWorktreeBranch(history, runtime, '/wt/volt-f717', undefined), false);
		assert.strictEqual(remembered.length, 1);
	});
});
