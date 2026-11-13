/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ResourceMap, ResourceSet } from '../../../../../base/common/map.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IAgentServerClientService } from '../../../../services/voltAgentServer/common/agentServerClient.js';
import { CodeIntelHost } from '../../../../services/voltRuntime/browser/host/codeIntelHost.js';
import { ICodeRange } from '../../../../services/voltRuntime/browser/tools/codeTools.js';
import { lspAllowedFor } from '../../../../services/voltRuntime/common/codeIntelligence.js';
import { IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { PROJECT_SETTINGS_STORAGE_KEY } from '../../../voltSetup/common/projectSettings.js';
import { AgentEditsJournalEntry } from '../../common/agentEditsJournal.js';
import { IAgentEditsService } from '../review/agentEditsService.js';
import { IAgentSurfaceDraft, IAgentWorkspaceService } from '../workspace/agentWorkspace.js';

/** Unsaved documents larger than this stay out of the agent server's view (agents read the file on disk). */
const MAX_SHARED_DOCUMENT_CHARS = 4_000_000;

/**
 * How a window names the files the agent server names with `file:` URIs. The desktop names them
 * the same; the browser workbench's editors and language servers read them through `vscode-remote:`.
 */
export interface IAgentServerFileNames {
	/** The server's URI as this window's editors and language servers name it. */
	toWindow(uri: URI): URI;
	/** This window's URI as the server names it; undefined for one that is not on the server's disk. */
	toServer(uri: URI): URI | undefined;
}

export const DESKTOP_FILE_NAMES: IAgentServerFileNames = {
	toWindow: uri => uri,
	toServer: uri => uri.scheme === Schemas.file ? uri : undefined,
};

/** The browser workbench: the server's disk is the remote connection's (`vscode-remote://<authority>/<path>`). */
export function remoteFileNames(remoteAuthority: string): IAgentServerFileNames {
	return {
		toWindow: uri => uri.scheme === Schemas.file ? uri.with({ scheme: Schemas.vscodeRemote, authority: remoteAuthority }) : uri,
		toServer: uri => uri.scheme === Schemas.file ? uri : uri.scheme === Schemas.vscodeRemote && uri.authority === remoteAuthority ? uri.with({ scheme: Schemas.file, authority: '' }) : undefined,
	};
}

export interface IAgentServerWindowOptions {
	readonly files: IAgentServerFileNames;
	/**
	 * The window's Project Settings start from the server's copy when it connects. The browser
	 * workbench keeps its storage in the browser; the desktop's is the one the server imported.
	 */
	readonly projectSettingsFromServer: boolean;
}

/** URIs anywhere in a handler's arguments or answer (plain objects and arrays), mapped. */
function mapUris(value: unknown, map: (uri: URI) => URI): unknown {
	if (URI.isUri(value)) {
		return map(value);
	}
	if (Array.isArray(value)) {
		return value.map(item => mapUris(item, map));
	}
	if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapUris(item, map)]));
	}
	return value;
}

/**
 * What every Volt window does for the agent server, the desktop's and the browser workbench's
 * alike: opens the previews an agent asks for, answers the agents' language server questions,
 * shares its unsaved changes, keeps Project Settings in step, applies the edits journal to the
 * Keep/Undo review, shows the server's notices, and reconnects when the network comes back.
 */
export class AgentServerWindow extends Disposable {

	private readonly appliedEdits = new Set<string>();
	private applyingEdits = false;

	constructor(
		private readonly options: IAgentServerWindowOptions,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		instantiationService.invokeFunction(accessor => this.start(accessor));
	}

