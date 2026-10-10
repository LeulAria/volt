/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { canonicalProjectRoot, IVoltProjectRecord, IVoltSessionBinding, IVoltSessionContextService, projectAuthority, projectDisplayName, projectIdForRoot } from '../../voltRuntime/common/sessionContext.js';
import { IAgentServerClientService } from './agentServerClient.js';

const ACTIVE_KEY = 'volt.agent.activeProject';
const PROJECT_PREFIX = 'project:';

/**
 * Projects and chat bindings kept by the agent server. The project a window has selected stays
 * this window's own (as before); registering and binding apply here at once and on the server.
 */
export class RemoteVoltSessionContextService extends Disposable implements IVoltSessionContextService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeProjects = this._register(new Emitter<void>());
	readonly onDidChangeProjects = this._onDidChangeProjects.event;
	private readonly _onDidChangeActiveProject = this._register(new Emitter<string | undefined>());
	readonly onDidChangeActiveProject = this._onDidChangeActiveProject.event;

	/** Registered or bound here and not yet echoed back by the server. */
	private readonly pendingProjects = new Map<string, IVoltProjectRecord>();
	private readonly pendingBindings = new Map<string, string>();
	private activeId: string | undefined;

	constructor(
		@IAgentServerClientService private readonly client: IAgentServerClientService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this.activeId = storageService.get(ACTIVE_KEY, StorageScope.WORKSPACE, '') || undefined;
		// As in-process: a window opened on a folder starts on that folder, an empty one on the project used last.
		const folders = workspaceContextService.getWorkbenchState() === WorkbenchState.FOLDER ? workspaceContextService.getWorkspace().folders : [];
		if (!this.activeId && folders.length === 1) {
			this.activeId = this.registerProject(folders[0].uri, folders[0].name).id;
			storageService.store(ACTIVE_KEY, this.activeId, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
		this.activeId ??= storageService.get(ACTIVE_KEY, StorageScope.APPLICATION, '') || undefined;
		this._register(client.onDidChangeCollection(e => {
			if (e.col !== 'projects') {
				return;
			}
			for (const id of [...this.pendingProjects.keys()]) {
				if (this.client.mirror.has('projects', PROJECT_PREFIX + id)) {
					this.pendingProjects.delete(id);
				}
			}
			const bindings = this.serverBindings();
			for (const [sessionId, projectId] of [...this.pendingBindings]) {
				if (bindings[sessionId] === projectId) {
					this.pendingBindings.delete(sessionId);
				}
			}
			this._onDidChangeProjects.fire();
		}));
	}

	private serverBindings(): Readonly<Record<string, string>> {
		return this.client.mirror.get<Record<string, string>>('projects', 'bindings') ?? {};
	}

	/** Every record, scratch folders included: the server's, then the ones registered here it has not echoed yet. */
	private allProjects(): readonly IVoltProjectRecord[] {
		const server = this.client.mirror.entries<IVoltProjectRecord>('projects').filter(([key]) => key.startsWith(PROJECT_PREFIX)).map(([, record]) => record);
		const known = new Set(server.map(project => project.id));
		return [...[...this.pendingProjects.values()].filter(project => !known.has(project.id)), ...server];
	}

	get projects(): readonly IVoltProjectRecord[] {
		return this.allProjects().filter(project => !project.scratch);
	}

	get activeProject(): IVoltProjectRecord | undefined {
		const project = this.activeId ? this.getProject(this.activeId) : undefined;
		return project?.scratch ? undefined : project;
	}

	getProject(id: string): IVoltProjectRecord | undefined {
		return this.pendingProjects.get(id) ?? this.client.mirror.get<IVoltProjectRecord>('projects', PROJECT_PREFIX + id);
	}

	registerProject(root: URI, displayName?: string): IVoltProjectRecord {
		return this.addProject(root, displayName, false);
	}

	registerScratchProject(root: URI, displayName: string): IVoltProjectRecord {
		return this.addProject(root, displayName, true);
	}

	/** Known here at once (callers bind chats to it right away); the server's record follows. */
	private addProject(root: URI, displayName: string | undefined, scratch: boolean): IVoltProjectRecord {
		const canonical = canonicalProjectRoot(root);
		const id = projectIdForRoot(canonical);
		const existing = this.getProject(id);
		if (existing) {
			return existing;
		}
		const record: IVoltProjectRecord = {
			id,
			root: canonical,
			displayName: projectDisplayName(canonical, displayName),
			authority: projectAuthority(canonical),
			...(scratch ? { scratch: true } : {}),
		};
		this.pendingProjects.set(id, record);
		this.client.send(scratch ? 'projects.registerScratchProject' : 'projects.registerProject', root, displayName);
		this._onDidChangeProjects.fire();
		return record;
	}

	unregisterProject(id: string): void {
		this.pendingProjects.delete(id);
		this.client.send('projects.unregisterProject', id);
		if (this.activeId === id) {
			this.selectProject(undefined);
		}
	}

	selectProject(id: string | undefined): void {
		const next = id && this.getProject(id) && !this.getProject(id)?.scratch ? id : undefined;
		if (this.activeId === next) {
			return;
		}
		this.activeId = next;
		if (next) {
			this.storageService.store(ACTIVE_KEY, next, StorageScope.APPLICATION, StorageTarget.USER);
			this.storageService.store(ACTIVE_KEY, next, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(ACTIVE_KEY, StorageScope.APPLICATION);
			this.storageService.remove(ACTIVE_KEY, StorageScope.WORKSPACE);
		}
		this._onDidChangeActiveProject.fire(next);
	}

	bindingFor(sessionId: string): IVoltSessionBinding | undefined {
		const projectId = this.pendingBindings.get(sessionId) ?? this.serverBindings()[sessionId];
		const project = projectId ? this.getProject(projectId) : undefined;
		return projectId && project ? { sessionId, projectId, root: project.root, authority: project.authority } : undefined;
	}

	bindSession(sessionId: string, projectId: string): IVoltSessionBinding | undefined {
		if (!sessionId || !this.getProject(projectId)) {
			return undefined;
		}
		const current = this.bindingFor(sessionId);
		if (current) {
			return current;
		}
		this.pendingBindings.set(sessionId, projectId);
		this.client.send('projects.bindSession', sessionId, projectId);
		return this.bindingFor(sessionId);
	}

	rebindUnstartedSession(sessionId: string, projectId: string): IVoltSessionBinding | undefined {
		if (!sessionId || !this.getProject(projectId)) {
			return undefined;
		}
		this.pendingBindings.set(sessionId, projectId);
		this.client.send('projects.rebindUnstartedSession', sessionId, projectId);
		return this.bindingFor(sessionId);
	}

	rootFor(sessionId: string): URI | undefined {
		return this.bindingFor(sessionId)?.root;
	}
}
