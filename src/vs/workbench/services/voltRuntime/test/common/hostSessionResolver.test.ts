/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { RunModeTracker } from '../../common/hostSessionResolver.js';
import { IAgentRuntimeService } from '../../common/runtime.js';

suite('Volt host tool session resolver', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function tracker(folders: Record<string, string | undefined>) {
		const emitter = store.add(new Emitter<{ sessionId: string; event: { type: string; mode?: string } }>());
		const runtime = {
			onDidEmit: emitter.event,
			workingFolder: (sessionId: string) => folders[sessionId],
		} as unknown as IAgentRuntimeService;
		const resolver = store.add(new RunModeTracker(runtime));
		const start = (sessionId: string) => emitter.fire({ sessionId, event: { type: 'run.start', mode: 'agent' } });
		return { resolver, start };
	}

	test('HOST-CWD-1: a chat without a worktree works in its project folder, not the window\'s', () => {
		const { resolver, start } = tracker({ plain: '/repo/app', worktree: '/worktrees/app-1' });
		start('plain');
		start('worktree');
		assert.strictEqual(resolver.cwd('plain'), '/repo/app', 'the project folder (no worktree)');
		assert.strictEqual(resolver.cwd('worktree'), '/worktrees/app-1', 'the worktree when it has one');
		assert.strictEqual(resolver.mode('plain'), 'agent');
	});

	test('HOST-CWD-2: a chat that never ran here has no folder from the resolver', () => {
		const { resolver } = tracker({ unknown: '/repo/app' });
		assert.strictEqual(resolver.cwd('unknown'), undefined);
	});
});