	private start(accessor: ServicesAccessor): void {
		const client = accessor.get(IAgentServerClientService);
		const workspace = accessor.get(IAgentWorkspaceService);
		const edits = accessor.get(IAgentEditsService);
		const notifications = accessor.get(INotificationService);
		const logService = accessor.get(ILogService);
		// The window's own copies of these services read the server; make them now so they listen from the first snapshot.
		accessor.get(IAgentRuntimeService);
		accessor.get(IVoltHostToolService);

		this._register(client.registerHandler('surface.open', (sessionId, draft, reuse) => {
			workspace.openSurface(String(sessionId), draft as IAgentSurfaceDraft, !!reuse);
			return true;
		}));
		this.serveCodeIntel(client, accessor, logService);
		this.shareDocuments(client, accessor);
		this.shareProjectSettings(client, accessor, logService);
		this._register(client.onDidResync(() => this.applyEdits(client, edits, logService)));
		const editsScheduler = this._register(new RunOnceScheduler(() => this.applyEdits(client, edits, logService), 0));
		this._register(client.onDidChangeCollection(e => {
			if (e.col === 'edits') {
				editsScheduler.schedule();
			}
		}));
		const pendingScheduler = this._register(new RunOnceScheduler(() => client.send('edits.setPending', edits.getPendingFiles().map(file => ({ uri: file.uri, sessionId: file.sessionId }))), 200));
		this._register(edits.onDidChange(() => pendingScheduler.schedule()));
		this._register(edits.onDidResolve(resolution => client.send('edits.resolved', resolution)));
		this._register(client.onServerEvent(event => {
			const notice = event as { kind?: string; severity?: Severity; message?: string };
			if (notice.kind === 'notification' && notice.message) {
				notifications.notify({ severity: notice.severity ?? Severity.Info, message: notice.message });
			}
		}));
		this._register(client.connection.onDidFail(failure => logService.error(`[volt agent server] connection refused (${failure.code}): ${failure.reason}`)));
		const online = () => {
			logService.info('[volt agent server] the network is back; reconnecting');
			client.connection.reconnect();
		};
		globalThis.addEventListener?.('online', online);
		this._register({ dispose: () => globalThis.removeEventListener?.('online', online) });
	}

