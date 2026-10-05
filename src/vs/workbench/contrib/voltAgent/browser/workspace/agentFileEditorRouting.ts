/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { EditorResourceAccessor, isEditorInputWithOptions, isUntitledResourceEditorInput, SideBySideEditor } from '../../../../common/editor.js';
import { registerEditorGroupRouter } from '../../../../services/editor/common/editorGroupFinder.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { AUX_WINDOW_GROUP } from '../../../../services/editor/common/editorService.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';

export interface IAgentFileEditorHost {
	/** The visible chat, only while the window is in agent layout. */
	getSessionId(): string | undefined;
	openToolsGroup(): IEditorGroup | undefined;
}

/** Files targeting a main chat belong to that chat's tools, leaving its conversation on screen. */
export function registerAgentFileEditorRouting(editorGroupsService: IEditorGroupsService, fileService: IFileService, host: IAgentFileEditorHost): IDisposable {
	return registerEditorGroupRouter(editorGroupsService, (input, preferredGroup) => {
		const sessionId = host.getSessionId();
		if (!sessionId || preferredGroup === AUX_WINDOW_GROUP) {
			return undefined;
		}
		const source = typeof preferredGroup === 'object' ? preferredGroup
			: typeof preferredGroup === 'number' && preferredGroup >= 0 ? editorGroupsService.getGroup(preferredGroup)
				: editorGroupsService.activeGroup;
		// Explicit tools groups and other windows keep their normal destination.
		if (!source || !editorGroupsService.mainPart.groups.includes(source)
			|| !(source.activeEditor instanceof AgentEditorInput) || source.activeEditor.sessionId !== sessionId) {
			return undefined;
		}
		const editor = isEditorInputWithOptions(input) ? input.editor : input;
		const resource = EditorResourceAccessor.getCanonicalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY });
		if (!(resource ? resource.scheme === Schemas.untitled || fileService.hasProvider(resource) : isUntitledResourceEditorInput(editor))) {
			return undefined;
		}
		return host.openToolsGroup();
	});
}
