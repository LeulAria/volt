/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyWindowScopeClaim, EMPTY_WINDOW_SCOPE, IVoltWindowScopes, IVoltWindowScopeState } from '../../../../../platform/voltWindowScope/common/voltWindowScope.js';
import { VoltWindowScopeService } from '../../common/voltWindowScopeService.js';
import { TestWindowScopesHost } from './testWindowScopesHost.js';

suite('Volt window scopes', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a claim adds to its scope only, and a main window claim gives created projects back', () => {
		const scopes: IVoltWindowScopes = { a: EMPTY_WINDOW_SCOPE, b: EMPTY_WINDOW_SCOPE };
		const claimed = applyWindowScopeClaim(scopes, 'a', { sessions: ['chat'], createdProjects: ['new'], projects: ['old'] });
		assert.deepStrictEqual(claimed.a, { sessions: ['chat'], projects: ['old', 'new'], createdProjects: ['new'] });
		assert.strictEqual(claimed.b, EMPTY_WINDOW_SCOPE);
		assert.strictEqual(applyWindowScopeClaim(claimed, 'a', { sessions: ['chat'] }), claimed, 'nothing new, same object');
		assert.strictEqual(applyWindowScopeClaim(claimed, 'gone', { sessions: ['x'] }), claimed, 'a closed scope takes nothing');

		const released = applyWindowScopeClaim(claimed, undefined, { projects: ['new'] });
		assert.deepStrictEqual(released.a.createdProjects, []);
		assert.deepStrictEqual(released.a.projects, ['old', 'new'], 'the window still lists it');
	});

	test('a New Window lists only its own; the main window leaves those out until it closes', async () => {
		const host = store.add(new TestWindowScopesHost());
		host.open('new-window');
		const main = store.add(new VoltWindowScopeService(undefined, host.scopes, host));
		const scoped = store.add(new VoltWindowScopeService('new-window', host.scopes, host));
		const ended: IVoltWindowScopeState[][] = [];
		store.add(main.onDidEndScopes(states => ended.push([...states])));

		assert.strictEqual(scoped.showsSession('old-chat'), false, 'starts empty');
		assert.strictEqual(scoped.showsProject('old-project'), false);
		assert.strictEqual(main.showsSession('old-chat'), true);

		scoped.claimSession('new-chat');
		scoped.claimProject('new-project', true);
		scoped.claimProject('old-project', false);
		await Promise.resolve();

		assert.strictEqual(scoped.showsSession('new-chat'), true);
		assert.strictEqual(scoped.showsProject('new-project'), true);
		assert.strictEqual(scoped.showsProject('old-project'), true);
		assert.strictEqual(main.showsSession('new-chat'), false);
		assert.strictEqual(main.showsProject('new-project'), false, 'created there: held back');
		assert.strictEqual(main.showsProject('old-project'), true, 'only picked there: still listed here');

		host.close('new-window');
		assert.strictEqual(main.showsSession('new-chat'), true);
		assert.strictEqual(main.showsProject('new-project'), true);
		assert.deepStrictEqual(ended.map(states => states.map(state => state.sessions)), [[['new-chat']]]);
	});

	test('the main window adding a project a New Window created lists it again', async () => {
		const host = store.add(new TestWindowScopesHost());
		host.open('new-window');
		const main = store.add(new VoltWindowScopeService(undefined, host.scopes, host));
		const scoped = store.add(new VoltWindowScopeService('new-window', host.scopes, host));
		scoped.claimProject('repo', true);
		await Promise.resolve();
		assert.strictEqual(main.showsProject('repo'), false);

		main.claimProject('repo', false);
		assert.strictEqual(main.showsProject('repo'), true);
		await Promise.resolve();
		assert.strictEqual(scoped.showsProject('repo'), true, 'the New Window keeps it too');
		assert.deepStrictEqual(host.scopes['new-window'].createdProjects, []);
	});

	test('a window loaded with the scopes as they were catches up', async () => {
		const host = store.add(new TestWindowScopesHost());
		host.open('new-window');
		const stale = host.scopes;
		await host.claim('new-window', { sessions: ['chat'] });
		const main = store.add(new VoltWindowScopeService(undefined, stale, host));
		assert.strictEqual(main.showsSession('chat'), true, 'not known yet');
		await Promise.resolve();
		await Promise.resolve();
		assert.strictEqual(main.showsSession('chat'), false);
	});

	test('a chat moved to another window leaves the one it was in', async () => {
		const host = store.add(new TestWindowScopesHost());
		host.open('first');
		host.open('second');
		const first = store.add(new VoltWindowScopeService('first', host.scopes, host));
		const second = store.add(new VoltWindowScopeService('second', host.scopes, host));
		first.claimSession('chat');
		await Promise.resolve();
		assert.strictEqual(first.showsSession('chat'), true);
		assert.strictEqual(second.heldElsewhere('chat'), true);

		// Open in New Window from the first New Window: the chat moves, the rest stays.
		await host.claim('second', { sessions: ['chat'] });
		assert.strictEqual(first.showsSession('chat'), false);
		assert.strictEqual(first.heldElsewhere('chat'), true, 'the first window closes its tab');
		assert.strictEqual(second.showsSession('chat'), true);
		assert.strictEqual(second.heldElsewhere('chat'), false);
		assert.deepStrictEqual(host.scopes.first.sessions, []);
	});

	test('a project moved whole leaves every other window', () => {
		const scopes: IVoltWindowScopes = { a: { sessions: ['x'], projects: ['repo'], createdProjects: ['repo'] }, b: EMPTY_WINDOW_SCOPE };
		const moved = applyWindowScopeClaim(scopes, 'b', { sessions: ['x'], createdProjects: ['repo'] });
		assert.deepStrictEqual(moved.a, { sessions: [], projects: [], createdProjects: [] });
		assert.deepStrictEqual(moved.b, { sessions: ['x'], projects: ['repo'], createdProjects: ['repo'] });
	});

	test('a moved chat comes back to the main window when its window closes', async () => {
		const host = store.add(new TestWindowScopesHost());
		const main = store.add(new VoltWindowScopeService(undefined, host.scopes, host));
		host.open('new-window');
		await host.claim('new-window', { sessions: ['chat'], projects: ['repo'] });
		assert.strictEqual(main.showsSession('chat'), false);
		assert.strictEqual(main.heldElsewhere('chat'), true);
		assert.strictEqual(main.showsSession('other-chat-of-repo'), true, 'only the moved chat leaves');
		assert.strictEqual(main.showsProject('repo'), true);

		host.retain([], true);
		assert.strictEqual(main.showsSession('chat'), true);
		assert.strictEqual(main.heldElsewhere('chat'), false);
	});

	test('with the main window closed, the oldest window left lists what no window holds', async () => {
		const host = store.add(new TestWindowScopesHost());
		host.open('older');
		host.open('newer');
		const older = store.add(new VoltWindowScopeService('older', host.scopes, host));
		const newer = store.add(new VoltWindowScopeService('newer', host.scopes, host));
		const ended: number[] = [];
		store.add(older.onDidEndScopes(states => ended.push(states.length)));
		await host.claim('newer', { sessions: ['moved'] });
		assert.strictEqual(older.showsSession('main-chat'), false);

		// The main window closes.
		host.retain(['older', 'newer'], false);
		assert.strictEqual(older.isMain, true);
		assert.strictEqual(newer.isMain, false);
		assert.strictEqual(older.showsSession('main-chat'), true, 'nothing is left without a window');
		assert.strictEqual(older.showsSession('moved'), false);
		assert.strictEqual(newer.showsSession('main-chat'), false);
		assert.deepStrictEqual(ended, [0], 'takes in what other windows wrote');

		// Then the other window closes: its chat shows in the one that is the main window now.
		host.retain(['older'], false);
		assert.strictEqual(older.showsSession('moved'), true);
		assert.strictEqual(older.isMain, true);
		assert.deepStrictEqual(ended, [0, 1]);
	});

	test('the main window stays the main window when a window without a scope opens', () => {
		const host = store.add(new TestWindowScopesHost());
		host.open('a');
		host.retain(['a'], false);
		host.retain(['a'], true);
		assert.strictEqual(host.scopes.a.main, true);
	});
});
