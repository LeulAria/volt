/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { RunModeTracker } from '../../common/hostSessionResolver.js';
import { IAgentRuntimeService } from '../../common/runtime.js';

suite('RunModeTracker', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function tracker(sessions: Record<string, { worktreePath?: string; folder?: string }>) {
		const emitter = store.add(new Emitter<{ sessionId: string; event: { type: string; mode?: string } }>());
		const runtime = {
			onDidEmit: emitter.event,
			getOrCreateSession: (id: string) => ({ id, worktreePath: sessions[id]?.worktreePath }),
			workingFolder: (id: string) => sessions[id]?.worktreePath ?? sessions[id]?.folder,
		} as unknown as IAgentRuntimeService;
		const result = store.add(new RunModeTracker(runtime));
		return { result, start: (sessionId: string) => emitter.fire({ sessionId, event: { type: 'run.start', mode: 'agent' } }) };
	}

	test('a chat on its project folder gets that folder (the agent server has no workspace to fall back on)', () => {
		const { result, start } = tracker({ a: { folder: '/repo' } });
		start('a');
		assert.strictEqual(result.cwd('a'), '/repo');
		assert.strictEqual(result.mode('a'), 'agent');
	});

	test('a chat in a worktree gets the worktree', () => {
		const { result, start } = tracker({ b: { worktreePath: '/wt/b', folder: '/repo' } });
		start('b');
		assert.strictEqual(result.cwd('b'), '/wt/b');
	});

	test('a session that never ran here has no folder', () => {
		const { result } = tracker({ c: { folder: '/repo' } });
		assert.strictEqual(result.cwd('c'), undefined);
	});
});
