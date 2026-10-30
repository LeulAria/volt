/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, session, webContents, type WebContents } from 'electron';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { getResolvedShellEnv } from '../../shell/node/shellEnv.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { IVoltDevServer, IVoltEmulation, IVoltLocalServer, IVoltMockHit, IVoltMockRoute, IVoltPlayground, IVoltPlaygroundRequest, IVoltPlaygroundUpdate, matchMockRoute, NETWORK_PRESETS } from '../common/browserAgent.js';
import { BrowserPlaygrounds, listLocalServers } from '../node/browserPlaygrounds.js';
import { DevServers } from '../node/devServers.js';
import { isPreviewPartition, IVoltCookieImportRequest, IVoltCookieImportResult, IVoltCookieSource, matchesDomainFilter, parseDomainFilter, siteOf, toElectronCookie } from '../common/browserCookies.js';
import { IVoltBrowserService, IVoltSiteData, VOLT_BROWSER_PARTITION, VoltBrowserColorScheme, VoltBrowserDataKind, VoltSiteDataKind } from '../common/voltBrowser.js';
import { listCookieSources, readCookies } from '../node/browserCookieReader.js';

interface IPageAgentState {
	routes: readonly IVoltMockRoute[];
	used: number[];
	hits: IVoltMockHit[];
	emulation: IVoltEmulation;
	listening: boolean;
}

export class VoltBrowserMainService implements IVoltBrowserService {

	declare readonly _serviceBrand: undefined;

