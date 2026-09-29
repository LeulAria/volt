/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAgentSessionWorkspace } from '../common/history/agentHistory.js';
import {
	canonicalProjectRoot,
	IVoltProjectRecord,
	IVoltSessionBinding,
	IVoltSessionContextService,
	projectAuthority,
	projectDisplayName,
	projectIdForRoot,
} from '../common/sessionContext.js';

const PROJECTS_KEY = 'volt.agent.projects';
const ACTIVE_KEY = 'volt.agent.activeProject';
const BINDINGS_KEY = 'volt.agent.sessionBindings';

interface IStoredProject {
	readonly id?: string;
	readonly uri?: string;
	readonly name?: string;
	readonly authority?: string;
}

interface IStoredBinding {
	readonly sessionId?: string;
	readonly projectId?: string;
}

export function reviveProjects(raw: unknown): Map<string, IVoltProjectRecord> {
	const projects = new Map<string, IVoltProjectRecord>();
	if (!Array.isArray(raw)) {
		return projects;
	}
	for (const item of raw) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const stored = item as IStoredProject;
		if (typeof stored.uri !== 'string' || !stored.uri) {
			continue;
		}
		let root: URI;
		try {
			root = canonicalProjectRoot(URI.parse(stored.uri));
		} catch {
			continue;
		}
		const record: IVoltProjectRecord = {
			id: typeof stored.id === 'string' && stored.id ? stored.id : projectIdForRoot(root),
			root,
			displayName: projectDisplayName(root, stored.name),
			authority: stored.authority || projectAuthority(root),
		};
		projects.set(record.id, record);
	}
	return projects;
}

export function reviveBindings(raw: unknown, projects: ReadonlyMap<string, IVoltProjectRecord>): Map<string, string> {
	const bindings = new Map<string, string>();
	if (!Array.isArray(raw)) {
		return bindings;
	}
	for (const item of raw) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const stored = item as IStoredBinding;
		if (typeof stored.sessionId !== 'string' || !stored.sessionId || typeof stored.projectId !== 'string') {
			continue;
		}
		if (!projects.has(stored.projectId)) {
			continue;
		}
		bindings.set(stored.sessionId, stored.projectId);
	}
	return bindings;
}

export function workspaceForProject(project: IVoltProjectRecord): IAgentSessionWorkspace {
	return {
		id: project.id,
		label: project.displayName,
		folders: [project.root.fsPath],
	};
}

