/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import type * as http from 'http';
import type { Socket } from 'net';
import { homedir } from 'os';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { parse as parseJsonc } from '../../../base/common/json.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { FileAccess } from '../../../base/common/network.js';
import { dirname, join, normalize, sep } from '../../../base/common/path.js';
import { IServerChannel, ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { parseArgs } from '../../../platform/environment/node/argv.js';
import { ILogService } from '../../../platform/log/common/log.js';
import product from '../../../platform/product/common/product.js';
import { RemoteAgentConnectionContext } from '../../../platform/remote/common/remoteAgentEnvironment.js';
import { IAgentServerAuth } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { VOLT_FS_BROWSE_CHANNEL_NAME } from '../../../platform/voltFsBrowse/common/voltFsBrowse.js';
import { VoltFsBrowseService } from '../../../platform/voltFsBrowse/node/voltFsBrowseService.js';
import { IVoltGitService, VOLT_GIT_CHANNEL_NAME } from '../../../platform/voltGit/common/voltGit.js';
import { IVoltCodeIndexService, VOLT_CODE_INDEX_CHANNEL_NAME } from '../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { VOLT_SOURCE_CONTROL_HOSTS_SETTING } from '../../../platform/voltPullRequests/common/voltPrHosts.js';
import { IVoltPullRequestService, VOLT_PULL_REQUEST_CHANNEL_NAME } from '../../../platform/voltPullRequests/common/voltPullRequests.js';
import { VoltPullRequestService } from '../../../platform/voltPullRequests/node/voltPullRequestService.js';
import { IVoltExecRequest, IVoltStdioSpawnOptions, VOLT_STDIO_CHANNEL_NAME } from '../../../platform/voltStdio/common/voltStdio.js';
import { VoltStdioService } from '../../../platform/voltStdio/node/voltStdioService.js';
import { VOLT_USAGE_CHANNEL_NAME } from '../../../platform/voltUsage/common/voltUsage.js';
import { VoltUsageService } from '../../../platform/voltUsage/node/voltUsageService.js';
import type { IServerAPI, IServerEmbedder } from '../remoteExtensionHostAgentServer.js';
import { ServerParsedArgs, serverOptions } from '../serverEnvironmentService.js';
import type { SocketServer } from '../serverServices.js';

/** Where the workbench lives on the agent server's port (the web app keeps `/`). */
export const WORKBENCH_BASE_PATH = '/code';
/** `POST` with the device token as a bearer: the cookies that open the workbench. `DELETE` signs out. */
export const WORKBENCH_SESSION_PATH = '/api/workbench/session';

const SESSION_COOKIE = 'volt-session';
const CONNECTION_TOKEN_COOKIE = 'vscode-tkn';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/** The checkout in dev, the app's Resources/app when packaged. */
const APP_ROOT = dirname(FileAccess.asFileUri('').fsPath);

/** Settings that describe the desktop's window, not the workbench in a tab. */
const DESKTOP_ONLY_SETTING_PREFIXES = ['window.', 'update.', 'volt.agentServer.', 'remote.', 'keyboard.dispatch'];

export interface IServerWorkbenchOptions {
	/** The desktop's user data dir (holds `User/settings.json`). */
	readonly userDataDir: string;
	/** The agent server's own folder (`<userDataDir>/agentServer`). */
	readonly serverDir: string;
	readonly label: string;
	readonly environmentId: () => string;
	/** Whose device token this is; undefined once revoked. */
	readonly authorize: (token: string) => IAgentServerAuth | undefined;
	readonly resolveEnv: () => Promise<NodeJS.ProcessEnv>;
	readonly git: IVoltGitService;
	/** The code index (instant grep) the agents here use; the browser's settings page shows it. */
	readonly codeIndex?: IVoltCodeIndexService;
	/** Serves a file with the agent server's caching and compression. Resolves false when it is missing. */
	readonly sendFile: (req: http.IncomingMessage, res: http.ServerResponse, file: string, immutable: boolean) => Promise<boolean>;
	/** The machine's usage reader, shared with the agent server's `/api/usage` (other machines read it there). */
	readonly usage?: VoltUsageService;
	/** The agent server's pull request service, shared with paired phones' git screens. */
	readonly pullRequests?: IVoltPullRequestService;
}

/**
 * Volt's workbench in the browser, as code-server does it: VS Code's own server (remote extension
 * host, terminals, files, the web client) runs inside the agent server, under {@link WORKBENCH_BASE_PATH}.
 * It starts with the first page load. Only paired devices get in: every request and socket carries
 * the device's token in an http-only cookie, checked against the paired devices each time, so a
 * removed device is locked out at once. The agent UI talks to the agent server over `/ws`, the
 * same as the desktop with the agent server on; Volt's machine-side services (processes, git,
 * folders, pull requests, usage) are channels on the workbench's remote connection.
 */
export class ServerWorkbench extends Disposable {

	private server: Promise<IServerAPI> | undefined;
	private connectionToken: Promise<string> | undefined;
	private readonly isBuilt = !process.env['VSCODE_DEV'];

	constructor(
		private readonly options: IServerWorkbenchOptions,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/** Whether this build carries the web workbench (a dev checkout always does once compiled). */
	get available(): boolean {
		const page = this.isBuilt ? 'workbench.html' : 'workbench-dev.html';
		return existsSync(join(APP_ROOT, 'out', 'vs', 'code', 'browser', 'workbench', page));
	}

	//#region HTTP

	/** Answers the workbench's routes. Resolves false for any other path. */
	async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (url.pathname === WORKBENCH_SESSION_PATH) {
			await this.handleSession(req, res);
			return true;
		}
		if (url.pathname !== WORKBENCH_BASE_PATH && !url.pathname.startsWith(`${WORKBENCH_BASE_PATH}/`)) {
			return false;
		}
		if (!this.available) {
			res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('This Volt build does not include the browser workbench.');
			return true;
		}
		if (!this.signedIn(req)) {
			// A page load goes through the web app, which signs in (pairing or the local session) and comes back.
			if (req.method === 'GET' && /text\/html/.test(req.headers.accept ?? '')) {
				res.writeHead(302, { Location: `/?next=${encodeURIComponent(url.pathname + url.search)}`, 'Cache-Control': 'no-store' }).end();
			} else {
				res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Sign in to Volt first.');
			}
			return true;
		}
		// The workbench's own files: served here, compressed and (in a release) cached for good.
		const staticFiles = this.staticFiles(url.pathname);
		if (staticFiles && (req.method === 'GET' || req.method === 'HEAD')) {
			if (staticFiles === 'forbidden') {
				res.writeHead(403).end();
				return true;
			}
			for (const file of staticFiles) {
				if (await this.options.sendFile(req, res, file, this.isBuilt)) {
					return true;
				}
			}
			res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
			return true;
		}
		try {
			await (await this.ensureServer()).handleRequest(req, res);
		} catch (err) {
			this.logService.error('[volt agent server] the workbench server failed to start', err);
			if (!res.headersSent) {
				res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`The workbench could not start: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return true;
	}

	/** The remote connection's sockets (management, extension host, terminals). False for any other path. */
	handleUpgrade(req: http.IncomingMessage, socket: Socket): boolean {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (url.pathname !== WORKBENCH_BASE_PATH && !url.pathname.startsWith(`${WORKBENCH_BASE_PATH}/`)) {
			return false;
		}
		if (!this.available || !this.signedIn(req) || !sameOrigin(req)) {
			socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
			return true;
		}
		this.ensureServer().then(server => server.handleUpgrade(req, socket), err => {
			this.logService.error('[volt agent server] the workbench server failed to start', err);
			socket.destroy();
		});
		return true;
	}

	private signedIn(req: http.IncomingMessage): boolean {
		const token = readCookie(req, SESSION_COOKIE);
		return !!token && !!this.options.authorize(token);
	}

	private async handleSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
		if (req.method === 'DELETE') {
			res.writeHead(204, { 'Set-Cookie': [`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`, `${CONNECTION_TOKEN_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0${secure}`] }).end();
			return;
		}
		if (req.method !== 'POST' || !sameOrigin(req)) {
			res.writeHead(405, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'method_not_allowed' }));
			return;
		}
		const header = req.headers.authorization ?? '';
		const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
		if (!token || !this.options.authorize(token)) {
			res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized', message: 'This device is not paired with Volt any more.' }));
			return;
		}
		if (!this.available) {
			res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unavailable', message: 'This Volt build does not include the browser workbench.' }));
			return;
		}
		const connectionToken = await this.ensureConnectionToken();
		res.writeHead(200, {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			'Set-Cookie': [
				`${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure}`,
				// The workbench reads this one itself (it is VS Code's connection token, not the device's).
				`${CONNECTION_TOKEN_COOKIE}=${connectionToken}; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure}`,
			],
		}).end(JSON.stringify({ path: `${WORKBENCH_BASE_PATH}/` }));
		// Warm the server while the browser follows the link.
		void this.ensureServer().catch(() => undefined);
	}

	/**
	 * `/code/<quality>-<commit>/static/<path>` → the file under the app root. A packaged app keeps
	 * its node modules (the terminal's, the grammars') in an archive Electron reads as a folder.
	 */
	private staticFiles(pathname: string): readonly string[] | 'forbidden' | undefined {
		const match = /^\/code\/[^/]+\/static\/(.+)$/.exec(pathname);
		if (!match) {
			return undefined;
		}
		let relative: string;
		try {
			relative = decodeURIComponent(match[1]);
		} catch {
			return 'forbidden';
		}
		const file = normalize(join(APP_ROOT, relative));
		if (!file.startsWith(APP_ROOT + sep)) {
			return 'forbidden';
		}
		const modules = join(APP_ROOT, 'node_modules') + sep;
		if (this.isBuilt && file.startsWith(modules)) {
			const rest = file.slice(modules.length);
			return [file, join(APP_ROOT, 'node_modules.asar', rest), join(APP_ROOT, 'node_modules.asar.unpacked', rest)];
		}
		return [file];
	}

	//#endregion

	//#region The VS Code server

	private ensureConnectionToken(): Promise<string> {
		this.connectionToken ??= (async () => {
			const file = join(this.options.serverDir, 'workbench-token');
			try {
				const existing = (await fs.readFile(file, 'utf8')).trim();
				if (/^[0-9A-Za-z_-]{32,}$/.test(existing)) {
					return existing;
				}
			} catch {
				// first start
			}
			const token = randomBytes(32).toString('base64url');
			await fs.mkdir(this.options.serverDir, { recursive: true });
			await fs.writeFile(file, token, { mode: 0o600 });
			return token;
		})();
		return this.connectionToken;
	}

	/** Started once; a start that failed is tried again on the next request. */
	private ensureServer(): Promise<IServerAPI> {
		if (!this.server) {
			const started = this.startServer();
			started.catch(() => {
				if (this.server === started) {
					this.server = undefined;
				}
			});
			this.server = started;
		}
		return this.server;
	}

	private async startServer(): Promise<IServerAPI> {
		const dataDir = join(this.options.serverDir, 'workbench');
		const args = parseArgs([], serverOptions) as ServerParsedArgs;
		args['server-base-path'] = WORKBENCH_BASE_PATH;
		args['connection-token'] = await this.ensureConnectionToken();
		args['accept-server-license-terms'] = true;
		args['server-data-dir'] = dataDir;
		args['user-data-dir'] = join(dataDir, 'data');
		// The desktop's extensions, so the browser has the same ones.
		args['extensions-dir'] = join(homedir(), product.dataFolderName, 'extensions');
		args['builtin-extensions-dir'] = join(APP_ROOT, 'extensions');
		args['telemetry-level'] = 'off';
		if ((await this.desktopSettings())['security.workspace.trust.enabled'] === false) {
			args['disable-workspace-trust'] = true;
		}
		for (const dir of [dataDir, args['user-data-dir'], join(args['user-data-dir'], 'User'), join(args['user-data-dir'], 'Machine'), args['extensions-dir']]) {
			await fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
		}
		this.logService.info(`[volt agent server] starting the browser workbench (${this.isBuilt ? 'release' : 'dev'}) under ${WORKBENCH_BASE_PATH}`);
		const { createServer } = await import('../remoteExtensionHostAgentServer.js');
		const embedder: IServerEmbedder = {
			registerChannels: socketServer => this.registerChannels(socketServer),
			webConfiguration: () => this.webConfiguration(),
		};
		const server = await createServer(null, args, dataDir, embedder);
		this._register(toDisposable(() => server.dispose()));
		return server;
	}

	/** Volt's machine-side services, for the workbench windows (the desktop gets them from its main process). */
	private registerChannels(socketServer: SocketServer<RemoteAgentConnectionContext>): void {
		const store = this._register(new DisposableStore());
		const { resolveEnv, git, codeIndex, userDataDir } = this.options;

		// Each window's processes stop when its connection goes, as a desktop window's do when it closes.
		const stdio = store.add(new WorkbenchStdioService(this.logService, this.configurationService, userDataDir));
		const owners = new WeakMap<RemoteAgentConnectionContext, string>();
		let nextOwner = 0;
		const ownerOf = (ctx: RemoteAgentConnectionContext) => {
			let owner = owners.get(ctx);
			if (!owner) {
				owner = `workbench:${++nextOwner}`;
				owners.set(ctx, owner);
			}
			return owner;
		};
		store.add(socketServer.onDidRemoveConnection(connection => {
			const owner = owners.get(connection.ctx);
			if (owner) {
				stdio.release(owner);
			}
		}));
		socketServer.registerChannel(VOLT_STDIO_CHANNEL_NAME, stdioChannel(stdio, ownerOf, store));

		socketServer.registerChannel(VOLT_GIT_CHANNEL_NAME, ProxyChannel.fromService(git, store));
		if (codeIndex) {
			socketServer.registerChannel(VOLT_CODE_INDEX_CHANNEL_NAME, ProxyChannel.fromService(codeIndex, store));
		}
		socketServer.registerChannel(VOLT_FS_BROWSE_CHANNEL_NAME, ProxyChannel.fromService(store.add(new VoltFsBrowseService()), store));
		const pullRequests = this.options.pullRequests ?? store.add(new VoltPullRequestService(resolveEnv, this.logService, 'gh', {
			hostSettings: () => this.configurationService.getValue(VOLT_SOURCE_CONTROL_HOSTS_SETTING),
		}));
		socketServer.registerChannel(VOLT_PULL_REQUEST_CHANNEL_NAME, ProxyChannel.fromService(pullRequests, store));
		socketServer.registerChannel(VOLT_USAGE_CHANNEL_NAME, ProxyChannel.fromService(this.options.usage ?? new VoltUsageService(resolveEnv, this.logService, join(userDataDir, 'volt-usage')), store));
	}

	/**
	 * What the page starts with: the desktop's settings as defaults (theme, fonts, editor), the
	 * agent layout, Volt's product identity, and which paired environment this is.
	 */
	private async webConfiguration(): Promise<Record<string, unknown>> {
		const settings = await this.desktopSettings();
		const defaults: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(settings)) {
			if (!DESKTOP_ONLY_SETTING_PREFIXES.some(prefix => key.startsWith(prefix))) {
				defaults[key] = value;
			}
		}
		// The agent window: the agent list on the left, the primary side bar on the right.
		defaults['workbench.sideBar.location'] = 'right';
		// The desktop's title (a browser's adds the server's address).
		defaults['window.title'] ??= '${dirty}${activeEditorShort}${separator}${rootName}${separator}${profileName}${separator}${appName}';
		return {
			configurationDefaults: defaults,
			// The first frame in the desktop's colors, before the theme loads (no white flash).
			initialColorTheme: initialColorTheme(settings['workbench.colorTheme']),
			productConfiguration: productForWeb(),
			// The desktop's remote button: the icon alone, the computer in its tooltip.
			windowIndicator: { label: '$(remote)', tooltip: `Volt on ${this.options.label}` },
			voltAgentServer: { environmentId: this.options.environmentId(), wsPath: '/ws' },
		};
	}

	private async desktopSettings(): Promise<Record<string, unknown>> {
		try {
			const parsed = parseJsonc(await fs.readFile(join(this.options.userDataDir, 'User', 'settings.json'), 'utf8'));
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
		} catch {
			return {};
		}
	}

	//#endregion
}

/** {@link VoltStdioService} for workbench windows: what a window started stops with it. */
class WorkbenchStdioService extends VoltStdioService {
	release(owner: string): void {
		this.killOwnedBy(owner);
	}
}

/** As the desktop's channel: `spawn` and `exec` record the window, and output goes only to it. */
function stdioChannel(service: WorkbenchStdioService, ownerOf: (ctx: RemoteAgentConnectionContext) => string, store: DisposableStore): IServerChannel<RemoteAgentConnectionContext> {
	const proxied = ProxyChannel.fromService(service, store);
	return {
		call<T>(ctx: RemoteAgentConnectionContext, command: string, arg?: unknown, token?: CancellationToken): Promise<T> {
			if (command === 'spawn') {
				return service.spawnFor(ownerOf(ctx), (arg as [IVoltStdioSpawnOptions])[0]) as Promise<unknown> as Promise<T>;
			}
			if (command === 'exec') {
				return service.execFor(ownerOf(ctx), (arg as [IVoltExecRequest])[0]) as Promise<unknown> as Promise<T>;
			}
			return proxied.call<T>(ctx, command, arg, token);
		},
		listen<T>(ctx: RemoteAgentConnectionContext, event: string, arg?: unknown): Event<T> {
			if (event === 'onData') {
				return Event.filter(service.onData, e => service.ownerOf(e.id) === ownerOf(ctx)) as Event<unknown> as Event<T>;
			}
			if (event === 'onExit') {
				return Event.filter(service.onExit, e => service.ownerOf(e.id) === ownerOf(ctx)) as Event<unknown> as Event<T>;
			}
			return proxied.listen<T>(ctx, event, arg);
		},
	};
}

/** Volt Dark's or Volt Light's chrome, by the desktop's theme. */
function initialColorTheme(theme: unknown): { readonly themeType: 'dark' | 'light'; readonly colors: Record<string, string> } {
	const light = typeof theme === 'string' && /light/i.test(theme);
	const [background, chrome, foreground] = light ? ['#FCFCFC', '#F3F3F3', '#141414'] : ['#181818', '#141414', '#F0F0F0'];
	return {
		themeType: light ? 'light' : 'dark',
		colors: {
			'editor.background': background,
			'editor.foreground': foreground,
			'foreground': foreground,
			'titleBar.activeBackground': chrome,
			'activityBar.background': chrome,
			'sideBar.background': chrome,
			'statusBar.background': chrome,
			'panel.background': chrome,
			'editorGroupHeader.tabsBackground': chrome,
		},
	};
}

/** The product the page shows (name, icons, data folder), not the server's dev defaults. */
function productForWeb(): Record<string, unknown> {
	const keys = ['nameShort', 'nameLong', 'applicationName', 'dataFolderName', 'urlProtocol', 'version', 'commit', 'quality', 'date', 'licenseUrl', 'reportIssueUrl', 'documentationUrl', 'extensionsGallery', 'linkProtectionTrustedDomains', 'defaultChatAgent'] as const;
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		const value = (product as unknown as Record<string, unknown>)[key];
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

function readCookie(req: http.IncomingMessage, name: string): string | undefined {
	const header = req.headers.cookie;
	if (!header) {
		return undefined;
	}
	for (const part of header.split(';')) {
		const index = part.indexOf('=');
		if (index > 0 && part.slice(0, index).trim() === name) {
			const value = part.slice(index + 1).trim();
			try {
				return decodeURIComponent(value);
			} catch {
				return value;
			}
		}
	}
	return undefined;
}

/** Requests from another site's page (which would carry the cookies) are refused. */
function sameOrigin(req: http.IncomingMessage): boolean {
	const origin = req.headers.origin;
	if (!origin) {
		return true;
	}
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}
