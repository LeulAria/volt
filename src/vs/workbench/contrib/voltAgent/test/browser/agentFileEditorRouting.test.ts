/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { EditorService } from '../../../../services/editor/browser/editorService.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../../../../services/editor/common/editorService.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { RegisteredEditorPriority } from '../../../../services/editor/common/editorResolverService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { createEditorPart, ITestInstantiationService, registerTestEditor, TestEditorPart, TestFileEditorInput, TestServiceAccessor, workbenchInstantiationService, workbenchTeardown } from '../../../../test/browser/workbenchTestServices.js';
import { AgentEditorInput } from '../../browser/editor/agentEditorInput.js';
import { registerAgentFileEditorRouting } from '../../browser/workspace/agentFileEditorRouting.js';

/** An editor with no resource, like a webview page or the extension details. */
class ResourcelessEditorInput extends EditorInput {
	override get typeId(): string { return 'test.agentFileRouting.resourceless'; }
	override get resource(): undefined { return undefined; }
}

suite('Agent file editor routing', () => {
	const store = new DisposableStore();
	const fileType = 'test.agentFileRouting.file';
	let instantiation: ITestInstantiationService;
	let part: TestEditorPart;
	let service: EditorService;
	let chat: AgentEditorInput;
	let chatGroup: IEditorGroup;
	let toolsGroup: IEditorGroup;
	let enabled: boolean;

	setup(async () => {
		store.add(registerTestEditor('test.agentFileRouting.editor', [new SyncDescriptor(TestFileEditorInput), new SyncDescriptor(AgentEditorInput), new SyncDescriptor(ResourcelessEditorInput)]));
		instantiation = workbenchInstantiationService(undefined, store);
		part = await createEditorPart(instantiation, store);
		instantiation.stub(IEditorGroupsService, part);
		service = store.add(instantiation.createInstance(EditorService, undefined));
		instantiation.stub(IEditorService, service);
		const accessor = instantiation.createInstance(TestServiceAccessor);
		store.add(accessor.editorResolverService.registerEditor('*', { id: fileType, label: 'File', priority: RegisteredEditorPriority.default }, {}, {
			createEditorInput: input => ({ editor: store.add(new TestFileEditorInput(input.resource, fileType)) }),
		}));
		chat = store.add(new AgentEditorInput(AgentEditorInput.uriForSession('chat'),
			{ get: () => undefined, onDidChange: Event.None } as unknown as IAgentHistoryService,
			{} as IAgentRuntimeService,
			{ createInstance: () => ({ dispose() { } }) } as unknown as IInstantiationService));
		chatGroup = part.activeGroup;
		toolsGroup = part.addGroup(chatGroup.id, GroupDirection.RIGHT);
		store.add(part.enforcePartOptions({ showTabs: 'multiple', enablePreview: false }));
		await chatGroup.openEditor(chat, { pinned: true });
		part.activateGroup(chatGroup.id);
		enabled = true;
		store.add(registerAgentFileEditorRouting(part, {
			getSessionId: () => enabled ? chat.sessionId : undefined,
			openToolsGroup: () => toolsGroup,
		}));
	});

	teardown(async () => {
		await workbenchTeardown(instantiation);
		store.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('file opens keep the chat visible and retain separate tabs, reusing an existing file', async () => {
		const first = { resource: URI.file('/workspace/first.ts') };
		const second = { resource: URI.file('/workspace/second.ts') };
		assert.strictEqual((await service.openEditor(first))?.group, toolsGroup);
		part.activateGroup(chatGroup.id);
		assert.strictEqual((await service.openEditor(second, ACTIVE_GROUP))?.group, toolsGroup);
		part.activateGroup(chatGroup.id);
		assert.strictEqual((await service.openEditor(first))?.group, toolsGroup);
		assert.strictEqual(chatGroup.activeEditor, chat);
		assert.strictEqual(chatGroup.count, 1);
		assert.strictEqual(toolsGroup.count, 2);
		assert.ok(toolsGroup.editors.every(editor => toolsGroup.isPinned(editor)));
	});

	test('typed files and Open to the Side use the tools without making another main group', async () => {
		const input = store.add(new TestFileEditorInput(URI.file('/workspace/typed.ts'), fileType));
		assert.strictEqual((await service.openEditor(input, { preserveFocus: true }, SIDE_GROUP))?.group, toolsGroup);
		assert.strictEqual(chatGroup.activeEditor, chat);
		assert.strictEqual(part.count, 2);
	});

	test('batch opens targeting the chat by id all go to its tools', async () => {
		await service.openEditors([
			{ resource: URI.file('/workspace/a.ts') },
			{ resource: URI.parse('vscode-remote://ssh-remote+host/workspace/b.ts') },
		], chatGroup.id);
		assert.strictEqual(chatGroup.activeEditor, chat);
		assert.strictEqual(toolsGroup.count, 2);
	});

	test('IDE mode keeps the requested main group', async () => {
		enabled = false;
		assert.strictEqual((await service.openEditor({ resource: URI.file('/workspace/ide.ts') }))?.group, chatGroup);
		assert.strictEqual(toolsGroup.count, 0);
	});

	test('explicit tools destinations and the window\'s own pages keep their destination', async () => {
		const otherGroup = part.addGroup(toolsGroup.id, GroupDirection.DOWN);
		assert.strictEqual((await service.openEditor({ resource: URI.file('/workspace/explicit.ts') }, otherGroup))?.group, otherGroup);
		for (const uri of ['volt-settings:/settings', 'volt-customize:customize', 'volt-usage:usage', 'volt-schedules:schedules', 'volt-run-group:/group', 'volt-agent:/other-chat']) {
			part.activateGroup(chatGroup.id);
			const page = store.add(new TestFileEditorInput(URI.parse(uri), fileType));
			assert.strictEqual((await service.openEditor(page))?.group, chatGroup, uri);
			await chatGroup.openEditor(chat);
		}
		assert.strictEqual(toolsGroup.count, 0);
	});

	test('non-file editors like a turn\'s changes or a resourceless page open in the tools too', async () => {
		const changes = store.add(new TestFileEditorInput(URI.parse('volt-agent-changes:/chat?scope=turn:1'), fileType));
		assert.strictEqual((await service.openEditor(changes, { pinned: true }))?.group, toolsGroup);
		part.activateGroup(chatGroup.id);
		const page = store.add(new ResourcelessEditorInput());
		assert.strictEqual((await service.openEditor(page, { pinned: true }))?.group, toolsGroup);
		assert.strictEqual(chatGroup.activeEditor, chat);
		assert.strictEqual(chatGroup.count, 1);
		assert.strictEqual(toolsGroup.count, 2);
	});
});
