/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { VoltSessionContextService } from '../../../../services/voltRuntime/browser/sessionContextService.js';
import {
	agentComposerCanSend,
	agentComposerNeedsProjectChip,
	attachSessionToProject,
	isCurrentActivation,
	matchSessionProject,
	resolveSessionProject,
} from '../../browser/workspace/agentShell.js';
import { AgentWorkspaceService } from '../../browser/workspace/agentWorkspace.js';

suite('Agent shell project matching', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a saved folder wins, and a chat with no folder is not attached to the visible project', () => {
		assert.deepStrictEqual(matchSessionProject({ workspaceFolder: '/repo', workspaceLabel: 'Repo' }, false), {
			kind: 'folder',
			folder: '/repo',
			label: 'Repo',
		});
		assert.deepStrictEqual(matchSessionProject(undefined, true), { kind: 'active' });
		assert.deepStrictEqual(matchSessionProject({ workspaceLabel: 'Repo' }, true), { kind: 'none' });
		assert.deepStrictEqual(matchSessionProject(undefined, false), { kind: 'none' });
	});

	test('binding a chat to another project does not move it', () => {
		const context = store.add(new VoltSessionContextService(store.add(new InMemoryStorageService())));
		const workspace = store.add(new AgentWorkspaceService(store.add(new InMemoryStorageService())));
		const pinned: string[] = [];
		const history = { pinSessionWorkspace: (id: string) => { pinned.push(id); } } as unknown as IAgentHistoryService;
		const repo = context.registerProject(URI.file('/repo'), 'Repo');
		const other = context.registerProject(URI.file('/other'), 'Other');

		attachSessionToProject(context, workspace, history, 'chat', repo);
		attachSessionToProject(context, workspace, history, 'chat', other);

		assert.strictEqual(context.bindingFor('chat')?.projectId, repo.id);
		assert.strictEqual(workspace.get('chat')?.root, repo.root.toString());
		assert.deepStrictEqual(pinned, ['chat']);
	});

	test('a foreground chat with no history uses the selected project', () => {
		const context = store.add(new VoltSessionContextService(store.add(new InMemoryStorageService())));
		const selected = context.registerProject(URI.file('/repo'), 'Repo');
		context.selectProject(selected.id);
		assert.strictEqual(resolveSessionProject(context, undefined, true)?.id, selected.id);
		assert.strictEqual(resolveSessionProject(context, { workspaceLabel: 'Repo' }, true), undefined);
	});

	test('no-project composer disables send and shows the project chip', () => {
		const context = store.add(new VoltSessionContextService(store.add(new InMemoryStorageService())));
		assert.strictEqual(agentComposerCanSend(context, 'new'), false);
		assert.strictEqual(agentComposerNeedsProjectChip(context, 'new'), true);
		const project = context.registerProject(URI.file('/repo'), 'Repo');
		context.bindSession('bound', project.id);
		assert.strictEqual(agentComposerCanSend(context, 'bound'), true);
		assert.strictEqual(agentComposerNeedsProjectChip(context, 'bound'), false);
		assert.strictEqual(agentComposerCanSend(context, 'saved', { workspaceFolder: '/repo' }), true);
		assert.strictEqual(agentComposerNeedsProjectChip(context, 'saved', { workspaceFolder: '/repo' }), false);
	});

	test('New Chat uses the last project when one is selected, otherwise none', () => {
		const context = store.add(new VoltSessionContextService(store.add(new InMemoryStorageService())));
		assert.strictEqual(context.activeProject, undefined, 'no last project');
		const project = context.registerProject(URI.file('/repo'), 'Repo');
		context.selectProject(project.id);
		assert.strictEqual(context.activeProject?.id, project.id);
		assert.strictEqual(resolveSessionProject(context, undefined, true)?.id, project.id);
		context.selectProject(undefined);
		assert.strictEqual(resolveSessionProject(context, undefined, true), undefined);
	});

	test('a late hydration is ignored once a newer selection exists', () => {
		assert.strictEqual(isCurrentActivation(2, 2), true);
		assert.strictEqual(isCurrentActivation(1, 2), false);
	});
});
