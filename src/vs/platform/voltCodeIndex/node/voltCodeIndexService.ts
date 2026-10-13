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
import { IVoltCodeIndexFilesRequest, IVoltCodeIndexFilesResult, IVoltCodeIndexOptions, IVoltCodeIndexSearchRequest, IVoltCodeIndexSearchResult, IVoltCodeIndexService, IVoltCodeIndexStatus, IVoltCodeIndexSymbolsRequest, IVoltCodeIndexSymbolsResult, IVoltLspBudget, IVoltLspLimits, IVoltWorkspaceActivity } from '../common/voltCodeIndex.js';
import type { ICodeIndexWorker } from './codeIndexEngine.js';

/** The index process (and its file watchers) stays up this long after the last use. */
const KEEP_ALIVE_MS = 20 * 60_000;
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
				if (code && signal !== 'SIGTERM') {
					this.logService.warn(`[code index] process exited with ${code} ${signal ?? ''}`);
				}
			}));
			this.client = client;
			this.worker = ProxyChannel.toService<ICodeIndexWorker>(getNextTickChannel(client.getChannel('codeIndex')));
		}
		return this.worker!;
	}

	/** Holds the process (and its watchers) open while Volt is using the index. */
	private use(): ICodeIndexWorker {
		const worker = this.connect();
		if (!this.keepAlive) {
			this.keepAlive = worker.onDidChangeStatus(() => { /* only held to keep the process alive */ });
		}
		clearTimeout(this.keepAliveTimer);
		this.keepAliveTimer = setTimeout(() => {
			this.keepAlive?.dispose();
			this.keepAlive = undefined;
		}, KEEP_ALIVE_MS);
		return worker;
	}

	private failed(err: unknown): { readonly kind: 'fallback'; readonly reason: string } {
		this.logService.trace('[code index] call failed', err);
		return { kind: 'fallback', reason: err instanceof Error ? err.message : String(err) };
	}

	async warm(root: string, options?: IVoltCodeIndexOptions): Promise<void> {
		await this.use().warm(root, options).catch(err => this.logService.warn('[code index] warm failed', err));
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

	status(roots?: readonly string[]): Promise<readonly IVoltCodeIndexStatus[]> {
		return this.connect().status(roots).catch(() => []);
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
