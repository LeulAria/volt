/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap, IDisposable } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AGENT_EDITOR_ID } from '../../voltAgent/browser/editor/agentEditorInput.js';
import { VOLT_THEME_CONTRAST_MAX, VOLT_THEME_CONTRAST_MIN, VOLT_THEME_CONTRAST_SETTING, VOLT_THEME_CONTRAST_STEP } from '../common/voltThemeContrast.js';
import { IVoltThemeContrastService } from './voltThemeContrast.js';
import { VoltThemeImporter } from './voltThemeImporter.js';
import { VOLT_IMPORT_THEMES_COMMAND_ID, VoltThemePicker } from './voltThemePicker.js';

export const VOLT_PICK_THEME_COMMAND_ID = 'volt.theme.pick';
const VOLT_CONTRAST_UP_COMMAND_ID = 'volt.theme.increaseContrast';
const VOLT_CONTRAST_DOWN_COMMAND_ID = 'volt.theme.decreaseContrast';
const VOLT_CONTRAST_RESET_COMMAND_ID = 'volt.theme.resetContrast';

const voltCategory = localize2('voltThemes.category', "Volt");

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.theme',
	title: localize('voltThemes.configTitle', "Volt Theme"),
	type: 'object',
	properties: {
		[VOLT_THEME_CONTRAST_SETTING]: {
			type: 'number',
			default: 0,
			minimum: VOLT_THEME_CONTRAST_MIN,
			maximum: VOLT_THEME_CONTRAST_MAX,
			description: localize('voltThemes.contrastSetting', "Contrast on top of the color theme, from -100 (softer) to 100 (stronger). Text, icons, borders and the main surfaces move apart or together; 0 shows the theme as made. Also in the theme picker (/theme in the chat)."),
		},
	},
});

/** Contrast is applied before the workbench paints, so a saved value never flashes off. */
class VoltThemeContrastStartup extends Disposable {
	static readonly ID = 'workbench.contrib.voltThemeContrast';
	constructor(@IVoltThemeContrastService _contrast: IVoltThemeContrastService) {
		super();
	}
}

registerWorkbenchContribution2(VoltThemeContrastStartup.ID, VoltThemeContrastStartup, WorkbenchPhase.BlockRestore);

function openPicker(accessor: ServicesAccessor, anchor?: HTMLElement): Promise<void> {
	return accessor.get(IInstantiationService).createInstance(VoltThemePicker).show({ anchor });
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOLT_PICK_THEME_COMMAND_ID,
			title: localize2('voltThemes.pick', "Choose Theme…"),
			category: voltCategory,
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return openPicker(accessor);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOLT_IMPORT_THEMES_COMMAND_ID,
			title: localize2('voltThemes.importCommand', "Import Themes from VS Code and Cursor…"),
			category: voltCategory,
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IInstantiationService).createInstance(VoltThemeImporter).run();
	}
});

function stepContrast(accessor: ServicesAccessor, delta: number | undefined): Promise<void> {
	const contrast = accessor.get(IVoltThemeContrastService);
	return contrast.set(delta === undefined ? 0 : contrast.saved + delta);
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: VOLT_CONTRAST_UP_COMMAND_ID, title: localize2('voltThemes.contrastUp', "Increase Theme Contrast"), category: voltCategory, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return stepContrast(accessor, VOLT_THEME_CONTRAST_STEP);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: VOLT_CONTRAST_DOWN_COMMAND_ID, title: localize2('voltThemes.contrastDown', "Decrease Theme Contrast"), category: voltCategory, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return stepContrast(accessor, -VOLT_THEME_CONTRAST_STEP);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: VOLT_CONTRAST_RESET_COMMAND_ID, title: localize2('voltThemes.contrastReset', "Reset Theme Contrast"), category: voltCategory, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return stepContrast(accessor, undefined);
	}
});

// The chat's "..." menu, next to Agent Settings.
MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: VOLT_PICK_THEME_COMMAND_ID, title: localize('voltThemes.menu', "Theme…") },
	group: '2z_volt_settings',
	order: 5,
	when: ActiveEditorContext.isEqualTo(AGENT_EDITOR_ID),
});

//#region `/theme` in the composer

const THEME_COMMAND = /^\s*\/theme\s*$/i;
const AGENT_INPUT_SCHEME = 'volt-agent-input';

/**
 * `/theme` + Enter in an agent composer (its models use the `volt-agent-input` scheme) opens the
 * theme picker instead of sending. The composer sends from its own key listener, which skips keys
 * already handled, so this listens on each composer from the moment the editor is created: its
 * listener comes first. The composer's code is not touched.
 */
class VoltThemeSlashCommand extends Disposable {

	static readonly ID = 'workbench.contrib.voltThemeSlashCommand';

	private readonly editors = this._register(new DisposableMap<ICodeEditor, IDisposable>());

	constructor(
		@ICodeEditorService codeEditorService: ICodeEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		for (const editor of codeEditorService.listCodeEditors()) {
			this.track(editor);
		}
		this._register(codeEditorService.onCodeEditorAdd(editor => this.track(editor)));
		this._register(codeEditorService.onCodeEditorRemove(editor => this.editors.deleteAndDispose(editor)));
	}

	private track(editor: ICodeEditor): void {
		if (this.editors.has(editor)) {
			return;
		}
		this.editors.set(editor, editor.onKeyDown(e => {
			if (e.keyCode !== KeyCode.Enter || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.browserEvent.defaultPrevented) {
				return;
			}
			const model = editor.getModel();
			if (model?.uri.scheme !== AGENT_INPUT_SCHEME || model.getValueLength() > 32 || !THEME_COMMAND.test(model.getValue())) {
				return;
			}
			// Claim the key before anything edits the model (see composer-keydown re-entrancy).
			e.preventDefault();
			e.stopPropagation();
			const node = editor.getContainerDomNode();
			const anchor = (node.closest('.volt-agent-input-box') ?? node) as HTMLElement;
			setTimeout(() => {
				model.setValue('');
				void this.instantiationService.invokeFunction(accessor => openPicker(accessor, anchor));
			}, 0);
		}));
	}
}

registerWorkbenchContribution2(VoltThemeSlashCommand.ID, VoltThemeSlashCommand, WorkbenchPhase.BlockRestore);

//#endregion
