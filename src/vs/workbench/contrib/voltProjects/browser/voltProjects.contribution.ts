/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isHTMLElement } from '../../../../base/browser/dom.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IVoltFsBrowseService } from '../../../../platform/voltFsBrowse/common/voltFsBrowse.js';
import { IVoltGitService } from '../../../../platform/voltGit/common/voltGit.js';
import { IVoltProjectsService, VoltProjectCommands } from '../common/projects.js';
import { FileServiceFsBrowse, NullVoltGitService } from './fallbackServices.js';
import { GitHubReposService, IGitHubReposService } from './githubRepos.js';
import { IProjectCloneService, ProjectCloneService } from './projectCloneService.js';
import { AddProjectDialog, AddProjectTab } from './ui/addProjectView.js';
import { showAgentProjectMenu } from '../../voltAgent/browser/home/agentHomeWorkspaceActions.js';
import { IVoltFolderPickerService, VoltFolderPickerService } from './folderPickerService.js';
import { VoltProjectsService } from './voltProjectsService.js';

// Desktop registers main-process versions of these two over the fallbacks.
registerSingleton(IVoltFsBrowseService, FileServiceFsBrowse, InstantiationType.Delayed);
registerSingleton(IVoltGitService, NullVoltGitService, InstantiationType.Delayed);
registerSingleton(IVoltProjectsService, VoltProjectsService, InstantiationType.Delayed);
registerSingleton(IProjectCloneService, ProjectCloneService, InstantiationType.Delayed);
registerSingleton(IGitHubReposService, GitHubReposService, InstantiationType.Delayed);
registerSingleton(IVoltFolderPickerService, VoltFolderPickerService, InstantiationType.Delayed);

const category = localize2('volt', "Volt");

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VoltProjectCommands.addProject,
			title: localize2('voltProjects.addProject', "Add Project"),
			category,
			f1: true,
			keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyA, weight: KeybindingWeight.WorkbenchContrib + 50 },
		});
	}

	override async run(accessor: ServicesAccessor, args?: { readonly anchor?: unknown; readonly current?: unknown }): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		const anchor = args?.anchor;
		if (isHTMLElement(anchor) && anchor.isConnected) {
			await showAgentProjectMenu(instantiationService, anchor, URI.isUri(args?.current) ? args.current : undefined);
		} else {
			await instantiationService.createInstance(AddProjectDialog).show();
		}
	}
});

function registerTabCommand(id: string, title: string, tab: AddProjectTab, f1: boolean): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id, title: { value: title, original: title }, category, f1 });
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IInstantiationService).createInstance(AddProjectDialog).show(tab);
		}
	});
}

registerTabCommand(VoltProjectCommands.openFromThisPC, localize('voltProjects.openFromThisPCTitle', "Open Project from This PC"), 'thisPC', false);
registerTabCommand(VoltProjectCommands.cloneFromUrl, localize('voltProjects.cloneRepository', "Clone Repository"), 'gitUrl', true);
registerTabCommand(VoltProjectCommands.cloneFromGitHub, localize('voltProjects.cloneFromGitHubTitle', "Clone from GitHub"), 'github', true);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: VoltProjectCommands.cancelClone, title: localize2('voltProjects.cancelClone', "Cancel Clone"), category, f1: false });
	}

	override async run(accessor: ServicesAccessor, projectId?: string): Promise<void> {
		if (typeof projectId === 'string') {
			await accessor.get(IProjectCloneService).cancel(projectId);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: VoltProjectCommands.retryClone, title: localize2('voltProjects.retryClone', "Retry Clone"), category, f1: false });
	}

	override async run(accessor: ServicesAccessor, projectId?: string): Promise<void> {
		if (typeof projectId === 'string') {
			await accessor.get(IProjectCloneService).retry(projectId);
		}
	}
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'voltProjects',
	title: localize('voltProjects.settings', "Volt Projects"),
	type: 'object',
	properties: {
		'volt.projects.cloneDirectory': {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltProjects.cloneDirectory', "Folder that clones go into. Empty uses the last folder you cloned into, else ~/code (or a similar folder), else ~/Volt."),
		},
		'volt.projects.showHiddenFolders': {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltProjects.showHiddenFolders', "Show hidden folders in the Add Project folder picker."),
		},
		'volt.projects.deepSearchRoots': {
			type: 'array',
			items: { type: 'string' },
			default: ['~'],
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltProjects.deepSearchRoots', "Folders that \"Search all folders\" looks through."),
		},
		'volt.projects.deepSearchMaxDepth': {
			type: 'number',
			default: 5,
			minimum: 1,
			maximum: 10,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltProjects.deepSearchMaxDepth', "How many folder levels \"Search all folders\" goes down."),
		},
	},
});
