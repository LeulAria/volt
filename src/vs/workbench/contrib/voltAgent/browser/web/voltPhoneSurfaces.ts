/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt's secondary surfaces on a phone (the browser only): Settings, the tools' tabs, the Changes
// view, the editors. The stylesheet does most of it; this file sets what CSS cannot reach.

import './media/voltPhoneSurfaces.css';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { VOLT_WEB_PHONE_QUERY } from './voltWebPhone.js';

/**
 * Editor settings a phone's width needs: no minimap, overview ruler, folding or glyph margin taking
 * columns from the code, lines wrapped instead of scrolled sideways, a smaller font, narrow line
 * numbers, and diffs inline. They live in memory only: the user's settings file (which the desktop
 * shares) never sees them, and they go away when the window grows past a phone's width.
 */
const PHONE_EDITOR_SETTINGS: Readonly<Record<string, unknown>> = {
	'editor.minimap.enabled': false,
	'editor.wordWrap': 'on',
	'editor.fontSize': 13,
	'editor.stickyScroll.enabled': false,
	'editor.lineNumbersMinChars': 3,
	'editor.folding': false,
	'editor.glyphMargin': false,
	'editor.overviewRulerLanes': 0,
	'editor.overviewRulerBorder': false,
	'editor.hideCursorInOverviewRuler': true,
	'editor.scrollBeyondLastLine': false,
	'editor.scrollbar.verticalScrollbarSize': 6,
	'editor.scrollbar.horizontalScrollbarSize': 6,
	'diffEditor.renderSideBySide': false,
	'diffEditor.renderOverviewRuler': false,
};

class VoltPhoneSurfacesContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltPhoneSurfaces';

	private applied = false;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const phone = mainWindow.matchMedia(VOLT_WEB_PHONE_QUERY);
		const sync = () => this.applyEditorSettings(phone.matches);
		sync();
		phone.addEventListener('change', sync);
		this._register(toDisposable(() => {
			phone.removeEventListener('change', sync);
			this.applyEditorSettings(false);
		}));
	}

	private applyEditorSettings(phone: boolean): void {
		if (phone === this.applied) {
			return;
		}
		this.applied = phone;
		for (const [key, value] of Object.entries(PHONE_EDITOR_SETTINGS)) {
			void this.configurationService.updateValue(key, phone ? value : undefined, ConfigurationTarget.MEMORY);
		}
	}
}

// Before the editors are restored, so a file reopened on a phone lays out for it from the start.
registerWorkbenchContribution2(VoltPhoneSurfacesContribution.ID, VoltPhoneSurfacesContribution, WorkbenchPhase.BlockRestore);
