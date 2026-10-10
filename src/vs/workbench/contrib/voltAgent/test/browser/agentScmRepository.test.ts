/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { extUriIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../../scm/common/scm.js';
import { AgentScmRepositoryFocus } from '../../browser/review/agentScmRepository.js';

suite('Agent repository switching', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	function setup() {
		const added = disposables.add(new Emitter<ISCMRepository>());
		const visibleChanged = disposables.add(new Emitter<void>());
		const repositories: ISCMRepository[] = [];
		const opened: string[] = [];
		const pending = new Map<string, DeferredPromise<void>>();
		let visible: ISCMRepository[] = [];
		const view = {
			get visibleRepositories() { return visible; },
			set visibleRepositories(value: ISCMRepository[]) { visible = value; visibleChanged.fire(); },
			onDidChangeVisibleRepositories: visibleChanged.event,
			focus: () => { },
		} as unknown as ISCMViewService;
		const focus = disposables.add(new AgentScmRepositoryFocus(
			{
				executeCommand: (_command: string, path: string) => {
					opened.push(path);
					const result = new DeferredPromise<void>();
					pending.set(path, result);
					return result.p;
				}
			} as unknown as ICommandService,
			{ rootFor: (session: string) => URI.file(`/projects/${session}`) } as IVoltSessionContextService,
			{} as IWorkspaceContextService,
			{ repositories, onDidAddRepository: added.event, getRepository: () => undefined } as unknown as ISCMService,
			view,
			{ extUri: extUriIgnorePathCase } as unknown as IUriIdentityService,
		));
		const add = (path: string) => {
			const repo = { provider: { rootUri: URI.file(path) } } as ISCMRepository;
			repositories.push(repo);
			added.fire(repo);
			return repo;
		};
		return { focus, opened, pending, view, add };
	}

	test('returning to a loaded project selects its live repository synchronously without reopening it', async () => {
		const { focus, opened, view, add } = setup();
		const a = add('/projects/a');
		const b = add('/projects/b');
		for (const [session, repository] of [['a', a], ['b', b], ['a', a]] as const) {
			const states: string[] = [];
			const result = focus.show(session, () => true, undefined, state => states.push(state));
			assert.deepStrictEqual(view.visibleRepositories, [repository]);
			assert.ok(states.includes('ready'));
			assert.ok(!states.includes('loading'));
			await result;
		}
		assert.deepStrictEqual(opened, []);
	});

	test('late discovery cannot replace the newly selected project', async () => {
		const { focus, pending, view, add } = setup();
		const states: string[] = [];
		const old = focus.show('a', () => true, undefined, state => states.push(state));
		assert.deepStrictEqual(states, ['loading']);
		assert.deepStrictEqual(view.visibleRepositories, []);
		const b = add('/projects/b');
		await focus.show('b', () => true);
		const a = add('/projects/a');
		view.visibleRepositories = [a, b];
		await pending.get('/projects/a')!.complete();
		await old;
		assert.deepStrictEqual(view.visibleRepositories, [b]);
		assert.deepStrictEqual(states, ['loading']);
	});

	test('uses the chat worktree and waits for discovery before reporting unavailable', async () => {
		const { focus, pending, opened } = setup();
		const states: string[] = [];
		const result = focus.show('project', () => true, URI.file('/worktrees/chat'), state => states.push(state));
		assert.deepStrictEqual(opened, ['/worktrees/chat']);
		assert.deepStrictEqual(states, ['loading']);
		await pending.get('/worktrees/chat')!.complete();
		await result;
		assert.deepStrictEqual(states, ['loading', 'unavailable']);
	});

	test('hiding the panel invalidates an outstanding request', async () => {
		const { focus, pending } = setup();
		const states: string[] = [];
		const result = focus.show('a', () => true, undefined, state => states.push(state));
		focus.clear();
		await pending.get('/projects/a')!.complete();
		await result;
		assert.deepStrictEqual(states, ['loading']);
	});

	test('revisiting a folder while it loads shares its discovery request', async () => {
		const { focus, opened, pending, add, view } = setup();
		const first = focus.show('a', () => true);
		focus.clear();
		const second = focus.show('a', () => true);
		assert.deepStrictEqual(opened, ['/projects/a']);
		const a = add('/projects/a');
		await pending.get('/projects/a')!.complete();
		await Promise.all([first, second]);
		assert.deepStrictEqual(view.visibleRepositories, [a]);
	});
});
