/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { Workspace } from '../../../../../platform/workspace/common/workspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { VoltSessionContextService } from '../../../../services/voltRuntime/browser/sessionContextService.js';
import {
	adoptProjectForUnstartedSession,
	agentSessionNeedsScratch,
	attachSessionToProject,
	isCurrentActivation,
	matchSessionProject,
	resolveSessionProject,
} from '../../browser/workspace/agentShell.js';
import { AgentWorkspaceService } from '../../browser/workspace/agentWorkspace.js';

suite('Agent shell project matching', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const emptyWindow = () => new TestContextService(new Workspace('empty', [], false, null, () => false));

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
		const context = store.add(new VoltSessionContextService(store.add(new InMemoryStorageService()), emptyWindow()));
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

	test('an unstarted chat moves to the project its composer shows', () => {
		const context = store.add(new VoltSessionContextService(store.add(new InMemoryStorageService()), emptyWindow()));
		const workspace = store.add(new AgentWorkspaceService(store.add(new InMemoryStorageService())));
		const pinned: string[] = [];
		const history = { pinSessionWorkspace: (id: string, ws: { folders: string[] }) => { pinned.push(`${id}:${ws.folders[0]}`); } } as unknown as IAgentHistoryService;
		const stale = context.registerProject(URI.file('/stale'), 'Stale');
		const visible = context.registerProject(URI.file('/visible'), 'Visible');
		attachSessionToProject(context, workspace, history, 'chat', stale);

		adoptProjectForUnstartedSession(context, workspace, history, 'chat', visible);

		assert.strictEqual(context.rootFor('chat')?.fsPath, visible.root.fsPath);
		assert.strictEqual(workspace.get('chat')?.root, visible.root.toString());
		assert.deepStrictEqual(pinned, [`chat:${stale.root.fsPath}`, `chat:${visible.root.fsPath}`]);
	});

	test('a foreground chat with no history uses the selected project', () => {
		const context = store.add(new VoltSessionContextService(store.add(new InMemoryStorageService()), emptyWindow()));
		const selected = context.registerProject(URI.file('/repo'), 'Repo');
		context.selectProject(selected.id);
		assert.strictEqual(resolveSessionProject(context, undefined, true)?.id, selected.id);
		assert.strictEqual(resolveSessionProject(context, { workspaceLabel: 'Repo' }, true), undefined);
	});

	test('a chat with no project gets a scratch folder on its first send, unless a project is selected', () => {
		const context = store.add(new VoltSessionContextService(store.add(new InMemoryStorageService()), emptyWindow()));
		assert.strictEqual(agentSessionNeedsScratch(context, 'new', undefined, false), true);
		const project = context.registerProject(URI.file('/repo'), 'Repo');
		context.bindSession('bound', project.id);
		assert.strictEqual(agentSessionNeedsScratch(context, 'bound', undefined, true), false);
		assert.strictEqual(agentSessionNeedsScratch(context, 'saved', { workspaceFolder: '/repo' }, true), false);
		context.selectProject(project.id);
		assert.strictEqual(agentSessionNeedsScratch(context, 'new', undefined, false), false, 'an unstarted chat adopts the selected project');
		assert.strictEqual(agentSessionNeedsScratch(context, 'old', undefined, true), true, 'a chat that ran without a project does not');
	});

	test('scratch folders bind like projects but are never listed or selected', () => {
		const storage = store.add(new InMemoryStorageService());
		const context = store.add(new VoltSessionContextService(storage, emptyWindow()));
		const repo = context.registerProject(URI.file('/repo'), 'Repo');
		context.selectProject(repo.id);
		const scratch = context.registerScratchProject(URI.file('/home/.volt/scratch/2026-10-06-hi-abcd1234'), 'No Project');
		context.bindSession('chat', scratch.id);

		assert.strictEqual(context.rootFor('chat')?.fsPath, scratch.root.fsPath);
		assert.deepStrictEqual(context.projects.map(project => project.id), [repo.id]);
		context.selectProject(scratch.id);
		assert.strictEqual(context.activeProject, undefined, 'showing a scratch chat shows no project');
		assert.strictEqual(context.registerProject(scratch.root).scratch, true, 'opening the folder again keeps it scratch');
		// The chat's saved folder resolves to its scratch record, which stays unlisted.
		assert.strictEqual(resolveSessionProject(context, { workspaceFolder: scratch.root.fsPath, workspaceLabel: 'No Project' }, true)?.id, scratch.id);
		assert.strictEqual(context.projects.length, 1);

		const reloaded = store.add(new VoltSessionContextService(storage, emptyWindow()));
		assert.strictEqual(reloaded.getProject(scratch.id)?.scratch, true);
		assert.strictEqual(reloaded.rootFor('chat')?.fsPath, scratch.root.fsPath, 'the binding survives a reload');
		assert.deepStrictEqual(reloaded.projects.map(project => project.id), [repo.id]);
	});

	test('New Chat uses the last project when one is selected, otherwise none', () => {
		const context = store.add(new VoltSessionContextService(store.add(new InMemoryStorageService()), emptyWindow()));
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
