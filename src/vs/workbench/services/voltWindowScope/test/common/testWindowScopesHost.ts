/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { applyWindowScopeClaim, EMPTY_WINDOW_SCOPE, IVoltWindowScopeClaim, IVoltWindowScopes, IVoltWindowScopesService } from '../../../../../platform/voltWindowScope/common/voltWindowScope.js';

/** The main process: scopes open with their window and end when it closes. */
export class TestWindowScopesHost extends Disposable implements IVoltWindowScopesService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeScopes = this._register(new Emitter<IVoltWindowScopes>());
	readonly onDidChangeScopes = this._onDidChangeScopes.event;

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

	private set(next: IVoltWindowScopes): void {
		if (next !== this.scopes) {
			this.scopes = next;
			this._onDidChangeScopes.fire(next);
		}
	}
}
