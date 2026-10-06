/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IVoltEditorImportService } from '../../../../platform/voltEditorImport/common/voltEditorImport.js';
import { IVoltStorageService } from '../../../../platform/voltStorage/common/voltStorage.js';
import { getLayoutMode, onDidChangeLayoutMode } from '../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltProjectRecord, IVoltSessionContextService, projectIdForRoot } from '../../../services/voltRuntime/common/sessionContext.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../services/voltRuntime/common/runtime.js';
import { NullVoltEditorImportService, NullVoltStorageService } from './nullServices.js';
import { ProjectSettingsDialog } from './projectSettingsDialog.js';
import { IVoltProjectSettingsService, ProjectDefaultModelContribution, VoltProjectSettingsService } from './projectSettingsService.js';
import { VOLT_MANAGE_STORAGE_COMMAND_ID, VOLT_PROJECT_SETTINGS_COMMAND_ID, VOLT_SETUP_COMMAND_ID } from './settingsSections.js';
import { SetupStep, VoltSetupWizard } from './setupWizard.js';

// Desktop registers the main-process versions over these.
registerSingleton(IVoltStorageService, NullVoltStorageService, InstantiationType.Delayed);
registerSingleton(IVoltEditorImportService, NullVoltEditorImportService, InstantiationType.Delayed);
registerSingleton(IVoltProjectSettingsService, VoltProjectSettingsService, InstantiationType.Delayed);

const FIRST_RUN_STORAGE_KEY = 'volt.setup.firstRunShown';
const SHOW_ON_FIRST_LAUNCH_SETTING = 'volt.setup.showOnFirstLaunch';

const category = localize2('volt', "Volt");

registerAction2(class extends Action2 {
	constructor() {
		super({ id: VOLT_SETUP_COMMAND_ID, title: localize2('voltSetup.command', "Set Up Agents and Projects..."), category, f1: true });
	}

	override run(accessor: ServicesAccessor, step?: SetupStep): void {
		accessor.get(IInstantiationService).createInstance(VoltSetupWizard).show(step === 'projects' || step === 'done' ? step : 'agents');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: VOLT_PROJECT_SETTINGS_COMMAND_ID, title: localize2('voltProjectSettings.command', "Project Settings..."), category, f1: true });
	}

	override async run(accessor: ServicesAccessor, target?: string | URI): Promise<void> {
		const sessionContext = accessor.get(IVoltSessionContextService);
		const quickInput = accessor.get(IQuickInputService);
		const labelService = accessor.get(ILabelService);
		const instantiationService = accessor.get(IInstantiationService);
		let project: IVoltProjectRecord | undefined;
		if (typeof target === 'string') {
			project = sessionContext.getProject(target);
		} else if (URI.isUri(target)) {
			project = sessionContext.getProject(projectIdForRoot(target));
		}
		if (!project) {
			const active = sessionContext.activeProject;
			const projects = [...sessionContext.projects].sort((a, b) => Number(b.id === active?.id) - Number(a.id === active?.id));
			if (!projects.length) {
				return;
			}
			const picked = await quickInput.pick(projects.map((record): IQuickPickItem & { record: IVoltProjectRecord } => ({
				label: record.displayName,
				description: labelService.getUriLabel(record.root, { relative: false }),
				record,
			})), { placeHolder: localize('voltProjectSettings.pick', "Which project?") });
			project = picked?.record;
		}
		if (project) {
			instantiationService.createInstance(ProjectSettingsDialog).show(project);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: VOLT_MANAGE_STORAGE_COMMAND_ID, title: localize2('voltStorage.command', "Manage Storage..."), category, f1: true });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await accessor.get(ICommandService).executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
		// Volt Settings opens on its last page; jump to Storage.
		const pane = editorService.activeEditorPane as unknown as { showSection?: (id: string) => void } | undefined;
		pane?.showSection?.('storage');
	}
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'voltSetup',
	title: localize('voltSetup.settings', "Volt Setup"),
	type: 'object',
	properties: {
		[SHOW_ON_FIRST_LAUNCH_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltSetup.showOnFirstLaunch', "Show the agent and project setup the first time the agent window opens. It opens once; \"Volt: Set Up Agents and Projects\" brings it back."),
		},
	},
});

/**
 * Opens setup once, the first time the agent window shows on a machine with no chats yet.
 * Someone who already has chats is not new and never sees it unasked.
 */
class VoltFirstRunContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltFirstRun';

	private shown = false;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		if (this.storageService.getBoolean(FIRST_RUN_STORAGE_KEY, StorageScope.APPLICATION, false) || this.configurationService.getValue<boolean>(SHOW_ON_FIRST_LAUNCH_SETTING) === false) {
			return;
		}
		this._register(onDidChangeLayoutMode(() => void this.maybeShow()));
		void this.maybeShow();
	}

	private async maybeShow(): Promise<void> {
		if (this.shown || getLayoutMode(this.layoutService) !== 'agent') {
			return;
		}
		this.shown = true;
		await this.history.whenReady;
		this.storageService.store(FIRST_RUN_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		if (this.history.list({ includeArchived: true }).length) {
			return;
		}
		this.instantiationService.createInstance(VoltSetupWizard).show('agents');
	}
}

/**
 * Right-click on a project row in the agent sidebar offers Project Settings. The sidebar's own
 * context menu only handles chat rows, so this listens on the window and resolves the project
 * from the row's label.
 */
class ProjectRowMenuContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltProjectRowMenu';

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		const container = layoutService.mainContainer;
		this._register(addDisposableListener(getWindow(container).document, 'contextmenu', e => this.onContextMenu(e), true));
	}

	private onContextMenu(e: MouseEvent): void {
		const target = e.target;
		if (!isHTMLElement(target) || !target.closest('.volt-agent-home-tree')) {
			return;
		}
		const row = target.closest<HTMLElement>('.volt-agent-home-row.is-folder');
		const label = row?.querySelector('.name')?.textContent?.split(' · ')[0]?.trim();
		const project = label ? this.projectFor(label) : undefined;
		if (!project) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => [
				new Action('volt.projectSettings', localize('voltProjectSettings.menu', "Project Settings..."), undefined, true, () => this.instantiationService.createInstance(ProjectSettingsDialog).show(project)),
			],
		});
	}

	private projectFor(label: string): IVoltProjectRecord | undefined {
		const projects = this.sessionContext.projects;
		return projects.find(project => project.displayName === label) ?? projects.find(project => basename(project.root) === label);
	}
}

registerWorkbenchContribution2(VoltFirstRunContribution.ID, VoltFirstRunContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ProjectRowMenuContribution.ID, ProjectRowMenuContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ProjectDefaultModelContribution.ID, ProjectDefaultModelContribution, WorkbenchPhase.AfterRestored);
