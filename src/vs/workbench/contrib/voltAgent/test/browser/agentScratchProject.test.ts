/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IVoltExecRequest, IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { Workspace } from '../../../../../platform/workspace/common/workspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { VoltSessionContextService } from '../../../../services/voltRuntime/browser/sessionContextService.js';
import { IAgentHistoryService, IAgentSessionWorkspace } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { AGENT_SCRATCH_WORKSPACE_ID } from '../../browser/home/agentHomeWorkspace.js';
import { AgentScratchFolders } from '../../browser/workspace/agentScratchProject.js';
import { AgentWorkspaceService } from '../../browser/workspace/agentWorkspace.js';

suite('Agent scratch folders', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(home: string, insideCheckout: boolean) {
		const disposables = store.add(new DisposableStore());
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		const execs: IVoltExecRequest[] = [];
		const stdio = {
			exec: async (request: IVoltExecRequest) => {
				execs.push(request);
				return { id: request.id, exitCode: insideCheckout ? 0 : 128, stdout: insideCheckout ? 'true' : '', stderr: insideCheckout ? '' : 'fatal: not a git repository', timedOut: false };
			},
		} as unknown as IVoltStdioService;
		const errors: string[] = [];
		const notifications = { error: (message: string) => { errors.push(message); } } as unknown as INotificationService;
		const pins = new Map<string, IAgentSessionWorkspace>();
		const history = { pinSessionWorkspace: (id: string, workspace: IAgentSessionWorkspace) => { pins.set(id, workspace); } } as unknown as IAgentHistoryService;
		const sessionContext = disposables.add(new VoltSessionContextService(disposables.add(new InMemoryStorageService()), new TestContextService(new Workspace('empty', [], false, null, () => false))));
		const workspace = disposables.add(new AgentWorkspaceService(disposables.add(new InMemoryStorageService())));
		const pathService = { userHome: () => URI.file(home) } as unknown as IPathService;
		const folders = new AgentScratchFolders(fileService, pathService, stdio, notifications, sessionContext, history, workspace);
		return { folders, fileService, sessionContext, workspace, pins, errors, execs };
	}

	test('the first send makes a dated folder under ~/.volt/scratch and binds the chat to it', async () => {
		const { folders, fileService, sessionContext, workspace, pins, errors } = await setup('/home/a', false);
		const project = await folders.bind('chat', 'Convert these PNGs to WebP please');
		assert.ok(project?.scratch);
		const name = project.root.path.split('/').at(-1)!;
		assert.match(name, /^\d{4}-\d{2}-\d{2}-convert-these-pngs-to-webp-[0-9a-f]{8}$/);
		assert.strictEqual(project.root.path, joinPath(URI.file('/home/a/.volt/scratch'), name).path);
		assert.ok(await fileService.exists(project.root), 'the folder exists');
		assert.strictEqual(sessionContext.rootFor('chat')?.toString(), project.root.toString());
		assert.strictEqual(workspace.get('chat')?.root, project.root.toString());
		assert.deepStrictEqual(pins.get('chat'), { id: AGENT_SCRATCH_WORKSPACE_ID, label: 'No Project', folders: [project.root.fsPath] });
		assert.deepStrictEqual(sessionContext.projects, [], 'not listed as a project');
		assert.deepStrictEqual(errors, []);

		const again = await folders.bind('chat', 'something else');
		assert.strictEqual(again?.id, project.id, 'a bound chat keeps its folder');
		const other = await folders.bind('other', 'Convert these PNGs to WebP please');
		assert.ok(other && other.id !== project.id, 'every chat gets its own folder');
	});

	test('no scratch folder inside a git checkout: the prompt stays and the reason is shown', async () => {
		const { folders, sessionContext, errors, execs } = await setup('/home/dotfiles', true);
		assert.strictEqual(await folders.bind('chat', 'hello'), undefined);
		assert.strictEqual(sessionContext.bindingFor('chat'), undefined);
		assert.strictEqual(errors.length, 1);
		assert.ok(execs[0].command.includes('rev-parse'));
	});
});
