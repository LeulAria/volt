/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { VoltSettingsEditor } from './voltSettingsEditor.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID, VOLT_SETTINGS_EDITOR_ID, VoltSettingsEditorInput, VoltSettingsEditorInputSerializer } from './voltSettingsEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		VoltSettingsEditor,
		VOLT_SETTINGS_EDITOR_ID,
		localize('voltSettings.editorLabel', "Volt Settings")
	),
	[new SyncDescriptor(VoltSettingsEditorInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	VoltSettingsEditorInput.TypeID,
	VoltSettingsEditorInputSerializer
);

registerAction2(class OpenVoltSettingsAction extends Action2 {
	constructor() {
		super({
			id: OPEN_VOLT_SETTINGS_COMMAND_ID,
			title: localize2('voltSettings.open', "Volt Settings"),
			category: Categories.Preferences,
			f1: true,
			icon: Codicon.settings,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Comma,
				weight: KeybindingWeight.WorkbenchContrib,
			},
			menu: [
				{
					id: MenuId.TitleBar,
					group: 'navigation',
					order: 0,
				},
				{
					id: MenuId.GlobalActivity,
					group: '2_configuration',
					order: 1,
				},
				{
					id: MenuId.MenubarPreferencesMenu,
					group: '2_configuration',
					order: 1,
				},
			],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		await editorService.openEditor(instantiationService.createInstance(VoltSettingsEditorInput), { pinned: true });
	}
});
