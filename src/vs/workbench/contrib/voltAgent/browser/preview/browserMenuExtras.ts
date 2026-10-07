/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../../base/browser/dom.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVoltBrowserService } from '../../../../../platform/voltBrowser/common/voltBrowser.js';
import { AGENT_BROWSER_ACCESS_SETTING, IVoltBrowserAccessService } from '../../../../services/voltRuntime/common/browserAccess.js';
import { IVoltRecordingStatusService } from '../capture/recordingStatus.js';
import { showCookieImportMenu } from './browserCookieImport.js';
import { BrowserMenuEntry } from './browserMenu.js';

/** Commands from the electron-browser layer (the desktop app). */
const OPEN_DEVICE_PREVIEW_COMMAND_ID = 'volt.devices.openPreview';
const RECORD_WINDOW_COMMAND_ID = 'volt.capture.recordWindow';

export interface IBrowserMenuExtrasContext {
	/** The chat whose tools hold the browser tab, if any. */
	readonly sessionId: string | undefined;
	readonly anchor: HTMLElement;
	readonly toast: (message: string) => void;
}

export interface IBrowserMenuExtras {
	/** After Take Screenshot. */
	readonly capture: readonly BrowserMenuEntry[];
	/** After Show Device Toolbar. */
	readonly devices: readonly BrowserMenuEntry[];
	/** Its own group, before the bookmarks. */
	readonly agents: readonly BrowserMenuEntry[];
	/** In the profile group. */
	readonly profile: readonly BrowserMenuEntry[];
}

function optional<T>(accessor: ServicesAccessor, get: (accessor: ServicesAccessor) => T): T | undefined {
	try {
		return get(accessor);
	} catch {
		return undefined;
	}
}

/** The browser ⋯ menu's rows for recording, simulators, agent access and cookie import. */
export function browserMenuExtras(accessor: ServicesAccessor, context: IBrowserMenuExtrasContext): IBrowserMenuExtras {
	const commandService = accessor.get(ICommandService);
	const contextViewService = accessor.get(IContextViewService);
	const configurationService = accessor.get(IConfigurationService);
	const access = optional(accessor, a => a.get(IVoltBrowserAccessService));
	const recordings = optional(accessor, a => a.get(IVoltRecordingStatusService));
	const browserService = optional(accessor, a => a.get(IVoltBrowserService));
	const recording = !!recordings?.recordings.length;
	const capture: BrowserMenuEntry[] = [{
		kind: 'item',
		label: recording ? localize('voltBrowser.menu.stopRecording', "Stop Recording") : localize('voltBrowser.menu.record', "Record Window…"),
		run: () => recording ? void Promise.all(recordings!.recordings.map(entry => entry.stop())) : void commandService.executeCommand(RECORD_WINDOW_COMMAND_ID),
	}];
	const devices: BrowserMenuEntry[] = [{
		kind: 'item',
		label: localize('voltBrowser.menu.simulators', "Open iOS Simulator / Android Emulator"),
		run: () => void commandService.executeCommand(OPEN_DEVICE_PREVIEW_COMMAND_ID),
	}];
	const agents: BrowserMenuEntry[] = access ? [{
		kind: 'toggle',
		label: context.sessionId ? localize('voltBrowser.menu.agentAccessChat', "Let Agents Use the Browser in This Chat") : localize('voltBrowser.menu.agentAccess', "Let Agents Use the Browser"),
		checked: !access.blockReason(context.sessionId),
		run: checked => {
			if (context.sessionId) {
				access.setChatChoice(context.sessionId, checked);
			} else {
				void configurationService.updateValue(AGENT_BROWSER_ACCESS_SETTING, checked);
			}
			context.toast(checked ? localize('voltBrowser.agentsAllowed', "Agents can use the browser") : localize('voltBrowser.agentsBlocked', "Agents can't use the browser"));
		},
	}] : [];
	const profile: BrowserMenuEntry[] = browserService ? [{
		kind: 'item',
		label: localize('voltBrowser.menu.importCookies', "Import Cookies from Browser…"),
		// After the ⋯ menu closes: the picker takes the same anchor.
		run: () => getWindow(context.anchor).setTimeout(() => void showCookieImportMenu(contextViewService, context.anchor, browserService, context.toast), 0),
	}] : [];
	return { capture, devices, agents, profile };
}
