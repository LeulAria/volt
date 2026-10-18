/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IPath, join, posix } from '../../../base/common/path.js';
import { OperatingSystem } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { IStorage, Storage } from '../../../base/parts/storage/common/storage.js';
import { SQLiteStorageDatabase } from '../../../base/parts/storage/node/storage.js';
import { ITextModelService } from '../../../editor/common/services/resolverService.js';
import { CommandsRegistry, ICommandEvent, ICommandService } from '../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { AbstractLogger, ILogger, LogLevel } from '../../../platform/log/common/log.js';
import { INotification, INotificationHandle, INotificationService, NoOpNotification } from '../../../platform/notification/common/notification.js';
import { ISecretStorageService } from '../../../platform/secrets/common/secrets.js';
import { AbstractStorageService, IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { AUTOMATE_BROWSER_COMMAND_ID, BROWSER_PAGE_URL_COMMAND_ID, CAPTURE_BROWSER_SNAPSHOT_COMMAND_ID } from '../../../workbench/services/voltRuntime/common/hostTools.js';
import { toWire } from '../../../platform/voltAgentServer/common/wire.js';
import { IAgentServerClients } from './serverClients.js';
import { IAnyWorkspaceIdentifier, ISingleFolderWorkspaceIdentifier, IWorkspace, IWorkspaceContextService, IWorkspaceFolder, IWorkspaceFoldersChangeEvent, IWorkspaceFoldersWillChangeEvent, IWorkspaceIdentifier, WorkbenchState } from '../../../platform/workspace/common/workspace.js';
import { IUserDataProfile } from '../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustTransitionParticipant, IWorkspaceTrustUriInfo } from '../../../platform/workspace/common/workspaceTrust.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { IPathService } from '../../../workbench/services/path/common/pathService.js';
import { BeforeShutdownErrorEvent, BeforeShutdownEvent, ILifecycleService, LifecyclePhase, ShutdownReason, StartupKind, WillShutdownEvent, WillShutdownJoinerOrder } from '../../../workbench/services/lifecycle/common/lifecycle.js';
import { IFileMatch, IFileQuery, ISearchComplete, ISearchProgressItem, ISearchService, ISerializedSearchComplete, ISerializedSearchProgressItem, isSerializedSearchComplete, isSerializedSearchSuccess, ITextQuery, SearchProviderType } from '../../../workbench/services/search/common/search.js';
import { SearchService as RawSearchService } from '../../../workbench/services/search/node/rawSearchService.js';

//#region Logging

/** Plain timestamped lines on stdout; launchd sends them to `<userData>/logs/agent-server.log`. */
export class ServerConsoleLogger extends AbstractLogger implements ILogger {

	constructor(level: LogLevel) {
		super();
		this.setLevel(level);
	}

	private write(level: LogLevel, label: string, message: string, args: unknown[]): void {
		if (!this.canLog(level)) {
			return;
		}
		const extra = args.map(arg => arg instanceof Error ? (arg.stack ?? arg.message) : typeof arg === 'string' ? arg : safeJson(arg)).join(' ');
		const line = `${new Date().toISOString()} [${label}] ${message}${extra ? ` ${extra}` : ''}\n`;
		(level >= LogLevel.Warning ? process.stderr : process.stdout).write(line);
	}

	trace(message: string, ...args: unknown[]): void { this.write(LogLevel.Trace, 'trace', message, args); }
	debug(message: string, ...args: unknown[]): void { this.write(LogLevel.Debug, 'debug', message, args); }
	info(message: string, ...args: unknown[]): void { this.write(LogLevel.Info, 'info', message, args); }
	warn(message: string, ...args: unknown[]): void { this.write(LogLevel.Warning, 'warn', message, args); }
	error(message: string | Error, ...args: unknown[]): void {
		this.write(LogLevel.Error, 'error', message instanceof Error ? (message.stack ?? message.message) : message, args);
	}
	flush(): void { }
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

//#endregion

//#region Storage

/**
 * Storage the server owns: SQLite files in `<userData>/agentServer/`. The default profile's
 * storage is the application storage (as in the desktop), so PROFILE reads and writes share it.
 */
export class ServerStorageService extends AbstractStorageService {

	private readonly application: Storage;
	private readonly workspace: Storage;

	constructor(private readonly dir: string) {
		super({ flushInterval: 5_000 });
		this.application = this._register(new Storage(new SQLiteStorageDatabase(join(dir, 'application.vscdb'))));
		this.workspace = this._register(new Storage(new SQLiteStorageDatabase(join(dir, 'workspace.vscdb'))));
		this._register(this.application.onDidChangeStorage(e => {
			this.emitDidChangeValue(StorageScope.APPLICATION, e);
			this.emitDidChangeValue(StorageScope.PROFILE, e);
		}));
		this._register(this.workspace.onDidChangeStorage(e => this.emitDidChangeValue(StorageScope.WORKSPACE, e)));
	}

	protected async doInitialize(): Promise<void> {
		await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
		await Promise.all([this.application.init(), this.workspace.init()]);
	}

	protected getStorage(scope: StorageScope): IStorage {
		return scope === StorageScope.WORKSPACE ? this.workspace : this.application;
	}

	protected getLogDetails(scope: StorageScope): string | undefined {
		return join(this.dir, scope === StorageScope.WORKSPACE ? 'workspace.vscdb' : 'application.vscdb');
	}

	protected async switchToProfile(): Promise<void> { }
	protected async switchToWorkspace(): Promise<void> { }

	hasScope(_scope: IAnyWorkspaceIdentifier | IUserDataProfile): boolean {
		return false;
	}

	/** Every key in application storage (for the one-time import check). */
	applicationKeys(): string[] {
		return [...this.application.items.keys()];
	}

	async close(): Promise<void> {
		await this.flush();
		await Promise.all([this.application.close(), this.workspace.close()]);
	}
}

/**
 * Copies the agent settings (`volt.runtime.*`, `volt.agent.*`, ...) from the desktop's own
 * storage the first time a server starts on a profile, so profiles, model choices and projects
 * carry over. Read-only on the desktop's database.
 */
export async function importDesktopStorage(storage: ServerStorageService, userDataDir: string, prefixes: readonly string[]): Promise<number> {
	const source = join(userDataDir, 'User', 'globalStorage', 'state.vscdb');
	try {
		await fs.access(source);
	} catch {
		return 0;
	}
	const db = new SQLiteStorageDatabase(source);
	try {
		const items = await db.getItems();
		let count = 0;
		for (const [key, value] of items) {
			if (prefixes.some(prefix => key.startsWith(prefix))) {
				storage.store(key, value, StorageScope.APPLICATION, StorageTarget.MACHINE);
				count++;
			}
		}
		return count;
	} finally {
		await db.close(() => new Map());
	}
}

//#endregion

//#region Secrets

/**
 * Provider API keys. On macOS they go in the login Keychain (the desktop keeps them encrypted
 * with Electron's safeStorage, which a Node process can't open; the desktop hands them over once).
 * Values reach `security` on stdin, never on a command line. Elsewhere: a 0600 file.
 */
export class ServerSecretStorageService extends Disposable implements ISecretStorageService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSecret = this._register(new Emitter<string>());
	readonly onDidChangeSecret: Event<string> = this._onDidChangeSecret.event;

	readonly type = 'persisted' as const;

	private readonly cache = new Map<string, string | undefined>();
	private chain: Promise<unknown> = Promise.resolve();

	constructor(private readonly service: string, private readonly fallbackFile: string) {
		super();
	}

	get(key: string): Promise<string | undefined> {
		if (this.cache.has(key)) {
			return Promise.resolve(this.cache.get(key));
		}
		return this.serial(async () => {
			const value = process.platform === 'darwin' ? await this.keychainGet(key) : (await this.readFile())[key];
			this.cache.set(key, value);
			return value;
		});
	}

	set(key: string, value: string): Promise<void> {
		return this.serial(async () => {
			if (process.platform === 'darwin') {
				await this.securityStdin(`add-generic-password -U -s ${quote(this.service)} -a ${quote(key)} -w ${quote(value)}\n`);
			} else {
				const all = await this.readFile();
				all[key] = value;
				await this.writeFile(all);
			}
			this.cache.set(key, value);
			this._onDidChangeSecret.fire(key);
		});
	}

	delete(key: string): Promise<void> {
		return this.serial(async () => {
			if (process.platform === 'darwin') {
				await new Promise<void>(resolve => execFile('/usr/bin/security', ['delete-generic-password', '-s', this.service, '-a', key], () => resolve()));
			} else {
				const all = await this.readFile();
				delete all[key];
				await this.writeFile(all);
			}
			this.cache.set(key, undefined);
			this._onDidChangeSecret.fire(key);
		});
	}

	async keys(): Promise<string[]> {
		return [...this.cache.entries()].filter(([, value]) => value !== undefined).map(([key]) => key);
	}

	private serial<T>(work: () => Promise<T>): Promise<T> {
		const next = this.chain.then(work, work);
		this.chain = next.catch(() => undefined);
		return next;
	}

	private keychainGet(key: string): Promise<string | undefined> {
		return new Promise(resolve => {
			execFile('/usr/bin/security', ['find-generic-password', '-s', this.service, '-a', key, '-w'], { timeout: 10_000 }, (err, stdout) => {
				resolve(err ? undefined : String(stdout).replace(/\n$/, ''));
			});
		});
	}

	private securityStdin(commands: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
			let stderr = '';
			child.stderr.on('data', data => stderr += String(data));
			child.on('error', reject);
			child.on('close', code => code === 0 && !stderr.trim() ? resolve() : reject(new Error(`security failed (${code}): ${stderr.trim()}`)));
			child.stdin.end(commands);
		});
	}

	private async readFile(): Promise<Record<string, string>> {
		try {
			return JSON.parse(await fs.readFile(this.fallbackFile, 'utf8'));
		} catch {
			return {};
		}
	}

	private async writeFile(all: Record<string, string>): Promise<void> {
		await fs.writeFile(this.fallbackFile, JSON.stringify(all), { mode: 0o600 });
	}
}

