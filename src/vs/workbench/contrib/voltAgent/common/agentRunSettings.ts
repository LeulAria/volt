/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Show what runs start inside Volt: simulators and emulators that a run, a debug session or an
 * agent boots open in the device panel, and local pages (a run's dev server, an extension's
 * `openExternal` of localhost) open in Volt's browser.
 */
export const AGENT_RUN_SHOW_IN_VOLT_SETTING = 'volt.agent.run.showInVolt';

/** Mirror extensions' status bar items (Go Live, the Flutter device) in the chat side toolbar. */
export const AGENT_RUN_STATUS_ITEMS_SETTING = 'volt.agent.run.extensionStatusItems';

/** A page on this computer (a dev server), which Volt's browser can show. */
export function isLocalPageUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return false;
		}
		const host = parsed.hostname.toLowerCase();
		return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]' || host === '::1';
	} catch {
		return false;
	}
}
