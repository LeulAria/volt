/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The editor on a phone: the same editor with defaults for a narrow touch screen. They are defaults
// (the configuration registry's), so anything the user set wins, and they leave again when the window
// is no longer a phone. The column of code gets the width (no minimap, folding or glyph margin, short
// line numbers, wrapped lines), lines get a little air for a finger, the cursor keeps a few lines clear
// of the keyboard's edge, and a finger dragging over a selection scrolls instead of moving the text.

import { IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationDefaults, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../../platform/registry/common/platform.js';

export const VOLT_PHONE_EDITOR_DEFAULTS: IConfigurationDefaults = {
	overrides: {
		'editor.minimap.enabled': false,
		'editor.folding': false,
		'editor.glyphMargin': false,
		'editor.lineNumbersMinChars': 3,
		'editor.lineDecorationsWidth': 6,
		'editor.wordWrap': 'on',
		'editor.lineHeight': 1.55,
		'editor.padding.top': 6,
		'editor.scrollBeyondLastLine': false,
		'editor.overviewRulerLanes': 0,
		'editor.hideCursorInOverviewRuler': true,
		'editor.stickyScroll.enabled': false,
		'editor.cursorSurroundingLines': 3,
		'editor.dragAndDrop': false,
		'editor.scrollbar.verticalScrollbarSize': 6,
		'editor.scrollbar.horizontalScrollbarSize': 6,
		'editor.renderLineHighlight': 'line',
		'editor.inlayHints.enabled': 'offUnlessPressed',
		'diffEditor.renderSideBySide': false,
	},
};

/** Applies the phone's editor defaults while `phone` holds. */
export function applyPhoneEditorDefaults(phone: boolean, applied: boolean): boolean {
	if (phone === applied) {
		return applied;
	}
	const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	if (phone) {
		registry.registerDefaultConfigurations([VOLT_PHONE_EDITOR_DEFAULTS]);
	} else {
		registry.deregisterDefaultConfigurations([VOLT_PHONE_EDITOR_DEFAULTS]);
	}
	return phone;
}

/** Keeps the phone's editor defaults in step with the window; removes them when disposed. */
export function trackPhoneEditorDefaults(isPhone: () => boolean, onDidChange: (listener: () => void) => IDisposable): IDisposable {
	let applied = applyPhoneEditorDefaults(isPhone(), false);
	const listener = onDidChange(() => applied = applyPhoneEditorDefaults(isPhone(), applied));
	return toDisposable(() => {
		listener.dispose();
		applied = applyPhoneEditorDefaults(false, applied);
	});
}