/** Quotes one argument for `security -i`, which splits its input lines like a shell. */
function quote(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

//#endregion

//#region Workspace, paths, lifecycle

/** The server has no window and so no workspace: chats run in their projects' folders. */
export class ServerWorkspaceContextService implements IWorkspaceContextService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeWorkbenchState: Event<WorkbenchState> = Event.None;
	readonly onDidChangeWorkspaceName: Event<void> = Event.None;
	readonly onWillChangeWorkspaceFolders: Event<IWorkspaceFoldersWillChangeEvent> = Event.None;
	readonly onDidChangeWorkspaceFolders: Event<IWorkspaceFoldersChangeEvent> = Event.None;
	private readonly workspace: IWorkspace = { id: 'volt-agent-server', folders: [] };

	async getCompleteWorkspace(): Promise<IWorkspace> { return this.workspace; }
	getWorkspace(): IWorkspace { return this.workspace; }
	getWorkbenchState(): WorkbenchState { return WorkbenchState.EMPTY; }
	getWorkspaceFolder(_resource: URI): IWorkspaceFolder | null { return null; }
	isCurrentWorkspace(_workspaceIdOrFolder: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | URI): boolean { return false; }
	isInsideWorkspace(_resource: URI): boolean { return false; }
}

export class ServerPathService implements IPathService {
	declare readonly _serviceBrand: undefined;
	readonly path: Promise<IPath> = Promise.resolve(posix);
	readonly defaultUriScheme = 'file';
	readonly resolvedUserHome = URI.file(homedir());

