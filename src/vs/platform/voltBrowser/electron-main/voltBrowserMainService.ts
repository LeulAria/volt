/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { session, webContents, type WebContents } from 'electron';
import { ILogService } from '../../log/common/log.js';
import { isPreviewPartition, IVoltCookieImportRequest, IVoltCookieImportResult, IVoltCookieSource, matchesDomainFilter, parseDomainFilter, siteOf, toElectronCookie } from '../common/browserCookies.js';
import { IVoltBrowserService, VOLT_BROWSER_PARTITION, VoltBrowserColorScheme, VoltBrowserDataKind } from '../common/voltBrowser.js';
import { listCookieSources, readCookies } from '../node/browserCookieReader.js';

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

	async setFocusEmulation(webContentsId: number, enabled: boolean): Promise<boolean> {
		const contents = this.browserPage(webContentsId);
		if (!contents) {
			return false;
		}
		const protocol = contents.debugger;
		try {
			if (!protocol.isAttached()) {
				if (!enabled) {
					return true;
				}
				protocol.attach('1.3');
			}
			await protocol.sendCommand('Emulation.setFocusEmulationEnabled', { enabled });
			return true;
		} catch (err) {
			this.logService.warn('[volt] browser focus emulation failed', err);
			return false;
		}
	}

	listCookieSources(): Promise<IVoltCookieSource[]> {
		return listCookieSources();
	}

	async importCookies(request: IVoltCookieImportRequest): Promise<IVoltCookieImportResult> {
		const partition = request.partition ?? VOLT_BROWSER_PARTITION;
		if (!isPreviewPartition(partition)) {
			throw new Error(`Cookies can only be imported into a preview browser profile, not ${partition}.`);
		}
		const source = (await listCookieSources()).find(candidate => candidate.id === request.sourceId);
		if (!source) {
			throw new Error('That browser profile is no longer there.');
		}
		const read = await readCookies(source);
		const filter = parseDomainFilter(request.domains ?? []);
		const cookies = session.fromPartition(partition).cookies;
		const sites = new Set<string>();
		let imported = 0;
		let skipped = read.partitioned;
		let failed = read.undecryptable;
		const now = Date.now() / 1000;
		for (const cookie of read.cookies) {
			if (!matchesDomainFilter(cookie.host, filter)) {
				skipped++;
				continue;
			}
			const details = toElectronCookie(cookie, now);
			if ('skip' in details) {
				skipped++;
				continue;
			}
			try {
				await cookies.set(details);
				imported++;
				sites.add(siteOf(cookie.host));
			} catch (err) {
				failed++;
				this.logService.trace(`[volt] cookie ${cookie.name} for ${cookie.host} was refused`, err);
			}
		}
		await cookies.flushStore();
		this.logService.info(`[volt] imported ${imported} cookies from ${source.browserLabel} (${source.profile}) into ${partition}; ${skipped} skipped, ${failed} failed`);
		return { imported, skipped, failed, sites: sites.size, warnings: read.warnings };
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