	/**
	 * Agents in the server ask this window's language servers (go to definition, references,
	 * outline, diagnostics). Worktrees outside this window's folders follow Settings > Code Intelligence.
	 */
	private serveCodeIntel(client: IAgentServerClientService, accessor: ServicesAccessor, logService: ILogService): void {
		const configuration = accessor.get(IConfigurationService);
		const workspace = accessor.get(IWorkspaceContextService);
		const files = this.options.files;
		// The server sends a file's queries to the window that has its folder open.
		const sendFolders = () => client.call('codeIntel.setFolders', workspace.getWorkspace().folders.map(folder => files.toServer(folder.uri)?.fsPath).filter((path): path is string => !!path))
			.catch(err => logService.trace('[volt agent server] could not send this window\'s folders', err));
		this._register(workspace.onDidChangeWorkspaceFolders(() => void sendFolders()));
		this._register(client.onDidResync(() => void sendFolders()));
		if (client.isReady) {
			void sendFolders();
		}
		const host = this._register(new CodeIntelHost(accessor.get(IMarkerService), accessor.get(ITextModelService), accessor.get(ILanguageFeaturesService), accessor.get(IFileService)));
		host.setLspPolicy(uri => lspAllowedFor(configuration, !workspace.isInsideWorkspace(uri)));
		const allowed = (uri: unknown): uri is URI => URI.isUri(uri) && host.lspAllowed(uri);
		// The server's `file:` URIs come in as this window names them, and the answers go back in the server's names.
		const handle = (method: string, handler: (...args: unknown[]) => unknown) => this._register(client.registerHandler(method, async (...args) =>
			mapUris(await handler(...args.map(arg => mapUris(arg, files.toWindow))), uri => files.toServer(uri) ?? uri)));
		handle('codeIntel.noteWrite', uri => {
			if (URI.isUri(uri)) {
				host.noteWrite(uri);
			}
			return true;
		});
		handle('codeIntel.errorCounts', uri => URI.isUri(uri) ? [...host.errorCounts(uri)] : []);
		handle('codeIntel.newErrors', (uri, baseline) =>
			allowed(uri) ? host.newErrors(uri, new Map(Array.isArray(baseline) ? baseline as [string, number][] : [])) : []);
		handle('codeIntel.diagnostics', (uris, severity) => {
			const list = Array.isArray(uris) ? uris.filter(allowed) : undefined;
			if (Array.isArray(uris) && uris.length && !list?.length) {
				throw new Error('Language servers are off for this checkout (Settings > Code Intelligence), so the editor has no diagnostics for it. Run the project\'s type checker or linter instead.');
			}
			return host.diagnostics(list?.length ? list : undefined, severity === 'warning' || severity === 'all' ? severity : 'error');
		});
		const position = (line: unknown, column: unknown) => Number.isInteger(line) && Number.isInteger(column) && (line as number) >= 1 && (column as number) >= 1;
		handle('codeIntel.definitions', (uri, line, column) => allowed(uri) && position(line, column) ? host.definitions(uri, line as number, column as number) : []);
		handle('codeIntel.references', (uri, line, column) => allowed(uri) && position(line, column) ? host.references(uri, line as number, column as number) : []);
		handle('codeIntel.symbols', uri => allowed(uri) ? host.symbols(uri) : []);
		const direction = <T extends string>(value: unknown, options: readonly T[]): T | undefined => options.find(option => option === value);
		const range = (value: unknown): ICodeRange | undefined => {
			const record = value as Partial<ICodeRange> | undefined;
			return record && Number.isInteger(record.startLine) && Number.isInteger(record.endLine) ? { startLine: record.startLine!, endLine: record.endLine! } : undefined;
		};
		const text = (value: unknown) => typeof value === 'string' ? value : undefined;
		handle('codeIntel.fileText', uri => allowed(uri) ? host.fileText(uri) : undefined);
		handle('codeIntel.implementations', (uri, line, column) => allowed(uri) && position(line, column) ? host.implementations(uri, line as number, column as number) : []);
		handle('codeIntel.typeDefinitions', (uri, line, column) => allowed(uri) && position(line, column) ? host.typeDefinitions(uri, line as number, column as number) : []);
		handle('codeIntel.hover', (uri, line, column) => allowed(uri) && position(line, column) ? host.hover(uri, line as number, column as number) : undefined);
		handle('codeIntel.workspaceSymbols', (query, limit) => typeof query === 'string' ? host.workspaceSymbols(query, Number.isInteger(limit) ? limit as number : 80) : []);
		handle('codeIntel.calls', (uri, line, column, way) => {
			const value = direction(way, ['incoming', 'outgoing'] as const);
			return allowed(uri) && position(line, column) && value ? host.calls(uri, line as number, column as number, value) : undefined;
		});
		handle('codeIntel.typeHierarchy', (uri, line, column, way) => {
			const value = direction(way, ['supertypes', 'subtypes'] as const);
			return allowed(uri) && position(line, column) && value ? host.typeHierarchy(uri, line as number, column as number, value) : undefined;
		});
		const off = 'Language servers are off for this checkout (Settings > Code Intelligence). Edit the files directly.';
		handle('codeIntel.rename', (uri, line, column, newName) => allowed(uri) && position(line, column) && typeof newName === 'string' ? host.rename(uri, line as number, column as number, newName) : off);
		handle('codeIntel.format', uri => allowed(uri) ? host.format(uri) : off);
		handle('codeIntel.codeActions', (uri, value, only) => {
			const lines = range(value);
			return allowed(uri) && lines ? host.codeActions(uri, lines, text(only)) : [];
		});
		handle('codeIntel.applyCodeAction', (uri, value, only, title) => {
			const lines = range(value);
			return allowed(uri) && lines ? host.applyCodeAction(uri, lines, text(only), text(title)) : off;
		});
	}