	async fileURI(path: string): Promise<URI> { return URI.file(path); }

	userHome(options: { preferLocal: true }): URI;
	userHome(options?: { preferLocal: boolean }): Promise<URI>;
	userHome(options?: { preferLocal: boolean }): URI | Promise<URI> {
		return options?.preferLocal ? this.resolvedUserHome : Promise.resolve(this.resolvedUserHome);
	}

	hasValidBasename(resource: URI, basename?: string): Promise<boolean>;
	hasValidBasename(resource: URI, os: OperatingSystem, basename?: string): boolean;
	hasValidBasename(_resource: URI, arg2?: OperatingSystem | string): boolean | Promise<boolean> {
		return typeof arg2 === 'number' ? true : Promise.resolve(true);
	}
}

/**
 * Folder trust as the desktop decided it: the trusted folders it keeps in application storage
 * (WORKSPACE_TRUST_STORAGE_KEY), or everything when trust is turned off. The server never asks:
 * an untrusted project's own hooks simply don't run.
 */
export class ServerWorkspaceTrustService implements IWorkspaceTrustManagementService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeTrust: Event<boolean> = Event.None;
	readonly onDidChangeTrustedFolders: Event<void> = Event.None;
	readonly workspaceResolved = Promise.resolve();
	readonly workspaceTrustInitialized = Promise.resolve();
	acceptsOutOfWorkspaceFiles = false;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	private enabled(): boolean {
		return this.configurationService.getValue('security.workspace.trust.enabled') !== false;
	}

	getTrustedUris(): URI[] {
		try {
			const info = JSON.parse(this.storageService.get('content.trust.model.key', StorageScope.APPLICATION) ?? '{}') as { uriTrustInfo?: { uri: unknown; trusted?: boolean }[] };
			return (info.uriTrustInfo ?? []).filter(item => item.trusted).map(item => URI.revive(item.uri as URI));
		} catch {
			return [];
		}
	}

	async getUriTrustInfo(uri: URI): Promise<IWorkspaceTrustUriInfo> {
		const trusted = !this.enabled() || this.getTrustedUris().some(root => extUriBiasedIgnorePathCase.isEqualOrParent(uri, root));
		return { uri, trusted };
	}

	isWorkspaceTrusted(): boolean { return !this.enabled(); }
	isWorkspaceTrustForced(): boolean { return false; }
	canSetParentFolderTrust(): boolean { return false; }
	async setParentFolderTrust(_trusted: boolean): Promise<void> { }
	canSetWorkspaceTrust(): boolean { return false; }
	async setWorkspaceTrust(_trusted: boolean): Promise<void> { }
	async setUrisTrust(_uris: URI[], _trusted: boolean): Promise<void> { }
	async setTrustedUris(_uris: URI[]): Promise<void> { }
	addWorkspaceTrustTransitionParticipant(_participant: IWorkspaceTrustTransitionParticipant): IDisposable { return Disposable.None; }
}

