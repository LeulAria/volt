/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { applyWindowScopeClaim, EMPTY_WINDOW_SCOPE, IVoltWindowScopeClaim, IVoltWindowScopes, IVoltWindowScopesService } from '../common/voltWindowScope.js';

export const IVoltWindowScopesMainService = createDecorator<IVoltWindowScopesMainService>('voltWindowScopesMainService');

export interface IVoltWindowScopesMainService extends IVoltWindowScopesService {
	/** A new, empty scope for a window about to open. */
	createScope(): string;
	/** Ends every scope not in `live`: their windows are gone. */
	retainScopes(live: ReadonlySet<string>): void;
	/** The scopes as they are now, for a window's configuration. */
	readonly scopes: IVoltWindowScopes;
}

/** Holds the scopes for the windows' lifetime only; nothing is written to disk. */
export class VoltWindowScopesMainService extends Disposable implements IVoltWindowScopesMainService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeScopes = this._register(new Emitter<IVoltWindowScopes>());
	readonly onDidChangeScopes = this._onDidChangeScopes.event;

	private _scopes: IVoltWindowScopes = {};

	constructor(@ILogService private readonly logService: ILogService) {
		super();
	}

	get scopes(): IVoltWindowScopes {
		return this._scopes;
	}

	createScope(): string {
		const id = generateUuid();
		this.update({ ...this._scopes, [id]: EMPTY_WINDOW_SCOPE });
		this.logService.trace('[voltWindowScopes] opened', id);
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

	private update(next: IVoltWindowScopes): void {
		if (next === this._scopes) {
			return;
		}
		this._scopes = next;
		this._onDidChangeScopes.fire(next);
	}
}
