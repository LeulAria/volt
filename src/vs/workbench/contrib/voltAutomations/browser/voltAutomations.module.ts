/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IAutomationService } from '../../../services/voltRuntime/common/automations/automations.js';
import { AutomationsRoute, IAutomationSeed } from '../../voltAgent/browser/automations/automationRoutes.js';
import { openInAgentTools } from '../../voltAgent/browser/workspace/agentSurfaceHost.js';
import { OPEN_AUTOMATIONS_IN_TOOLS_COMMAND_ID, OPEN_WORKFLOWS_IN_TOOLS_COMMAND_ID } from '../../voltAgent/browser/workspace/agentSurfaceMenu.js';
import { closeModuleEditorsOnUnload, embedModuleEditor, IVoltFeatureModule, IVoltFeatureModuleHost } from '../../voltCustomize/browser/voltFeatureModules.js';
import {
	AUTOMATIONS_EDITOR_ID, IAutomationsEmbeddedPage, IVoltAutomationsModule, NEW_AUTOMATION_COMMAND_ID, OPEN_AUTOMATION_RUNS_COMMAND_ID, OPEN_AUTOMATIONS_COMMAND_ID,
	OPEN_AUTOMATIONS_ROUTE_COMMAND_ID,
} from '../common/voltAutomations.js';
import { AutomationsEditor, AutomationsEditorInput, AutomationsEditorInputSerializer } from './automationsEditor.js';

/** Opens the Automations tab on `route`; an open tab moves there (asking first about unsaved changes). */
async function openAutomations(accessor: ServicesAccessor, route: AutomationsRoute): Promise<void> {
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

const ROUTE_PAGES: readonly AutomationsRoute['page'][] = ['list', 'detail', 'runs', 'workflows', 'workflow'];

function registerCommands(store: DisposableStore): void {
	store.add(registerAction2(class OpenAutomationsAction extends Action2 {
		constructor() {
			super({
				id: OPEN_AUTOMATIONS_COMMAND_ID,
				visibility: 'public',
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
	}));

	store.add(registerAction2(class OpenAutomationsRouteAction extends Action2 {
		constructor() {
			super({ id: OPEN_AUTOMATIONS_ROUTE_COMMAND_ID, visibility: 'internal', title: localize2('voltAutomations.openRoute', "Open Automations Page") });
		}

		override async run(accessor: ServicesAccessor, route?: unknown): Promise<void> {
			const page = (route as { page?: unknown } | undefined)?.page;
			await openAutomations(accessor, ROUTE_PAGES.includes(page as AutomationsRoute['page']) ? route as AutomationsRoute : { page: 'list' });
		}
	}));

	store.add(registerAction2(class OpenAutomationsInToolsAction extends Action2 {
		constructor() {
			super({ id: OPEN_AUTOMATIONS_IN_TOOLS_COMMAND_ID, visibility: 'public', title: localize2('voltAutomations.openInTools', "Open Automations Beside Chat") });
		}

		/** A tab in the chat's right panel (its own input, so the main panel's tab stays where it is); no chat on screen opens the usual tab. */
		override async run(accessor: ServicesAccessor, sessionId?: unknown): Promise<void> {
			const input = accessor.get(IInstantiationService).createInstance(AutomationsEditorInput);
			input.route = { page: 'list' };
			const opened = openInAgentTools(input, typeof sessionId === 'string' ? sessionId : undefined, { pinned: true });
			if (opened) {
				await opened;
			} else {
				input.dispose();
				await openAutomations(accessor, { page: 'list' });
			}
		}
	}));

	store.add(registerAction2(class OpenWorkflowsInToolsAction extends Action2 {
		constructor() {
			super({ id: OPEN_WORKFLOWS_IN_TOOLS_COMMAND_ID, visibility: 'public', title: localize2('voltAutomations.openWorkflowsInTools', "Open Workflows Beside Chat") });
		}

		/** The workflow library in the chat's right panel; no chat on screen opens the usual Automations tab there. */
		override async run(accessor: ServicesAccessor, sessionId?: unknown): Promise<void> {
			const input = accessor.get(IInstantiationService).createInstance(AutomationsEditorInput);
			input.route = { page: 'workflows' };
			const opened = openInAgentTools(input, typeof sessionId === 'string' ? sessionId : undefined, { pinned: true });
			if (opened) {
				await opened;
			} else {
				input.dispose();
				await openAutomations(accessor, { page: 'workflows' });
			}
		}
	}));

	store.add(registerAction2(class NewAutomationAction extends Action2 {
		constructor() {
			super({
				id: NEW_AUTOMATION_COMMAND_ID,
				visibility: 'internal',
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
	}));

	store.add(registerAction2(class OpenAutomationRunsAction extends Action2 {
		constructor() {
			super({
				id: OPEN_AUTOMATION_RUNS_COMMAND_ID,
				visibility: 'public',
				title: localize2('voltAutomations.runsCommand', "Show All Automation Runs"),
				category: localize2('voltAgent.category', "Agent"),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			await openAutomations(accessor, { page: 'runs' });
		}
	}));
}

/**
 * The Automations pages, as a module of the `volt.automations` built-in extension: its commands,
 * its editor (the tab, and the page Volt Settings hosts). Everything it registers goes into
 * `host.subscriptions`, so disabling the extension unloads it.
 */
class VoltAutomationsModule implements IVoltFeatureModule, IVoltAutomationsModule {

	private host: IVoltFeatureModuleHost | undefined;

	activate(host: IVoltFeatureModuleHost): void {
		this.host = host;
		registerCommands(host.subscriptions);
		host.subscriptions.add(Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
			EditorPaneDescriptor.create(AutomationsEditor, AUTOMATIONS_EDITOR_ID, localize('voltAutomations.editorLabel', "Automations")),
			[new SyncDescriptor(AutomationsEditorInput)]
		));
		host.registerEditorSerializer(AutomationsEditorInput.TypeID, new AutomationsEditorInputSerializer());
		closeModuleEditorsOnUnload(host, [AutomationsEditorInput.TypeID]);
		host.subscriptions.add(toDisposable(() => this.host = undefined));
	}

	createEmbeddedPage(parent: HTMLElement, group: IEditorGroup): IAutomationsEmbeddedPage {
		const host = this.host;
		if (!host) {
			throw new Error('The Automations module is not loaded.');
		}
		return embedModuleEditor(host, host.instantiationService.createInstance(AutomationsEditor, group), new AutomationsEditorInput(), parent);
	}
}

export const voltAutomationsModule: IVoltFeatureModule & IVoltAutomationsModule = new VoltAutomationsModule();
