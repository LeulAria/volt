/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { applyWindowScopeClaim, EMPTY_WINDOW_SCOPE, IVoltWindowScopeClaim, IVoltWindowScopes, IVoltWindowScopesService, IVoltWindowStart, mainWindowScope, withMainWindowScope } from '../../../../../platform/voltWindowScope/common/voltWindowScope.js';

/** The main process: scopes open with their window and end when it closes. */
export class TestWindowScopesHost extends Disposable implements IVoltWindowScopesService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeScopes = this._register(new Emitter<IVoltWindowScopes>());
	readonly onDidChangeScopes = this._onDidChangeScopes.event;
	readonly onDidStartWindow = Event.None;
	readonly onDidRevealSession = Event.None;

	scopes: IVoltWindowScopes = {};

	open(scope: string): void {
		this.set({ ...this.scopes, [scope]: EMPTY_WINDOW_SCOPE });
	}

	close(scope: string): void {
		const next = { ...this.scopes };
		delete next[scope];
		this.set(next);
	}

	async getScopes(): Promise<IVoltWindowScopes> {
		return this.scopes;
	}

	async claim(scope: string | undefined, claim: IVoltWindowScopeClaim): Promise<void> {
		this.set(applyWindowScopeClaim(this.scopes, scope, claim));
	}

	async prepareWindow(_start: IVoltWindowStart): Promise<void> { }

	async takeWindowStart(_scope: string): Promise<string | undefined> {
		return undefined;
	}

	async didShowWindowStart(_scope: string): Promise<void> { }

	async revealSession(_sessionId: string, _fromScope: string | undefined): Promise<boolean> {
		return false;
	}

	/** Closes a window the way the main process does: with no main window left, the oldest scope is it. */
	retain(live: readonly string[], hasUnscopedWindow: boolean): void {
		let next: IVoltWindowScopes = Object.fromEntries(Object.entries(this.scopes).filter(([id]) => live.includes(id)));
		next = withMainWindowScope(next, mainWindowScope(next) ?? (hasUnscopedWindow ? undefined : live.find(id => !!next[id])));
		this.set(next);
	}

	private set(next: IVoltWindowScopes): void {
		if (next !== this.scopes) {
			this.scopes = next;
			this._onDidChangeScopes.fire(next);
		}
	}
}
