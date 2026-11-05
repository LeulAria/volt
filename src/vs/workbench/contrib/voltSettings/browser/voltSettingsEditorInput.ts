/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { GroupsOrder, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

const VoltSettingsIcon = registerIcon('volt-settings-editor-label-icon', Codicon.settings, localize('voltSettingsIcon', 'Icon of the Volt Settings editor tab.'));

export const VOLT_SETTINGS_EDITOR_ID = 'workbench.editor.voltSettings';
export const VOLT_SETTINGS_INPUT_ID = 'workbench.input.voltSettings';
export const OPEN_VOLT_SETTINGS_COMMAND_ID = 'workbench.action.openVoltSettings';

export function openVoltSettingsEditor(editorService: IEditorService, editorGroupsService: IEditorGroupsService) {
	for (const group of editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
		const input = group.editors.find(editor => editor instanceof VoltSettingsEditorInput);
		if (input) {
			return editorService.openEditor(input, { pinned: true }, group);
		}
	}
	return editorService.openEditor(new VoltSettingsEditorInput(), { pinned: true }, editorGroupsService.mainPart.activeGroup);
}

export class VoltSettingsEditorInput extends EditorInput {

	static readonly TypeID = VOLT_SETTINGS_INPUT_ID;
	static readonly EditorID = VOLT_SETTINGS_EDITOR_ID;

	readonly resource = URI.from({ scheme: Schemas.voltSettings, path: 'settings' });

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	override get typeId(): string {
		return VoltSettingsEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return VoltSettingsEditorInput.EditorID;
	}

	override getName(): string {
		return localize('voltSettings.tab', "Volt Settings");
	}

	override getIcon(): ThemeIcon {
		return VoltSettingsIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof VoltSettingsEditorInput;
	}
}

export class VoltSettingsEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(VoltSettingsEditorInput);
	}
}
