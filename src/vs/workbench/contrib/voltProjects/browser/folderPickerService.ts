/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/addProject.css';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
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
		@IVoltProjectsService private readonly projects: IVoltProjectsService,
	) { }

	pickFolder(options: IVoltPickFolderOptions): Promise<string | undefined> {
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
					const browser = store.add(this.instantiationService.createInstance(FolderBrowser, body, {
						initialPath: options.initialPath,
						addedPaths: () => new Set(this.projects.list().filter(project => project.uri.scheme === 'file').map(project => project.uri.fsPath)),
						knownFolders: () => this.projects.list().filter(project => project.uri.scheme === 'file').map(project => ({ name: project.name, path: project.uri.fsPath })),
						acceptLabel: options.acceptLabel,
						onAccept: accept,
					}));
					browser.focus();
					return store;
				},
			});
		});
	}
}
