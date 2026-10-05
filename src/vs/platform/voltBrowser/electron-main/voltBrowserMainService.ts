/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { session, webContents, type WebContents } from 'electron';
import { ILogService } from '../../log/common/log.js';
import { IVoltBrowserService, VOLT_BROWSER_PARTITION, VoltBrowserColorScheme, VoltBrowserDataKind } from '../common/voltBrowser.js';

export class VoltBrowserMainService implements IVoltBrowserService {

	declare readonly _serviceBrand: undefined;

	constructor(@ILogService private readonly logService: ILogService) { }

	async clearData(kind: VoltBrowserDataKind): Promise<void> {
		const browserSession = session.fromPartition(VOLT_BROWSER_PARTITION);
		switch (kind) {
			case 'cookies':
				await browserSession.clearStorageData({ storages: ['cookies'] });
				return;
			case 'cache':
				await browserSession.clearCache();
				await browserSession.clearCodeCaches({});
				return;
			case 'siteData':
				await browserSession.clearStorageData({ storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem', 'shadercache', 'websql'] });
				return;
		}
	}

	async setColorScheme(webContentsId: number, scheme: VoltBrowserColorScheme): Promise<boolean> {
		const contents = this.browserPage(webContentsId);
		if (!contents) {
			return false;
		}
		const protocol = contents.debugger;
		try {
			if (!protocol.isAttached()) {
				if (scheme === 'system') {
					return true;
				}
				protocol.attach('1.3');
			}
			// An empty value drops the override; the page follows the OS again.
			await protocol.sendCommand('Emulation.setEmulatedMedia', {
				features: [{ name: 'prefers-color-scheme', value: scheme === 'system' ? '' : scheme }],
			});
			return true;
		} catch (err) {
			this.logService.warn('[volt] browser color scheme emulation failed', err);
			return false;
		}
	}

	/** Only pages of the in-app browser: any other web contents is out of reach. */
	private browserPage(id: number): WebContents | undefined {
		const contents = webContents.fromId(id);
		if (!contents || contents.isDestroyed() || contents.getType() !== 'webview') {
			return undefined;
		}
		return contents.session === session.fromPartition(VOLT_BROWSER_PARTITION) ? contents : undefined;
	}
}
