/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/addProject.css';
import { $, append } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles, defaultCheckboxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IVoltFsBrowseService } from '../../../../platform/voltFsBrowse/common/voltFsBrowse.js';
import { tildify } from '../common/browsePath.js';
import { IVoltProjectsService } from '../common/projects.js';
import { FolderBrowser } from './ui/folderBrowser.js';
import { showVoltModal } from './ui/voltModal.js';

export interface IVoltPickFolderOptions {
	readonly title: string;
	readonly subtitle?: string;
	/** The primary button, e.g. "Choose". */
	readonly acceptLabel: string;
	/** Absolute folder to start in. */
	readonly initialPath?: string;
}

export const IVoltFolderPickerService = createDecorator<IVoltFolderPickerService>('voltFolderPickerService');

/** Volt's in-app replacement for the native "choose a folder" dialog. */
export interface IVoltFolderPickerService {
	readonly _serviceBrand: undefined;
	/** The chosen folder's absolute path, or undefined when cancelled. */
	pickFolder(options: IVoltPickFolderOptions): Promise<string | undefined>;
}

export class VoltFolderPickerService implements IVoltFolderPickerService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVoltFsBrowseService private readonly fsBrowse: IVoltFsBrowseService,
		@IVoltProjectsService private readonly projects: IVoltProjectsService,
	) { }

	async pickFolder(options: IVoltPickFolderOptions): Promise<string | undefined> {
		const home = await this.fsBrowse.home();
		return new Promise<string | undefined>(resolve => {
			let result: string | undefined;
			showVoltModal(this.layoutService, {
				title: options.title,
				subtitle: options.subtitle,
				width: 760,
				height: 520,
				className: 'volt-add-project',
				onDidClose: () => resolve(result),
				render: (body, close) => {
					const store = new DisposableStore();
					const accept = (path: string) => {
						result = path;
						close();
					};
					const host = append(body, $('.volt-add-browser'));
					const browser = store.add(this.instantiationService.createInstance(FolderBrowser, host, {
						initialPath: options.initialPath,
						addedPaths: () => new Set(this.projects.list().filter(project => project.uri.scheme === 'file').map(project => project.uri.fsPath)),
						knownFolders: () => this.projects.list().filter(project => project.uri.scheme === 'file').map(project => ({ name: project.name, path: project.uri.fsPath })),
						onAccept: accept,
					}));
					const footer = append(body, $('.volt-add-footer'));
					const hidden = store.add(new Checkbox(localize('voltProjects.showHidden', "Show hidden folders"), browser.hiddenShown, defaultCheckboxStyles));
					const hiddenLabel = append(footer, $('label.volt-add-check'));
					hiddenLabel.appendChild(hidden.domNode);
					append(hiddenLabel, $('span')).textContent = localize('voltProjects.showHidden', "Show hidden folders");
					store.add(hidden.onChange(() => browser.setShowHidden(hidden.checked)));
					const target = append(footer, $('span.volt-add-footer-target'));
					const cancel = store.add(new Button(footer, { ...defaultButtonStyles, secondary: true }));
					cancel.label = localize('voltProjects.cancel', "Cancel");
					store.add(cancel.onDidClick(close));
					const choose = store.add(new Button(footer, defaultButtonStyles));
					choose.label = options.acceptLabel;
					store.add(choose.onDidClick(() => {
						const path = browser.target;
						if (path) {
							accept(path);
						}
					}));
					store.add(browser.onDidChangeTarget(path => {
						choose.enabled = !!path;
						target.textContent = path ? `\u200e${tildify(path, home)}\u200e` : '';
						target.title = path ?? '';
					}));
					browser.focus();
					return store;
				},
			});
		});
	}
}