	/** Mocks and emulation per in-app browser page, while an agent has any set. */
	private readonly pages = new Map<number, IPageAgentState>();
	/** The appearance the user picked per page in the browser's menu; agent emulation ends back on it. */
	private readonly userSchemes = new Map<number, VoltBrowserColorScheme>();
	private readonly playgrounds: BrowserPlaygrounds;
	private readonly devServers: DevServers;
	private shellEnv: Promise<NodeJS.ProcessEnv> | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
	) {
		this.playgrounds = new BrowserPlaygrounds(message => this.logService.info(message));
		// Started from the Dock, the main process lacks the user's PATH (nvm, Homebrew); a dev server needs it.
		this.devServers = new DevServers(() => this.shellEnv ??= getResolvedShellEnv(this.configurationService, this.logService, this.environmentMainService.args, process.env).then(env => ({ ...process.env, ...env }), () => process.env), message => this.logService.info(message));
		lifecycleMainService.onWillShutdown(event => {
			event.join('voltPlaygrounds', this.playgrounds.dispose());
			event.join('voltDevServers', this.devServers.dispose());
		});
	}

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

	async siteData(webContentsId: number): Promise<IVoltSiteData | undefined> {
		const contents = this.browserPage(webContentsId);
		const url = contents?.getURL();
		if (!contents || !url || !/^https?:/i.test(url)) {
			return undefined;
		}
		const cookies = await contents.session.cookies.get({ url });
		return {
			url,
			origin: new URL(url).origin,
			cookies: cookies.map(cookie => ({
				name: cookie.name,
				value: cookie.value,
				...(cookie.domain ? { domain: cookie.domain } : {}),
				...(cookie.path ? { path: cookie.path } : {}),
				httpOnly: !!cookie.httpOnly,
				secure: !!cookie.secure,
				...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
				session: !!cookie.session,
				...(cookie.expirationDate !== undefined ? { expires: Math.round(cookie.expirationDate) } : {}),
			})),
		};
	}

	async clearSiteData(webContentsId: number, kinds: readonly VoltSiteDataKind[]): Promise<boolean> {
		const contents = this.browserPage(webContentsId);
		const url = contents?.getURL();
		if (!contents || !url) {
			return false;
		}
		const origin = /^https?:/i.test(url) ? new URL(url).origin : undefined;
		const storages = new Set<'cookies' | 'localstorage' | 'indexdb' | 'cachestorage' | 'serviceworkers' | 'websql' | 'filesystem'>();
		for (const kind of kinds) {
			switch (kind) {
				case 'cookies': storages.add('cookies'); break;
				case 'storage': storages.add('localstorage').add('websql').add('filesystem'); break;
				case 'indexeddb': storages.add('indexdb'); break;
				case 'cache_storage': storages.add('cachestorage'); break;
				case 'service_workers': storages.add('serviceworkers'); break;
				case 'http_cache': break;
			}
		}
		if (storages.size) {
			// A page without an http(s) origin (file:, about:) has no site to scope to: nothing to clear by origin.
			if (origin) {
				await contents.session.clearStorageData({ origin, storages: [...storages] });
			}
		}
		if (kinds.includes('http_cache')) {
			// Chromium keeps one HTTP cache per profile; there is no per-origin clear.
			await contents.session.clearCache();
			await contents.session.clearCodeCaches({});
		}
		return true;
	}

	async setColorScheme(webContentsId: number, scheme: VoltBrowserColorScheme): Promise<boolean> {
		const contents = this.browserPage(webContentsId);
		if (!contents) {
			return false;
		}
		const protocol = contents.debugger;
		const state = this.pages.get(contents.id);
		if (!this.userSchemes.has(contents.id)) {
			const id = contents.id;
			contents.once('destroyed', () => this.userSchemes.delete(id));
		}
		this.userSchemes.set(contents.id, scheme);
		try {
			if (!protocol.isAttached()) {
				if (scheme === 'system') {
					return true;
				}
				protocol.attach('1.3');
			}
			// An empty value drops the override; the page follows the OS again. An agent's emulation
			// (for this turn) wins over the user's choice and keeps its reduced-motion setting.
			const effective = state?.emulation.colorScheme ?? scheme;
			await protocol.sendCommand('Emulation.setEmulatedMedia', {
				features: [
					{ name: 'prefers-color-scheme', value: effective === 'system' ? '' : effective },
					...(state?.emulation.reducedMotion !== undefined ? [{ name: 'prefers-reduced-motion', value: state.emulation.reducedMotion ? 'reduce' : 'no-preference' }] : []),
				],
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

	async setNetworkMocks(webContentsId: number, routes: readonly IVoltMockRoute[]): Promise<boolean> {
		const contents = this.browserPage(webContentsId);
		if (!contents) {
			return false;
		}
		const state = this.stateFor(contents);
		state.routes = routes;
		state.used = routes.map(() => 0);
		state.hits = [];
		try {
			this.attach(contents);
			if (routes.length) {
				await contents.debugger.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
			} else {
				await contents.debugger.sendCommand('Fetch.disable');
			}
			return true;
		} catch (err) {
			this.logService.warn('[volt] browser network mocks failed', err);
			return false;
		}
	}

	async getMockHits(webContentsId: number): Promise<IVoltMockHit[]> {
		return this.pages.get(webContentsId)?.hits.slice() ?? [];
	}

	async emulate(webContentsId: number, emulation: IVoltEmulation, reset?: boolean): Promise<IVoltEmulation | undefined> {
		const contents = this.browserPage(webContentsId);
		if (!contents) {
			return undefined;
		}
		const state = this.stateFor(contents);
		const next: IVoltEmulation = reset ? { ...emulation } : { ...state.emulation, ...emulation };
		const scheme = next.colorScheme ?? this.userSchemes.get(contents.id) ?? 'system';
		try {
			this.attach(contents);
			const protocol = contents.debugger;
			await protocol.sendCommand('Emulation.setEmulatedMedia', {
				features: [
					{ name: 'prefers-color-scheme', value: scheme !== 'system' ? scheme : '' },
					{ name: 'prefers-reduced-motion', value: next.reducedMotion === undefined ? '' : next.reducedMotion ? 'reduce' : 'no-preference' },
				],
			});
			const preset = next.network && next.network !== 'none' ? NETWORK_PRESETS[next.network] : undefined;
			await protocol.sendCommand('Network.enable');
			await protocol.sendCommand('Network.emulateNetworkConditions', preset
				? { offline: preset.offline, latency: preset.latency, downloadThroughput: preset.download, uploadThroughput: preset.upload }
				: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
			await protocol.sendCommand('Emulation.setCPUThrottlingRate', { rate: next.cpuSlowdown ?? 1 });
			await protocol.sendCommand('Emulation.setTimezoneOverride', { timezoneId: next.timezone ?? '' }).catch(() => undefined);
			await protocol.sendCommand('Emulation.setLocaleOverride', next.locale ? { locale: next.locale } : {}).catch(() => undefined);
			state.emulation = next;
			return next;
		} catch (err) {
			this.logService.warn('[volt] browser emulation failed', err);
			return undefined;
		}
	}

	async captureFullPage(webContentsId: number, maxHeight = 8000): Promise<{ dataUrl: string; width: number; height: number; clipped: boolean } | undefined> {
		const contents = this.browserPage(webContentsId);
		if (!contents) {
			return undefined;
		}
		try {
			this.attach(contents);
			const metrics = await contents.debugger.sendCommand('Page.getLayoutMetrics') as { cssContentSize?: { width: number; height: number }; contentSize: { width: number; height: number }; cssLayoutViewport?: { clientWidth: number } };
			const size = metrics.cssContentSize ?? metrics.contentSize;
			const width = Math.ceil(metrics.cssLayoutViewport?.clientWidth ?? size.width);
			const height = Math.min(Math.ceil(size.height), maxHeight);
			const shot = await contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }) as { data: string };
			return { dataUrl: `data:image/png;base64,${shot.data}`, width, height, clipped: size.height > maxHeight };
		} catch (err) {
			this.logService.warn('[volt] full-page capture failed', err);
			return undefined;
		}
	}

	listLocalServers(): Promise<IVoltLocalServer[]> {
		return listLocalServers(new Set(app.getAppMetrics().map(metric => metric.pid)));
	}

	createPlayground(request: IVoltPlaygroundRequest): Promise<IVoltPlayground> {
		return this.playgrounds.create(request);
	}

	updatePlayground(update: IVoltPlaygroundUpdate): Promise<IVoltPlayground> {
		return this.playgrounds.update(update);
	}

	async listPlaygrounds(sessionId?: string): Promise<IVoltPlayground[]> {
		return this.playgrounds.list(sessionId);
	}

	deletePlaygrounds(selector: { readonly id?: string; readonly sessionId?: string }): Promise<IVoltPlayground[]> {
		return this.playgrounds.delete(selector);
	}

	startDevServer(cwd: string, command: string, waitMs: number): Promise<IVoltDevServer> {
		return this.devServers.start(cwd, command, Math.max(0, Math.min(60_000, waitMs)));
	}

	async listDevServers(): Promise<IVoltDevServer[]> {
		return this.devServers.list();
	}

	async stopDevServer(pid: number): Promise<boolean> {
		return this.devServers.stop(pid);
	}

	private attach(contents: WebContents): void {
		if (!contents.debugger.isAttached()) {
			contents.debugger.attach('1.3');
		}
	}

	private stateFor(contents: WebContents): IPageAgentState {
		let state = this.pages.get(contents.id);
		if (!state) {
			state = { routes: [], used: [], hits: [], emulation: {}, listening: false };
			this.pages.set(contents.id, state);
			const id = contents.id;
			contents.once('destroyed', () => this.pages.delete(id));
		}
		if (!state.listening) {
			state.listening = true;
			const page = state;
			contents.debugger.on('message', (_event, method, params) => {
				if (method === 'Fetch.requestPaused') {
					void this.answer(contents, page, params as { requestId: string; request: { url: string; method: string } });
				}
			});
			contents.debugger.on('detach', () => {
				page.listening = false;
			});
		}
		return state;
	}

	/** One intercepted request: answer it from the first matching route, or let it through. */
	private async answer(contents: WebContents, state: IPageAgentState, params: { requestId: string; request: { url: string; method: string } }): Promise<void> {
		const protocol = contents.debugger;
		const index = matchMockRoute(state.routes, params.request.url, params.request.method, state.used);
		const route = index >= 0 ? state.routes[index] : undefined;
		state.hits.push({ url: params.request.url, method: params.request.method, route: index, status: route && !route.abort ? route.status : undefined });
		if (state.hits.length > 200) {
			state.hits.shift();
		}
		try {
			if (!route) {
				await protocol.sendCommand('Fetch.continueRequest', { requestId: params.requestId });
				return;
			}
			state.used[index] = (state.used[index] ?? 0) + 1;
			if (route.delayMs) {
				await new Promise(resolve => setTimeout(resolve, route.delayMs));
			}
			if (route.abort) {
				await protocol.sendCommand('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Failed' });
				return;
			}
			const headers = [
				{ name: 'content-type', value: route.contentType },
				{ name: 'cache-control', value: 'no-store' },
				{ name: 'access-control-allow-origin', value: '*' },
				...Object.entries(route.headers).map(([name, value]) => ({ name, value })),
			];
			await protocol.sendCommand('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: route.status, responseHeaders: headers, body: Buffer.from(route.body).toString('base64') });
		} catch (err) {
			this.logService.trace('[volt] mock answer failed', err);
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
