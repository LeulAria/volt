/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './automationHooks.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IAutomationService } from '../../../../services/voltRuntime/common/automations/automations.js';
import { NEW_AUTOMATION_COMMAND_ID, OPEN_AUTOMATION_RUNS_COMMAND_ID, OPEN_AUTOMATIONS_COMMAND_ID } from './automationCommands.js';
import { AutomationsRoute, IAutomationSeed } from './automationRoutes.js';
import { AutomationService } from './automationService.js';
import { AUTOMATIONS_EDITOR_ID, AutomationsEditor, AutomationsEditorInput, AutomationsEditorInputSerializer } from './automationsEditor.js';

registerSingleton(IAutomationService, AutomationService, InstantiationType.Delayed);

/** Starts the clock and the webhook queue once the window is up (runs need the orchestrator and history). */
class AutomationsContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltAutomations';
	constructor(@IAutomationService automations: IAutomationService) {
		void automations.whenReady;
	}
}
registerWorkbenchContribution2(AutomationsContribution.ID, AutomationsContribution, WorkbenchPhase.AfterRestored);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AutomationsEditor, AUTOMATIONS_EDITOR_ID, localize('voltAutomations.editorLabel', "Automations")),
	[new SyncDescriptor(AutomationsEditorInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AutomationsEditorInput.TypeID, AutomationsEditorInputSerializer);

/** Opens the Automations tab on `route`; an open tab moves there (asking first about unsaved changes). */
export async function openAutomations(accessor: ServicesAccessor, route: AutomationsRoute): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const existing = editorService.editors.find((editor): editor is AutomationsEditorInput => editor instanceof AutomationsEditorInput);
	const showing = !!existing && editorService.activeEditor === existing;
	const input = existing ?? accessor.get(IInstantiationService).createInstance(AutomationsEditorInput);
	if (!showing) {
		input.route = route;
	}
	const pane = await editorService.openEditor(input, { pinned: true });
	if (showing && pane instanceof AutomationsEditor) {
		await pane.navigate(route);
	}
}

registerAction2(class OpenAutomationsAction extends Action2 {
	constructor() {
		super({
			id: OPEN_AUTOMATIONS_COMMAND_ID,
			title: localize2('voltAutomations.open', "Show Automations"),
			category: localize2('voltAgent.category', "Agent"),
			icon: Codicon.zap,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, automationId?: unknown, view?: unknown): Promise<void> {
		const route: AutomationsRoute = typeof automationId === 'string' && accessor.get(IAutomationService).get(automationId)
			? { page: 'detail', id: automationId, tab: view === 'runs' ? 'runs' : 'settings' }
			: { page: 'list' };
		await openAutomations(accessor, route);
	}
});

registerAction2(class NewAutomationAction extends Action2 {
	constructor() {
		super({
			id: NEW_AUTOMATION_COMMAND_ID,
			title: localize2('voltAutomations.newCommand', "New Automation…"),
			category: localize2('voltAgent.category', "Agent"),
			icon: Codicon.zap,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
		const raw = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
		const seed: { -readonly [K in keyof IAutomationSeed]: IAutomationSeed[K] } = {};
		for (const key of ['templateId', 'threadId', 'mode', 'modelRef'] as const) {
			if (typeof raw[key] === 'string' && raw[key]) {
				seed[key] = raw[key] as string;
			}
		}
		if (typeof raw.prompt === 'string' && raw.prompt.trim()) {
			seed.instructions = raw.prompt.trim();
		}
		await openAutomations(accessor, { page: 'detail', tab: 'settings', ...(Object.keys(seed).length ? { seed } : {}) });
	}
});

registerAction2(class OpenAutomationRunsAction extends Action2 {
	constructor() {
		super({
			id: OPEN_AUTOMATION_RUNS_COMMAND_ID,
			title: localize2('voltAutomations.runsCommand', "Show All Automation Runs"),
			category: localize2('voltAgent.category', "Agent"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openAutomations(accessor, { page: 'runs' });
	}
});
