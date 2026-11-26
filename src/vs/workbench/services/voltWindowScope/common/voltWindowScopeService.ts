/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { applyWindowScopeClaim, IVoltWindowScopeClaim, IVoltWindowScopes, IVoltWindowScopesService, IVoltWindowScopeState, VoltWindowLayoutMode } from '../../../../platform/voltWindowScope/common/voltWindowScope.js';
import { IVoltWindowScopeService } from './voltWindowScope.js';

/**
 * Keeps this window's copy of the scopes. Claims apply here at once and then go to the main
 * process, whose updates replace the copy; what this window claimed itself is kept on top until an
 * update has it (here, or moved to another window), so an update sent before a claim arrived
 * cannot drop it.
 */
export class VoltWindowScopeService extends Disposable implements IVoltWindowScopeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDidEndScopes = this._register(new Emitter<readonly IVoltWindowScopeState[]>());
	readonly onDidEndScopes = this._onDidEndScopes.event;

	readonly onDidRevealSession: Event<string>;

	private scopes: IVoltWindowScopes;
	/** Claimed here (scoped window), or projects a main window added itself (released everywhere). */
	private readonly ownSessions = new Set<string>();
	private readonly ownProjects = new Set<string>();
	/** The scope holding each chat. */
	private sessionOwners = new Map<string, string>();
	/** Projects some scope holds, by that scope. */
	private projectHolders = new Map<string, string>();

	constructor(
		readonly scope: string | undefined,
		initial: IVoltWindowScopes | undefined,
		private readonly host: IVoltWindowScopesService | undefined,
		windowId?: number,
	) {
		super();
		this.scopes = initial ?? {};
		this.index();
		this.onDidRevealSession = host && windowId !== undefined
			? Event.map(Event.filter(host.onDidRevealSession, e => e.windowId === windowId, this._store), e => e.session, this._store)
			: Event.None;
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

	/** A window without a scope, or the scoped window that is the main window too. */
	get isMain(): boolean {
		return !this.scope || !!this.scopes[this.scope]?.main;
	}

	showsSession(sessionId: string): boolean {
		const owner = this.sessionOwners.get(sessionId);
		if (owner !== undefined) {
			return owner === this.scope;
		}
		return this.isMain;
	}

	heldElsewhere(sessionId: string): boolean {
		const owner = this.sessionOwners.get(sessionId);
		return owner !== undefined && owner !== this.scope;
	}

	showsProject(projectId: string): boolean {
		if (this.ownProjects.has(projectId)) {
			return true;
		}
		const holder = this.projectHolders.get(projectId);
		if (this.scope && (holder === this.scope || this.scopes[this.scope]?.projects.includes(projectId))) {
			return true;
		}
		return this.isMain && holder === undefined;
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
			if (this.projectHolders.has(projectId) && !this.ownProjects.has(projectId)) {
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

	async revealElsewhere(sessionId: string): Promise<boolean> {
		if (!this.host || this.showsSession(sessionId)) {
			return false;
		}
		try {
			return await this.host.revealSession(sessionId, this.scope);
		} catch {
			return false;
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
		const wasMain = this.isMain;
		const ended = Object.entries(this.scopes).filter(([id]) => !next[id] && id !== this.scope).map(([, state]) => state);
		// A chat claimed here that the update does not have yet stays here; once the update has it,
		// here or in another window (it moved), the update says where it is.
		const pending = this.scope ? [...this.ownSessions].filter(id => {
			const known = Object.values(next).some(state => state.sessions.includes(id));
			if (known) {
				this.ownSessions.delete(id);
			}
			return !known;
		}) : [];
		this.scopes = pending.length && this.scope ? applyWindowScopeClaim(next, this.scope, { sessions: pending }) : next;
		this.index();
		this._onDidChange.fire();
		// The main window takes in what closed windows owned. A window that just became the main
		// window takes in everything other windows wrote.
		if (this.isMain && (ended.length || !wasMain)) {
			this._onDidEndScopes.fire(ended);
		}
	}

	private index(): void {
		const sessions = new Map<string, string>();
		const projects = new Map<string, string>();
		for (const [id, state] of Object.entries(this.scopes)) {
			state.sessions.forEach(session => sessions.set(session, id));
			state.createdProjects.forEach(project => projects.set(project, id));
		}
		this.sessionOwners = sessions;
		this.projectHolders = projects;
	}
}
