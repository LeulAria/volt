/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { EditorsOrder } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { closeAgentToolEditorsWhere } from '../../voltAgent/browser/workspace/agentSurfaceHost.js';
import { IVoltFeatureService } from '../common/voltFeatures.js';

/**
 * Closes a feature's tabs (editors of `typeIds`) when the user turns it off, in the editor area and
 * in every chat's tools, for a feature without a module (a module's tabs close when it unloads,
 * `closeModuleEditorsOnUnload`). Turned on again, its commands open them anew.
 */
export function closeEditorsWhenVoltFeatureOff(features: IVoltFeatureService, featureId: string, typeIds: readonly string[], editorService: IEditorService): IDisposable {
	let on = features.isEnabled(featureId);
	return features.onDidChange(() => {
		const was = on;
		on = features.isEnabled(featureId);
		if (!was || on) {
			return;
		}
		const open = editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(({ editor }) => typeIds.includes(editor.typeId));
		if (open.length) {
			void editorService.closeEditors(open);
		}
		// The editor service does not see the chats' tools areas.
		closeAgentToolEditorsWhere(editor => typeIds.includes(editor.typeId));
	});
}
