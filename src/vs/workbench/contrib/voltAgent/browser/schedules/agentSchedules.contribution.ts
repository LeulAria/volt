/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IVoltRelayService } from '../../../../../platform/voltRelay/common/voltRelay.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { describeSchedule, IAgentScheduleService, scheduleModelChoices } from '../../../../services/voltRuntime/common/schedules/agentSchedules.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { NEW_AGENT_SCHEDULE_COMMAND_ID, OPEN_AGENT_SCHEDULES_COMMAND_ID } from './agentScheduleCommands.js';
import { showAgentScheduleDialog } from './agentScheduleDialog.js';
import { AgentScheduleService } from './agentScheduleService.js';
import { connectVoltRelay } from './agentWebhookRelay.js';
import { AGENT_SCHEDULES_EDITOR_ID, AgentSchedulesEditor, AgentSchedulesEditorInput, AgentSchedulesEditorInputSerializer } from './agentSchedulesEditor.js';
import { formatScheduleWhen } from './agentScheduleFormat.js';

registerSingleton(IAgentScheduleService, AgentScheduleService, InstantiationType.Delayed);

/** Starts the schedule clock once the window is up; runs need the orchestrator and history. */
class AgentSchedulesContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltAgentSchedules';
	constructor(@IAgentScheduleService schedules: IAgentScheduleService) {
		void schedules.whenReady;
	}
}
registerWorkbenchContribution2(AgentSchedulesContribution.ID, AgentSchedulesContribution, WorkbenchPhase.AfterRestored);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AgentSchedulesEditor, AGENT_SCHEDULES_EDITOR_ID, localize('voltSchedules.editorLabel', "Scheduled Tasks")),
	[new SyncDescriptor(AgentSchedulesEditorInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	AgentSchedulesEditorInput.TypeID,
	AgentSchedulesEditorInputSerializer
);

registerAction2(class OpenAgentSchedulesAction extends Action2 {
	constructor() {
		super({
			id: OPEN_AGENT_SCHEDULES_COMMAND_ID,
			title: localize2('voltSchedules.open', "Show Scheduled Agent Tasks"),
			category: localize2('voltAgent.category', "Agent"),
			icon: Codicon.history,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, taskId?: string): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const existing = editorService.editors.find(editor => editor instanceof AgentSchedulesEditorInput);
		const input = existing instanceof AgentSchedulesEditorInput ? existing : accessor.get(IInstantiationService).createInstance(AgentSchedulesEditorInput);
		input.focusTask = typeof taskId === 'string' ? taskId : undefined;
		await editorService.openEditor(input, { pinned: true });
	}
});

interface INewScheduleArgs {
	/** The chat it was opened from: its runs go there by default. */
	readonly threadId?: string;
	/** Prefill (the composer's text). */
	readonly prompt?: string;
	readonly mode?: string;
	readonly modelRef?: string;
}

registerAction2(class NewAgentScheduleAction extends Action2 {
	constructor() {
		super({
			id: NEW_AGENT_SCHEDULE_COMMAND_ID,
			title: localize2('voltSchedules.newCommand', "Schedule a Prompt…"),
			category: localize2('voltAgent.category', "Agent"),
			icon: Codicon.history,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, args?: INewScheduleArgs): Promise<void> {
		const schedules = accessor.get(IAgentScheduleService);
		const history = accessor.get(IAgentHistoryService);
		const sessionContext = accessor.get(IVoltSessionContextService);
		const layoutService = accessor.get(ILayoutService);
		const notificationService = accessor.get(INotificationService);
		const relay = accessor.get(IVoltRelayService);
		const quickInput = accessor.get(IQuickInputService);
		const runtime = accessor.get(IAgentRuntimeService);
		const threadId = typeof args?.threadId === 'string' ? args.threadId : undefined;
		const binding = threadId ? sessionContext.bindingFor(threadId) : undefined;
		const project = (binding ? sessionContext.getProject(binding.projectId) : undefined) ?? sessionContext.activeProject;
		showAgentScheduleDialog(layoutService.activeContainer, {
			...(threadId ? { threadId, threadTitle: history.get(threadId)?.title || undefined } : {}),
			...(project ? { projectLabel: project.displayName, projectRoot: project.root.toString() } : {}),
			...(args?.prompt ? { prompt: args.prompt } : {}),
			...(args?.mode ? { mode: args.mode } : {}),
			...(args?.modelRef ? { modelRef: args.modelRef } : {}),
			models: scheduleModelChoices(runtime.listCatalog()),
			relay,
			connectRelay: () => connectVoltRelay(relay, quickInput, notificationService),
			onSave: async input => {
				const task = await schedules.create(input);
				notificationService.info(task.nextRunAt !== undefined
					? localize('voltSchedules.created', "Scheduled \"{0}\": {1}, next run {2}.", task.title, describeSchedule(task.schedule).toLowerCase(), formatScheduleWhen(task.nextRunAt, Date.now()))
					: localize('voltSchedules.createdNoRun', "Scheduled \"{0}\".", task.title));
			},
		});
	}
});
