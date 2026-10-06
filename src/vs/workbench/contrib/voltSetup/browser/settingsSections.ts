/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltSetup.css';
import { $, append } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../services/voltRuntime/common/sessionContext.js';
import { VoltProjectCommands } from '../../voltProjects/common/projects.js';
import { IVoltProjectSettingsService } from './projectSettingsService.js';
import { VoltStorageView } from './storageView.js';

export const VOLT_SETUP_COMMAND_ID = 'volt.setup.open';
export const VOLT_PROJECT_SETTINGS_COMMAND_ID = 'volt.projects.settings';
export const VOLT_MANAGE_STORAGE_COMMAND_ID = 'volt.storage.manage';

/** Volt Settings > Agents: a way back into the first-run wizard. */
export function renderSetupButton(parent: HTMLElement, instantiationService: IInstantiationService, store: DisposableStore): void {
	const commandService = instantiationService.invokeFunction(accessor => accessor.get(ICommandService));
	const button = store.add(new Button(append(parent, $('.volt-setup-settings-button')), { ...defaultButtonStyles, secondary: true }));
	button.label = localize('voltSetup.openWizard', "Set Up Agents and Projects...");
	store.add(button.onDidClick(() => void commandService.executeCommand(VOLT_SETUP_COMMAND_ID)));
}

/** Volt Settings > Projects: every project with what its settings change, and a Settings button. */
export function renderProjectsSection(target: HTMLElement, instantiationService: IInstantiationService, store: DisposableStore, needle: string): void {
	const { sessionContext, settings, runtime, labelService, commandService } = instantiationService.invokeFunction(accessor => ({
		sessionContext: accessor.get(IVoltSessionContextService),
		settings: accessor.get(IVoltProjectSettingsService),
		runtime: accessor.get(IAgentRuntimeService),
		labelService: accessor.get(ILabelService),
		commandService: accessor.get(ICommandService),
	}));
	const host = append(target, $('.volt-setup-projects-section'));
	const rows = store.add(new MutableDisposable<DisposableStore>());
	const render = () => {
		host.replaceChildren();
		const rowStore = rows.value = new DisposableStore();
		const seen = new Set<string>();
		const projects = sessionContext.projects.filter(project => {
			const key = project.root.toString();
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return !needle || project.displayName.toLowerCase().includes(needle) || project.root.fsPath.toLowerCase().includes(needle);
		});
		if (!projects.length) {
			append(host, $('.volt-settings-empty')).textContent = localize('voltSetup.noProjects', "No projects yet. Add one to give it its own settings.");
		} else {
			const list = append(host, $('.volt-settings-list'));
			for (const project of projects) {
				const row = append(list, $('.volt-settings-row'));
				const copy = append(row, $('.volt-settings-row-copy'));
				append(copy, $('label')).textContent = project.displayName;
				const saved = settings.get(project.id);
				const model = saved.defaultModel ? runtime.listCatalog().find(item => item.ref === saved.defaultModel)?.label ?? saved.defaultModel : undefined;
				const facts = [
					labelService.getUriLabel(project.root, { relative: false }),
					model ? localize('voltSetup.factModel', "starts on {0}", model) : undefined,
					settings.getRunOn(project.id) === 'worktree' ? localize('voltSetup.factWorktree', "new worktree per chat") : undefined,
					saved.env ? localize('voltSetup.factEnv', "{0} env vars", Object.keys(saved.env).length) : undefined,
				].filter(Boolean);
				append(copy, $('.desc')).textContent = facts.join(' · ');
				const control = append(row, $('.volt-settings-row-control'));
				const button = rowStore.add(new Button(control, { ...defaultButtonStyles, secondary: true }));
				button.label = localize('voltSetup.projectSettingsButton', "Settings...");
				rowStore.add(button.onDidClick(() => void commandService.executeCommand(VOLT_PROJECT_SETTINGS_COMMAND_ID, project.id)));
			}
		}
		const add = rowStore.add(new Button(append(host, $('.volt-setup-settings-button')), { ...defaultButtonStyles, secondary: true }));
		add.label = localize('voltSetup.addProject', "Add Project...");
		rowStore.add(add.onDidClick(() => void commandService.executeCommand(VoltProjectCommands.addProject)));
	};
	store.add(sessionContext.onDidChangeProjects(render));
	store.add(settings.onDidChange(render));
	render();
}

/** Volt Settings > Storage: the machine-wide sizes and Clean buttons. */
export function renderStorageSection(target: HTMLElement, instantiationService: IInstantiationService, store: DisposableStore): void {
	store.add(instantiationService.createInstance(VoltStorageView, target, undefined));
}
