/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { InMemoryStorageService, IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { Workspace } from '../../../../../platform/workspace/common/workspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { projectIdForRoot } from '../../common/sessionContext.js';
import { VoltSessionContextService } from '../../browser/sessionContextService.js';
import { VoltWindowScopeService } from '../../../voltWindowScope/common/voltWindowScopeService.js';
import { TestWindowScopesHost } from '../../../voltWindowScope/test/common/testWindowScopesHost.js';

suite('Agent session context', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const emptyWindow = () => new TestContextService(new Workspace('empty', [], false, null, () => false));
	const create = (storage: IStorageService, workspace = emptyWindow()) => store.add(new VoltSessionContextService(storage, workspace, store.add(new VoltWindowScopeService(undefined, undefined, undefined))));

	test('the same folder is one project, and each chat keeps its own root', () => {
		const service = create(store.add(new InMemoryStorageService()));
		const repo = URI.file('/repo');
		const first = service.registerProject(URI.file('/repo/'), 'Repo');
		const second = service.registerProject(repo, 'Other');
		const other = service.registerProject(URI.file('/other'), 'Other');

		assert.strictEqual(first.id, second.id);
		assert.strictEqual(first.id, projectIdForRoot(repo));
		assert.strictEqual(service.projects.length, 2);
		assert.notStrictEqual(first.id, other.id);

		service.bindSession('chat-a', first.id);
		service.bindSession('chat-b', other.id);
		service.bindSession('chat-a', other.id);

		assert.strictEqual(service.rootFor('chat-a')?.fsPath, first.root.fsPath);
		assert.strictEqual(service.rootFor('chat-b')?.fsPath, other.root.fsPath);
		assert.strictEqual(service.bindingFor('chat-a')?.projectId, first.id);
	});

	test('the selected project is restored with the registry', () => {
		const storage = store.add(new InMemoryStorageService());
		const first = create(storage);
		const project = first.registerProject(URI.file('/repo'), 'Repo');
		first.selectProject(project.id);
		first.bindSession('chat', project.id);

		const second = create(storage);
		assert.strictEqual(second.activeProject?.id, project.id);
		assert.strictEqual(second.rootFor('chat')?.fsPath, project.root.fsPath);
	});

	test('a window opened on a folder starts on that folder, and keeps its own choice', () => {
		const storage = store.add(new InMemoryStorageService());
		const empty = create(storage);
		const other = empty.registerProject(URI.file('/other'), 'Other');
		empty.selectProject(other.id);
		// A second window: same application storage, its own (empty) workspace storage.
		storage.remove('volt.agent.activeProject', StorageScope.WORKSPACE);

		const folderWindow = create(storage, new TestContextService(testWorkspace(URI.file('/pricing'))));
		assert.strictEqual(folderWindow.activeProject?.root.fsPath, URI.file('/pricing').fsPath);

		folderWindow.selectProject(other.id);
		const reloaded = create(storage, new TestContextService(testWorkspace(URI.file('/pricing'))));
		assert.strictEqual(reloaded.activeProject?.id, other.id);
	});

	test('a New Window starts with no projects and keeps the ones it creates until it closes', async () => {
		const storage = store.add(new InMemoryStorageService());
		const host = store.add(new TestWindowScopesHost());
		const inWindow = (scope?: string) => store.add(new VoltSessionContextService(storage, emptyWindow(), store.add(new VoltWindowScopeService(scope, host.scopes, host))));
		const main = inWindow();
		const old = main.registerProject(URI.file('/old'), 'Old');
		main.selectProject(old.id);

		host.open('new-window');
		const scoped = inWindow('new-window');
		assert.strictEqual(scoped.projects.length, 0, 'nothing from the main window');
		assert.strictEqual(scoped.activeProject, undefined, 'not the project used last elsewhere');

		const created = scoped.registerProject(URI.file('/new'), 'New');
		scoped.registerProject(URI.file('/old'), 'Old');
		scoped.selectProject(created.id);
		assert.deepStrictEqual(scoped.projects.map(project => project.displayName).sort(), ['New', 'Old']);
		assert.strictEqual(storage.get('volt.agent.activeProject', StorageScope.APPLICATION), old.id, 'the main window keeps its last project');

		const mainLater = inWindow();
		assert.deepStrictEqual(mainLater.projects.map(project => project.displayName), ['Old'], 'the New Window\'s own project is held back');
		host.close('new-window');
		assert.deepStrictEqual(mainLater.projects.map(project => project.displayName).sort(), ['New', 'Old']);
	});
});
