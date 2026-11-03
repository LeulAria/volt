/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { applyWindowScopeClaim, IVoltWindowScopeClaim, IVoltWindowScopes, IVoltWindowScopesService, IVoltWindowScopeState, VoltWindowLayoutMode } from '../../../../platform/voltWindowScope/common/voltWindowScope.js';
import { IVoltWindowScopeService } from './voltWindowScope.js';

/**
 * Keeps this window's copy of the scopes. Claims apply here at once and then go to the main
 * process, whose updates replace the copy; what this window claimed itself is kept on top, so an
 * update sent before a claim arrived cannot drop it.
 */
export class VoltWindowScopeService extends Disposable implements IVoltWindowScopeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDidEndScopes = this._register(new Emitter<readonly IVoltWindowScopeState[]>());
	readonly onDidEndScopes = this._onDidEndScopes.event;

	private scopes: IVoltWindowScopes;
	/** Claimed here (scoped window), or projects a main window added itself (released everywhere). */
	private readonly ownSessions = new Set<string>();
	private readonly ownProjects = new Set<string>();
	private hiddenSessions = new Set<string>();
	private hiddenProjects = new Set<string>();

	constructor(
		readonly scope: string | undefined,
		initial: IVoltWindowScopes | undefined,
		private readonly host: IVoltWindowScopesService | undefined,
	) {
		super();
		this.scopes = initial ?? {};
		this.index();
		if (host) {
			let updated = false;
			this._register(host.onDidChangeScopes(scopes => {
				updated = true;
				this.replace(scopes);
			}));
			// The configuration was read when the window loaded; catch up with what changed since,
			// unless an update already came (it is newer).
			void host.getScopes().then(scopes => updated || this.replace(scopes), () => undefined);
		}
	}

	get layoutMode(): VoltWindowLayoutMode | undefined {
		return this.scope ? this.scopes[this.scope]?.layoutMode : undefined;
	}

	showsSession(sessionId: string): boolean {
		if (this.scope) {
			return this.ownSessions.has(sessionId) || !!this.scopes[this.scope]?.sessions.includes(sessionId);
		}
		return !this.hiddenSessions.has(sessionId);
	}

	showsProject(projectId: string): boolean {
		if (this.scope) {
			return this.ownProjects.has(projectId) || !!this.scopes[this.scope]?.projects.includes(projectId);
		}
		return this.ownProjects.has(projectId) || !this.hiddenProjects.has(projectId);
	}

	claimSession(sessionId: string): void {
		if (!this.scope || this.showsSession(sessionId)) {
			return;
		}
		this.ownSessions.add(sessionId);
		this.send({ sessions: [sessionId] });
	}

	claimProject(projectId: string, created: boolean): void {
		if (!this.scope) {
			// A main window adding a project another window created makes it everyone's.
			if (this.hiddenProjects.has(projectId) && !this.ownProjects.has(projectId)) {
				this.ownProjects.add(projectId);
				this.send({ projects: [projectId] });
			}
			return;
		}
		const createdHere = created && !this.scopes[this.scope]?.createdProjects.includes(projectId);
		if (this.showsProject(projectId) && !createdHere) {
			return;
		}
		this.ownProjects.add(projectId);
		this.send(createdHere ? { createdProjects: [projectId] } : { projects: [projectId] });
	}

	setLayoutMode(mode: VoltWindowLayoutMode): void {
		if (this.scope && this.layoutMode !== mode) {
			this.send({ layoutMode: mode });
		}
	}

	private send(claim: IVoltWindowScopeClaim): void {
		this.scopes = applyWindowScopeClaim(this.scopes, this.scope, claim);
		this.index();
		this._onDidChange.fire();
		void this.host?.claim(this.scope, claim).catch(() => undefined);
	}

	private replace(next: IVoltWindowScopes): void {
		if (next === this.scopes) {
			return;
		}
		const ended = Object.entries(this.scopes).filter(([id]) => !next[id] && id !== this.scope).map(([, state]) => state);
		this.scopes = next;
		this.index();
		this._onDidChange.fire();
		if (ended.length && !this.scope) {
			this._onDidEndScopes.fire(ended);
		}
	}

	/** A main window leaves out every scope's chats and the projects scoped windows created. */
	private index(): void {
		const sessions = new Set<string>();
		const projects = new Set<string>();
		if (!this.scope) {
			for (const state of Object.values(this.scopes)) {
				state.sessions.forEach(id => sessions.add(id));
				state.createdProjects.forEach(id => projects.add(id));
			}
		}
		this.hiddenSessions = sessions;
		this.hiddenProjects = projects;
	}
}