/** Shutdown hooks (history flushes its logs) run when the server stops. */
export class ServerLifecycleService extends Disposable implements ILifecycleService {
	declare readonly _serviceBrand: undefined;
	readonly startupKind = StartupKind.NewWindow;
	phase = LifecyclePhase.Eventually;
	readonly onBeforeShutdown: Event<BeforeShutdownEvent> = Event.None;
	readonly onShutdownVeto: Event<void> = Event.None;
	readonly onBeforeShutdownError: Event<BeforeShutdownErrorEvent> = Event.None;
	private readonly _onWillShutdown = this._register(new Emitter<WillShutdownEvent>());
	readonly onWillShutdown: Event<WillShutdownEvent> = this._onWillShutdown.event;
	private readonly _onDidShutdown = this._register(new Emitter<void>());
	readonly onDidShutdown: Event<void> = this._onDidShutdown.event;
	willShutdown = false;

	async when(_phase: LifecyclePhase): Promise<void> { }

	async shutdown(): Promise<void> {
		if (this.willShutdown) {
			return;
		}
		this.willShutdown = true;
		const joiners: Promise<void>[] = [];
		this._onWillShutdown.fire({
			reason: ShutdownReason.QUIT,
			token: CancellationToken.None,
			join: (promise: Promise<void> | (() => Promise<void>), _joiner: { id: string; label: string; order?: WillShutdownJoinerOrder }) => {
				joiners.push(typeof promise === 'function' ? promise() : promise);
			},
			joiners: () => [],
			force: () => { },
		});
		await Promise.allSettled(joiners);
		this._onDidShutdown.fire();
	}
}

//#endregion

//#region Search

/**
 * Text and file search for the agent's grep/glob tools, run in-process with the same ripgrep
 * engine the desktop's search process uses.
 */
export class ServerSearchService implements Partial<ISearchService> {

	private readonly raw = new RawSearchService('searchProcess');

	textSearch(query: ITextQuery, token?: CancellationToken, onProgress?: (result: ISearchProgressItem) => void): Promise<ISearchComplete> {
		return this.run(this.raw.textSearch(query), token, onProgress);
	}

	fileSearch(query: IFileQuery, token?: CancellationToken): Promise<ISearchComplete> {
		return this.run(this.raw.fileSearch(query), token);
	}

	registerSearchResultProvider(_scheme: string, _type: SearchProviderType): IDisposable {
		return toDisposable(() => { });
	}

