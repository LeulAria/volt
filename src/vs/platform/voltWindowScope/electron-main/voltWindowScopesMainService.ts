/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { applyWindowScopeClaim, EMPTY_WINDOW_SCOPE, IVoltWindowRevealedSession, IVoltWindowScopeClaim, IVoltWindowScopes, IVoltWindowOpenedStart, IVoltWindowScopesService, IVoltWindowStart, mainWindowScope, sessionScope, withMainWindowScope } from '../common/voltWindowScope.js';

export const IVoltWindowScopesMainService = createDecorator<IVoltWindowScopesMainService>('voltWindowScopesMainService');

/** How long a prepared start waits for its window to open. */
const PREPARED_START_MS = 15_000;

export interface IVoltWindowScopesMainService extends IVoltWindowScopesService {
	/**
	 * A new, empty scope for a window about to open; it takes a prepared start, if one waits.
	 * `reserve`: for the window kept ready for the next New Window, which takes a start when it shows.
	 */
	createScope(reserve?: boolean): string;
	/**
	 * The window kept ready in `scope` is about to show: it gets the prepared start, if one waits.
	 * Returns when the window shows that chat (`didShowWindowStart`); undefined without a start.
	 */
	startScope(scope: string): Promise<void> | undefined;
	/**
	 * Ends every scope not in `live` (oldest window first): their windows are gone. With no window
	 * without a scope open, one scope is the main window too: the one already, else the oldest.
	 */
	retainScopes(live: readonly string[], hasUnscopedWindow: boolean): void;
	/** The window that shows what a scope owns (undefined: the main window), brought to the front. */
	setWindowShower(shower: (scope: string | undefined) => number | undefined): void;
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

	private readonly _onDidStartWindow = this._register(new Emitter<IVoltWindowOpenedStart>());
	readonly onDidStartWindow = this._onDidStartWindow.event;

	private readonly _onDidRevealSession = this._register(new Emitter<IVoltWindowRevealedSession>());
	readonly onDidRevealSession = this._onDidRevealSession.event;

	private showWindow: ((scope: string | undefined) => number | undefined) | undefined;

	private _scopes: IVoltWindowScopes = {};
	/** Open in New Window: waits for the window it asked for. */
	private prepared: { readonly start: IVoltWindowStart; readonly at: number } | undefined;
	/** The chat each such window opens on load, until it asks for it. */
	private readonly starts = new Map<string, string>();
	/** Windows given a chat after they loaded, until they show it. */
	private readonly shownStarts = new Map<string, () => void>();

	constructor(@ILogService private readonly logService: ILogService) {
		super();
	}

	get scopes(): IVoltWindowScopes {
		return this._scopes;
	}

	get hasPreparedStart(): boolean {
		return !!this.prepared && Date.now() - this.prepared.at < PREPARED_START_MS;
	}

	createScope(reserve?: boolean): string {
		const id = generateUuid();
		const start = reserve ? undefined : this.takePreparedStart();
		let next: IVoltWindowScopes = { ...this._scopes, [id]: EMPTY_WINDOW_SCOPE };
		if (start) {
			const { openSession, ...claim } = start;
			next = applyWindowScopeClaim(next, id, claim);
			if (openSession) {
				this.starts.set(id, openSession);
			}
		}
		this.update(next);
		this.logService.trace('[voltWindowScopes] opened', id, start?.openSession);
		return id;
	}

	startScope(scope: string): Promise<void> | undefined {
		const start = this._scopes[scope] ? this.takePreparedStart() : undefined;
		if (!start) {
			return undefined;
		}
		const { openSession, ...claim } = start;
		// The scope first, so the window lists the chat by the time it is asked to show it.
		this.update(applyWindowScopeClaim(this._scopes, scope, claim));
		if (!openSession) {
			return undefined;
		}
		const shown = new Promise<void>(resolve => this.shownStarts.set(scope, resolve));
		this.logService.trace('[voltWindowScopes] started', scope, openSession);
		this._onDidStartWindow.fire({ scope, session: openSession });
		return shown;
	}

	async didShowWindowStart(scope: string): Promise<void> {
		this.shownStarts.get(scope)?.();
		this.shownStarts.delete(scope);
	}

	private takePreparedStart(): IVoltWindowStart | undefined {
		const start = this.hasPreparedStart ? this.prepared?.start : undefined;
		this.prepared = undefined;
		return start;
	}

	retainScopes(live: readonly string[], hasUnscopedWindow: boolean): void {
		const alive = new Set(live);
		const ended = Object.keys(this._scopes).filter(id => !alive.has(id));
		let next = this._scopes;
		if (ended.length) {
			const kept = { ...this._scopes };
			for (const id of ended) {
				delete kept[id];
				this.starts.delete(id);
				this.shownStarts.get(id)?.();
				this.shownStarts.delete(id);
			}
			this.logService.trace('[voltWindowScopes] closed', ended);
			next = kept;
		}
		// Once a scoped window is the main window it stays so until it closes, so the chats it lists
		// never move away under the user. A window opened later beside it gets a scope of its own.
		const main = mainWindowScope(next) ?? (hasUnscopedWindow ? undefined : live.find(id => !!next[id]));
		this.update(withMainWindowScope(next, main));
	}

	setWindowShower(shower: (scope: string | undefined) => number | undefined): void {
		this.showWindow = shower;
	}

	async revealSession(sessionId: string, fromScope: string | undefined): Promise<boolean> {
		const owner = sessionScope(this._scopes, sessionId);
		const fromMain = fromScope === undefined || !!this._scopes[fromScope]?.main;
		if (owner === fromScope || (owner === undefined && fromMain)) {
			return false;
		}
		// Held by another window, or the main window's while this one is not it.
		const windowId = this.showWindow?.(owner);
		if (windowId === undefined) {
			return false;
		}
		this.logService.trace('[voltWindowScopes] revealed', sessionId, owner);
		this._onDidRevealSession.fire({ windowId, session: sessionId });
		return true;
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
