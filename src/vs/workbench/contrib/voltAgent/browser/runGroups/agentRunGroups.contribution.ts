/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IAgentRunGroupService } from '../../../../services/voltRuntime/common/runGroups/runGroups.js';
import { IMultiDiffSourceResolverService } from '../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { ARCHIVE_RUN_GROUP_COMMAND_ID, OPEN_RUN_GROUP_COMMAND_ID, STOP_RUN_GROUP_COMMAND_ID } from './agentRunGroupCommands.js';
import { RUN_BLOB_SCHEME, RunBlobContentProvider, RunDiffSourceResolver } from './agentRunGroupDiff.js';
import { AGENT_RUN_GROUP_EDITOR_ID, AgentRunGroupEditor, AgentRunGroupEditorInput, AgentRunGroupEditorInputSerializer } from './agentRunGroupEditor.js';
import { AgentRunGroupService } from './agentRunGroupService.js';

registerSingleton(IAgentRunGroupService, AgentRunGroupService, InstantiationType.Delayed);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AgentRunGroupEditor, AGENT_RUN_GROUP_EDITOR_ID, localize('voltRun.editorLabel', "Compare Models")),
	[new SyncDescriptor(AgentRunGroupEditorInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AgentRunGroupEditorInput.TypeID, AgentRunGroupEditorInputSerializer);

/** Run diffs and their blobs resolve before editors restore, so a restored diff tab is not empty. */
class AgentRunGroupResolversContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentRunGroupResolvers';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IMultiDiffSourceResolverService multiDiffSourceResolverService: IMultiDiffSourceResolverService,
		@ITextModelService textModelService: ITextModelService,
	) {
		super();
		this._register(multiDiffSourceResolverService.registerResolver(instantiationService.createInstance(RunDiffSourceResolver)));
		this._register(textModelService.registerTextModelContentProvider(RUN_BLOB_SCHEME, instantiationService.createInstance(RunBlobContentProvider)));
	}
}

registerWorkbenchContribution2(AgentRunGroupResolversContribution.ID, AgentRunGroupResolversContribution, WorkbenchPhase.BlockRestore);

/** Restores groups (and the orchestration of their runs) once the window is up. */
class AgentRunGroupStartupContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentRunGroups';

	constructor(@IAgentRunGroupService runGroups: IAgentRunGroupService) {
		super();
		void runGroups.whenReady;
	}
}

registerWorkbenchContribution2(AgentRunGroupStartupContribution.ID, AgentRunGroupStartupContribution, WorkbenchPhase.AfterRestored);

export function openRunGroup(accessor: ServicesAccessor, groupId: string): Promise<unknown> {
	const editorService = accessor.get(IEditorService);
	const instantiationService = accessor.get(IInstantiationService);
	const existing = editorService.editors.find(editor => editor instanceof AgentRunGroupEditorInput && editor.runGroupId === groupId);
	return editorService.openEditor(existing ?? instantiationService.createInstance(AgentRunGroupEditorInput, groupId), { pinned: true, revealIfOpened: true });
}

async function pickGroup(accessor: ServicesAccessor, groupId: unknown): Promise<string | undefined> {
	if (typeof groupId === 'string') {
		return groupId;
	}
	const runGroups = accessor.get(IAgentRunGroupService);
	const quickInput = accessor.get(IQuickInputService);
	await runGroups.whenReady;
	const picked = await quickInput.pick(runGroups.list().filter(group => !group.archived).map(group => ({
		id: group.id,
		label: group.title,
		description: group.runs.map(run => run.model.label).join(', '),
	})), { placeHolder: localize('voltRun.pickGroup', "Pick a model comparison") });
	return picked?.id;
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: OPEN_RUN_GROUP_COMMAND_ID, title: localize2('voltRun.open', "Open Model Comparison"), category: localize2('volt', "Volt"), f1: true });
	}
	override async run(accessor: ServicesAccessor, groupId?: unknown): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		const id = await pickGroup(accessor, groupId);
		if (id) {
			await instantiationService.invokeFunction(openRunGroup, id);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: STOP_RUN_GROUP_COMMAND_ID, title: localize2('voltRun.stop', "Stop Every Run in a Model Comparison"), category: localize2('volt', "Volt"), f1: true });
	}
	override async run(accessor: ServicesAccessor, groupId?: unknown): Promise<void> {
		const runGroups = accessor.get(IAgentRunGroupService);
		const id = await pickGroup(accessor, groupId);
		if (id) {
			await runGroups.stop(id);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: ARCHIVE_RUN_GROUP_COMMAND_ID, title: localize2('voltRun.archiveCommand', "Archive Model Comparison"), category: localize2('volt', "Volt"), f1: false });
	}
	override async run(accessor: ServicesAccessor, groupId?: unknown): Promise<void> {
		const runGroups = accessor.get(IAgentRunGroupService);
		if (typeof groupId === 'string') {
			await runGroups.archive(groupId);
		}
	}
});