	/**
	 * Agents in the server read what the user sees: this window's unsaved changes go to the server as
	 * they happen, and an agent's edit to such a file lands in the buffer here (and saves) instead of
	 * behind it on disk.
	 */
	private shareDocuments(client: IAgentServerClientService, accessor: ServicesAccessor): void {
		const textFiles = accessor.get(ITextFileService);
		const workingCopies = accessor.get(IWorkingCopyService);
		const files = this.options.files;
		/** Unsaved documents the server has (by the server's name), by the version it has. */
		const sent = new ResourceMap<number>();
		const send = (reset: boolean) => {
			if (!client.isReady) {
				return;
			}
			const changes: [URI, string | null][] = [];
			const dirty = new ResourceSet();
			for (const model of textFiles.files.models) {
				const text = model.textEditorModel;
				const uri = files.toServer(model.resource);
				if (!uri || !model.isDirty() || !text || text.getValueLength() > MAX_SHARED_DOCUMENT_CHARS) {
					continue;
				}
				dirty.add(uri);
				const version = text.getAlternativeVersionId();
				if (!reset && sent.get(uri) === version) {
					continue;
				}
				sent.set(uri, version);
				changes.push([uri, text.getValue()]);
			}
			for (const uri of [...sent.keys()]) {
				if (!dirty.has(uri)) {
					sent.delete(uri);
					changes.push([uri, null]);
				}
			}
			if (reset) {
				client.send('documents.reset');
			}
			if (changes.length) {
				client.send('documents.update', changes);
			}
		};
		const soon = this._register(new RunOnceScheduler(() => send(false), 300));
		this._register(workingCopies.onDidChangeDirty(() => soon.schedule()));
		this._register(workingCopies.onDidChangeContent(() => soon.schedule()));
		this._register(client.onDidResync(() => {
			sent.clear();
			send(true);
		}));
		if (client.isReady) {
			send(true);
		}
		this._register(client.registerHandler('documents.writeOpen', async (uri, text) => {
			const model = URI.isUri(uri) && typeof text === 'string' ? textFiles.files.get(uri) ?? textFiles.files.get(files.toWindow(uri)) : undefined;
			const editor = model?.textEditorModel;
			if (!model || !editor || typeof text !== 'string') {
				return false;
			}
			editor.pushEditOperations([], [{ range: editor.getFullModelRange(), text }], () => null);
			await model.save();
			return true;
		}));
	}

	/**
	 * Project Settings > Environment applies to what the server runs: it gets this window's settings
	 * when they change, and a change made in another window (desktop or browser) comes back here.
	 */
	private shareProjectSettings(client: IAgentServerClientService, accessor: ServicesAccessor, logService: ILogService): void {
		const storage = accessor.get(IStorageService);
		const local = () => storage.get(PROJECT_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION, '{}');
		let applying = false;
		const send = () => client.call('projectSettings.set', local())
			.catch(err => logService.warn('[volt agent server] could not send the project settings', err));
		const pull = async () => {
			const text = await client.call<unknown>('projectSettings.get').catch(err => {
				logService.trace('[volt agent server] could not read the project settings', err);
				return undefined;
			});
			if (typeof text === 'string' && text !== local()) {
				applying = true;
				try {
					storage.store(PROJECT_SETTINGS_STORAGE_KEY, text, StorageScope.APPLICATION, StorageTarget.USER);
				} finally {
					applying = false;
				}
			}
		};
		this._register(storage.onDidChangeValue(StorageScope.APPLICATION, PROJECT_SETTINGS_STORAGE_KEY, this._store)(() => {
			if (!applying) {
				void send();
			}
		}));
		const connected = () => void (this.options.projectSettingsFromServer ? pull() : send());
		this._register(client.onDidResync(connected));
		if (client.isReady) {
			connected();
		}
		this._register(client.onServerEvent(event => {
			if ((event as { kind?: string } | undefined)?.kind === 'projectSettings') {
				void pull();
			}
		}));
	}

	/** Applies new journal entries in order, then tells the server they are done. */
	private applyEdits(client: IAgentServerClientService, edits: IAgentEditsService, logService: ILogService): void {
		if (this.applyingEdits) {
			return;
		}
		const entries = client.mirror.entries<AgentEditsJournalEntry>('edits')
			.filter(([id]) => !this.appliedEdits.has(id))
			.sort(([a], [b]) => a.localeCompare(b));
		if (!entries.length) {
			return;
		}
		this.applyingEdits = true;
		void (async () => {
			const done: string[] = [];
			for (const [id, entry] of entries) {
				try {
					await edits.applyJournalEntry(entry);
				} catch (err) {
					logService.warn('[volt agent server] could not apply an edits journal entry', err);
				}
				this.appliedEdits.add(id);
				done.push(id);
			}
			client.send('edits.ack', done);
		})().finally(() => {
			this.applyingEdits = false;
			if (client.mirror.entries('edits').some(([id]) => !this.appliedEdits.has(id))) {
				this.applyEdits(client, edits, logService);
			}
		});
	}
}