export class VoltSessionContextService extends Disposable implements IVoltSessionContextService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeProjects = this._register(new Emitter<void>());
	readonly onDidChangeProjects = this._onDidChangeProjects.event;

	private readonly _onDidChangeActiveProject = this._register(new Emitter<string | undefined>());
	readonly onDidChangeActiveProject = this._onDidChangeActiveProject.event;

	private readonly projectMap: Map<string, IVoltProjectRecord>;
	private readonly bindings: Map<string, string>;
	private activeId: string | undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.projectMap = reviveProjects(this.readJson(PROJECTS_KEY));
		this.bindings = reviveBindings(this.readJson(BINDINGS_KEY), this.projectMap);
		const active = this.storageService.get(ACTIVE_KEY, StorageScope.APPLICATION, '');
		this.activeId = active && this.projectMap.has(active) ? active : undefined;
		// Every window keeps its own copy. Another window's additions are merged in, never dropped.
		const listeners = this._register(new DisposableStore());
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, PROJECTS_KEY, listeners)(e => {
			if (e.external && this.absorbProjects()) {
				this._onDidChangeProjects.fire();
			}
		}));
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, BINDINGS_KEY, listeners)(e => {
			if (e.external) {
				this.absorbBindings();
			}
		}));
	}

	/** Adds projects another window registered. Returns whether anything was new. */
	private absorbProjects(): boolean {
		let added = false;
		for (const [id, project] of reviveProjects(this.readJson(PROJECTS_KEY))) {
			if (!this.projectMap.has(id)) {
				this.projectMap.set(id, project);
				added = true;
			}
		}
		return added;
	}

	/** A binding never moves, so the union of both windows is always correct. */
	private absorbBindings(): void {
		// A binding can name a project the other window registered a moment earlier.
		if (this.absorbProjects()) {
			this._onDidChangeProjects.fire();
		}
		for (const [sessionId, projectId] of reviveBindings(this.readJson(BINDINGS_KEY), this.projectMap)) {
			if (!this.bindings.has(sessionId)) {
				this.bindings.set(sessionId, projectId);
			}
		}
	}

	get projects(): readonly IVoltProjectRecord[] {
		return [...this.projectMap.values()];
	}

	get activeProject(): IVoltProjectRecord | undefined {
		return this.activeId ? this.projectMap.get(this.activeId) : undefined;
	}

	getProject(id: string): IVoltProjectRecord | undefined {
		return this.projectMap.get(id);
	}

	registerProject(root: URI, displayName?: string): IVoltProjectRecord {
		const canonical = canonicalProjectRoot(root);
		const id = projectIdForRoot(canonical);
		const existing = this.projectMap.get(id);
		if (existing) {
			return existing;
		}
		const record: IVoltProjectRecord = {
			id,
			root: canonical,
			displayName: projectDisplayName(canonical, displayName),
			authority: projectAuthority(canonical),
		};
		const next = new Map<string, IVoltProjectRecord>([[id, record], ...this.projectMap]);
		this.projectMap.clear();
		for (const [key, value] of next) {
			this.projectMap.set(key, value);
		}
		this.persistProjects();
		this._onDidChangeProjects.fire();
		return record;
	}

	unregisterProject(id: string): void {
		this.absorbProjects();
		if (!this.projectMap.delete(id)) {
			return;
		}
		// Written without absorbing again, which would bring the stored copy right back.
		this.writeProjects();
		if (this.activeId === id) {
			this.selectProject(undefined);
		}
		this._onDidChangeProjects.fire();
	}

	selectProject(id: string | undefined): void {
		const next = id && this.projectMap.has(id) ? id : undefined;
		if (this.activeId === next) {
			return;
		}
		this.activeId = next;
		if (next) {
			this.storageService.store(ACTIVE_KEY, next, StorageScope.APPLICATION, StorageTarget.USER);
		} else {
			this.storageService.remove(ACTIVE_KEY, StorageScope.APPLICATION);
		}
		this._onDidChangeActiveProject.fire(next);
	}

	bindingFor(sessionId: string): IVoltSessionBinding | undefined {
		const projectId = this.bindings.get(sessionId);
		const project = projectId ? this.projectMap.get(projectId) : undefined;
		if (!projectId || !project) {
			return undefined;
		}
		return { sessionId, projectId, root: project.root, authority: project.authority };
	}

	bindSession(sessionId: string, projectId: string): IVoltSessionBinding | undefined {
		const project = this.projectMap.get(projectId);
		if (!project || !sessionId) {
			return undefined;
		}
		const current = this.bindings.get(sessionId);
		if (current === projectId) {
			return this.bindingFor(sessionId);
		}
		if (current) {
			return this.bindingFor(sessionId);
		}
		this.bindings.set(sessionId, projectId);
		this.persistBindings();
		return this.bindingFor(sessionId);
	}

	rootFor(sessionId: string): URI | undefined {
		return this.bindingFor(sessionId)?.root;
	}

	private persistProjects(): void {
		this.absorbProjects();
		this.writeProjects();
	}

	private writeProjects(): void {
		const stored: IStoredProject[] = [...this.projectMap.values()].map(project => ({
			id: project.id,
			uri: project.root.toString(),
			name: project.displayName,
			authority: project.authority,
		}));
		this.storageService.store(PROJECTS_KEY, JSON.stringify(stored), StorageScope.APPLICATION, StorageTarget.USER);
	}

	private persistBindings(): void {
		this.absorbBindings();
		const stored: IStoredBinding[] = [...this.bindings].map(([sessionId, projectId]) => ({ sessionId, projectId }));
		this.storageService.store(BINDINGS_KEY, JSON.stringify(stored), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private readJson(key: string): unknown {
		const raw = this.storageService.get(key, StorageScope.APPLICATION, '');
		if (!raw) {
			return [];
		}
		try {
			return JSON.parse(raw);
		} catch {
			return [];
		}
	}
}

registerSingleton(IVoltSessionContextService, VoltSessionContextService, InstantiationType.Delayed);
