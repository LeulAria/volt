/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';

/** A chat on screen: the active editor group's first, then any visible one (the side panel in the IDE layout). */
export function visibleChatSession(accessor: ServicesAccessor): string | undefined {
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const parts = editorGroupsService.parts.length ? editorGroupsService.parts : [editorGroupsService.mainPart];
	const active = editorGroupsService.activeGroup.activeEditor;
	if (active instanceof AgentEditorInput) {
		return active.sessionId;
	}
	for (const part of parts) {
		for (const group of part.groups) {
			const pane = group.activeEditorPane;
			if (pane?.getId() === AgentEditorInput.EditorID && pane.input instanceof AgentEditorInput) {
				return pane.input.sessionId;
			}
		}
	}
	return undefined;
}
