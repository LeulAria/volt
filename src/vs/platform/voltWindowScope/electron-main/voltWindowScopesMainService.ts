/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { applyWindowScopeClaim, EMPTY_WINDOW_SCOPE, IVoltWindowScopeClaim, IVoltWindowScopes, IVoltWindowScopesService, IVoltWindowStart } from '../common/voltWindowScope.js';

export const IVoltWindowScopesMainService = createDecorator<IVoltWindowScopesMainService>('voltWindowScopesMainService');

/** How long a prepared start waits for its window to open. */
const PREPARED_START_MS = 15_000;

export interface IVoltWindowScopesMainService extends IVoltWindowScopesService {
	/** A new, empty scope for a window about to open; it takes a prepared start, if one waits. */
	createScope(): string;
	/** Ends every scope not in `live`: their windows are gone. */
	retainScopes(live: ReadonlySet<string>): void;
	/** The scopes as they are now, for a window's configuration. */
	readonly scopes: IVoltWindowScopes;
	/** A window was asked for one chat: the next new window gets a scope even with no main window open. */
	readonly hasPreparedStart: boolean;
}

/** Holds the scopes for the windows' lifetime only; nothing is written to disk. */
export class VoltWindowScopesMainService extends Disposable implements IVoltWindowScopesMainService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeScopes = this._register(new Emitter<IVoltWindowScopes>());
	readonly onDidChangeScopes = this._onDidChangeScopes.event;

	private _scopes: IVoltWindowScopes = {};
	/** Open in New Window: waits for the window it asked for. */
	private prepared: { readonly start: IVoltWindowStart; readonly at: number } | undefined;
	/** The chat each such window opens on load, until it asks for it. */
	private readonly starts = new Map<string, string>();

	constructor(@ILogService private readonly logService: ILogService) {
		super();
	}

	get scopes(): IVoltWindowScopes {
		return this._scopes;
	}

	get hasPreparedStart(): boolean {
		return !!this.prepared && Date.now() - this.prepared.at < PREPARED_START_MS;
	}

	createScope(): string {
		const id = generateUuid();
		const start = this.hasPreparedStart ? this.prepared?.start : undefined;
		this.prepared = undefined;
		let next: IVoltWindowScopes = { ...this._scopes, [id]: EMPTY_WINDOW_SCOPE };
		if (start) {
			const { openSession, ...claim } = start;
			next = applyWindowScopeClaim(next, id, claim);
			this.starts.set(id, openSession);
		}
		this.update(next);
		this.logService.trace('[voltWindowScopes] opened', id, start?.openSession);
		return id;
	}

	retainScopes(live: ReadonlySet<string>): void {
		const ended = Object.keys(this._scopes).filter(id => !live.has(id));
		if (!ended.length) {
			return;
		}
		const next = { ...this._scopes };
		for (const id of ended) {
			delete next[id];
			this.starts.delete(id);
		}
		this.logService.trace('[voltWindowScopes] closed', ended);
		this.update(next);
	}

	async getScopes(): Promise<IVoltWindowScopes> {
		return this._scopes;
	}

	async claim(scope: string | undefined, claim: IVoltWindowScopeClaim): Promise<void> {
		this.update(applyWindowScopeClaim(this._scopes, scope, claim));
	}

	async prepareWindow(start: IVoltWindowStart): Promise<void> {
		this.prepared = { start, at: Date.now() };
	}

	async takeWindowStart(scope: string): Promise<string | undefined> {
		const session = this.starts.get(scope);
		this.starts.delete(scope);
		return session;
	}

	private update(next: IVoltWindowScopes): void {
		if (next === this._scopes) {
			return;
		}
		this._scopes = next;
		this._onDidChangeScopes.fire(next);
	}
}
