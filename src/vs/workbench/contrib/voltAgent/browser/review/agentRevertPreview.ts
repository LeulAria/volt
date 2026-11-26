/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../voltProjects/browser/media/addProject.css';
import '../media/agentRevertPreview.css';
import { $, append } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { showVoltModal } from '../../../voltProjects/browser/ui/voltModal.js';
import { createVoltButton } from '../chrome/voltButton.js';
import type { IAgentRevertPreviewFile } from './agentCheckpointService.js';
import { FileChangePreview } from './fileChangePreview.js';
import { FileChangeVerb } from './fileChangePreviewModel.js';

/**
 * The message's revert button: shows every change the agent made since that message as diffs, and
 * resolves true when the user picks Revert. Only files change; the chat stays as it is.
 */
export function showAgentRevertPreview(instantiationService: IInstantiationService, layoutService: ILayoutService, files: readonly IAgentRevertPreviewFile[]): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		let confirmed = false;
		showVoltModal(layoutService, {
			title: localize('voltAgent.revertPreview.title', "Revert changes since this message?"),
			subtitle: files.length === 1
				? localize('voltAgent.revertPreview.detailOne', "This change is undone: the file goes back to how it was before this message. The chat stays as it is.")
				: localize('voltAgent.revertPreview.detailMany', "These changes are undone: {0} files go back to how they were before this message. The chat stays as it is.", files.length),
			width: 820,
			height: 640,
			className: 'volt-revert-preview',
			onDidClose: () => resolve(confirmed),
			render: (body, close) => {
				const store = new DisposableStore();
				const list = append(body, $('.volt-revert-preview-files'));
				for (const file of files) {
					const item = append(list, $('.volt-revert-preview-file'));
					const preview = store.add(instantiationService.createInstance(FileChangePreview));
					item.appendChild(preview.element);
					const verb: FileChangeVerb = file.kind === 'added' ? 'Created' : file.kind === 'deleted' ? 'Deleted' : 'Edited';
					preview.setInput({
						uri: file.uri,
						path: file.path,
						verb,
						original: file.binary ? undefined : file.original ?? '',
						modified: file.binary ? undefined : file.current ?? '',
					}, { style: 'card', expanded: true, collapsible: false, openOnClick: false });
					const notes: string[] = [];
					if (file.kind === 'added') {
						notes.push(localize('voltAgent.revertPreview.added', "The agent created this file, so reverting deletes it."));
					} else if (file.kind === 'deleted') {
						notes.push(localize('voltAgent.revertPreview.deleted', "The agent deleted this file, so reverting brings it back."));
					}
					if (file.binary) {
						notes.push(localize('voltAgent.revertPreview.binary', "Binary file: no diff to show."));
					}
					if (file.editedSince) {
						notes.push(localize('voltAgent.revertPreview.editedSince', "Also edited after the agent. You choose whether to keep those edits where they overlap."));
					}
					if (notes.length) {
						append(item, $('.volt-revert-preview-note')).textContent = notes.join(' ');
					}
				}
				const foot = append(body, $('.volt-revert-preview-foot'));
				const cancel = store.add(createVoltButton(foot, 'secondary'));
				cancel.label = localize('voltAgent.revertPreview.cancel', "Cancel");
				const revert = store.add(createVoltButton(foot, 'primary'));
				revert.label = files.length === 1
					? localize('voltAgent.revertPreview.revertOne', "Revert File")
					: localize('voltAgent.revertPreview.revertMany', "Revert {0} Files", files.length);
				store.add(cancel.onDidClick(() => close()));
				store.add(revert.onDidClick(() => {
					confirmed = true;
					close();
				}));
				revert.focus();
				return store;
			},
		});
	});
}
