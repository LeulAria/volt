/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { projectIdForRoot } from '../../common/sessionContext.js';
import { VoltSessionContextService } from '../../browser/sessionContextService.js';

suite('Agent session context', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the same folder is one project, and each chat keeps its own root', () => {
		const service = store.add(new VoltSessionContextService(store.add(new InMemoryStorageService())));
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
		const first = store.add(new VoltSessionContextService(storage));
		const project = first.registerProject(URI.file('/repo'), 'Repo');
		first.selectProject(project.id);
		first.bindSession('chat', project.id);

		const second = store.add(new VoltSessionContextService(storage));
		assert.strictEqual(second.activeProject?.id, project.id);
		assert.strictEqual(second.rootFor('chat')?.fsPath, project.root.fsPath);
	});
});