	async clearCache(_cacheKey: string): Promise<void> { }

	private run(event: Event<ISerializedSearchProgressItem | ISerializedSearchComplete>, token: CancellationToken | undefined, onProgress?: (result: ISearchProgressItem) => void): Promise<ISearchComplete> {
		return new Promise<ISearchComplete>((resolve, reject) => {
			const results: IFileMatch[] = [];
			const cancelHolder: { cancel?: IDisposable } = {};
			const listener = event(item => {
				if (isSerializedSearchComplete(item)) {
					listener.dispose();
					cancelHolder.cancel?.dispose();
					if (isSerializedSearchSuccess(item)) {
						resolve({ results, limitHit: item.limitHit, messages: item.messages, stats: item.stats });
					} else {
						reject(new Error(item.error?.message ?? 'Search failed.'));
					}
					return;
				}
				for (const match of Array.isArray(item) ? item : [item]) {
					if ('path' in match) {
						const fileMatch: IFileMatch = { resource: URI.file(match.path), results: match.results };
						results.push(fileMatch);
						onProgress?.(fileMatch);
					}
				}
			});
			cancelHolder.cancel = token?.onCancellationRequested(() => {
				listener.dispose();
				reject(new Error('Canceled'));
			});
		});
	}
}

//#endregion

//#region Commands, notifications, editor-only services

/** Commands only a Volt window can run (the in-app browser lives there). */
export const WINDOW_COMMANDS: ReadonlySet<string> = new Set([AUTOMATE_BROWSER_COMMAND_ID, BROWSER_PAGE_URL_COMMAND_ID, CAPTURE_BROWSER_SNAPSHOT_COMMAND_ID]);

/**
 * Runs commands from the CommandsRegistry (the checkpoint service registers its own). Commands
 * that need a window are run by a connected Volt window that has the in-app browser.
 */
export class ServerCommandService implements ICommandService {
	declare readonly _serviceBrand: undefined;
	private readonly _onWillExecuteCommand = new Emitter<ICommandEvent>();
	readonly onWillExecuteCommand = this._onWillExecuteCommand.event;
	private readonly _onDidExecuteCommand = new Emitter<ICommandEvent>();
	readonly onDidExecuteCommand = this._onDidExecuteCommand.event;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentServerClients private readonly clients: IAgentServerClients,
	) { }

	async executeCommand<T>(id: string, ...args: unknown[]): Promise<T | undefined> {
		const command = CommandsRegistry.getCommand(id);
		this._onWillExecuteCommand.fire({ commandId: id, args });
		try {
			if (command) {
				return this.instantiationService.invokeFunction(command.handler, ...args) as T;
			}
			if (WINDOW_COMMANDS.has(id)) {
				return await this.clients.call<T>('browser', 'command.execute', id, ...args.map(arg => toWire(arg)));
			}
			throw new Error(`command '${id}' not found on the agent server`);
		} finally {
			this._onDidExecuteCommand.fire({ commandId: id, args });
		}
	}
}

/** Notifications have no window to show in: they go to the log and to connected clients. */
export class ServerNotificationService implements Partial<INotificationService> {
	private readonly _onDidNotify = new Emitter<INotification>();
	readonly onDidNotify: Event<INotification> = this._onDidNotify.event;

	constructor(private readonly log: ILogger) { }

	notify(notification: INotification): INotificationHandle {
		this.log.info(`[notification] ${typeof notification.message === 'string' ? notification.message : notification.message instanceof Error ? notification.message.message : ''}`);
		this._onDidNotify.fire(notification);
		return new NoOpNotification();
	}

	info(message: string): INotificationHandle { return this.notify({ severity: 1, message }); }
	warn(message: string): INotificationHandle { return this.notify({ severity: 2, message }); }
	error(message: string | Error): INotificationHandle { return this.notify({ severity: 3, message }); }
}

/** No editor models on the server: code-intel tools that need one answer that they can't. */
export class ServerTextModelService implements Partial<ITextModelService> {
	createModelReference(): never {
		throw new Error('Code intelligence needs an open Volt window.');
	}
}

/** The agent writes files straight to disk; open editors in Volt reload from their watchers. */
export const serverTextFileService = {
	files: {
		get: () => undefined,
		onDidSave: Event.None,
	},
};

//#endregion
