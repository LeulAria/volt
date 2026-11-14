/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { FileAccess } from '../../../base/common/network.js';
import { getNextTickChannel, ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { Client } from '../../../base/parts/ipc/node/ipc.cp.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltCodeIndexFilesRequest, IVoltCodeIndexFilesResult, IVoltCodeIndexFindFilesRequest, IVoltCodeIndexFindFilesResult, IVoltCodeIndexOptions, IVoltFffStatus, IVoltCodeIndexSearchRequest, IVoltCodeIndexSearchResult, IVoltCodeIndexService, IVoltCodeIndexStatus, IVoltCodeIndexSymbolsRequest, IVoltCodeIndexSymbolsResult, IVoltCodeImportersRequest, IVoltCodeImportersResult, IVoltCodeStructuralRequest, IVoltCodeStructuralResult, IVoltCodeStructureRequest, IVoltCodeStructureResult, IVoltLspBudget, IVoltLspLimits, IVoltWorkspaceActivity } from '../common/voltCodeIndex.js';
import type { ICodeIndexWorker } from './codeIndexEngine.js';

/** The index process (and its file watchers) stays up this long after the last search. */
const KEEP_ALIVE_MS = 20 * 60_000;
/**
 * After a warm-up alone (a workspace opened, an agent about to start) it stays this long: long enough for the
 * search that usually follows to find it hot, short enough that a window left alone does not keep a 50-60 MB
 * process and its watchers for 20 minutes (ADEMark A5/A6, round 6). The index is on disk; the next use forks
 * the process again and it catches up from file sizes and mtimes.
 */
const WARM_KEEP_ALIVE_MS = 90_000;
/** How long a status answer serves questions asked while no index process runs (see {@link VoltCodeIndexService.status}). */
const STATUS_CACHE_MS = 10 * 60_000;
/** Then it exits once no call is in flight for this long. */
const IDLE_EXIT_MS = 30_000;
/** A workbench that has not reported for this long is forgotten (it crashed or closed). */
const WORKSPACE_STALE_MS = 10 * 60_000;

interface IWorkspaceEntry {
	readonly activity: IVoltWorkspaceActivity;
	readonly lastActive: number;
	readonly reportedAt: number;
}

/**
 * Talks to the code index process, forking it on first use and letting it exit when Volt has
 * not searched for a while, so no process holds index memory between bursts of agent work.
 * Also keeps the language-server budget across all project workbenches (no process needed).
 */
export class VoltCodeIndexService extends Disposable implements IVoltCodeIndexService {

	declare readonly _serviceBrand: undefined;

	private client: Client | undefined;
	private worker: ICodeIndexWorker | undefined;
	private keepAlive: IDisposable | undefined;
	private keepAliveTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly workspaces = new Map<number, IWorkspaceEntry>();
	private allowed: readonly number[] = [];
	private readonly _onDidChangeLspBudget = this._register(new Emitter<IVoltLspBudget>());
	readonly onDidChangeLspBudget: Event<IVoltLspBudget> = this._onDidChangeLspBudget.event;

	constructor(
		private readonly dataDir: string,
		private readonly logService: ILogService,
	) {
		super();
		this._register({
			dispose: () => {
				clearTimeout(this.keepAliveTimer);
				this.keepAlive?.dispose();
				this.client?.dispose();
			}
		});
	}

	private connect(): ICodeIndexWorker {
		if (!this.client) {
			const client = new Client(FileAccess.asFileUri('bootstrap-fork').fsPath, {
				serverName: 'Volt Code Index',
				args: ['--type=voltCodeIndex'],
				timeout: IDLE_EXIT_MS,
				env: {
					VSCODE_ESM_ENTRYPOINT: 'vs/platform/voltCodeIndex/node/codeIndexWorkerMain',
					VSCODE_PIPE_LOGGING: 'true',
					VSCODE_VERBOSE_LOGGING: 'true',
					VOLT_CODE_INDEX_DIR: this.dataDir,
				},
			});
			this._register(client.onDidProcessExit(({ code, signal }) => {
				// The client forks a fresh process on the next call; hold it open again then.
				this.keepAlive = undefined;
				this.live = false;
				if (code && signal !== 'SIGTERM') {
					this.logService.warn(`[code index] process exited with ${code} ${signal ?? ''}`);
				}
			}));
			this.client = client;
			this.worker = ProxyChannel.toService<ICodeIndexWorker>(getNextTickChannel(client.getChannel('codeIndex')));
		}
		// Every call through the client forks the process when none runs.
		this.live = true;
		return this.worker!;
	}

	/** Until when the process is held open; a shorter hold never cuts a longer one. */
	private keepAliveUntil = 0;

	/** Holds the process (and its watchers) open while Volt is using the index, for `holdMs` after this use. */
	private use(holdMs = KEEP_ALIVE_MS): ICodeIndexWorker {
		const worker = this.connect();
		if (!this.keepAlive) {
			this.keepAlive = worker.onDidChangeStatus(() => { /* only held to keep the process alive */ });
			this.keepAliveUntil = 0;
		}
		const until = Date.now() + holdMs;
		if (until > this.keepAliveUntil) {
			this.keepAliveUntil = until;
			clearTimeout(this.keepAliveTimer);
			this.keepAliveTimer = setTimeout(() => {
				this.keepAlive?.dispose();
				this.keepAlive = undefined;
				this.keepAliveUntil = 0;
			}, holdMs);
		}
		return worker;
	}

	private failed(err: unknown): { readonly kind: 'fallback'; readonly reason: string } {
		this.logService.trace('[code index] call failed', err);
		return { kind: 'fallback', reason: err instanceof Error ? err.message : String(err) };
	}

	async warm(root: string, options?: IVoltCodeIndexOptions): Promise<void> {
		await this.use(WARM_KEEP_ALIVE_MS).warm(root, options).catch(err => this.logService.warn('[code index] warm failed', err));
	}

	search(request: IVoltCodeIndexSearchRequest): Promise<IVoltCodeIndexSearchResult> {
		return this.use().search(request).catch(err => this.failed(err));
	}

	files(request: IVoltCodeIndexFilesRequest): Promise<IVoltCodeIndexFilesResult> {
		return this.use().files(request).catch(err => this.failed(err));
	}

	symbols(request: IVoltCodeIndexSymbolsRequest): Promise<IVoltCodeIndexSymbolsResult> {
		return this.use().symbols(request).catch(err => this.failed(err));
	}

	structure(request: IVoltCodeStructureRequest): Promise<IVoltCodeStructureResult> {
		return this.use().structure(request).catch(err => this.failed(err));
	}

	importers(request: IVoltCodeImportersRequest): Promise<IVoltCodeImportersResult> {
		return this.use().importers(request).catch(err => this.failed(err));
	}

	structural(request: IVoltCodeStructuralRequest): Promise<IVoltCodeStructuralResult> {
		return this.use().structural(request).catch(err => this.failed(err));
	}

	findFiles(request: IVoltCodeIndexFindFilesRequest): Promise<IVoltCodeIndexFindFilesResult> {
		return this.use().findFiles(request).catch(err => this.failed(err));
	}

	fffStatus(fffPath?: string): Promise<IVoltFffStatus> {
		return this.connect().fffStatus(fffPath);
	}

	installFff(): Promise<IVoltFffStatus> {
		return this.use().installFff();
	}

	/**
	 * The last answer per root, for a question asked while no index process runs. Every agent start asked whether
	 * its project is large and indexed, which forked a 50-60 MB process for one number, 30 s each time (round 6).
	 * A live process answers itself; a stopped one is asked again only once the answer is older than
	 * STATUS_CACHE_MS, or for a root never asked about.
	 */
	private readonly statusCache = new Map<string, { at: number; status: IVoltCodeIndexStatus }>();
	/** Whether the process has been forked and has not exited since. */
	private live = false;

	status(roots?: readonly string[]): Promise<readonly IVoltCodeIndexStatus[]> {
		if (!this.live && roots?.length) {
			const now = Date.now();
			const cached = roots.map(root => this.statusCache.get(root));
			if (cached.every(entry => entry && now - entry.at < STATUS_CACHE_MS)) {
				return Promise.resolve(cached.map(entry => entry!.status));
			}
		}
		return this.connect().status(roots).then(list => {
			const at = Date.now();
			for (const status of list) {
				this.statusCache.set(status.root, { at, status });
			}
			return list;
		}).catch(() => []);
	}

	async rebuild(root: string, options?: IVoltCodeIndexOptions): Promise<void> {
		await this.use().rebuild(root, options);
	}

	async remove(root?: string): Promise<void> {
		await this.connect().remove(root);
	}

	async reportWorkspaceActivity(activity: IVoltWorkspaceActivity, limits: IVoltLspLimits): Promise<IVoltLspBudget> {
		const now = Date.now();
		if (activity.closed) {
			this.workspaces.delete(activity.windowId);
		} else {
			const previous = this.workspaces.get(activity.windowId);
			this.workspaces.set(activity.windowId, {
				activity,
				// A new window counts as just used; a background one keeps its last use.
				lastActive: activity.active || !previous ? now : previous.lastActive,
				reportedAt: now,
			});
		}
		for (const [id, entry] of [...this.workspaces]) {
			if (now - entry.reportedAt > WORKSPACE_STALE_MS) {
				this.workspaces.delete(id);
			}
		}
		const allowed = computeLspBudget([...this.workspaces.values()], limits);
		if (allowed.length !== this.allowed.length || allowed.some((id, i) => id !== this.allowed[i])) {
			this.allowed = allowed;
			this._onDidChangeLspBudget.fire({ allowed });
		}
		return { allowed };
	}
}

/**
 * Which windows may run language servers: the one on screen always; then, up to the limit for
 * its kind, ones with an agent at work, then the most recently used. With language servers
 * turned off, only the window on screen keeps them (its editor needs them).
 */
export function computeLspBudget(entries: readonly { readonly activity: IVoltWorkspaceActivity; readonly lastActive: number }[], limits: IVoltLspLimits): number[] {
	const allowed: number[] = [];
	for (const remote of [false, true]) {
		const limit = !limits.enabled ? 0 : Math.max(1, remote ? limits.maxRemote : limits.maxLocal);
		const ranked = entries
			.filter(entry => entry.activity.remote === remote)
			.sort((a, b) => Number(b.activity.active) - Number(a.activity.active) || Number(b.activity.busy) - Number(a.activity.busy) || b.lastActive - a.lastActive);
		ranked.forEach((entry, index) => {
			if (entry.activity.active || index < limit) {
				allowed.push(entry.activity.windowId);
			}
		});
	}
	return allowed.sort((a, b) => a - b);
}
