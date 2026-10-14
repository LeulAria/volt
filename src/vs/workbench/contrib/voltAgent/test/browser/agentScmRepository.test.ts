/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { extUriIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IVoltGitRepo, IVoltGitService } from '../../../../../platform/voltGit/common/voltGit.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../../scm/common/scm.js';
import { AgentScmRepositoryFocus, AgentScmRepositoryState } from '../../browser/review/agentScmRepository.js';

suite('Agent repository switching', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	function setup() {
		const added = disposables.add(new Emitter<ISCMRepository>());
		const removed = disposables.add(new Emitter<ISCMRepository>());
		const visibleChanged = disposables.add(new Emitter<void>());
		const extensionsChanged = disposables.add(new Emitter<ExtensionIdentifier[]>());
		/** What Volt's own git says about a folder: a repository, none (undefined), or an error when git cannot run. */
		const git = new Map<string, IVoltGitRepo | Error>();
		const extension = { gitRunning: true };
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
			{ repositories, onDidAddRepository: added.event, onDidRemoveRepository: removed.event, getRepository: () => undefined } as unknown as ISCMService,
			view,
			{ extUri: extUriIgnorePathCase } as unknown as IUriIdentityService,
			{
				resolveRepo: async (folder: string) => {
					const found = git.get(folder);
					if (found instanceof Error) {
						throw found;
					}
					return found;
				}
			} as unknown as IVoltGitService,
			{
				onDidChangeExtensionsStatus: extensionsChanged.event,
				getExtensionsStatus: () => extension.gitRunning ? { 'vscode.git': { activationTimes: {} } } : {},
			} as unknown as IExtensionService,
			{ getValue: () => undefined } as unknown as IConfigurationService,
			{} as IFileService,
			{} as IProductService,
		));
		const add = (path: string) => {
			const repo = { provider: { rootUri: URI.file(path) } } as ISCMRepository;
			repositories.push(repo);
			added.fire(repo);
			return repo;
		};
		const startGit = () => {
			extension.gitRunning = true;
			extensionsChanged.fire([new ExtensionIdentifier('vscode.git')]);
		};
		return { focus, opened, pending, view, add, git, extension, startGit };
	}

	test('returning to a loaded project selects its live repository synchronously without reopening it', async () => {
		const { focus, opened, view, add } = setup();
		const a = add('/projects/a');
		const b = add('/projects/b');
		for (const [session, repository] of [['a', a], ['b', b], ['a', a]] as const) {
			const states: AgentScmRepositoryState['kind'][] = [];
			const result = focus.show(session, () => true, undefined, state => states.push(state.kind));
			assert.deepStrictEqual(view.visibleRepositories, [repository]);
			assert.ok(states.includes('ready'));
			assert.ok(!states.includes('loading'));
			await result;
		}
		assert.deepStrictEqual(opened, []);
	});

	test('late discovery cannot replace the newly selected project', async () => {
		const { focus, pending, view, add } = setup();
		const states: AgentScmRepositoryState['kind'][] = [];
		const old = focus.show('a', () => true, undefined, state => states.push(state.kind));
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

	test('uses the chat worktree and waits for discovery before reporting it is not a repository', async () => {
		const { focus, pending, opened } = setup();
		const states: AgentScmRepositoryState['kind'][] = [];
		const result = focus.show('project', () => true, URI.file('/worktrees/chat'), state => states.push(state.kind));
		assert.deepStrictEqual(opened, ['/worktrees/chat']);
		assert.deepStrictEqual(states, ['loading']);
		await pending.get('/worktrees/chat')!.complete();
		await result;
		assert.deepStrictEqual(states, ['loading', 'notRepository']);
	});

	test('hiding the panel invalidates an outstanding request', async () => {
		const { focus, pending } = setup();
		const states: AgentScmRepositoryState['kind'][] = [];
		const result = focus.show('a', () => true, undefined, state => states.push(state.kind));
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

	test('says git could not run, with its error, instead of offering to initialize', async () => {
		const { focus, pending, git } = setup();
		git.set('/projects/a', new Error('xcrun: error: You have not agreed to the Xcode license agreements.'));
		const states: AgentScmRepositoryState[] = [];
		const result = focus.show('a', () => true, undefined, state => states.push(state));
		await pending.get('/projects/a')!.complete();
		await result;
		assert.deepStrictEqual(states.map(state => state.kind), ['loading', 'gitFailed']);
		const failed = states[1];
		assert.ok(failed.kind === 'gitFailed' && failed.detail.includes('Xcode license'));
	});

	test('a repository the running Git extension did not open is reported as not opened', async () => {
		const { focus, pending, git } = setup();
		git.set('/projects/a', { repoRoot: '/projects/a', gitDir: '/projects/a/.git', commonDir: '/projects/a/.git' });
		const states: AgentScmRepositoryState[] = [];
		const result = focus.show('a', () => true, undefined, state => states.push(state));
		await pending.get('/projects/a')!.complete();
		await result;
		assert.deepStrictEqual(states, [{ kind: 'loading' }, { kind: 'notOpened', repoRoot: '/projects/a' }]);
	});

	test('a repository with the Git extension stopped waits for it, then reports it stopped', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { focus, pending, git, extension } = setup();
		git.set('/projects/a', { repoRoot: '/projects/a', gitDir: '/projects/a/.git', commonDir: '/projects/a/.git' });
		extension.gitRunning = false;
		const states: AgentScmRepositoryState[] = [];
		const result = focus.show('a', () => true, undefined, state => states.push(state));
		await pending.get('/projects/a')!.complete();
		await result;
		// Not the window's build mismatch: the product has no commit, so a restart is the fix.
		assert.deepStrictEqual(states, [{ kind: 'loading' }, { kind: 'extensionStopped', repoRoot: '/projects/a', outdated: false }]);
	}));

	test('Git starting again opens the chat repository and shows it', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { focus, pending, opened, git, extension, startGit, add, view } = setup();
		git.set('/projects/a', { repoRoot: '/projects/a', gitDir: '/projects/a/.git', commonDir: '/projects/a/.git' });
		extension.gitRunning = false;
		const states: AgentScmRepositoryState['kind'][] = [];
		const result = focus.show('a', () => true, undefined, state => states.push(state.kind));
		await pending.get('/projects/a')!.complete();
		await result;
		assert.deepStrictEqual(states, ['loading', 'extensionStopped']);
		startGit();
		assert.deepStrictEqual(opened, ['/projects/a', '/projects/a']);
		const a = add('/projects/a');
		await pending.get('/projects/a')!.complete();
		assert.deepStrictEqual(view.visibleRepositories, [a]);
		assert.deepStrictEqual(states, ['loading', 'extensionStopped', 'loading', 'ready']);
	}));
});
